import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as groqProvider from '../../src/ai/providers/groqProvider.js';
import * as geminiProvider from '../../src/ai/providers/geminiProvider.js';
import * as openrouterProvider from '../../src/ai/providers/openrouterProvider.js';
import { assertValidAdapter } from '../../src/ai/providerInterface.js';

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  openrouterProvider._resetCacheForTests();
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe('provider adapters match the shared contract', () => {
  it.each([
    ['groq', groqProvider],
    ['gemini', geminiProvider],
    ['openrouter', openrouterProvider],
  ])('%s exposes isConfigured() and call()', (_name, adapter) => {
    expect(() => assertValidAdapter(adapter)).not.toThrow();
  });
});

describe('isConfigured() reflects env vars, not network state', () => {
  it('groq is unconfigured with no key', () => {
    expect(groqProvider.isConfigured()).toBe(false);
  });
  it('groq is configured once GROQ_API_KEY is set', () => {
    process.env.GROQ_API_KEY = 'fake-key';
    expect(groqProvider.isConfigured()).toBe(true);
  });
  it('gemini is unconfigured with no key', () => {
    expect(geminiProvider.isConfigured()).toBe(false);
  });
  it('openrouter is unconfigured with no key', () => {
    expect(openrouterProvider.isConfigured()).toBe(false);
  });
});

describe('groqProvider.call()', () => {
  it('parses a successful completion', async () => {
    process.env.GROQ_API_KEY = 'fake-key';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'hello from groq' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    });
    const result = await groqProvider.call({ userPrompt: 'hi', maxTokens: 100 });
    expect(result.text).toBe('hello from groq');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it('throws a rate_limited error on HTTP 429', async () => {
    process.env.GROQ_API_KEY = 'fake-key';
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    await expect(groqProvider.call({ userPrompt: 'hi' })).rejects.toMatchObject({ status: 'rate_limited' });
  });
});

describe('geminiProvider.call()', () => {
  it('parses a successful completion', async () => {
    process.env.GEMINI_API_KEY = 'fake-key';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'hello from gemini' }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 6 },
      }),
    });
    const result = await geminiProvider.call({ userPrompt: 'hi' });
    expect(result.text).toBe('hello from gemini');
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 6 });
  });

  it('throws a rate_limited error on HTTP 429', async () => {
    process.env.GEMINI_API_KEY = 'fake-key';
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    await expect(geminiProvider.call({ userPrompt: 'hi' })).rejects.toMatchObject({ status: 'rate_limited' });
  });
});

describe('openrouterProvider.call()', () => {
  it('resolves a genuinely-free model then completes', async () => {
    process.env.OPENROUTER_API_KEY = 'fake-key';
    global.fetch = vi
      .fn()
      // first call: GET /models
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'some/model:free', pricing: { prompt: '0' } }, { id: 'other/model', pricing: { prompt: '0.001' } }] }),
      })
      // second call: POST /chat/completions
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'hello from openrouter' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      });
    const result = await openrouterProvider.call({ userPrompt: 'hi' });
    expect(result.text).toBe('hello from openrouter');
    expect(result.modelUsed).toBe('some/model:free');
  });

  it('never selects a model that is not genuinely $0', async () => {
    process.env.OPENROUTER_API_KEY = 'fake-key';
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'paid/model:free', pricing: { prompt: '0.002' } }] }),
    });
    await expect(openrouterProvider.call({ userPrompt: 'hi' })).rejects.toThrow(/No genuinely \$0/);
  });

  it('throws a rate_limited error on HTTP 429 from the completions call', async () => {
    process.env.OPENROUTER_API_KEY = 'fake-key';
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [{ id: 'a/b:free', pricing: { prompt: '0' } }] }) })
      .mockResolvedValueOnce({ ok: false, status: 429 });
    await expect(openrouterProvider.call({ userPrompt: 'hi' })).rejects.toMatchObject({ status: 'rate_limited' });
  });
});
