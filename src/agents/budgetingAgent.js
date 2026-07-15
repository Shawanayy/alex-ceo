import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';
import { alertToolDefs, setAlertRule, listAlertRules, deactivateAlertRule, evaluateRules, pushAlertNotifications } from '../alerts.js';
import { plaidClient } from '../plaidClient.js';

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
- "accounts" holds Shane's current balances per account (Checking, MMA, Roth IRA, Robinhood, etc.) — some \
are manually maintained, others are linked via Plaid and kept current by sync_plaid_transactions.
- "transactions" is the single ledger for both manually logged expenses/income AND Plaid-synced \
transactions. Log manual expenses here via log_transaction so budget comparisons stay accurate.
- "budgets" is one row per category with a monthly_limit. set_budget upserts by category, so calling it \
again for the same category just updates the limit.

Plaid bank sync (list_plaid_connections, sync_plaid_transactions): Shane can link real bank accounts via \
Plaid for automatic balance/transaction sync. Linking a NEW bank has to happen in a browser on Shane's own \
machine — Plaid's secure login widget can't run inside this chat, so if Shane asks to connect a new bank \
and list_plaid_connections shows no active connection for it, tell him to run 'npm run link' in the project \
and open the local page it prints (http://localhost:5544 by default) to connect it there. Once at least \
one bank is linked, sync_plaid_transactions pulls new transactions and refreshed balances for every \
linked bank — use it whenever Shane asks to sync/refresh/update his accounts from the bank. Never ask for \
or handle Shane's actual bank username/password yourself.

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
  {
    name: 'list_plaid_connections',
    description:
      "List Shane's linked bank connections (institution name, status, when linked) — does not expose " +
      'access tokens. Use this to check whether a given bank is already connected before telling Shane ' +
      'to go link it.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'sync_plaid_transactions',
    description:
      'Pull fresh transactions and account balances from every linked bank via Plaid and write them into ' +
      "the accounts/transactions tables. Use this whenever Shane asks to sync/refresh/update his accounts " +
      "or get current balances from the bank. If list_plaid_connections shows no linked banks, this will " +
      "just report that — tell Shane to run `npm run link` first instead of guessing at numbers.",
    input_schema: { type: 'object', properties: {} },
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

async function listPlaidConnections() {
  const { data, error } = await supabase
    .from('plaid_items')
    .select('id, institution_name, status, created_at, updated_at')
    .eq('user_id', DEFAULT_USER_ID)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return { ok: true, connections: data ?? [] };
}

// Pulls new transactions + refreshed balances for every linked bank, one Plaid Item at a time.
// Uses Plaid's recommended /transactions/sync (cursor-based, incremental) rather than the older
// /transactions/get — each item's cursor is persisted on plaid_items so re-syncing only fetches
// what changed since last time. Amount sign convention: Plaid reports positive = money leaving
// the account; our transactions table uses negative = expense, so it's flipped on the way in.
async function syncPlaidTransactions() {
  const { data: items, error: itemsErr } = await supabase
    .from('plaid_items')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .eq('status', 'active');
  if (itemsErr) throw itemsErr;

  if (!items || items.length === 0) {
    return {
      ok: true,
      institutions_synced: [],
      note:
        "No linked bank accounts yet — Shane needs to run `npm run link` and connect one via the local " +
        'page before a sync has anything to pull.',
    };
  }

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  const institutionsSynced = [];
  const errors = [];

  for (const item of items) {
    try {
      let cursor = item.sync_cursor ?? undefined;
      let added = [];
      let modified = [];
      let removed = [];
      let hasMore = true;

      while (hasMore) {
        const response = await plaidClient.transactionsSync({ access_token: item.access_token, cursor });
        added = added.concat(response.data.added);
        modified = modified.concat(response.data.modified);
        removed = removed.concat(response.data.removed);
        hasMore = response.data.has_more;
        cursor = response.data.next_cursor;
      }

      const upserts = [...added, ...modified].map((t) => ({
        user_id: DEFAULT_USER_ID,
        date: t.date,
        description: t.merchant_name || t.name || null,
        amount: -Number(t.amount),
        category: t.personal_finance_category?.primary ?? (Array.isArray(t.category) ? t.category[0] : null) ?? 'Uncategorized',
        account: t.account_id,
        plaid_transaction_id: t.transaction_id,
      }));

      if (upserts.length > 0) {
        const { error: upsertErr } = await supabase
          .from('transactions')
          .upsert(upserts, { onConflict: 'plaid_transaction_id' });
        if (upsertErr) throw upsertErr;
      }

      if (removed.length > 0) {
        const idsToRemove = removed.map((r) => r.transaction_id);
        const { error: delErr } = await supabase.from('transactions').delete().in('plaid_transaction_id', idsToRemove);
        if (delErr) throw delErr;
      }

      const balanceRes = await plaidClient.accountsBalanceGet({ access_token: item.access_token });
      const accountUpserts = balanceRes.data.accounts.map((a) => ({
        user_id: DEFAULT_USER_ID,
        name: `${item.institution_name ?? 'Linked'} ${a.name}`,
        type: a.subtype || a.type || null,
        balance: a.balances.current ?? a.balances.available ?? 0,
        plaid_account_id: a.account_id,
        plaid_item_id: item.id,
        updated_at: new Date().toISOString(),
      }));
      if (accountUpserts.length > 0) {
        const { error: accErr } = await supabase
          .from('accounts')
          .upsert(accountUpserts, { onConflict: 'plaid_account_id' });
        if (accErr) throw accErr;
      }

      await supabase
        .from('plaid_items')
        .update({ sync_cursor: cursor, status: 'active', updated_at: new Date().toISOString() })
        .eq('id', item.id);

      totalAdded += added.length;
      totalModified += modified.length;
      totalRemoved += removed.length;
      institutionsSynced.push(item.institution_name || item.item_id);
    } catch (err) {
      const message = err?.response?.data?.error_message || err?.message || String(err);
      errors.push({ institution: item.institution_name || item.item_id, error: message });
      await supabase
        .from('plaid_items')
        .update({ status: 'error', updated_at: new Date().toISOString() })
        .eq('id', item.id);
    }
  }

  return {
    ok: errors.length === 0,
    institutions_synced: institutionsSynced,
    transactions_added: totalAdded,
    transactions_modified: totalModified,
    transactions_removed: totalRemoved,
    errors: errors.length > 0 ? errors : undefined,
  };
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
    case 'list_plaid_connections':
      return listPlaidConnections();
    case 'sync_plaid_transactions':
      return syncPlaidTransactions();
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
