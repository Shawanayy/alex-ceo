import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';
import { tavilySearch } from '../tavilyClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Entertainment Planner, a specialist sub-agent that Alex (Shane Pinho's Chief \
of Staff) delegates leisure-planning requests to. You have real tools backed by Shane's LifeOS dashboard \
"entertainment_log" table, plus a live web search tool — use them, don't guess or make up numbers.

Your job: help Shane plan free time — find movies, books, restaurants, and local events via live search, and \
track what he wants to check out vs. what he's already done, with ratings.

Notes on the data:
- "entertainment_log" is one row per movie/book/restaurant/event Shane is tracking. entertainment_type is one \
of 'movie', 'book', 'restaurant', or 'event'. status is 'want_to' (default) or 'done'. rating is an optional \
1-5 integer, only set once Shane has actually experienced it and gives a rating.
- search_entertainment_info uses live web search (Tavily) to look up real, current movies playing, book \
recommendations, restaurants, or local events. Use it whenever Shane asks for recommendations or what's \
happening — don't invent showtimes, restaurant names, or event details. Ground concrete claims in what the \
search actually returned, and say so if results are thin or location/date-specific info wasn't available.
- When Shane picks something from your research he wants to check out, log it via add_log_entry so it's tracked.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete details (titles, sources) rather than vague summaries, and note when \
info came from live search vs. the dashboard.`;

const toolDefs = [
  {
    name: 'add_log_entry',
    description: 'Add a movie/book/restaurant/event to track (want-to or already done).',
    input_schema: {
      type: 'object',
      properties: {
        entertainment_type: { type: 'string', enum: ['movie', 'book', 'restaurant', 'event'] },
        title: { type: 'string' },
        status: { type: 'string', enum: ['want_to', 'done'], description: "Defaults to 'want_to'" },
        rating: { type: 'integer', description: '1-5, only if already done and rated' },
        notes: { type: 'string' },
      },
      required: ['entertainment_type', 'title'],
    },
  },
  {
    name: 'update_log_entry',
    description: "Update an entry's status, rating, or notes (e.g. mark done and rate it). Matches the most recent entry by title if multiple match.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title to match' },
        status: { type: 'string', enum: ['want_to', 'done'] },
        rating: { type: 'integer', description: '1-5' },
        notes: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_log_entries',
    description: "List Shane's entertainment log, most recent first. Optionally filter by type or status.",
    input_schema: {
      type: 'object',
      properties: {
        entertainment_type: { type: 'string', enum: ['movie', 'book', 'restaurant', 'event'] },
        status: { type: 'string', enum: ['want_to', 'done'] },
        limit: { type: 'integer', description: 'How many to return, default 20' },
      },
    },
  },
  {
    name: 'search_entertainment_info',
    description: 'Live web search for real, current movies, books, restaurants, or local events. Use this to research, not guess.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "highly rated sci-fi movies in theaters now" or "best new restaurants Columbus Ohio"' },
      },
      required: ['query'],
    },
  },
];

async function findEntryByTitle(title) {
  const { data, error } = await supabase
    .from('entertainment_log')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .ilike('title', title)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function addLogEntry({ entertainment_type, title, status, rating, notes }) {
  const row = { user_id: DEFAULT_USER_ID, entertainment_type, title };
  if (status !== undefined) row.status = status;
  if (rating !== undefined) row.rating = rating;
  if (notes !== undefined) row.notes = notes;

  const { data, error } = await supabase.from('entertainment_log').insert(row).select().single();
  if (error) throw error;
  return { ok: true, log_entry: data };
}

async function updateLogEntry({ title, status, rating, notes }) {
  const existing = await findEntryByTitle(title);
  if (!existing) return { ok: false, error: `No entertainment log entry found titled '${title}'` };

  const updates = { updated_at: new Date().toISOString() };
  if (status !== undefined) updates.status = status;
  if (rating !== undefined) updates.rating = rating;
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await supabase.from('entertainment_log').update(updates).eq('id', existing.id).select().single();
  if (error) throw error;
  return { ok: true, log_entry: data };
}

async function listLogEntries({ entertainment_type, status, limit }) {
  const n = limit ?? 20;
  let query = supabase.from('entertainment_log').select('*').eq('user_id', DEFAULT_USER_ID).order('created_at', { ascending: false }).limit(n);
  if (entertainment_type) query = query.eq('entertainment_type', entertainment_type);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, log_entries: data };
}

async function searchEntertainmentInfo({ query }) {
  const result = await tavilySearch(query, { maxResults: 5 });
  return { ok: true, ...result };
}

async function runEntertainmentTool(name, input) {
  switch (name) {
    case 'add_log_entry':
      return addLogEntry(input);
    case 'update_log_entry':
      return updateLogEntry(input);
    case 'list_log_entries':
      return listLogEntries(input);
    case 'search_entertainment_info':
      return searchEntertainmentInfo(input);
    default:
      throw new Error(`Unknown Entertainment Planner tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runEntertainmentAgent(request) {
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
        const result = await runEntertainmentTool(use.name, use.input);
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

  return finalText || "Entertainment Planner got stuck and didn't produce a final answer — try rephrasing the request.";
}
