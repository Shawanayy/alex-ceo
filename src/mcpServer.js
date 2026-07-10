#!/usr/bin/env node
// Alex-through-Claude bridge. Exposes Alex as a single MCP tool ("ask_alex") over stdio so
// he can be reached from a Claude app (Claude Desktop, Claude Code, Cowork, etc.) in addition
// to Telegram. This does NOT replace Telegram — it's a second entry point into the same
// handleMessage() brain, with its own in-memory rolling history (see src/alex.js).
//
// To connect it, add this to your Claude Desktop config
// (~/Library/Application Support/Claude/claude_desktop_config.json), under "mcpServers":
//
//   "alex-ceo": {
//     "command": "node",
//     "args": ["/Users/susanpinho/Desktop/Alex CEO/src/mcpServer.js"]
//   }
//
// Then restart Claude Desktop and ask it to "ask Alex ...".

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
dotenv.config();

import { handleMessage } from './alex.js';

const server = new Server(
  { name: 'alex-ceo', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[Alex MCP] Ready — listening on stdio.');

"alex-ceo": {
  "command": "node",
  "args": ["/Users/susanpinho/Desktop/Alex CEO/src/mcpServer.js"]
}