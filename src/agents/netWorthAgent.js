import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';
import { alertToolDefs, setAlertRule, listAlertRules, deactivateAlertRule, evaluateRules, pushAlertNotifications } from '../alerts.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Net Worth Tracker Agent, a specialist sub-agent that Alex (Shane Pinho's \
Chief of Staff) delegates net-worth requests to. You have real tools backed by Shane's LifeOS dashboard — use \
them, don't guess or make up numbers.

Your job: keep track of Shane's net worth over time (assets only — investments + cash — no debts/liabilities \
tracked yet, that was explicitly scoped out for now) and report on how it's trending.

Notes on the data:
- "net_worth" is a live database VIEW, not a stored table — it's always computed on the fly from \
portfolio_summary.current_value (investments) plus the sum of accounts.balance (cash), so it never needs to \
be written to and is never stale. This is assets-only — there is no debt/liability figure anywhere in this \
system yet, so never imply net worth accounts for debt.
- The "net_worth_history" table is the only thing that actually gets written — it's append-only, one row per \
user per calendar day (log_net_worth_snapshot upserts by day, so calling it more than once on the same day \
just updates that day's row rather than creating duplicates). This history table is what makes \
month-over-month trend reporting and "long-term progress" actually possible, which the live net_worth view \
alone could never do since it has no memory of the past.
- Use log_net_worth_snapshot whenever Shane asks you to record/archive his net worth right now (needed \
before trend comparisons will have anything to compare against).
- Use get_net_worth_history for a list of past snapshots (e.g. "show my net worth over the last few months").
- Use get_net_worth_trend for change-over-time questions ("how is my net worth trending", "am I making \
progress", "how much did I grow this quarter") — it compares the latest snapshot against one from roughly N \
months back and reports both dollar and percent change for investments, cash, and total net worth.

Alert rules (set_alert_rule, list_alert_rules, deactivate_alert_rule, check_alert_rules): Shane can define \
his own floor thresholds — 'net_worth_floor' or 'cash_floor' — and check_alert_rules will tell him plainly \
when the live figure drops below it and push a notice to his dashboard. Shane picks the number; you just \
watch for it and report facts, never advice about what to do if it's breached.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Always include concrete dollar figures and percentages rather than vague summaries.`;

const toolDefs = [
  {
    name: 'log_net_worth_snapshot',
    description:
      "Recompute Shane's current net worth from live data (portfolio_summary for investments, sum of " +
      'accounts.balance for cash) and record it — updates the current net_worth row and upserts today\'s ' +
      "row in net_worth_history (calling this again same-day just updates today's snapshot, no duplicates). " +
      "Use this for any 'what's my net worth' / 'update my net worth' request.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_current_net_worth',
    description:
      "Read Shane's current net worth snapshot without recomputing it (fast path — use log_net_worth_snapshot " +
      'instead if you need it freshly recalculated from live account/portfolio data).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_net_worth_history',
    description: "List Shane's past net worth snapshots, most recent first.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many snapshots to return, default 12' },
      },
    },
  },
  {
    name: 'get_net_worth_trend',
    description:
      "Compare Shane's latest net worth snapshot against one from roughly N months ago and report dollar " +
      'and percent change for investments, cash, and total net worth. Use this for progress/trend questions.',
    input_schema: {
      type: 'object',
      properties: {
        months: { type: 'integer', description: 'How many months back to compare against, default 1' },
      },
    },
  },
  ...alertToolDefs(['net_worth_floor', 'cash_floor']),
];

// "net_worth" is a live view (investments from portfolio_summary, cash from accounts) — read from it
// directly rather than recomputing by hand, so this always matches exactly what the view would return.
async function getCurrentFiguresFromView() {
  const { data, error } = await supabase
    .from('net_worth')
    .select('investments,cash,net_worth')
    .eq('user_id', DEFAULT_USER_ID)
    .maybeSingle();
  if (error) throw error;
  return {
    investments: Number(data?.investments ?? 0),
    cash: Number(data?.cash ?? 0),
    net_worth: Number(data?.net_worth ?? 0),
  };
}

