import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';
import { alertToolDefs, setAlertRule, listAlertRules, deactivateAlertRule, evaluateRules, pushAlertNotifications } from '../alerts.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Credit Score Monitoring Agent, a specialist sub-agent that Alex (Shane \
Pinho's Chief of Staff) delegates credit-score requests to. You have real tools backed by Shane's LifeOS \
dashboard "credit_score_history" table — use them, don't guess or make up numbers.

Your job: keep a record of Shane's credit score over time and report on how it's trending. There is no live \
credit bureau integration yet — Shane tells you a score he's checked (e.g. from his bank app or a bureau \
site) and you record it. Never estimate or guess a score he hasn't given you.

Notes on the data:
- "credit_score_history" is append-only, one row per user per calendar day (log_credit_score_snapshot upserts \
by day, so calling it more than once on the same day just updates that day's row rather than creating \
duplicates).
- bureau is optional free text (e.g. 'Experian', 'Equifax', 'TransUnion', 'Credit Karma estimate') — record it \
if Shane mentions where the score came from, but don't require it.
- Use log_credit_score_snapshot whenever Shane tells you a score to record.
- Use get_credit_score_history for a list of past snapshots.
- Use get_credit_score_trend for change-over-time questions — it compares the latest snapshot against one \
from roughly N months back and reports the point change.

Alert rules (set_alert_rule, list_alert_rules, deactivate_alert_rule, check_alert_rules): Shane can define his \
own 'credit_score_floor' — the score he doesn't want to drop below — and check_alert_rules will tell him \
plainly when the latest recorded score is below it and push a notice to his dashboard. Shane picks the \
number; you just watch for it and report facts, never advice about how to raise his score.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Always include concrete numbers (score, point change) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'log_credit_score_snapshot',
    description:
      "Record a credit score Shane reports, for today's date (upserts today's row in credit_score_history — " +
      "calling this again same-day just updates today's snapshot, no duplicates). Use this for any 'my score " +
      "is X' / 'record my credit score' request.",
    input_schema: {
      type: 'object',
      properties: {
        score: { type: 'integer', description: 'Credit score Shane reported' },
        bureau: { type: 'string', description: "Optional source, e.g. 'Experian', 'Credit Karma estimate'" },
        notes: { type: 'string' },
      },
      required: ['score'],
    },
  },
  {
    name: 'get_current_credit_score',
    description: "Get Shane's most recently recorded credit score snapshot.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_credit_score_history',
    description: "List Shane's past credit score snapshots, most recent first.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many snapshots to return, default 12' },
      },
    },
  },
  {
    name: 'get_credit_score_trend',
    description:
      "Compare Shane's latest credit score snapshot against one from roughly N months ago and report the " +
      'point change. Use this for progress/trend questions.',
    input_schema: {
      type: 'object',
      properties: {
        months: { type: 'integer', description: 'How many months back to compare against, default 1' },
      },
    },
  },
  ...alertToolDefs(['credit_score_floor']),
];

async function logCreditScoreSnapshot({ score, bureau, notes }) {
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('credit_score_history')
    .upsert(
      {
        user_id: DEFAULT_USER_ID,
        snapshot_date: today,
        score,
        bureau: bureau ?? null,
        notes: notes ?? null,
      },
      { onConflict: 'user_id,snapshot_date' }
    )
    .select()
    .single();
  if (error) throw error;
  return { ok: true, snapshot: data };
}

async function getCurrentCreditScore() {
  const { data, error } = await supabase
    .from('credit_score_history')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return { ok: true, note: 'No credit score recorded yet — call log_credit_score_snapshot first.' };
  }
  return { ok: true, snapshot: data };
}

async function getCreditScoreHistory({ limit }) {
  const n = limit ?? 12;
  const { data, error } = await supabase
    .from('credit_score_history')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('snapshot_date', { ascending: false })
    .limit(n);
  if (error) throw error;
  return { ok: true, history: data };
}

async function getCreditScoreTrend({ months }) {
  const n = months ?? 1;

  const { data: latest, error: latestError } = await supabase
    .from('credit_score_history')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw latestError;
  if (!latest) {
    return {
      ok: true,
      note: 'No credit score history yet — call log_credit_score_snapshot at least once (ideally on ' +
        'separate days) before trend comparisons are possible.',
    };
  }

  const cutoff = new Date(latest.snapshot_date);
  cutoff.setMonth(cutoff.getMonth() - n);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { data: past, error: pastError } = await supabase
    .from('credit_score_history')
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
      score_point_change: latest.score - past.score,
    },
  };
}

async function checkAlertRules() {
  const { data: latest, error } = await supabase
    .from('credit_score_history')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  const breaches = await evaluateRules('credit', { credit_score_floor: latest?.score ?? null });
  const { pushed } = await pushAlertNotifications('credit_score_agent', breaches);

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

async function runCreditScoreTool(name, input) {
  switch (name) {
    case 'log_credit_score_snapshot':
      return logCreditScoreSnapshot(input);
    case 'get_current_credit_score':
      return getCurrentCreditScore();
    case 'get_credit_score_history':
      return getCreditScoreHistory(input);
    case 'get_credit_score_trend':
      return getCreditScoreTrend(input);
    case 'set_alert_rule':
      return setAlertRule({ agent: 'credit', ...input });
    case 'list_alert_rules':
      return listAlertRules({ agent: 'credit' });
    case 'deactivate_alert_rule':
      return deactivateAlertRule(input);
    case 'check_alert_rules':
      return checkAlertRules();
    default:
      throw new Error(`Unknown Credit Score Monitoring Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runCreditScoreAgent(request) {
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
        const result = await runCreditScoreTool(use.name, use.input);
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

  return finalText || "Credit Score Monitoring Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
