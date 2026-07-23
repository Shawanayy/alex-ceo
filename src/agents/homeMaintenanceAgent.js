import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Home Maintenance Agent, a specialist sub-agent that Alex (Shane Pinho's \
Chief of Staff) delegates home-upkeep requests to. You have real tools backed by Shane's LifeOS dashboard \
"home_maintenance_records" table — use them, don't guess or make up numbers.

Your job: help Shane track recurring maintenance tasks, warranties, and household supplies so nothing gets \
missed — and surface what's due or overdue soonest.

Notes on the data:
- "home_maintenance_records" is one row per tracked item. record_type is one of 'maintenance' (e.g. "Replace \
HVAC filter", recurring), 'warranty' (e.g. "Refrigerator warranty", tied to a purchase), or 'supply' (e.g. \
"Air filters running low", a household supply to reorder).
- due_date is when the item is next due (a filter change, a warranty expiration, a restock). frequency is \
free text for recurring maintenance (e.g. "every 3 months") — only set for record_type='maintenance' that \
repeats.
- status is 'upcoming' (default), 'completed', or 'overdue'. When Shane says he did a maintenance task, mark it \
completed via update_record — if it's recurring (has a frequency), also create the next occurrence with a new \
due_date so the schedule keeps going, and mention that you did so.
- get_due_soon returns records with a due_date within a given number of days (default 30) that aren't already \
completed, ordered soonest-first — use it whenever Shane asks what's coming up or needs a maintenance summary.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete details (titles, due dates) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'add_record',
    description: 'Add a new maintenance task, warranty, or supply to track.',
    input_schema: {
      type: 'object',
      properties: {
        record_type: { type: 'string', enum: ['maintenance', 'warranty', 'supply'] },
        title: { type: 'string', description: "e.g. 'Replace HVAC filter', 'Refrigerator warranty', 'Air filters'" },
        due_date: { type: 'string', description: 'ISO date (YYYY-MM-DD), if known' },
        frequency: { type: 'string', description: "For recurring maintenance, e.g. 'every 3 months'" },
        notes: { type: 'string' },
      },
      required: ['record_type', 'title'],
    },
  },
  {
    name: 'update_record',
    description: "Update a record's status, due date, frequency, or notes. Matches the most recent record for the given title if multiple match.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title to match' },
        status: { type: 'string', enum: ['upcoming', 'completed', 'overdue'] },
        due_date: { type: 'string' },
        frequency: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_records',
    description: "List Shane's tracked home maintenance records. Optionally filter by record_type or status.",
    input_schema: {
      type: 'object',
      properties: {
        record_type: { type: 'string', enum: ['maintenance', 'warranty', 'supply'] },
        status: { type: 'string', enum: ['upcoming', 'completed', 'overdue'] },
        limit: { type: 'integer', description: 'How many to return, default 20' },
      },
    },
  },
  {
    name: 'get_due_soon',
    description: "Get records with a due_date within N days that aren't completed, soonest first.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Look-ahead window in days, default 30' },
      },
    },
  },
];

async function findRecordByTitle(title) {
  const { data, error } = await supabase
    .from('home_maintenance_records')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .ilike('title', title)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function addRecord({ record_type, title, due_date, frequency, notes }) {
  const row = { user_id: DEFAULT_USER_ID, record_type, title };
  if (due_date !== undefined) row.due_date = due_date;
  if (frequency !== undefined) row.frequency = frequency;
  if (notes !== undefined) row.notes = notes;

  const { data, error } = await supabase.from('home_maintenance_records').insert(row).select().single();
  if (error) throw error;
  return { ok: true, record: data };
}

async function updateRecord({ title, status, due_date, frequency, notes }) {
  const existing = await findRecordByTitle(title);
  if (!existing) return { ok: false, error: `No record found titled '${title}'` };

  const updates = { updated_at: new Date().toISOString() };
  if (status !== undefined) updates.status = status;
  if (due_date !== undefined) updates.due_date = due_date;
  if (frequency !== undefined) updates.frequency = frequency;
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await supabase.from('home_maintenance_records').update(updates).eq('id', existing.id).select().single();
  if (error) throw error;
  return { ok: true, record: data };
}

async function listRecords({ record_type, status, limit }) {
  const n = limit ?? 20;
  let query = supabase
    .from('home_maintenance_records')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('due_date', { ascending: true })
    .limit(n);
  if (record_type) query = query.eq('record_type', record_type);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, records: data };
}

async function getDueSoon({ days }) {
  const windowDays = days ?? 30;
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + windowDays);

  const { data, error } = await supabase
    .from('home_maintenance_records')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .neq('status', 'completed')
    .not('due_date', 'is', null)
    .lte('due_date', cutoff.toISOString().slice(0, 10))
    .order('due_date', { ascending: true });
  if (error) throw error;
  return { ok: true, due_soon: data };
}

async function runHomeMaintenanceTool(name, input) {
  switch (name) {
    case 'add_record':
      return addRecord(input);
    case 'update_record':
      return updateRecord(input);
    case 'list_records':
      return listRecords(input);
    case 'get_due_soon':
      return getDueSoon(input);
    default:
      throw new Error(`Unknown Home Maintenance Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runHomeMaintenanceAgent(request) {
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
        const result = await runHomeMaintenanceTool(use.name, use.input);
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

  return finalText || "Home Maintenance Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
