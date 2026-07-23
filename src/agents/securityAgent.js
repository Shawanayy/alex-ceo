import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Security & Privacy Agent, a specialist sub-agent that Alex (Shane Pinho's \
Chief of Staff) delegates digital-hygiene tracking to. You have real tools backed by Shane's LifeOS dashboard \
"security_checklist" table — use them, don't guess.

Be upfront about scope: you are a hygiene TRACKER, not a real security system. Alex is never allowed to see, \
enter, or store actual passwords, account credentials, or 2FA codes, and cannot log into Shane's accounts to \
check on them. So you don't do real password audits or live account monitoring — you help Shane keep a \
checklist of hygiene tasks (e.g. "rotate email password", "review app permissions on X", "check for unrecognized \
devices on Y", "enable 2FA on Z") with due/recurrence tracking, and remind him what's overdue. If Shane asks for \
something that requires actually touching a credential or logging into an account, say plainly that's something \
he needs to do himself — don't attempt it.

Notes on the data:
- Each checklist item has: item_name, category ('password_hygiene', '2fa', 'device', 'data_privacy', or \
'other'), status ('ok', 'needs_attention', or 'overdue'), last_checked_at, recurrence_days (how often it should \
be redone, if recurring), and notes.
- When Shane says he's done a task, mark it 'ok' and set last_checked_at to now.
- get_overdue_items should be used whenever Shane asks for a security summary/checkup — it's status = \
'needs_attention' or 'overdue', or items whose last_checked_at + recurrence_days has passed.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete details (item names, statuses, dates) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'add_checklist_item',
    description: 'Add a new security/privacy hygiene item to track.',
    input_schema: {
      type: 'object',
      properties: {
        item_name: { type: 'string' },
        category: { type: 'string', enum: ['password_hygiene', '2fa', 'device', 'data_privacy', 'other'] },
        status: { type: 'string', enum: ['ok', 'needs_attention', 'overdue'] },
        recurrence_days: { type: 'integer', description: 'How often this should be redone, in days, if recurring' },
        notes: { type: 'string' },
      },
      required: ['item_name'],
    },
  },
  {
    name: 'mark_checked',
    description: "Mark a checklist item as done/checked now — sets status to 'ok' and last_checked_at to now. Matches by item_name.",
    input_schema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Name to match' },
        notes: { type: 'string' },
      },
      required: ['item_name'],
    },
  },
  {
    name: 'update_checklist_item',
    description: "Update a checklist item's status, category, recurrence, or notes. Matches by item_name.",
    input_schema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Name to match' },
        status: { type: 'string', enum: ['ok', 'needs_attention', 'overdue'] },
        category: { type: 'string', enum: ['password_hygiene', '2fa', 'device', 'data_privacy', 'other'] },
        recurrence_days: { type: 'integer' },
        notes: { type: 'string' },
      },
      required: ['item_name'],
    },
  },
  {
    name: 'list_checklist_items',
    description: "List Shane's security checklist items. Optionally filter by status or category.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'needs_attention', 'overdue'] },
        category: { type: 'string', enum: ['password_hygiene', '2fa', 'device', 'data_privacy', 'other'] },
        limit: { type: 'integer', description: 'How many to return, default 30' },
      },
    },
  },
  {
    name: 'get_overdue_items',
    description: "Return items needing attention: status is 'needs_attention'/'overdue', or a recurring item whose recurrence window has passed.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

async function findItemByName(item_name) {
  const { data, error } = await supabase
    .from('security_checklist')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .ilike('item_name', item_name)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function addChecklistItem({ item_name, category, status, recurrence_days, notes }) {
  const row = { user_id: DEFAULT_USER_ID, item_name };
  if (category !== undefined) row.category = category;
  if (status !== undefined) row.status = status;
  if (recurrence_days !== undefined) row.recurrence_days = recurrence_days;
  if (notes !== undefined) row.notes = notes;

  const { data, error } = await supabase.from('security_checklist').insert(row).select().single();
  if (error) throw error;
  return { ok: true, item: data };
}

async function markChecked({ item_name, notes }) {
  const existing = await findItemByName(item_name);
  if (!existing) return { ok: false, error: `No checklist item found named '${item_name}'` };

  const updates = { status: 'ok', last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await supabase.from('security_checklist').update(updates).eq('id', existing.id).select().single();
  if (error) throw error;
  return { ok: true, item: data };
}

async function updateChecklistItem({ item_name, status, category, recurrence_days, notes }) {
  const existing = await findItemByName(item_name);
  if (!existing) return { ok: false, error: `No checklist item found named '${item_name}'` };

  const updates = { updated_at: new Date().toISOString() };
  if (status !== undefined) updates.status = status;
  if (category !== undefined) updates.category = category;
  if (recurrence_days !== undefined) updates.recurrence_days = recurrence_days;
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await supabase.from('security_checklist').update(updates).eq('id', existing.id).select().single();
  if (error) throw error;
  return { ok: true, item: data };
}

async function listChecklistItems({ status, category, limit }) {
  const n = limit ?? 30;
  let q = supabase
    .from('security_checklist')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('created_at', { ascending: false })
    .limit(n);
  if (status) q = q.eq('status', status);
  if (category) q = q.eq('category', category);
  const { data, error } = await q;
  if (error) throw error;
  return { ok: true, items: data };
}

async function getOverdueItems() {
  const { data, error } = await supabase
    .from('security_checklist')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('last_checked_at', { ascending: true, nullsFirst: true });
  if (error) throw error;

  const now = Date.now();
  const overdue = (data ?? []).filter((item) => {
    if (item.status === 'needs_attention' || item.status === 'overdue') return true;
    if (item.recurrence_days && item.last_checked_at) {
      const dueAt = new Date(item.last_checked_at).getTime() + item.recurrence_days * 24 * 60 * 60 * 1000;
      return now >= dueAt;
    }
    return false;
  });

  return { ok: true, overdue_items: overdue };
}

async function runSecurityTool(name, input) {
  switch (name) {
    case 'add_checklist_item':
      return addChecklistItem(input);
    case 'mark_checked':
      return markChecked(input);
    case 'update_checklist_item':
      return updateChecklistItem(input);
    case 'list_checklist_items':
      return listChecklistItems(input);
    case 'get_overdue_items':
      return getOverdueItems();
    default:
      throw new Error(`Unknown Security & Privacy Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runSecurityAgent(request) {
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
        const result = await runSecurityTool(use.name, use.input);
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

  return finalText || "Security & Privacy Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
