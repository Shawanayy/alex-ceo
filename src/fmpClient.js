// Financial Modeling Prep client — richer fundamentals than Alpha Vantage (margins, free cash
// flow, debt, revenue/EPS growth trends, earnings surprises), used by the Investment Analyst
// Agent's daily briefing and by a couple of its on-demand research tools. Separate from
// alphaVantageRequest in investmentAgent.js on purpose: different base URL/auth shape, and Alpha
// Vantage's live quote/news tools stay as they are (they already work fine) rather than churning
// working code — this just adds the fundamentals depth FMP is actually better at.
const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

async function fmpGet(path, params = {}) {
  if (!FMP_API_KEY) {
    return { error: 'FMP_API_KEY is not configured.' };
  }
  const url = new URL(`${FMP_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('apikey', FMP_API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) {
    return { error: `FMP HTTP ${res.status}` };
  }
  const data = await res.json();
  // FMP returns 200 with an "Error Message" field (or a plain {error: ...} object, or {} on
  // certain rejected-plan requests) instead of throwing, so treat those the same way.
  if (data?.['Error Message'] || data?.error) {
    return { error: data['Error Message'] || data.error };
  }
  return { data };
}

// Live/last-close quote — price, day change $/%, volume, market cap. Same shape of info as
// Alpha Vantage's get_stock_quote but from a different provider (used by the daily briefing so
// its one Sonnet call can compare "today" against the sheet's cost basis in the same pass).
export async function fmpQuote(ticker) {
  const { data, error } = await fmpGet(`/quote/${encodeURIComponent(ticker)}`);
  if (error) return { ok: false, error };
  const q = data?.[0];
  if (!q) return { ok: false, error: `No quote returned for '${ticker}'.` };
  return {
    ok: true,
    ticker: q.symbol,
    price: q.price,
    change_dollar: q.change,
    change_pct: q.changesPercentage,
    day_low: q.dayLow,
    day_high: q.dayHigh,
    year_low: q.yearLow,
    year_high: q.yearHigh,
    market_cap: q.marketCap,
    pe_ratio: q.pe,
    eps: q.eps,
    volume: q.volume,
    avg_volume: q.avgVolume,
  };
}

// One historical close a set number of trading days back — used to tell "one bad day" apart
// from "actually down over the week/month" per Shane's ask to compare against history rather
// than react to daily noise. daysBack counts calendar days back for the fetch window; FMP skips
// weekends/holidays on its own.
export async function fmpHistoricalClose(ticker, daysBack) {
  const from = new Date();
  from.setDate(from.getDate() - daysBack - 5); // pad for weekends/holidays
  const { data, error } = await fmpGet(`/historical-price-full/${encodeURIComponent(ticker)}`, {
    from: from.toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
  });
  if (error) return { ok: false, error };
  const series = data?.historical;
  if (!series || series.length === 0) return { ok: false, error: `No historical data for '${ticker}'.` };
  // series is newest-first; walk back roughly daysBack trading entries.
  const target = series[Math.min(daysBack, series.length - 1)];
  return { ok: true, ticker, date: target.date, close: target.close };
}

// Margins, FCF, debt — the core "did the business actually change" fundamentals, TTM (trailing
// twelve months) so it's a stable current-state snapshot rather than one noisy quarter.
export async function fmpKeyMetricsAndRatios(ticker) {
  const [metricsRes, ratiosRes] = await Promise.all([
    fmpGet(`/key-metrics-ttm/${encodeURIComponent(ticker)}`),
    fmpGet(`/ratios-ttm/${encodeURIComponent(ticker)}`),
  ]);
  if (metricsRes.error || ratiosRes.error) {
    return { ok: false, error: metricsRes.error || ratiosRes.error };
  }
  const m = metricsRes.data?.[0];
  const r = ratiosRes.data?.[0];
  if (!m && !r) return { ok: false, error: `No fundamentals data for '${ticker}'.` };
  return {
    ok: true,
    ticker,
    free_cash_flow_per_share_ttm: m?.freeCashFlowPerShareTTM ?? null,
    revenue_per_share_ttm: m?.revenuePerShareTTM ?? null,
    net_debt_to_ebitda_ttm: m?.netDebtToEBITDATTM ?? null,
    debt_to_equity_ttm: m?.debtToEquityTTM ?? r?.debtEquityRatioTTM ?? null,
    current_ratio_ttm: r?.currentRatioTTM ?? null,
    gross_profit_margin_ttm: r?.grossProfitMarginTTM ?? null,
    operating_profit_margin_ttm: r?.operatingProfitMarginTTM ?? null,
    net_profit_margin_ttm: r?.netProfitMarginTTM ?? null,
    pe_ratio_ttm: r?.peRatioTTM ?? null,
    price_to_free_cash_flow_ttm: r?.priceToFreeCashFlowsRatioTTM ?? null,
  };
}

// Last N quarters of revenue/EPS so growth direction is visible (not just one snapshot) —
// covers Shane's "revenue/EPS growth changes" and "margin changes over time" asks.
export async function fmpQuarterlyIncomeTrend(ticker, quarters = 4) {
  const { data, error } = await fmpGet(`/income-statement/${encodeURIComponent(ticker)}`, {
    period: 'quarter',
    limit: String(quarters),
  });
  if (error) return { ok: false, error };
  if (!data || data.length === 0) return { ok: false, error: `No income statement data for '${ticker}'.` };
  return {
    ok: true,
    ticker,
    quarters: data.map((q) => ({
      period_end: q.date,
      revenue: q.revenue,
      eps: q.eps,
      gross_profit_ratio: q.grossProfitRatio,
      operating_income_ratio: q.operatingIncomeRatio,
      net_income_ratio: q.netIncomeRatio,
    })),
  };
}

// Most recent earnings beat/miss — actual vs. estimated EPS, so a "changed thesis" moment
// (big beat/miss) is easy to spot without pulling a full transcript.
export async function fmpEarningsSurprises(ticker, limit = 4) {
  const { data, error } = await fmpGet(`/earnings-surprises/${encodeURIComponent(ticker)}`);
  if (error) return { ok: false, error };
  if (!data || data.length === 0) return { ok: false, error: `No earnings surprise data for '${ticker}'.` };
  return {
    ok: true,
    ticker,
    surprises: data.slice(0, limit).map((e) => ({
      date: e.date,
      actual_eps: e.actualEarningResult,
      estimated_eps: e.estimatedEarning,
    })),
  };
}

// Recent headlines for one ticker — separate from Alpha Vantage's get_market_news (which stays
// as-is for on-demand sentiment lookups); this one's tuned for the daily briefing's tighter loop.
export async function fmpStockNews(ticker, limit = 5) {
  const { data, error } = await fmpGet('/stock_news', { tickers: ticker, limit: String(limit) });
  if (error) return { ok: false, error };
  return {
    ok: true,
    ticker,
    articles: (data ?? []).map((a) => ({
      title: a.title,
      source: a.site,
      published: a.publishedDate,
      url: a.url,
      summary: a.text,
    })),
  };
}
