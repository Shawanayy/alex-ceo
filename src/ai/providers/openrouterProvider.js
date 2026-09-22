// OpenRouter adapter — OpenAI-compatible chat completions endpoint.
// OFFICIAL docs (https://openrouter.ai/docs/api-reference/limits), checked 2026-09-21:
// free-model (":free" suffix) rate limits are 20 requests/min always, and 50 requests/day with
// $0 all-time credits purchased or 1,000 requests/day once at least $10 has ever been purchased
// (that higher ceiling persists even if the balance later returns to zero). No payment method is
// required to start — sign-up alone is enough to use :free models at the 50/day tier.
//
// IMPORTANT per Shane's decision #9: this adapter must NEVER purchase credits or attach a
// payment method on its own to raise the quota — it only ever uses the free, no-cost tier as-is.
//
// OpenRouter's free-model roster changes frequently (models get added/pulled/repriced), so
// instead of hardcoding a specific ":free" model ID that could vanish, this adapter resolves the
// current live list via GET /api/v1/models and picks the first text model whose id ends in
// ":free" and whose pricing.prompt is literally "0" — i.e. a model OpenRouter itself reports as
// $0/token right now. Cached for 1 hour to avoid hammering the models endpoint on every call.

import { ProviderCallError } from '../providerInterface.js';

export const id = 'openrouter-dynamic-free';
export const MODEL = '(resolved dynamically at call time — see resolveFreeModel)';

export function isConfigured() {
  return !!process.env.OPENROUTER_API_KEY;
}

let cachedFreeModelId = null;
let cachedAt = 0;
const CACHE_MS = 60 * 60 * 1000;

async function resolveFreeModel() {
  if (cachedFreeModelId && Date.now() - cachedAt < CACHE_MS) return cachedFreeModelId;

  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/models');
  } catch (err) {
    throw new ProviderCallError(`OpenRouter models list network error: ${err.message}`, 'error');
  }
  if (!res.ok) {
    throw new ProviderCallError(`OpenRouter models list error ${res.status}`, 'error');
  }
  const { data } = await res.json();
  const free = (data || []).find((m) => m.id?.endsWith(':free') && m.pricing?.prompt === '0');
  if (!free) {
    throw new ProviderCallError('No genuinely $0 ":free" OpenRouter model is currently listed', 'error');
  }
  cachedFreeModelId = free.id;
  cachedAt = Date.now();
  return free.id;
}

export async function call({ systemPrompt, userPrompt, maxTokens, responseFormat }) {
  const model = await resolveFreeModel();

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });

  const body = { model, messages, max_tokens: maxTokens ?? 1024 };
  if (responseFormat === 'json') body.response_format = { type: 'json_object' };

  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ProviderCallError(`OpenRouter network error: ${err.message}`, 'error');
  }

  if (res.status === 429) {
    throw new ProviderCallError('OpenRouter rate limit exceeded', 'rate_limited');
  }
  if (res.status === 402) {
    // Would incur cost or exceed free quota — never treated as "try harder", always a hard skip.
    throw new ProviderCallError('OpenRouter returned 402 (would incur cost) — refusing under free_only policy', 'error');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderCallError(`OpenRouter API error ${res.status}: ${text.slice(0, 300)}`, 'error');
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return {
    text,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
    },
    modelUsed: model,
  };
}

// Exposed for tests only, so the cache doesn't leak state between test cases.
export function _resetCacheForTests() {
  cachedFreeModelId = null;
  cachedAt = 0;
}
