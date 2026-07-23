import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';
import { alertToolDefs, setAlertRule, listAlertRules, deactivateAlertRule, evaluateRules, pushAlertNotifications } from '../alerts.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Subscription Monitoring Agent, a specialist sub-agent that Alex (Shane \
Pinho's Chief of Staff) delegates recurring-subscription requests to. You have real tools backed by Shane's \
LifeOS dashboard "subscriptions" table — use them, don't guess or make up numbers.

Your job: help Shane track his recurring subscriptions (streaming, software, memberships, etc.), what they \
cost, when they next charge, whether they're active/trial/cancelled, flag trials about to convert to paid, \
and total up what he's spending on subscriptions.

Notes on the data:
- "subscriptions" is one row per subscription, upserted by name via add_or_update_subscription (calling it \
again for the same name just updates that subscription's fields — so re-adding "Netflix" updates it rather \
than duplicating it).
- billing_cycle is 'weekly', 'monthly', or 'annual'. status is 'active', 'trial', or 'cancelled'.
- trial_end_date matters most for status='trial' — that's the date it converts to a paid subscription unless \
cancelled, so flag it clearly when asked about upcoming charges or trials.
- get_total_monthly_spend normalizes every active/trial subscription to a monthly-equivalent cost (annual ÷ \
12, weekly × ~4.33) so it's an apples-to-apples total, regardless of each one's individual billing_cycle.
- get_upcoming_charges looks at next_charge_date (and trial_end_date for trials) across active/trial \
subscriptions and ranks soonest-first.
- push_subscription_reminders pushes the soonest upcoming charges/trial-conversions into Shane's \
notifications table (same table Bill Pay and other agents use) so they surface on his dashboard — use this \
when Shane asks for a subscription check-in/summary or explicitly asks to push reminders.

Alert rules (set_alert_rule, list_alert_rules, deactivate_alert_rule, check_alert_rules): Shane can define his \
own 'monthly_spend_total' threshold — the total monthly-equivalent subscription spend he's willing to have — \
and check_alert_rules will tell him plainly when it's crossed and push a notice to his dashboard. Shane picks \
the number; you just watch for it and report facts, never advice about what to cancel.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Always include concrete numbers (amounts, dates) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'add_or_update_subscription',
    description:
      'Create or update a recurring subscription (upserts by subscription name). Use this to add a new ' +
      'subscription or change its amount, billing cycle, next charge date, status, or trial end date.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Subscription name, e.g. 'Netflix', 'ChatGPT Plus', 'Gym Membership'" },
        amount: { type: 'number', description: 'Charge amount in dollars per billing cycle' },
        billing_cycle: { type: 'string', enum: ['weekly', 'monthly', 'annual'], description: "Defaults to 'monthly'" },
        next_charge_date: { type: 'string', description: 'ISO date (YYYY-MM-DD) of the next charge' },
        category: { type: 'string', description: "e.g. 'streaming', 'software', 'fitness'" },
        status: { type: 'string', enum: ['active', 'trial', 'cancelled'], description: "Defaults to 'active'" },
        trial_end_date: { type: 'string', description: 'ISO date (YYYY-MM-DD) the trial converts to paid, if status is trial' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_subscriptions',
    description: "List all of Shane's tracked subscriptions with amount, billing cycle, next charge date, and status.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'trial', 'cancelled'], description: 'Optional — limit to one status' },
      },
    },
  },
  {
    name: 'cancel_subscription',
    description: "Mark a subscription as cancelled by name (sets status='cancelled').",
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Subscription name (must match an existing one)' } },
      required: ['name'],
    },
  },
  {
    name: 'get_upcoming_charges',
    description:
      'List active and trial subscriptions ranked by soonest next_charge_date (trials ranked by ' +
      'trial_end_date) — use this for "what am I about to be charged for" / trial-ending questions.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many to return, default 5' },
      },
    },
  },
  {
    name: 'get_total_monthly_spend',
    description:
      'Compute total monthly-equivalent spend across all active/trial subscriptions, normalizing annual and ' +
      'weekly cycles to a monthly figure.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'push_subscription_reminders',
    description:
      "Push the soonest upcoming charges/trial-conversions into Shane's notifications table so they surface " +
      'on his dashboard. Use this when Shane asks for a subscription check-in/summary or explicitly asks to ' +
      'push/send reminders.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many upcoming items to push, default 3' },
      },
    },
  },
  ...alertToolDefs(['monthly_spend_total']),
];

