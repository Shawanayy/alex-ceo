import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';
import { alertToolDefs, setAlertRule, listAlertRules, deactivateAlertRule, evaluateRules, pushAlertNotifications } from '../alerts.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const ALPHA_VANTAGE_BASE = 'https://www.alphavantage.co/query';

const SYSTEM_PROMPT = `You are the Investment Analyst Agent, a specialist sub-agent that Alex (Shane Pinho's \
Chief of Staff) delegates investment/portfolio requests to. You have real tools backed by Shane's LifeOS \
dashboard "holdings"/"portfolio_summary" tables AND live market data from Alpha Vantage — use them, don't \
guess or make up numbers.

Portfolio data (Shane's own positions, from Supabase):
- list_holdings: every position Shane holds, with invested amount, current value, dollar gain, and % return.
- get_portfolio_summary: portfolio-wide totals (invested, current value, total return) plus week/month/year \
gain percentages, as of the last time those figures were updated in the dashboard (not live).
- get_portfolio_allocation: what % of the total portfolio each holding represents, for spotting \
concentration (e.g. "60% of your portfolio is in one ticker").
- get_top_bottom_performers: best- and worst-performing holdings by stored % return (dashboard data, not live).

Live market data (Alpha Vantage, free tier — 25 requests/day total, so don't call these more than the \
request actually needs):
- get_stock_quote: live price, day change $ and %, and volume for one ticker.
- get_company_overview: company fundamentals for one ticker — sector, market cap, P/E, 52-week high/low, \
description — use this for "research this company" requests.
- get_market_news: recent news headlines + sentiment score for one or more tickers (or general market news \
if no ticker given) — use this for "what's the news on X" or portfolio news summaries.
- get_portfolio_daily_movers: fetches a LIVE quote for every distinct ticker Shane holds and reports which \
is up the most and down the most today (his own personal "bull and bear of the day") — this calls the API \
once per distinct ticker he holds, so be mindful of the daily rate limit before calling it more than once \
per conversation.
If Alpha Vantage returns a rate-limit or error message, report that plainly (e.g. "hit today's API rate \
limit") rather than inventing numbers.

Important boundary: you are not a licensed financial advisor and must not give personalized buy/sell \
investment advice or tell Shane what to do with his money. You CAN state plain facts — his portfolio's \
concentration/performance, a stock's live price/fundamentals/news — that's reporting, not advice. If Shane \
asks what he should buy/sell/rebalance into, say you can show him the facts but can't make investment \
recommendations, and suggest he consult a licensed advisor for that.

Alert rules (set_alert_rule, list_alert_rules, deactivate_alert_rule, check_alert_rules): Shane can define \
his own threshold — currently just 'max_position_pct', the max % any single holding should be of his total \
portfolio — and check_alert_rules will tell him plainly when a holding crosses it and push a notice to his \
dashboard. This is still not advice: Shane picks the number, you just watch for it and report facts. Never \
suggest what the threshold should be or what to do once it's crossed beyond stating it's crossed.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Always include concrete dollar figures and percentages rather than vague summaries.`;

const toolDefs = [
  {
    name: 'list_holdings',
    description:
      "List every one of Shane's holdings with invested amount, current value, dollar gain, and % return.",
    input_schema: {
      type: 'object',
      properties: {
        sort_by: {
          type: 'string',
          enum: ['pct_return', 'current_value', 'invested'],
          description: "Field to sort by, descending. Default 'pct_return'.",
        },
      },
    },
  },
  {
    name: 'get_portfolio_summary',
    description:
      "Get portfolio-wide totals for Shane: total invested, current value, total return, and week/month/year " +
      'gain percentages, as of the last update.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_portfolio_allocation',
    description:
      "Break down what % of Shane's total portfolio value each holding represents, sorted largest first — " +
      'use this for concentration questions (e.g. is he over-exposed to one position).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_top_bottom_performers',
    description:
      "Get Shane's best- and worst-performing holdings by stored % return (not live market data).",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many top and how many bottom performers to return, default 3' },
      },
    },
  },
  {
    name: 'get_stock_quote',
    description: 'Get a live price quote for one ticker: price, day change $ and %, and volume.',
    input_schema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: "Stock ticker symbol, e.g. 'NVDA'" } },
      required: ['ticker'],
    },
  },
  {
    name: 'get_company_overview',
    description:
      'Get company fundamentals for one ticker — sector, market cap, P/E ratio, 52-week high/low, and a ' +
      'short description. Use this for company research requests.',
    input_schema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: "Stock ticker symbol, e.g. 'NVDA'" } },
      required: ['ticker'],
    },
  },
  {
    name: 'get_market_news',
    description:
      'Get recent news headlines and sentiment for one or more tickers, or general market news if no ' +
      'ticker is given.',
    input_schema: {
      type: 'object',
      properties: {
        tickers: {
          type: 'array',
          items: { type: 'string' },
          description: "Ticker symbols to get news for, e.g. ['NVDA','QQQ']. Omit for general market news.",
        },
        limit: { type: 'integer', description: 'How many articles to return, default 5' },
      },
    },
  },
  {
    name: 'get_portfolio_daily_movers',
    description:
      "Fetch a live quote for every distinct ticker Shane holds and report today's biggest gainer and " +
      "biggest loser among his holdings (his personal 'bull and bear of the day'). Uses one API call per " +
      'distinct ticker — mindful of the 25/day rate limit.',
    input_schema: { type: 'object', properties: {} },
  },
  ...alertToolDefs(['max_position_pct']),
];

