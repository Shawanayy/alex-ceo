import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import http from 'node:http';

import { handleMessage } from './alex.js';
import { runLearningAgent } from './agents/learningAgent.js';
import { startBackgroundLoop } from './backgroundLoop.js';

// Extracts plain text from a PDF buffer using PDF.js (pdfjs-dist), page by page.
async function extractPdfText(buffer) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map((item) => item.str).join(' ') + '\n';
  }
  return fullText;
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const ownerId = process.env.OWNER_TELEGRAM_USER_ID ? String(process.env.OWNER_TELEGRAM_USER_ID) : null;

if (!token) {
  console.error('[Alex] Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}
if (!ownerId) {
  console.error('[Alex] Missing OWNER_TELEGRAM_USER_ID in .env — message @userinfobot on Telegram to get yours.');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[Alex] Missing ANTHROPIC_API_KEY in .env');
  process.exit(1);
}

console.log('[Alex] Starting up...');

// In webhook mode (cloud deployment, e.g. Render) Telegram pushes updates to us instead of us
// polling for them — this lets the process sleep between messages, which is what makes free-tier
// hosting viable. Locally (npm start) we default to long polling since there's no public HTTPS URL.
const useWebhook = process.env.USE_WEBHOOK === 'true';
const bot = new TelegramBot(token, { polling: !useWebhook });

if (!useWebhook) {
  bot.on('polling_error', (err) => {
    console.error('[Alex] Telegram polling error:', err.message);
  });
}

bot.on('message', async (msg) => {
  const fromId = String(msg.from?.id ?? '');
  const chatId = msg.chat.id;
  const text = msg.text;

  if (fromId !== ownerId) {
    // Not Shane — stay silent rather than acting on unknown senders.
    console.log(`[Alex] Ignored message from unauthorized user id ${fromId}`);
    return;
  }

  if (msg.document) {
    await handleDocument(msg, chatId);
    return;
  }

  if (!text) {
    await bot.sendMessage(chatId, "I can only read text messages and PDF syllabus uploads right now — no photos/voice yet.");
    return;
  }

  await bot.sendChatAction(chatId, 'typing');

  try {
    const reply = await handleMessage(text, msg.message_id);
    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error('[Alex] Unhandled error:', err);
    await bot.sendMessage(chatId, "Something broke on my end handling that. Logged it — let Shane know if it persists.");
  }
});

// Handles a Telegram document upload — currently only supports PDF syllabi, which get run
// through the Learning & Career Agent's import_syllabus tool via a direct, self-contained
// delegation (bypassing Alex's main router since we already know this is a syllabus import).
async function handleDocument(msg, chatId) {
  const doc = msg.document;
  const isPdf = doc.mime_type === 'application/pdf' || (doc.file_name ?? '').toLowerCase().endsWith('.pdf');

  if (!isPdf) {
    await bot.sendMessage(chatId, "I can only process PDF syllabi right now — send it as a .pdf file.");
    return;
  }

  await bot.sendChatAction(chatId, 'typing');
  await bot.sendMessage(chatId, `Got it — reading ${doc.file_name || 'your syllabus'}...`);

  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const res = await fetch(fileLink);
    const buffer = Buffer.from(await res.arrayBuffer());
    const rawText = await extractPdfText(buffer);

    if (!rawText || !rawText.trim()) {
      await bot.sendMessage(
        chatId,
        "Couldn't extract any text from that PDF — it might be a scanned image rather than a text-based PDF."
      );
      return;
    }

    const prompt =
      'Import this syllabus: find every midterm/final exam date, create the class if it doesn\'t exist ' +
      'yet, log each exam as an assignment, and auto-schedule study sessions counting back from each ' +
      `exam.\n\nSyllabus text:\n${rawText}`;

    const result = await runLearningAgent(prompt);
    await bot.sendMessage(chatId, result);
  } catch (err) {
    console.error('[Alex] Syllabus import error:', err);
    await bot.sendMessage(
      chatId,
      "Something went wrong reading that syllabus. Logged it — try again, or paste the exam dates as text instead."
    );
  }
}

if (useWebhook) {
  // The bot token doubles as the secret path segment — a request that doesn't know the token
  // gets a 404, same auth principle as src/remoteMcpServer.js's token-in-path check.
  const webhookPath = `/telegram/${token}`;
  const port = process.env.PORT || 8788;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== webhookPath) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        bot.processUpdate(JSON.parse(body));
      } catch (err) {
        console.error('[Alex] Failed to process incoming webhook update:', err.message);
      }
      res.writeHead(200);
      res.end();
    });
  });

  server.listen(port, () => {
    console.log(
      `[Alex] Telegram bot is live (webhook mode) on port ${port}. Register the webhook URL with Telegram before messaging him.`
    );
  });
} else {
  console.log('[Alex] Telegram bot is live (long polling). Message him anytime.');
}

// The only proactive process in the app — see src/backgroundLoop.js for what it does.
startBackgroundLoop(bot, ownerId);
