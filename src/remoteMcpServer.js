#!/usr/bin/env node
// Remote (HTTP) MCP bridge for Alex — meant for Cowork's custom-connector flow, which requires
// a publicly reachable MCP server (Cowork connects from Anthropic's cloud, not your device).
// This is separate from src/mcpServer.js, the local stdio version for classic Claude Desktop —
// that one won't work for Cowork, this one is built for exactly that.
//
// AUTH: the shared secret (ALEX_REMOTE_MCP_TOKEN) must be supplied either as the last path
// segment — POST /mcp/<token> — or as `Authorization: Bearer <token>`. The path-segment form
// exists because Cowork/Claude's custom-connector UI only takes a URL (no custom header field,
// and no support for user-pasted static bearer tokens as of this writing) — so the full connector
// URL registered in Cowork should be `https://<host>/mcp/<token>`. The header form is kept for
// anything that CAN send custom headers (curl, other MCP clients). Without one of these checks
// passing, anyone who finds the base URL could message Alex and touch Shane's real Supabase data —
// don't deploy this without the token set.
//
// Deploy target: Render (see render.yaml). Render sets process.env.PORT itself.

import http from 'node:http';
import dotenv from 'dotenv';
dotenv.config();

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { handleMessage } from './alex.js';
import { toolDefs, runTool } from './tools.js';

const PORT = process.env.PORT || 8787;
const TOKEN = process.env.ALEX_REMOTE_MCP_TOKEN;

if (!TOKEN) {
  console.error('[Alex Remote MCP] Missing ALEX_REMOTE_MCP_TOKEN — refusing to start without an auth token.');
  process.exit(1);
}

// Stateless mode: build a fresh Server + Transport per request. There's no session to persist —
// each ask_alex call is a self-contained request/response, same as the Telegram and local-MCP paths.
function buildServer() {
  const server = new Server({ name: 'alex-ceo', version: '1.0.0' }, { capabilities: { tools: {} } });

  // Two kinds of tools:
  //  1. ask_alex: the old "text Alex" path. It runs Alex's own model loop (Haiku by default) and
  //     is kept only as a fallback.
  //  2. Every tool in tools.js (add_dashboard_todo, the delegate_to_* sub-agents, etc.) exposed
  //     DIRECTLY. The Claude app is now the orchestrator: it decides which tool to call, and the
  //     specialist sub-agents do the domain work. No second orchestrator model in the middle.
  const directTools = toolDefs.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ask_alex',
        description:
          "Fallback only: send a free-text message to Alex's own Telegram brain (a separate, smaller " +
          'model loop) and get its reply. Prefer calling the specific tools directly.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message to send to Alex, as if texting him.' },
          },
          required: ['message'],
        },
      },
      ...directTools,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};

    if (name === 'ask_alex') {
      const { message } = args;
      if (!message || typeof message !== 'string') {
        throw new Error('"message" (string) is required.');
      }
      // Fixed session key, separate from Telegram's history. See alex.js getSessionHistory().
      const reply = await handleMessage(message, null, 'cowork-alex');
      return { content: [{ type: 'text', text: reply }] };
    }

    if (!toolDefs.some((t) => t.name === name)) {
      throw new Error(`Unknown tool: ${name}`);
    }
    try {
      const result = await runTool(name, args, null);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text: text ?? 'Done.' }] };
    } catch (err) {
      console.error(`[Alex Remote MCP] Tool ${name} failed:`, err);
      return { content: [{ type: 'text', text: `Error in ${name}: ${err.message}` }], isError: true };
    }
  });

  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Accept either exactly "/mcp" (auth via header) or "/mcp/<token>" (auth via path — this is
  // the form Cowork's connector URL should use, since it can't send a custom Authorization header).
  const url = new URL(req.url, 'http://internal');
  const segments = url.pathname.split('/').filter(Boolean); // e.g. ["mcp"] or ["mcp", "<token>"]

  if (segments[0] !== 'mcp' || segments.length > 2) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const pathToken = segments[1];
  const headerAuth = req.headers['authorization'];
  const authorized = pathToken === TOKEN || headerAuth === `Bearer ${TOKEN}`;

  if (!authorized) {
    // 404, not 401: a 401 here reads to some MCP clients (incl. Claude.ai's custom-connector
    // setup) as "this server wants OAuth," triggering a dynamic-client-registration attempt that
    // fails since we don't do OAuth — the real auth gate is the secret path/header, not a
    // WWW-Authenticate challenge. Returning 404 for anything unauthenticated avoids that false
    // signal; the correct /mcp/<token> URL still authorizes and works normally.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
    return;
  }

  try {
    const body = await readBody(req);
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[Alex Remote MCP] Error handling request:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
    }
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Alex Remote MCP] Listening on port ${PORT} (path: /mcp/<token> or /mcp with header, health: /health)`);
});
