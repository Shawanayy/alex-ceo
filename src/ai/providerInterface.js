// Shared contract every free-worker provider adapter (src/ai/providers/*.js) must implement.
// Not a TypeScript interface (this repo is plain JS) — enforced by convention + the runtime
// shape-check below, which the router and tests both use.
//
// A provider adapter module exports exactly two functions:
//
//   isConfigured(): boolean
//     Return true only if the env var(s) this provider needs are actually present. Must never
//     throw. The router treats "not configured" as a normal, silent skip — not an error.
//
//   call(envelope): Promise<{ text: string, usage?: { inputTokens: number|null, outputTokens: number|null }, modelUsed?: string }>
//     envelope shape: { taskId, category, userPrompt, systemPrompt?, maxTokens?, responseFormat? ('text'|'json') }
//     On failure, throw an Error with a `.status` property set to one of:
//       'rate_limited'  — 429 / quota exceeded, router should try the next candidate
//       'error'         — anything else (auth failure, malformed response, network error)
//     Never catch-and-swallow inside the adapter — let the router decide what to do next.

export class ProviderCallError extends Error {
  constructor(message, status = 'error') {
    super(message);
    this.name = 'ProviderCallError';
    this.status = status; // 'rate_limited' | 'error'
  }
}

// Lightweight runtime check used by tests to catch an adapter that doesn't match the contract.
export function assertValidAdapter(adapter) {
  if (typeof adapter.isConfigured !== 'function') {
    throw new Error('Provider adapter is missing isConfigured()');
  }
  if (typeof adapter.call !== 'function') {
    throw new Error('Provider adapter is missing call()');
  }
}

export function assertValidCallResult(result) {
  if (!result || typeof result.text !== 'string') {
    throw new Error('Provider adapter call() must resolve to an object with a string "text" field');
  }
}
