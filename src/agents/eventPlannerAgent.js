import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Event Planner, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates event-organizing requests to. You have real tools backed by Shane's LifeOS dashboard "events" \
table — use them, don't guess or make up numbers.

Your job: help Shane organize events (parties, gatherings, etc.) — track dates, budgets, guest counts, vendors, \
and status, and surface what's coming up soonest.

Notes on the data:
- "events" is one row per event: title, event_date, budget, guest_count, status, vendors (free text), notes. \
status is 'planning' (default), 'confirmed', 'completed', or 'cancelled'.
- vendors is free text — a running list/notes of vendors involved (caterer, venue, etc.), not a separate table. \
Append to it rather than overwriting when Shane adds a new vendor, unless he's correcting something.
- The "contacts" table (owned primarily by the Gift Planner) can hold guest info if Shane wants to track \
specific people for an event, but you don't have direct tools for it here — if Shane wants named guest tracking, \
say that's better handled by the Gift Planner's contacts, don't try to invent your own guest list storage.
- get_upcoming_events returns events that aren't completed/cancelled, ordered soonest-first — use it whenever \
Shane asks what's coming up or wants an event-planning summary.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete details (titles, dates, budgets) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'create_event',
    description: 'Add a new event to plan/track.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        event_date: { type: 'string', description: 'ISO date (YYYY-MM-DD), if known' },
        budget: { type: 'number' },
        guest_count: { type: 'integer' },
        vendors: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_event',
    description: "Update an event's status, date, budget, guest count, vendors, or notes. Matches the most recent event by title if multiple match.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title to match' },
        status: { type: 'string', enum: ['planning', 'confirmed', 'completed', 'cancelled'] },
        event_date: { type: 'string' },
        budget: { type: 'number' },
        guest_count: { type: 'integer' },
        vendors: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_events',
    description: "List Shane's tracked events, most recent first. Optionally filter by status.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['planning', 'confirmed', 'completed', 'cancelled'] },
        limit: { type: 'integer', description: 'How many to return, default 20' },
      },
    },
  },
  {
    name: 'get_upcoming_events',
    description: "Return Shane's events that aren't completed/cancelled, ordered soonest-first.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many to return, default 10' },
      },
    },
  },
];

async function findEventByTitle(title) {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .ilike('title', title)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createEvent({ title, event_date, budget, guest_count, vendors, notes }) {
  const row = { user_id: DEFAULT_USER_ID, title };
  if (event_date !== undefined) row.event_date = event_date;
  if (budget !== undefined) row.budget = budget;
  if (guest_count !== undefined) row.guest_count = guest_count;
  if (vendors !== undefined) row.vendors = vendors;
  if (notes !== undefined) row.notes = notes;

  const { data, error } = await supabase.from('events').insert(row).select().single();
  if (error) throw error;
  return { ok: true, event: data };
}

async function updateEvent({ title, status, event_date, budget, guest_count, vendors, notes }) {
  const existing = await findEventByTitle(title);
  if (!existing) return { ok: false, error: `No event found titled '${title}'` };

  const updates = { updated_at: new Date().toISOString() };
  if (status !== undefined) updates.status = status;
  if (event_date !== undefined) updates.event_date = event_date;
  if (budget !== undefined) updates.budget = budget;
  if (guest_count !== undefined) updates.guest_count = guest_count;
  if (vendors !== undefined) updates.vendors = vendors;
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await supabase.from('events').update(updates).eq('id', existing.id).select().single();
  if (error) throw error;
  return { ok: true, event: data };
}

async function listEvents({ status, limit }) {
  const n = limit ?? 20;
  let query = supabase.from('events').select('*').eq('user_id', DEFAULT_USER_ID).order('event_date', { ascending: false }).limit(n);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, events: data };
}

async function getUpcomingEvents({ limit }) {
  const n = limit ?? 10;
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .not('status', 'in', '("completed","cancelled")')
    .order('event_date', { ascending: true })
    .limit(n);
  if (error) throw error;
  return { ok: true, upcoming_events: data };
}

async function runEventPlannerTool(name, input) {
  switch (name) {
    case 'create_event':
      return createEvent(input);
    case 'update_event':
      return updateEvent(input);
    case 'list_events':
      return listEvents(input);
    case 'get_upcoming_events':
      return getUpcomingEvents(input);
    default:
      throw new Error(`Unknown Event Planner tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runEventPlannerAgent(request) {
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
        const result = await runEventPlannerTool(use.name, use.input);
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

  return finalText || "Event Planner got stuck and didn't produce a final answer — try rephrasing the request.";
}