async function addOrUpdateSubscription({ name, amount, billing_cycle, next_charge_date, category, status, trial_end_date, notes }) {
  const update = { user_id: DEFAULT_USER_ID, name, updated_at: new Date().toISOString() };
  if (amount !== undefined) update.amount = amount;
  if (billing_cycle !== undefined) update.billing_cycle = billing_cycle;
  if (next_charge_date !== undefined) update.next_charge_date = next_charge_date;
  if (category !== undefined) update.category = category;
  if (status !== undefined) update.status = status;
  if (trial_end_date !== undefined) update.trial_end_date = trial_end_date;
  if (notes !== undefined) update.notes = notes;

  const { data, error } = await supabase
    .from('subscriptions')
    .upsert(update, { onConflict: 'user_id,name' })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, subscription: data };
}

async function listSubscriptions({ status }) {
  let query = supabase.from('subscriptions').select('*').eq('user_id', DEFAULT_USER_ID).order('name');
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, subscriptions: data };
}

async function cancelSubscription({ name }) {
  const { data, error } = await supabase
    .from('subscriptions')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('user_id', DEFAULT_USER_ID)
    .eq('name', name)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, error: `No subscription found named '${name}'.` };
  return { ok: true, subscription: data };
}

async function fetchActiveOrTrialSubscriptions() {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .in('status', ['active', 'trial']);
  if (error) throw error;
  return data ?? [];
}

async function getUpcomingCharges({ limit }) {
  const n = limit ?? 5;
  const subs = await fetchActiveOrTrialSubscriptions();

  const ranked = subs
    .map((s) => ({
      name: s.name,
      status: s.status,
      amount: s.amount,
      billing_cycle: s.billing_cycle,
      relevant_date: s.status === 'trial' ? s.trial_end_date : s.next_charge_date,
    }))
    .filter((s) => s.relevant_date)
    .sort((a, b) => a.relevant_date.localeCompare(b.relevant_date));

  return { ok: true, upcoming: ranked.slice(0, n) };
}

// Normalizes an amount to a monthly-equivalent figure regardless of billing_cycle.
function monthlyEquivalent(amount, billingCycle) {
  const amt = Number(amount ?? 0);
  if (billingCycle === 'annual') return amt / 12;
  if (billingCycle === 'weekly') return amt * (52 / 12);
  return amt; // monthly, or unknown defaults to as-is
}

async function getTotalMonthlySpend() {
  const subs = await fetchActiveOrTrialSubscriptions();
  const breakdown = subs.map((s) => ({
    name: s.name,
    status: s.status,
    amount: s.amount,
    billing_cycle: s.billing_cycle,
    monthly_equivalent: Number(monthlyEquivalent(s.amount, s.billing_cycle).toFixed(2)),
  }));
  const total = Number(breakdown.reduce((sum, s) => sum + s.monthly_equivalent, 0).toFixed(2));
  return { ok: true, total_monthly_spend: total, breakdown };
}

async function pushSubscriptionReminders({ limit }) {
  const { upcoming } = await getUpcomingCharges({ limit });

  if (upcoming.length === 0) {
    return { ok: true, pushed: 0, note: 'No upcoming charges or trial conversions to push.' };
  }

  const rows = upcoming.map((s) => ({
    source_agent: 'subscription_agent',
    urgency: 'low',
    title: s.status === 'trial'
      ? `${s.name} trial converts to paid on ${s.relevant_date}`
      : `${s.name} charges ${s.amount ? `$${s.amount}` : ''} on ${s.relevant_date}`,
    body: `Billing cycle: ${s.billing_cycle}. Status: ${s.status}.`,
  }));

  const { data, error } = await supabase.from('notifications').insert(rows).select();
  if (error) throw error;
  return { ok: true, pushed: data.length, notifications: data };
}

async function checkAlertRules() {
  const { total_monthly_spend } = await getTotalMonthlySpend();
  const breaches = await evaluateRules('subscription', { monthly_spend_total: total_monthly_spend });
  const { pushed } = await pushAlertNotifications('subscription_agent', breaches);

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

async function runSubscriptionTool(name, input) {
  switch (name) {
    case 'add_or_update_subscription':
      return addOrUpdateSubscription(input);
    case 'list_subscriptions':
      return listSubscriptions(input);
    case 'cancel_subscription':
      return cancelSubscription(input);
    case 'get_upcoming_charges':
      return getUpcomingCharges(input);
    case 'get_total_monthly_spend':
      return getTotalMonthlySpend();
    case 'push_subscription_reminders':
      return pushSubscriptionReminders(input);
    case 'set_alert_rule':
      return setAlertRule({ agent: 'subscription', ...input });
    case 'list_alert_rules':
      return listAlertRules({ agent: 'subscription' });
    case 'deactivate_alert_rule':
      return deactivateAlertRule(input);
    case 'check_alert_rules':
      return checkAlertRules();
    default:
      throw new Error(`Unknown Subscription Monitoring Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runSubscriptionAgent(request) {
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
        const result = await runSubscriptionTool(use.name, use.input);
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

  return finalText || "Subscription Monitoring Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
