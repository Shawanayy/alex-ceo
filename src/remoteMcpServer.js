#!/usr/bin/env node
// Remote (HTTP) MCP bridge for Alex — meant for Cowork's custom-connector flow, which requires
// a publicly reachable MCP server (Cowork connects from Anthropic's cloud, not your device).
// This is separate from src/mcpServer.js, the local stdio version for classic Claude Desktop —
// that one won't work for Cowork, this one is built for exactly that.
//
// AUTH: every request must include `Authorization: Bearer <ALEX_REMOTE_MCP_TOKEN>`. Without
// this check anyone who finds the URL could message Alex and touch Shane's real Supabase data —
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ask_alex',
        description:
          "Send a message to Alex, Shane Pinho's personal Chief of Staff assistant, and get his reply, " +
          'exactly as if texting him on Telegram. Alex can manage classes, assignments, grades, study ' +
          'sessions, flashcards, study guides, syllabus imports, internal tasks, remembered facts, and ' +
          'Calendar/Gmail actions via his own sub-agents.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message to send to Alex, as if texting him.' },
          },
          required: ['message'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'ask_alex') {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    const { message } = request.params.arguments ?? {};
    if (!message || typeof message !== 'string') {
      throw new Error('"message" (string) is required.');
    }
    const reply = await handleMessage(message, null);
    return { content: [{ type: 'text', text: reply }] };
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

  if (req.url !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
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
  console.log(`[Alex Remote MCP] Listening on port ${PORT} (path: /mcp, health: /health)`);
});
