// Groq adapter — OpenAI-compatible chat completions endpoint.
// Free tier confirmed via OFFICIAL docs (https://console.groq.com/docs/rate-limits), checked 2026-09-21:
// openai/gpt-oss-20b free-plan limits = 30 RPM / 1,000 RPD / 8K TPM / 200K TPD. No payment method
// required to use the free plan (per the same page). Data/retention policy: see
// https://console.groq.com/docs/your-data — review before sending sensitive content.
//
// Exact live numbers for Shane's own account are on https://console.groq.com/settings/limits
// once he has a key — the table above is Groq's general free-plan documentation, not
// account-specific.

import { ProviderCallError } from '../providerInterface.js';

export const id = 'groq-gpt-oss-20b';
export const MODEL = 'openai/gpt-oss-20b';

export function isConfigured() {
  return !!process.env.GROQ_API_KEY;
}

export async function call({ systemPrompt, userPrompt, maxTokens, responseFormat }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });

  const body = { model: MODEL, messages, max_tokens: maxTokens ?? 1024 };
  if (responseFormat === 'json') body.response_format = { type: 'json_object' };

  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ProviderCallError(`Groq network error: ${err.message}`, 'error');
  }

  if (res.status === 429) {
    throw new ProviderCallError('Groq rate limit exceeded', 'rate_limited');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderCallError(`Groq API error ${res.status}: ${text.slice(0, 300)}`, 'error');
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return {
    text,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
    },
    modelUsed: MODEL,
  };
}
