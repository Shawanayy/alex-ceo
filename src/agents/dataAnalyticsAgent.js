import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Data Analytics Agent, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates cross-department trend and insight requests to. You are READ-ONLY over Shane's finance, health, \
and productivity data (you never modify those tables) — the one thing you write is summary metrics into the \
"kpis" table, for tracking a number over time.

Your job: pull real numbers from across departments and turn them into clear trends and insights — never guess \
or estimate a number you could instead query.

Notes on the data:
- get_finance_snapshot pulls account balances, latest net worth snapshot, and portfolio summary.
- get_health_snapshot pulls recent workout completion, average sleep, and average mood/stress over a lookback \
window (default 30 days).
- get_productivity_snapshot pulls todo completion rate and goal progress.
- log_kpi saves a single computed metric into the "kpis" table (department, metric_name, metric_value, \
metric_unit, period — e.g. period '2026-07' for a monthly figure) — use this when Shane asks you to track \
something over time, or after computing a snapshot worth remembering for later comparison.
- list_kpis reads back previously logged kpis to show trend over time — use this before claiming something is \
"trending up/down" so the comparison is against real logged history, not assumption.
- If a relevant table is empty, say so plainly rather than fabricating a number ("no workouts logged yet" is a \
valid, useful answer).

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Lead with the concrete numbers, then the interpretation.`;

const toolDefs = [
  {
    name: 'get_finance_snapshot',
    description: 'Pull current account balances, latest net worth snapshot, and portfolio summary.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_health_snapshot',
    description: 'Pull recent workout completion, average sleep, and average mood/stress over a lookback window.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Lookback window in days, default 30' },
      },
    },
  },
  {
    name: 'get_productivity_snapshot',
    description: 'Pull todo completion rate and goal progress.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'log_kpi',
    description: 'Save a computed metric into the kpis table for tracking over time.',
    input_schema: {
      type: 'object',
      properties: {
        department: { type: 'string', description: "e.g. 'finance', 'health', 'productivity'" },
        metric_name: { type: 'string', description: "e.g. 'net_worth', 'avg_sleep_hours', 'todo_completion_rate'" },
        metric_value: { type: 'number' },
        metric_unit: { type: 'string', description: "e.g. 'usd', 'hours', 'percent'" },
        period: { type: 'string', description: "e.g. '2026-07' for monthly, '2026-07-23' for daily" },
      },
      required: ['department', 'metric_name', 'metric_value'],
    },
  },
  {
    name: 'list_kpis',
    description: 'List previously logged kpis to show trend over time. Optionally filter by department and/or metric_name.',
    input_schema: {
      type: 'object',
      properties: {
        department: { type: 'string' },
        metric_name: { type: 'string' },
        limit: { type: 'integer', description: 'How many to return, default 30' },
      },
    },
  },
];

async function getFinanceSnapshot() {
  const [{ data: accounts, error: accErr }, { data: netWorth, error: nwErr }, { data: portfolio, error: pfErr }] = await Promise.all([
    supabase.from('accounts').select('name, type, balance').eq('user_id', DEFAULT_USER_ID),
    supabase.from('net_worth_history').select('*').eq('user_id', DEFAULT_USER_ID).order('snapshot_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('portfolio_summary').select('*').eq('user_id', DEFAULT_USER_ID).maybeSingle(),
  ]);
  if (accErr) throw accErr;
  if (nwErr) throw nwErr;
  if (pfErr) throw pfErr;

  return { ok: true, accounts: accounts ?? [], latest_net_worth: netWorth ?? null, portfolio_summary: portfolio ?? null };
}

async function getHealthSnapshot({ days }) {
  const lookbackDays = days ?? 30;
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [{ data: workouts, error: wErr }, { data: sleep, error: sErr }, { data: mood, error: mErr }] = await Promise.all([
    supabase.from('workouts').select('date, completed, workout_type').eq('user_id', DEFAULT_USER_ID).gte('date', since),
    supabase.from('sleep_logs').select('date, hours_slept, quality').eq('user_id', DEFAULT_USER_ID).gte('date', since),
    supabase.from('mood_logs').select('date, mood, stress').eq('user_id', DEFAULT_USER_ID).gte('date', since),
  ]);
  if (wErr) throw wErr;
  if (sErr) throw sErr;
  if (mErr) throw mErr;

  const avg = (arr, key) => (arr.length ? arr.reduce((sum, r) => sum + (r[key] ?? 0), 0) / arr.length : null);

  return {
    ok: true,
    window_days: lookbackDays,
    workouts_logged: workouts.length,
    workouts_completed: workouts.filter((w) => w.completed).length,
    avg_sleep_hours: avg(sleep, 'hours_slept'),
    avg_sleep_quality: avg(sleep, 'quality'),
    avg_mood: avg(mood, 'mood'),
    avg_stress: avg(mood, 'stress'),
  };
}

async function getProductivitySnapshot() {
  const [{ data: todos, error: tErr }, { data: goals, error: gErr }] = await Promise.all([
    supabase.from('todos').select('completed').eq('user_id', DEFAULT_USER_ID),
    supabase.from('goals').select('title, goal_type, target_value, current_value, unit, completed').eq('user_id', DEFAULT_USER_ID),
  ]);
  if (tErr) throw tErr;
  if (gErr) throw gErr;

  const completedTodos = todos.filter((t) => t.completed).length;
  const completionRate = todos.length ? completedTodos / todos.length : null;

  return {
    ok: true,
    todos_total: todos.length,
    todos_completed: completedTodos,
    todo_completion_rate: completionRate,
    goals: goals.map((g) => ({
      title: g.title,
      goal_type: g.goal_type,
      progress: g.target_value ? `${g.current_value ?? 0}/${g.target_value} ${g.unit ?? ''}`.trim() : null,
      completed: g.completed,
    })),
  };
}

async function logKpi({ department, metric_name, metric_value, metric_unit, period }) {
  const row = { department, metric_name, metric_value };
  if (metric_unit !== undefined) row.metric_unit = metric_unit;
  if (period !== undefined) row.period = period;

  const { data, error } = await supabase.from('kpis').insert(row).select().single();
  if (error) throw error;
  return { ok: true, kpi: data };
}

async function listKpis({ department, metric_name, limit }) {
  const n = limit ?? 30;
  let q = supabase.from('kpis').select('*').order('created_at', { ascending: false }).limit(n);
  if (department) q = q.eq('department', department);
  if (metric_name) q = q.eq('metric_name', metric_name);
  const { data, error } = await q;
  if (error) throw error;
  return { ok: true, kpis: data };
}

async function runDataAnalyticsTool(name, input) {
  switch (name) {
    case 'get_finance_snapshot':
      return getFinanceSnapshot();
    case 'get_health_snapshot':
      return getHealthSnapshot(input);
    case 'get_productivity_snapshot':
      return getProductivitySnapshot();
    case 'log_kpi':
      return logKpi(input);
    case 'list_kpis':
      return listKpis(input);
    default:
      throw new Error(`Unknown Data Analytics Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runDataAnalyticsAgent(request) {
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
        const result = await runDataAnalyticsTool(use.name, use.input);
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

  return finalText || "Data Analytics Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