async function logNetWorthSnapshot() {
  const figures = await getCurrentFiguresFromView();
  const today = new Date().toISOString().slice(0, 10);

  const { data: historyRow, error: historyError } = await supabase
    .from('net_worth_history')
    .upsert(
      { user_id: DEFAULT_USER_ID, snapshot_date: today, ...figures },
      { onConflict: 'user_id,snapshot_date' }
    )
    .select()
    .single();
  if (historyError) throw historyError;

  return { ok: true, snapshot: historyRow };
}

async function getCurrentNetWorth() {
  const { data, error } = await supabase
    .from('net_worth')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return { ok: true, note: 'No net worth snapshot recorded yet — call log_net_worth_snapshot first.' };
  }
  return { ok: true, net_worth: data };
}

async function getNetWorthHistory({ limit }) {
  const n = limit ?? 12;
  const { data, error } = await supabase
    .from('net_worth_history')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('snapshot_date', { ascending: false })
    .limit(n);
  if (error) throw error;
  return { ok: true, history: data };
}

function pctChange(from, to) {
  if (!from) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

async function getNetWorthTrend({ months }) {
  const n = months ?? 1;

  const { data: latest, error: latestError } = await supabase
    .from('net_worth_history')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw latestError;
  if (!latest) {
    return {
      ok: true,
      note: 'No net worth history yet — call log_net_worth_snapshot at least once (ideally on separate ' +
        'days) before trend comparisons are possible.',
    };
  }

  const cutoff = new Date(latest.snapshot_date);
  cutoff.setMonth(cutoff.getMonth() - n);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Closest snapshot on or before the cutoff date (falls back to the earliest snapshot if history
  // doesn't go back that far yet).
  const { data: past, error: pastError } = await supabase
    .from('net_worth_history')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .lte('snapshot_date', cutoffStr)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pastError) throw pastError;

  if (!past || past.snapshot_date === latest.snapshot_date) {
    return {
      ok: true,
      latest,
      note: `Not enough history yet to compare ${n} month(s) back — only have data starting ` +
        `${latest.snapshot_date}. Showing the latest snapshot only.`,
    };
  }

  return {
    ok: true,
    from: past,
    to: latest,
    change: {
      investments_dollar: latest.investments - past.investments,
      investments_pct: pctChange(past.investments, latest.investments),
      cash_dollar: latest.cash - past.cash,
      cash_pct: pctChange(past.cash, latest.cash),
      net_worth_dollar: latest.net_worth - past.net_worth,
      net_worth_pct: pctChange(past.net_worth, latest.net_worth),
    },
  };
}

async function checkAlertRules() {
  const figures = await getCurrentFiguresFromView();
  const breaches = await evaluateRules('net_worth', {
    net_worth_floor: figures.net_worth,
    cash_floor: figures.cash,
  });
  const { pushed } = await pushAlertNotifications('net_worth_agent', breaches);

  return {
    ok: true,
    breaches_found: breaches.length,
    notifications_pushed: pushed,
    breaches: breaches.map((b) => ({
      metric: b.rule.metric,
      threshold: b.rule.threshold,
      current_value: b.current_value,
    })),
  };
}

async function runNetWorthTool(name, input) {
  switch (name) {
    case 'log_net_worth_snapshot':
      return logNetWorthSnapshot();
    case 'get_current_net_worth':
      return getCurrentNetWorth();
    case 'get_net_worth_history':
      return getNetWorthHistory(input);
    case 'get_net_worth_trend':
      return getNetWorthTrend(input);
    case 'set_alert_rule':
      return setAlertRule({ agent: 'net_worth', ...input });
    case 'list_alert_rules':
      return listAlertRules({ agent: 'net_worth' });
    case 'deactivate_alert_rule':
      return deactivateAlertRule(input);
    case 'check_alert_rules':
      return checkAlertRules();
    default:
      throw new Error(`Unknown Net Worth Tracker Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runNetWorthAgent(request) {
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
        const result = await runNetWorthTool(use.name, use.input);
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

  return finalText || "Net Worth Tracker Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