async function alphaVantageRequest(params) {
  if (!ALPHA_VANTAGE_API_KEY) {
    return { error: 'ALPHA_VANTAGE_API_KEY is not configured.' };
  }
  const url = new URL(ALPHA_VANTAGE_BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('apikey', ALPHA_VANTAGE_API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) {
    return { error: `Alpha Vantage HTTP ${res.status}` };
  }
  const data = await res.json();
  // Alpha Vantage returns 200 OK even for rate limits / bad input, with a "Note",
  // "Information", or "Error Message" field instead of the real payload.
  if (data.Note || data.Information || data['Error Message']) {
    return { error: data.Note || data.Information || data['Error Message'] };
  }
  return { data };
}

async function fetchHoldings() {
  const { data, error } = await supabase.from('holdings').select('*').eq('user_id', DEFAULT_USER_ID);
  if (error) throw error;
  return data ?? [];
}

function withGain(h) {
  const invested = Number(h.invested ?? 0);
  const currentValue = Number(h.current_value ?? 0);
  return {
    ticker: h.ticker,
    company: h.company,
    account: h.account,
    invested,
    current_value: currentValue,
    gain_dollar: currentValue - invested,
    pct_return: h.pct_return !== null && h.pct_return !== undefined ? Number(h.pct_return) : null,
    updated_at: h.updated_at,
  };
}

async function listHoldings({ sort_by }) {
  const holdings = (await fetchHoldings()).map(withGain);
  const key = sort_by ?? 'pct_return';
  holdings.sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
  return { ok: true, count: holdings.length, holdings };
}

async function getPortfolioSummary() {
  const { data, error } = await supabase
    .from('portfolio_summary')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return { ok: true, note: 'No portfolio_summary row found for Shane yet.' };
  }
  return { ok: true, summary: data };
}

async function getPortfolioAllocation() {
  const holdings = (await fetchHoldings()).map(withGain);
  const totalValue = holdings.reduce((sum, h) => sum + h.current_value, 0);

  const allocation = holdings
    .map((h) => ({
      ticker: h.ticker,
      company: h.company,
      current_value: h.current_value,
      pct_of_portfolio: totalValue > 0 ? (h.current_value / totalValue) * 100 : null,
    }))
    .sort((a, b) => (b.pct_of_portfolio ?? 0) - (a.pct_of_portfolio ?? 0));

  return { ok: true, total_value: totalValue, allocation };
}

async function getTopBottomPerformers({ limit }) {
  const n = limit ?? 3;
  const holdings = (await fetchHoldings())
    .map(withGain)
    .filter((h) => h.pct_return !== null);

  const sorted = [...holdings].sort((a, b) => b.pct_return - a.pct_return);
  return {
    ok: true,
    top_performers: sorted.slice(0, n),
    bottom_performers: sorted.slice(-n).reverse(),
  };
}

async function getStockQuote({ ticker }) {
  const { data, error } = await alphaVantageRequest({ function: 'GLOBAL_QUOTE', symbol: ticker });
  if (error) return { ok: false, error };
  const q = data?.['Global Quote'];
  if (!q || Object.keys(q).length === 0) {
    return { ok: false, error: `No quote data returned for '${ticker}' — check the ticker symbol.` };
  }
  return {
    ok: true,
    quote: {
      ticker: q['01. symbol'],
      price: Number(q['05. price']),
      change_dollar: Number(q['09. change']),
      change_pct: q['10. change percent'] ? Number(q['10. change percent'].replace('%', '')) : null,
      volume: Number(q['06. volume']),
      latest_trading_day: q['07. latest trading day'],
    },
  };
}

