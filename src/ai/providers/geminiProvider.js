// Gemini adapter — REST generateContent endpoint.
// OFFICIAL docs (https://ai.google.dev/gemini-api/docs/rate-limits), checked 2026-09-21, confirm a
// Free usage tier exists (qualification: "Active project or free trial", no spend-based rate
// limit). As of this date Google no longer publishes a static per-model free RPM/RPD table on
// that page — it directs you to your live, account-specific limits at
// https://aistudio.google.com/rate-limit. gemini-2.5-flash-lite is used here as the
// lowest-cost, non-deprecated, non-preview model in the current lineup (per
// https://ai.google.dev/gemini-api/docs/models, checked same date), but its exact free-tier
// eligibility/limits are NOT independently confirmed in this file — verify at the URL above
// once a real key exists, before flipping this worker's `enabled` flag on in production use.
// Data policy: see https://ai.google.dev/gemini-api/docs/logs-policy before sending sensitive content.

import { ProviderCallError } from '../providerInterface.js';

export const id = 'gemini-2.5-flash-lite';
export const MODEL = 'gemini-2.5-flash-lite';

export function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

export async function call({ systemPrompt, userPrompt, maxTokens, responseFormat }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { maxOutputTokens: maxTokens ?? 1024 },
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  if (responseFormat === 'json') body.generationConfig.responseMimeType = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ProviderCallError(`Gemini network error: ${err.message}`, 'error');
  }

  if (res.status === 429) {
    throw new ProviderCallError('Gemini rate limit exceeded', 'rate_limited');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderCallError(`Gemini API error ${res.status}: ${text.slice(0, 300)}`, 'error');
  }

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  return {
    text,
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount ?? null,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
    },
    modelUsed: MODEL,
  };
}
