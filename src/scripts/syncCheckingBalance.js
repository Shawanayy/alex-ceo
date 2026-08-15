#!/usr/bin/env node
// Run by the "daily sheet sync" scheduled task (see Cowork scheduled tasks). Re-syncs every
// linked Plaid item (balances + transactions, reusing the same logic as the Budgeting Agent's
// sync_plaid_transactions tool), then prints the current balance for every account that's
// actually Plaid-linked (plaid_account_id set) as simple "Name: $amount" lines — this is what
// gets copied into the STOCKS Google Sheet's Cash tab (and, once a brokerage/investment account
// is linked the same way, the Stocks tab).
//
// Usage: node src/scripts/syncCheckingBalance.js
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';
import { syncPlaidTransactions } from '../agents/budgetingAgent.js';

async function main() {
  const result = await syncPlaidTransactions();
  console.error('[syncCheckingBalance] sync result:', JSON.stringify(result));

  const { data: accounts, error } = await supabase
    .from('accounts')
    .select('name, type, balance, plaid_account_id')
    .not('plaid_account_id', 'is', null)
    .order('name');
  if (error) throw error;

  if (!accounts || accounts.length === 0) {
    console.log('NO_PLAID_LINKED_ACCOUNTS');
    return;
  }

  for (const a of accounts) {
    console.log(`${a.name} | ${a.type ?? ''} | ${Number(a.balance).toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error('[syncCheckingBalance] Failed:', err?.response?.data ?? err);
  process.exit(1);
});
