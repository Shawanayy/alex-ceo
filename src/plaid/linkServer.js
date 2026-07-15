#!/usr/bin/env node
// One-time-use local web page for linking a bank account via Plaid Link. This is NOT part of the
// Telegram bot process — Plaid Link is a browser widget that needs a real user typing bank
// credentials into Plaid's own secure UI, which can't happen inside a Telegram chat. Run this
// once per new bank connection:
//
//   npm run link
//
// then open http://localhost:5544 in a browser, click "Connect a bank", and follow Plaid's flow.
// Shane's bank username/password go directly into Plaid's hosted UI — this server never sees or
// stores them, only the access_token Plaid hands back afterward (which gets saved to
// plaid_items so the Budgeting Agent's sync_plaid_transactions tool can use it going forward).
//
// Binds to localhost only — never expose this port publicly.

import http from 'node:http';
import dotenv from 'dotenv';
dotenv.config();

import { plaidClient, PLAID_PRODUCTS, PLAID_COUNTRY_CODES } from '../plaidClient.js';
import { supabase } from '../supabaseClient.js';

const PORT = process.env.PLAID_LINK_PORT || 5544;
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const LINK_PAGE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Link a bank account — Alex</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 80px auto; text-align: center; color: #222; }
    button { font-size: 16px; padding: 12px 24px; border-radius: 8px; border: none; background: #111; color: #fff; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    #status { margin-top: 24px; color: #555; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h2>Connect a bank account</h2>
  <p>Your bank login happens inside Plaid's own secure window — this page and Alex never see it.</p>
  <button id="linkBtn">Connect a bank</button>
  <div id="status"></div>

  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <script>
    const btn = document.getElementById('linkBtn');
    const statusEl = document.getElementById('status');

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      statusEl.textContent = 'Preparing secure connection...';
      try {
        const tokenRes = await fetch('/create_link_token', { method: 'POST' });
        const tokenData = await tokenRes.json();
        if (!tokenData.ok) throw new Error(tokenData.error || 'Could not create link token');

        const handler = Plaid.create({
          token: tokenData.link_token,
          onSuccess: async (public_token, metadata) => {
            statusEl.textContent = 'Connected — saving...';
            const exRes = await fetch('/exchange_public_token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                public_token,
                institution_name: metadata.institution ? metadata.institution.name : null,
              }),
            });
            const exData = await exRes.json();
            if (exData.ok) {
              statusEl.textContent = 'Done — ' + (metadata.institution ? metadata.institution.name : 'your bank') +
                ' is linked. You can close this tab and ask Alex to sync your accounts.';
            } else {
              statusEl.textContent = 'Linked with Plaid but saving failed: ' + (exData.error || 'unknown error');
              btn.disabled = false;
            }
          },
          onExit: (err) => {
            btn.disabled = false;
            statusEl.textContent = err ? ('Exited: ' + (err.error_message || err.error_code)) : '';
          },
        });
        handler.open();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(LINK_PAGE_HTML);
      return;
    }

    if (req.method === 'POST' && req.url === '/create_link_token') {
      const response = await plaidClient.linkTokenCreate({
        user: { client_user_id: DEFAULT_USER_ID },
        client_name: 'Alex (Personal Finance)',
        products: PLAID_PRODUCTS,
        country_codes: PLAID_COUNTRY_CODES,
        language: 'en',
      });
      sendJson(res, 200, { ok: true, link_token: response.data.link_token });
      return;
    }

    if (req.method === 'POST' && req.url === '/exchange_public_token') {
      const { public_token, institution_name } = await readJsonBody(req);
      if (!public_token) {
        sendJson(res, 400, { ok: false, error: 'Missing public_token' });
        return;
      }

      const exchange = await plaidClient.itemPublicTokenExchange({ public_token });
      const { access_token, item_id } = exchange.data;

      const { error } = await supabase.from('plaid_items').insert({
        user_id: DEFAULT_USER_ID,
        item_id,
        access_token,
        institution_name: institution_name ?? null,
        status: 'active',
      });
      if (error) throw error;

      sendJson(res, 200, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error('[Plaid Link Server] Error:', err?.response?.data ?? err);
    sendJson(res, 500, { ok: false, error: String(err?.response?.data?.error_message ?? err?.message ?? err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Plaid Link Server] Open http://localhost:${PORT} in a browser to connect a bank account.`);
  console.log('[Plaid Link Server] This only needs to run while you\'re linking — you can stop it (Ctrl+C) afterward.');
});
