// Shared Plaid API client, used by the local Link server (src/plaid/linkServer.js — where Shane
// connects a new bank account) and the Budgeting Agent (sync_plaid_transactions /
// list_plaid_connections tools). PLAID_ENV should be 'sandbox' while testing (fake banks, no real
// money/accounts touched) and only switched to 'production' after Plaid approves the app for that.
import { PlaidApi, Configuration, PlaidEnvironments } from 'plaid';
import dotenv from 'dotenv';
dotenv.config();

const env = process.env.PLAID_ENV || 'sandbox';

if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
  console.error('[Alex] Missing PLAID_CLIENT_ID or PLAID_SECRET in .env');
}

const configuration = new Configuration({
  basePath: PlaidEnvironments[env],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

export const plaidClient = new PlaidApi(configuration);
export const PLAID_PRODUCTS = ['transactions'];
export const PLAID_COUNTRY_CODES = ['US'];
