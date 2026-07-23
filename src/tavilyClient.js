import dotenv from 'dotenv';
dotenv.config();

const TAVILY_API_URL = 'https://api.tavily.com/search';

if (!process.env.TAVILY_API_KEY) {
  console.error('[Alex] Missing TAVILY_API_KEY in .env — live web search tools will fail until it is set.');
}

// Shared live web-search helper used by Lifestyle agents (Travel Planner, Shopping Agent,
// Entertainment Planner, Personal Concierge) that need to look up current, real-world info
// (flights/hotels, product prices/reviews, showtimes, local events, etc.) that no dedicated
// structured API in this codebase covers.
//
// Returns Tavily's answer (if requested) plus a trimmed list of results: title, url, content
// snippet. Throws a clear error if the API key is missing or the request fails.
export async function tavilySearch(query, { maxResults = 5, includeAnswer = true, topic = 'general' } = {}) {
  if (!process.env.TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY is not set — live web search is unavailable until it is configured in .env');
  }

  const response = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: maxResults,
      include_answer: includeAnswer,
      topic,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Tavily search failed (${response.status}): ${text || response.statusText}`);
  }

  const data = await response.json();
  return {
    answer: data.answer ?? null,
    results: (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
    })),
  };
}
