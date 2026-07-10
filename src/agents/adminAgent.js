import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { getCalendarClient, getGmailClient } from '../google/googleClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';

const SYSTEM_PROMPT = `You are the Admin Agent, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates Calendar and Gmail requests to. You have real tools for Google Calendar and Gmail — use \
them, don't guess.

Hard rule: you can create email DRAFTS but you must NEVER send an email. There is no send tool available \
to you on purpose — if asked to send, explain (in your final answer) that you created a draft instead and \
Shane needs to review and send it himself from Gmail.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Include concrete details (event times, email subjects/senders) rather than vague \
summaries.`;

const toolDefs = [
  {
    name: 'list_events',
    description: "List events on Shane's primary Google Calendar within a time range.",
    input_schema: {
      type: 'object',
      properties: {
        time_min: { type: 'string', description: 'ISO 8601 start of range, e.g. 2026-07-09T00:00:00Z' },
        time_max: { type: 'string', description: 'ISO 8601 end of range' },
        max_results: { type: 'integer', description: 'Max events to return, default 20' },
      },
      required: ['time_min', 'time_max'],
    },
  },
  {
    name: 'create_event',
    description: "Create a new event on Shane's primary Google Calendar.",
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title' },
        description: { type: 'string', description: 'Optional event description' },
        start: { type: 'string', description: 'ISO 8601 start datetime' },
        end: { type: 'string', description: 'ISO 8601 end datetime' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of attendee email addresses',
        },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'list_emails',
    description: "Search/list messages in Shane's Gmail inbox.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Gmail search query, e.g. 'is:unread' or 'from:someone@example.com'. Defaults to 'is:unread'.",
        },
        max_results: { type: 'integer', description: 'Max messages to return, default 10' },
      },
    },
  },
  {
    name: 'create_draft',
    description: 'Create an email draft in Gmail. Does NOT send it — Shane reviews and sends manually.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Plain-text email body' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

function buildRawEmail({ to, subject, body }) {
  const messageParts = [
    `To: ${to}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body,
  ];
  const message = messageParts.join('\n');
  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function listEvents({ time_min, time_max, max_results }) {
  const calendar = getCalendarClient();
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: time_min,
    timeMax: time_max,
    maxResults: max_results ?? 20,
    singleEvents: true,
    orderBy: 'startTime',
  });
  const events = (res.data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    attendees: (e.attendees ?? []).map((a) => a.email),
  }));
  return { ok: true, events };
}

async function createEvent({ summary, description, start, end, attendees }) {
  const calendar = getCalendarClient();
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary,
      description: description ?? undefined,
      start: { dateTime: start },
      end: { dateTime: end },
      attendees: (attendees ?? []).map((email) => ({ email })),
    },
  });
  return { ok: true, event: { id: res.data.id, htmlLink: res.data.htmlLink } };
}

async function listEmails({ query, max_results }) {
  const gmail = getGmailClient();
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query || 'is:unread',
    maxResults: max_results ?? 10,
  });
  const messages = listRes.data.messages ?? [];
  const details = await Promise.all(
    messages.map(async (m) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const headers = msg.data.payload?.headers ?? [];
      const get = (name) => headers.find((h) => h.name === name)?.value ?? null;
      return {
        id: m.id,
        from: get('From'),
        subject: get('Subject'),
        date: get('Date'),
        snippet: msg.data.snippet,
      };
    })
  );
  return { ok: true, emails: details };
}

async function createDraft({ to, subject, body }) {
  const gmail = getGmailClient();
  const raw = buildRawEmail({ to, subject, body });
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });
  return {
    ok: true,
    draft_id: res.data.id,
    note: 'Draft created — not sent. Review and send manually in Gmail.',
  };
}

async function runAdminTool(name, input) {
  switch (name) {
    case 'list_events':
      return listEvents(input);
    case 'create_event':
      return createEvent(input);
    case 'list_emails':
      return listEmails(input);
    case 'create_draft':
      return createDraft(input);
    default:
      throw new Error(`Unknown Admin Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runAdminAgent(request) {
  let messages = [{ role: 'user', content: request }];
  let finalText = null;
  let guard = 0;

  while (finalText === null && guard < 6) {
    guard += 1;
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: toolDefs,
      messages,
    });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');

    if (toolUses.length === 0) {
      finalText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const use of toolUses) {
      try {
        const result = await runAdminTool(use.name, use.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
          is_error: true,
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return finalText || "Admin Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
