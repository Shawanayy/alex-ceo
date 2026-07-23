import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';

const SYSTEM_PROMPT = `You are the Notification Manager, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates notification triage to. You have real tools backed by Shane's LifeOS dashboard "notifications" \
table — use them, don't guess.

Context: every specialist agent (Bill Pay, alerts on Investment/Net Worth/Budgeting, etc.) can write rows into \
this shared "notifications" table when something needs Shane's attention. Separately, a background process \
(not you) periodically scans this table and proactively pushes undelivered 'high' and 'medium' urgency \
notifications to Shane's Telegram, then marks them delivered — that push loop runs on its own schedule outside \
of any conversation. Your job is the on-demand side: when Shane or Alex asks what's pending, what's urgent, or \
wants to review/clear notifications, you query and manage this table directly.

Notes on the data:
- Each notification has: source_agent (which agent created it), urgency ('high', 'medium', or 'low' — this is \
the existing app-wide vocabulary, keep using it), title, body, delivered (boolean), delivered_at.
- 'high' = needs attention very soon / time-sensitive. 'medium' = worth surfacing soon but not urgent. 'low' = \
informational, fine to batch or review later — the background push loop does not interrupt Shane for 'low'.
- When Shane says he's seen/handled something, mark it delivered so it doesn't get pushed or listed as pending \
again.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete details (titles, urgency, source) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'list_notifications',
    description: 'List notifications, most recent first. Optionally filter by delivered status and/or urgency.',
    input_schema: {
      type: 'object',
      properties: {
        delivered: { type: 'boolean' },
        urgency: { type: 'string', enum: ['high', 'medium', 'low'] },
        limit: { type: 'integer', description: 'How many to return, default 30' },
      },
    },
  },
  {
    name: 'get_pending_notifications',
    description: "Return all undelivered notifications, highest urgency first — use this for 'what's pending / what needs my attention' requests.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_notification',
    description: 'Create a new notification manually (e.g. Shane asks to be reminded/flagged about something outside an existing specialist workflow).',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        urgency: { type: 'string', enum: ['high', 'medium', 'low'] },
        source_agent: { type: 'string', description: "Defaults to 'notification_manager' if omitted" },
      },
      required: ['title'],
    },
  },
  {
    name: 'mark_delivered',
    description: 'Mark a notification as delivered/handled. Matches the most recent undelivered notification by title.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title to match' },
      },
      required: ['title'],
    },
  },
];

const urgencyRank = { high: 0, medium: 1, low: 2 };

async function listNotifications({ delivered, urgency, limit }) {
  const n = limit ?? 30;
  let q = supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(n);
  if (delivered !== undefined) q = q.eq('delivered', delivered);
  if (urgency) q = q.eq('urgency', urgency);
  const { data, error } = await q;
  if (error) throw error;
  return { ok: true, notifications: data };
}

async function getPendingNotifications() {
  const { data, error } = await supabase.from('notifications').select('*').eq('delivered', false);
  if (error) throw error;
  const sorted = (data ?? []).sort((a, b) => (urgencyRank[a.urgency] ?? 3) - (urgencyRank[b.urgency] ?? 3));
  return { ok: true, pending_notifications: sorted };
}

async function createNotification({ title, body, urgency, source_agent }) {
  const row = {
    title,
    body: body ?? null,
    urgency: urgency ?? 'medium',
    source_agent: source_agent ?? 'notification_manager',
  };
  const { data, error } = await supabase.from('notifications').insert(row).select().single();
  if (error) throw error;
  return { ok: true, notification: data };
}

async function markDelivered({ title }) {
  const { data: matches, error: findErr } = await supabase
    .from('notifications')
    .select('*')
    .eq('delivered', false)
    .ilike('title', `%${title}%`)
    .order('created_at', { ascending: false });
  if (findErr) throw findErr;
  if (!matches || matches.length === 0) return { ok: false, error: `No undelivered notification found matching '${title}'` };

  const target = matches[0];
  const { data, error } = await supabase
    .from('notifications')
    .update({ delivered: true, delivered_at: new Date().toISOString() })
    .eq('id', target.id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, notification: data };
}

async function runNotificationTool(name, input) {
  switch (name) {
    case 'list_notifications':
      return listNotifications(input);
    case 'get_pending_notifications':
      return getPendingNotifications();
    case 'create_notification':
      return createNotification(input);
    case 'mark_delivered':
      return markDelivered(input);
    default:
      throw new Error(`Unknown Notification Manager tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runNotificationAgent(request) {
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
        const result = await runNotificationTool(use.name, use.input);
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

  return finalText || "Notification Manager got stuck and didn't produce a final answer — try rephrasing the request.";
}
