import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';

const SYSTEM_PROMPT = `You are the Memory Agent, a specialist sub-agent that Alex (Shane Pinho's Chief of Staff) \
delegates long-term-memory management to. You have real tools backed by Shane's LifeOS dashboard "memories" \
table — use them, don't guess.

Context: Alex already has a lightweight always-on capability (a top-level 'remember' tool) that saves new \
memories and auto-injects the top 15 by importance into every conversation. You are NOT that — you're the \
queryable/management layer on top of the same table, for when Shane wants to browse, correct, re-prioritize, or \
delete what's been remembered about him, rather than just add to it.

Notes on the data:
- Each memory has: content (plain text), memory_type ('Preference', 'Vocabulary', 'Pattern', or 'Fact'), and \
importance (1 minor - 5 critical/always-in-context).
- 'Preference' = how Shane wants things done. 'Pattern' = a routine/recurring behavior or categorization rule. \
'Vocabulary' = a term/shorthand Shane uses. 'Fact' = anything else worth remembering.
- Matching is by content text (partial match), since Shane will refer to memories in natural language, not by id.
- If a search or update matches multiple memories, list them all and ask Alex (in your final answer) to have \
Shane be more specific rather than guessing which one to act on.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly.`;

const toolDefs = [
  {
    name: 'search_memories',
    description: 'Search saved memories by a text fragment of their content.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text fragment to search for within memory content' },
        limit: { type: 'integer', description: 'How many to return, default 20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_memories',
    description: 'List saved memories, most important first. Optionally filter by memory_type.',
    input_schema: {
      type: 'object',
      properties: {
        memory_type: { type: 'string', enum: ['Preference', 'Vocabulary', 'Pattern', 'Fact'] },
        limit: { type: 'integer', description: 'How many to return, default 30' },
      },
    },
  },
  {
    name: 'update_memory',
    description: "Update a memory's importance and/or rewrite its content. Matches by a text fragment of current content.",
    input_schema: {
      type: 'object',
      properties: {
        content_match: { type: 'string', description: 'Text fragment to find the memory to update' },
        new_content: { type: 'string', description: 'New content text, if rewording/correcting' },
        importance: { type: 'integer', description: '1 (minor) to 5 (critical)' },
        memory_type: { type: 'string', enum: ['Preference', 'Vocabulary', 'Pattern', 'Fact'] },
      },
      required: ['content_match'],
    },
  },
  {
    name: 'forget_memory',
    description: 'Delete a memory. Matches by a text fragment of its content — only deletes if exactly one match is found.',
    input_schema: {
      type: 'object',
      properties: {
        content_match: { type: 'string', description: 'Text fragment to find the memory to delete' },
      },
      required: ['content_match'],
    },
  },
];

async function searchMemories({ query, limit }) {
  const n = limit ?? 20;
  const { data, error } = await supabase
    .from('memories')
    .select('*')
    .ilike('content', `%${query}%`)
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(n);
  if (error) throw error;
  return { ok: true, memories: data };
}

async function listMemories({ memory_type, limit }) {
  const n = limit ?? 30;
  let q = supabase
    .from('memories')
    .select('*')
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(n);
  if (memory_type) q = q.eq('memory_type', memory_type);
  const { data, error } = await q;
  if (error) throw error;
  return { ok: true, memories: data };
}

async function findMatches(content_match) {
  const { data, error } = await supabase.from('memories').select('*').ilike('content', `%${content_match}%`);
  if (error) throw error;
  return data ?? [];
}

async function updateMemory({ content_match, new_content, importance, memory_type }) {
  const matches = await findMatches(content_match);
  if (matches.length === 0) return { ok: false, error: `No memory found matching '${content_match}'` };
  if (matches.length > 1) {
    return {
      ok: false,
      error: `${matches.length} memories match '${content_match}' — be more specific.`,
      matches: matches.map((m) => ({ id: m.id, content: m.content })),
    };
  }

  const updates = {};
  if (new_content !== undefined) updates.content = new_content;
  if (importance !== undefined) updates.importance = importance;
  if (memory_type !== undefined) updates.memory_type = memory_type;

  const { data, error } = await supabase.from('memories').update(updates).eq('id', matches[0].id).select().single();
  if (error) throw error;
  return { ok: true, memory: data };
}

async function forgetMemory({ content_match }) {
  const matches = await findMatches(content_match);
  if (matches.length === 0) return { ok: false, error: `No memory found matching '${content_match}'` };
  if (matches.length > 1) {
    return {
      ok: false,
      error: `${matches.length} memories match '${content_match}' — be more specific.`,
      matches: matches.map((m) => ({ id: m.id, content: m.content })),
    };
  }

  const { error } = await supabase.from('memories').delete().eq('id', matches[0].id);
  if (error) throw error;
  return { ok: true, forgotten: matches[0].content };
}

async function runMemoryTool(name, input) {
  switch (name) {
    case 'search_memories':
      return searchMemories(input);
    case 'list_memories':
      return listMemories(input);
    case 'update_memory':
      return updateMemory(input);
    case 'forget_memory':
      return forgetMemory(input);
    default:
      throw new Error(`Unknown Memory Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runMemoryAgent(request) {
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
        const result = await runMemoryTool(use.name, use.input);
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

  return finalText || "Memory Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
