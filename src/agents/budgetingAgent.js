import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';
import { alertToolDefs, setAlertRule, listAlertRules, deactivateAlertRule, evaluateRules, pushAlertNotifications } from '../alerts.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Budgeting Agent, a specialist sub-agent that Alex (Shane Pinho's Chief \
of Staff) delegates spending-plan requests to. You have real tools backed by Shane's LifeOS dashboard \
tables (accounts, budgets, transactions) — use them, don't guess or make up numbers.

Your job: help Shane set/edit budgets by category, log expenses/income, compare actual spend against \
budget, and give a simple cash-flow forecast based on his current account balances and recent spending \
trend.

Notes on the data:
- "accounts" holds Shane's current balances per account (Checking, MMA, Roth IRA, Robinhood, etc.) — this \
is manually maintained today; a future Plaid sync will keep it current automatically, but don't assume \
that's live yet unless told otherwise.
- "transactions" is the single ledger for both manually logged expenses/income AND (eventually) \
Plaid-synced transactions. Always log expenses here via log_transaction so budget comparisons stay \
accurate.
- "budgets" is one row per category with a monthly_limit. set_budget upserts by category, so calling it \
again for the same category just updates the limit.

Alert rules (set_alert_rule, list_alert_rules, deactivate_alert_rule, check_alert_rules): Shane can define \
his own 'category_overrun_pct' threshold — how far over a budget category's limit he's willing to go before \
being flagged — either for one specific category (pass category) or generically across all categories \
(omit category). check_alert_rules computes each category's overrun % for the current month against \
compare_budget_vs_actual and pushes a plain factual notice to Shane's dashboard for any breach. Shane picks \
the number; you just watch for it and report facts, never advice about what to cut.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Always include concrete numbers (amounts, percentages, dollar remaining) rather than \
vague summaries.`;

const toolDefs = [
  {
    name: 'set_budget',
    description: 'Create or update the monthly budget limit for a spending category (upserts by category).',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: "Spending category, e.g. 'Groceries', 'Dining', 'Transport'" },
        monthly_limit: { type: 'number', description: 'Monthly budget limit in dollars' },
        period: { type: 'string', description: "Budget period, defaults to 'monthly'" },
      },
      required: ['category', 'monthly_limit'],
    },
  },
  {
    name: 'list_budgets',
    description: 'List all budget categories and their monthly limits.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'log_transaction',
    description:
      "Log an expense or income entry into Shane's transaction ledger. Use a negative amount for " +
      'expenses/spending and a positive amount for income/deposits.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Negative for expense/spend, positive for income' },
        category: { type: 'string', description: "e.g. 'Groceries', 'Dining', 'Income', 'Transport'" },
        description: { type: 'string', description: 'Merchant or short description' },
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD), defaults to today' },
        account: { type: 'string', description: "Account name it hit, e.g. 'Checking' (optional)" },
      },
      required: ['amount', 'category'],
    },
  },
  {
    name: 'compare_budget_vs_actual',
    description:
      "Compare actual spend this month (from transactions) against each category's budget limit. " +
      'Returns per-category spend, limit, and amount remaining/over.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional — limit to one category' },
      },
    },
  },
  {
    name: 'list_accounts',
    description: "List Shane's accounts and current balances.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'forecast_cash_flow',
    description:
      'Project cash flow forward using current total account balance plus the average net ' +
      '(income minus expense) from recent logged transactions.',
    input_schema: {
      type: 'object',
      properties: {
        months_ahead: { type: 'integer', description: 'How many months to project, default 3' },
        lookback_days: { type: 'integer', description: 'How many days of transaction history to average over, default 30' },
      },
    },
  },
  ...alertToolDefs(['category_overrun_pct']),
];

async function setBudget({ category, monthly_limit, period }) {
  const { data, error } = await supabase
    .from('budgets')
    .upsert(
      {
        user_id: DEFAULT_USER_ID,
        category,
        monthly_limit,
        period: period ?? 'monthly',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,category' }
    )
    .select()
    .single();
  if (error) throw error;
  return { ok: true, budget: data };
}

async function listBudgets() {
  const { data, error } = await supabase.from('budgets').select('*').order('category');
  if (error) throw error;
  return { ok: true, budgets: data };
}

async function logTransaction({ amount, category, description, date, account }) {
  const { data, error } = await supabase
    .from('transactions')
    .insert({
      user_id: DEFAULT_USER_ID,
      amount,
      category,
      description: description ?? null,
      date: date ?? new Date().toISOString().slice(0, 10),
      account: account ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, transaction: data };
}

function currentMonthRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function compareBudgetVsActual({ category }) {
  const { start, end } = currentMonthRange();

  let budgetQuery = supabase.from('budgets').select('*');
  if (category) budgetQuery = budgetQuery.eq('category', category);
  const { data: budgets, error: budgetErr } = await budgetQuery;
  if (budgetErr) throw budgetErr;

  let txQuery = supabase
    .from('transactions')
    .select('category, amount')
    .gte('date', start)
    .lt('date', end)
    .lt('amount', 0);
  if (category) txQuery = txQuery.eq('category', category);
  const { data: transactions, error: txErr } = await txQuery;
  if (txErr) throw txErr;

  const spendByCategory = {};
  for (const t of transactions ?? []) {
    spendByCategory[t.category] = (spendByCategory[t.category] ?? 0) + Math.abs(Number(t.amount));
  }

  const comparison = (budgets ?? []).map((b) => {
    const spent = spendByCategory[b.category] ?? 0;
    return {
      category: b.category,
      monthly_limit: Number(b.monthly_limit),
      spent_so_far: Number(spent.toFixed(2)),
      remaining: Number((Number(b.monthly_limit) - spent).toFixed(2)),
      over_budget: spent > Number(b.monthly_limit),
    };
  });

  return { ok: true, period: { start, end }, comparison };
}

async function listAccounts() {
  const { data, error } = await supabase.from('accounts').select('*').order('name');
  if (error) throw error;
  return { ok: true, accounts: data };
}

async function forecastCashFlow({ months_ahead, lookback_days }) {
  const monthsAhead = months_ahead ?? 3;
  const lookbackDays = lookback_days ?? 30;

  const { data: accounts, error: accErr } = await supabase.from('accounts').select('balance');
  if (accErr) throw accErr;
  const currentTotal = (accounts ?? []).reduce((sum, a) => sum + Number(a.balance ?? 0), 0);

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data: transactions, error: txErr } = await supabase
    .from('transactions')
    .select('amount, date')
    .gte('date', since);
  if (txErr) throw txErr;

  const netOverWindow = (transactions ?? []).reduce((sum, t) => sum + Number(t.amount), 0);
  const dailyNet = (transactions ?? []).length > 0 ? netOverWindow / lookbackDays : 0;
  const monthlyNet = dailyNet * 30;

  const projection = [];
  let running = currentTotal;
  for (let m = 1; m <= monthsAhead; m += 1) {
    running += monthlyNet;
    projection.push({ month: m, projected_balance: Number(running.toFixed(2)) });
  }

  return {
    ok: true,
    current_total_balance: Number(currentTotal.toFixed(2)),
    avg_monthly_net_from_recent_transactions: Number(monthlyNet.toFixed(2)),
    lookback_days: lookbackDays,
    note:
      (transactions ?? []).length === 0
        ? 'No transactions logged in the lookback window yet — projection assumes flat (no net change). Log transactions for a real forecast.'
        : undefined,
    projection,
  };
}

async function checkAlertRules() {
  const { comparison } = await compareBudgetVsActual({});
  const overrunPctByCategory = {};
  for (const c of comparison) {
    overrunPctByCategory[c.category] = c.monthly_limit > 0
      ? ((c.spent_so_far - c.monthly_limit) / c.monthly_limit) * 100
      : null;
  }

  const breaches = await evaluateRules('budgeting', { category_overrun_pct: overrunPctByCategory });
  const { pushed } = await pushAlertNotifications('budgeting_agent', breaches);

  return {
    ok: true,
    breaches_found: breaches.length,
    notifications_pushed: pushed,
    breaches: breaches.map((b) => ({
      metric: b.rule.metric,
      category: b.rule.category ?? b.item,
      threshold: b.rule.threshold,
      current_value: b.current_value,
    })),
  };
}

async function runBudgetingTool(name, input) {
  switch (name) {
    case 'set_budget':
      return setBudget(input);
    case 'list_budgets':
      return listBudgets();
    case 'log_transaction':
      return logTransaction(input);
    case 'compare_budget_vs_actual':
      return compareBudgetVsActual(input);
    case 'list_accounts':
      return listAccounts();
    case 'forecast_cash_flow':
      return forecastCashFlow(input);
    case 'set_alert_rule':
      return setAlertRule({ agent: 'budgeting', ...input });
    case 'list_alert_rules':
      return listAlertRules({ agent: 'budgeting' });
    case 'deactivate_alert_rule':
      return deactivateAlertRule(input);
    case 'check_alert_rules':
      return checkAlertRules();
    default:
      throw new Error(`Unknown Budgeting Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runBudgetingAgent(request) {
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
        const result = await runBudgetingTool(use.name, use.input);
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

  return finalText || "Budgeting Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
