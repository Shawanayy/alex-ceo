import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Automation Agent, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates automation and repetitive-task requests to. You have real tools backed by Shane's LifeOS \
dashboard "automation_rules" table — use them, don't guess.

Be upfront about scope: Alex cannot sign Shane up for new third-party services, install software, or connect \
new apps/accounts on his behalf. What you actually do is (1) track automation ideas and "if this then that" \
rules as a structured backlog/wishlist, and (2) for rules Shane marks 'active' with a schedule-based trigger, \
have the app itself evaluate them on a recurring background pass and act via 'action_description' (e.g. pushing \
a reminder notification) — you are the rule-tracking layer, not a live app-integration platform.

Notes on the data:
- Each rule has: name, trigger_type ('schedule' — runs on a recurring cadence described in trigger_config, \
'event' — fires when something happens elsewhere in the app, described in trigger_config, or 'manual' — Shane \
runs it himself on request), trigger_config (free-form jsonb describing the trigger, e.g. \
{"cadence": "daily", "time": "08:00"} or {"on": "bill overdue"}), action_description (plain text describing what \
should happen when it fires), and status ('backlog' — idea not yet active, 'paused', or 'active').
- New rules default to 'backlog' unless Shane clearly wants it running now — don't set 'active' unless he says so \
or clearly implies it ("turn this on", "start doing this automatically").
- trigger_config should be a plain object capturing whatever timing/condition details Shane gives you — don't \
overthink the shape, just capture what's needed to describe the trigger clearly.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete details (names, statuses, triggers) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'create_automation_rule',
    description: 'Add a new automation rule or backlog idea.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        trigger_type: { type: 'string', enum: ['schedule', 'event', 'manual'] },
        trigger_config: { type: 'object', description: 'Free-form details of the trigger (cadence/time, or the event it fires on)' },
        action_description: { type: 'string', description: 'What should happen when this rule fires' },
        status: { type: 'string', enum: ['active', 'paused', 'backlog'] },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_automation_rule',
    description: "Update a rule's status, trigger, or action. Matches the most recent rule by name.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to match' },
        status: { type: 'string', enum: ['active', 'paused', 'backlog'] },
        trigger_type: { type: 'string', enum: ['schedule', 'event', 'manual'] },
        trigger_config: { type: 'object' },
        action_description: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_automation_rules',
    description: "List Shane's automation rules, most recently created first. Optionally filter by status.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'paused', 'backlog'] },
        limit: { type: 'integer', description: 'How many to return, default 30' },
      },
    },
  },
];

async function findRuleByName(name) {
  const { data, error } = await supabase
    .from('automation_rules')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .ilike('name', name)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createAutomationRule({ name, trigger_type, trigger_config, action_description, status }) {
  const row = { user_id: DEFAULT_USER_ID, name };
  if (trigger_type !== undefined) row.trigger_type = trigger_type;
  if (trigger_config !== undefined) row.trigger_config = trigger_config;
  if (action_description !== undefined) row.action_description = action_description;
  if (status !== undefined) row.status = status;

  const { data, error } = await supabase.from('automation_rules').insert(row).select().single();
  if (error) throw error;
  return { ok: true, rule: data };
}

async function updateAutomationRule({ name, status, trigger_type, trigger_config, action_description }) {
  const existing = await findRuleByName(name);
  if (!existing) return { ok: false, error: `No automation rule found named '${name}'` };

  const updates = { updated_at: new Date().toISOString() };
  if (status !== undefined) updates.status = status;
  if (trigger_type !== undefined) updates.trigger_type = trigger_type;
  if (trigger_config !== undefined) updates.trigger_config = trigger_config;
  if (action_description !== undefined) updates.action_description = action_description;

  const { data, error } = await supabase.from('automation_rules').update(updates).eq('id', existing.id).select().single();
  if (error) throw error;
  return { ok: true, rule: data };
}

async function listAutomationRules({ status, limit }) {
  const n = limit ?? 30;
  let q = supabase
    .from('automation_rules')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('created_at', { ascending: false })
    .limit(n);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return { ok: true, rules: data };
}

async function runAutomationTool(name, input) {
  switch (name) {
    case 'create_automation_rule':
      return createAutomationRule(input);
    case 'update_automation_rule':
      return updateAutomationRule(input);
    case 'list_automation_rules':
      return listAutomationRules(input);
    default:
      throw new Error(`Unknown Automation Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runAutomationAgent(request) {
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
        const result = await runAutomationTool(use.name, use.input);
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

  return finalText || "Automation Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