async function getCompanyOverview({ ticker }) {
  const { data, error } = await alphaVantageRequest({ function: 'OVERVIEW', symbol: ticker });
  if (error) return { ok: false, error };
  if (!data || Object.keys(data).length === 0) {
    return { ok: false, error: `No company overview returned for '${ticker}' — check the ticker symbol.` };
  }
  return {
    ok: true,
    overview: {
      ticker: data.Symbol,
      name: data.Name,
      sector: data.Sector,
      industry: data.Industry,
      description: data.Description,
      market_cap: data.MarketCapitalization,
      pe_ratio: data.PERatio,
      dividend_yield: data.DividendYield,
      week_52_high: data['52WeekHigh'],
      week_52_low: data['52WeekLow'],
    },
  };
}

async function getMarketNews({ tickers, limit }) {
  const params = { function: 'NEWS_SENTIMENT', limit: String(limit ?? 5) };
  if (tickers && tickers.length > 0) params.tickers = tickers.join(',');

  const { data, error } = await alphaVantageRequest(params);
  if (error) return { ok: false, error };
  const feed = data?.feed ?? [];
  return {
    ok: true,
    articles: feed.slice(0, limit ?? 5).map((a) => ({
      title: a.title,
      source: a.source,
      published: a.time_published,
      url: a.url,
      overall_sentiment: a.overall_sentiment_label,
      summary: a.summary,
    })),
  };
}

async function getPortfolioDailyMovers() {
  const holdings = await fetchHoldings();
  const distinctTickers = [...new Set(holdings.map((h) => h.ticker).filter(Boolean))];

  if (distinctTickers.length === 0) {
    return { ok: true, note: 'No holdings to check.' };
  }

  const results = [];
  for (const ticker of distinctTickers) {
    const { ok, quote, error } = await getStockQuote({ ticker });
    if (ok) {
      results.push(quote);
    } else {
      results.push({ ticker, error });
    }
  }

  const withData = results.filter((r) => typeof r.change_pct === 'number');
  if (withData.length === 0) {
    return { ok: false, error: 'Could not fetch live quotes for any holding.', raw: results };
  }

  const sorted = [...withData].sort((a, b) => b.change_pct - a.change_pct);
  return {
    ok: true,
    bull_of_the_day: sorted[0],
    bear_of_the_day: sorted[sorted.length - 1],
    all_quotes: results,
  };
}

async function checkAlertRules() {
  const { allocation } = await getPortfolioAllocation();
  const maxPositionPctByTicker = {};
  for (const h of allocation) {
    if (h.pct_of_portfolio !== null) maxPositionPctByTicker[h.ticker] = h.pct_of_portfolio;
  }

  const breaches = await evaluateRules('investment', { max_position_pct: maxPositionPctByTicker });
  const { pushed } = await pushAlertNotifications('investment_agent', breaches);

  return {
    ok: true,
    breaches_found: breaches.length,
    notifications_pushed: pushed,
    breaches: breaches.map((b) => ({
      metric: b.rule.metric,
      ticker: b.item,
      threshold: b.rule.threshold,
      current_value: b.current_value,
    })),
  };
}

async function runInvestmentTool(name, input) {
  switch (name) {
    case 'list_holdings':
      return listHoldings(input);
    case 'get_portfolio_summary':
      return getPortfolioSummary();
    case 'get_portfolio_allocation':
      return getPortfolioAllocation();
    case 'get_top_bottom_performers':
      return getTopBottomPerformers(input);
    case 'get_stock_quote':
      return getStockQuote(input);
    case 'get_company_overview':
      return getCompanyOverview(input);
    case 'get_market_news':
      return getMarketNews(input);
    case 'get_portfolio_daily_movers':
      return getPortfolioDailyMovers();
    case 'set_alert_rule':
      return setAlertRule({ agent: 'investment', ...input });
    case 'list_alert_rules':
      return listAlertRules({ agent: 'investment' });
    case 'deactivate_alert_rule':
      return deactivateAlertRule(input);
    case 'check_alert_rules':
      return checkAlertRules();
    default:
      throw new Error(`Unknown Investment Analyst Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runInvestmentAgent(request) {
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
        const result = await runInvestmentTool(use.name, use.input);
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

  return finalText || "Investment Analyst Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
