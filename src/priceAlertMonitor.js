// Standalone, read-only stock price monitor. Notify-only: it never places trades, never touches
// Robinhood/Plaid, and doesn't know Shane's cost basis — it only compares live prices against
// public 52-week high/low data and messages Telegram when a threshold is crossed. Runs on a
// schedule (see the Routine set up alongside this file) rather than inside the interactive
// Alex conversation loop, so it needs its own entrypoint and its own on-disk state.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import { supabase } from './supabaseClient.js';

dotenv.config();

// Group A: already-down positions — alert on further downside toward/through the 52-week low.
const GROUP_A = ['FSLR', 'IONQ'];
// Group B: winners off their highs — alert on pullback from a rolling high-water mark.
const GROUP_B = ['NVDA', 'QQQ', 'SPY', 'MU'];
const THRESHOLD = 0.175; // 17.5% — exact trigger per spec

const LOG_PATH = path.join(process.cwd(), 'logs', 'priceAlertMonitor.log');
const YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  // Best-effort local file log for manual runs. Render Cron Jobs get a fresh ephemeral
  // container each run (this file won't persist there) — Render's own captured stdout is
  // the durable log in production; this is just a convenience for running locally.
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, stamped + '\n');
  } catch {
    // ignore — e.g. read-only filesystem
  }
}

// State (high-water marks, anti-spam crossing flags) lives in Supabase, not a local file —
// Render Cron Jobs run in a fresh ephemeral container each time, so anything written to disk
// is gone by the next hourly check.
async function loadState() {
  const { data, error } = await supabase.from('price_alert_state').select('*');
  if (error) throw error;
  const state = {};
  for (const row of data ?? []) {
    state[row.ticker] = { highWaterMark: row.high_water_mark, crossed: row.crossed };
  }
  return state;
}

async function saveState(state) {
  const rows = Object.entries(state).map(([ticker, s]) => ({
    ticker,
    high_water_mark: s.highWaterMark ?? null,
    crossed: s.crossed ?? false,
    updated_at: new Date().toISOString(),
  }));
  if (rows.length === 0) return;
  const { error } = await supabase.from('price_alert_state').upsert(rows, { onConflict: 'ticker' });
  if (error) throw error;
}

// Mon-Fri 9:30am-4:00pm America/New_York, computed from wall-clock ET regardless of the host's
// own timezone or daylight saving — no hardcoded UTC offset that would drift with DST.
export function isMarketHoursET(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const minutes = hour * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

// Yahoo Finance's unauthenticated quote endpoint — one batched request for all tickers, no API
// key, no daily cap, and it returns regularMarketPrice + fiftyTwoWeekHigh/Low in the same payload
// (unlike Alpha Vantage, whose free tier caps at 25 req/day, nowhere near enough for hourly
// checks across 6 tickers plus the fundamentals lookups 52-week data needs there).
async function fetchQuotes(tickers) {
  const url = `${YAHOO_QUOTE_URL}?symbols=${tickers.join(',')}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);
  const json = await res.json();
  const results = json?.quoteResponse?.result ?? [];
  const byTicker = {};
  for (const r of results) {
    byTicker[r.symbol] = {
      price: r.regularMarketPrice,
      week52High: r.fiftyTwoWeekHigh,
      week52Low: r.fiftyTwoWeekLow,
    };
  }
  return byTicker;
}

// Anti-spam: once a threshold crossing has alerted, stays silent until price moves back past
// it (state.crossed -> false) and crosses again.
export function evaluateGroupA(ticker, quote, state) {
  const s = state[ticker] ?? {};
  const distFromLow = (quote.price - quote.week52Low) / quote.week52Low;
  const triggered = quote.price <= quote.week52Low || distFromLow <= THRESHOLD;

  let message = null;
  if (triggered && !s.crossed) {
    const belowLow = quote.price < quote.week52Low;
    message =
      `${ticker}: $${quote.price.toFixed(2)} is ${belowLow ? 'BELOW its 52-week low' : 'within 17.5% of its 52-week low'} ` +
      `of $${quote.week52Low.toFixed(2)} (${(distFromLow * 100).toFixed(1)}% from the low).`;
  }
  s.crossed = triggered;
  state[ticker] = s;
  return message;
}

export function evaluateGroupB(ticker, quote, state) {
  const s = state[ticker] ?? {};
  const highWaterMark = Math.max(s.highWaterMark ?? quote.week52High, quote.week52High, quote.price);
  const pullback = (highWaterMark - quote.price) / highWaterMark;
  const triggered = pullback >= THRESHOLD;

  let message = null;
  if (triggered && !s.crossed) {
    message =
      `${ticker}: pulled back ${(pullback * 100).toFixed(1)}% from its high-water mark of ` +
      `$${highWaterMark.toFixed(2)} to $${quote.price.toFixed(2)}.`;
  }
  s.crossed = triggered;
  s.highWaterMark = highWaterMark;
  state[ticker] = s;
  return message;
}

export async function runCheck({ force = false } = {}) {
  const now = new Date();
  if (!force && !isMarketHoursET(now)) {
    log('Skipped check — outside market hours (Mon-Fri 9:30am-4:00pm ET).');
    return { ok: true, skipped: true };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.OWNER_TELEGRAM_USER_ID;
  if (!token || !chatId) {
    log('ERROR: missing TELEGRAM_BOT_TOKEN or OWNER_TELEGRAM_USER_ID — cannot deliver alerts.');
    return { ok: false, error: 'Missing Telegram config' };
  }

  const allTickers = [...GROUP_A, ...GROUP_B];
  let quotes;
  try {
    quotes = await fetchQuotes(allTickers);
  } catch (err) {
    log(`ERROR fetching quotes: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const state = await loadState();
  const bot = new TelegramBot(token);
  const alertsSent = [];

  for (const ticker of GROUP_A) {
    const quote = quotes[ticker];
    if (!quote || quote.price == null || quote.week52Low == null) {
      log(`Checked ${ticker}: no data returned from Yahoo Finance, skipping.`);
      continue;
    }
    log(`Checked ${ticker}: price=$${quote.price} 52w_low=$${quote.week52Low}`);
    const message = evaluateGroupA(ticker, quote, state);
    if (message) {
      await bot.sendMessage(chatId, `Price alert — ${message}`);
      log(`ALERT sent for ${ticker}: ${message}`);
      alertsSent.push(message);
    }
  }

  for (const ticker of GROUP_B) {
    const quote = quotes[ticker];
    if (!quote || quote.price == null || quote.week52High == null) {
      log(`Checked ${ticker}: no data returned from Yahoo Finance, skipping.`);
      continue;
    }
    const hwmBefore = state[ticker]?.highWaterMark ?? quote.week52High;
    log(`Checked ${ticker}: price=$${quote.price} 52w_high=$${quote.week52High} hwm=$${hwmBefore}`);
    const message = evaluateGroupB(ticker, quote, state);
    if (message) {
      await bot.sendMessage(chatId, `Price alert — ${message}`);
      log(`ALERT sent for ${ticker}: ${message}`);
      alertsSent.push(message);
    }
  }

  await saveState(state);
  log(`Check complete. ${alertsSent.length} alert(s) sent.`);
  return { ok: true, alertsSent };
}

// `node src/priceAlertMonitor.js` runs a normal market-hours-gated check.
// `node src/priceAlertMonitor.js --force` bypasses the market-hours gate (for manual testing).
if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes('--force');
  runCheck({ force }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });
}
