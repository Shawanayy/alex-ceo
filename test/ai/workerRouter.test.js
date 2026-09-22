import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Supabase client is imported transitively via pilotUsageLogger.js. Mock it so tests never
// touch the real database and never fail because env vars aren't set in the test environment.
vi.mock('../../src/supabaseClient.js', () => ({
  supabase: { from: () => ({ insert: async () => ({ error: null }) }) },
}));

const { routeToFreeWorker } = await import('../../src/ai/workerRouter.js');

function makeWorker({ id, priority, free_status = 'documented_free_tier', configured = true, callImpl }) {
  return {
    id,
    provider: 'test',
    model: 'test-model',
    categories: ['test.category'],
    free_status,
    priority,
    enabled: true,
    adapter: {
      isConfigured: () => configured,
      call: callImpl,
    },
  };
}

const baseEnvelope = { taskId: 't1', category: 'test.category', userPrompt: 'hello' };

describe('routeToFreeWorker', () => {
  it('returns ok:false with no registry entries for the category', async () => {
    const result = await routeToFreeWorker({ ...baseEnvelope, category: 'nothing.registered' }, []);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_worker_registered_for_category');
  });

  it('succeeds on the primary (lowest priority number) worker', async () => {
    const primary = makeWorker({ id: 'primary', priority: 1, callImpl: async () => ({ text: 'primary result', usage: { inputTokens: 10, outputTokens: 5 } }) });
    const backup = makeWorker({ id: 'backup', priority: 2, callImpl: async () => ({ text: 'backup result' }) });
    const result = await routeToFreeWorker(baseEnvelope, [backup, primary]);
    expect(result.ok).toBe(true);
    expect(result.workerId).toBe('primary');
    expect(result.text).toBe('primary result');
  });

  it('falls back to the next worker when the primary is rate-limited', async () => {
    const primary = makeWorker({
      id: 'primary',
      priority: 1,
      callImpl: async () => {
        const err = new Error('rate limited');
        err.status = 'rate_limited';
        throw err;
      },
    });
    const backup = makeWorker({ id: 'backup', priority: 2, callImpl: async () => ({ text: 'backup saved the day' }) });
    const result = await routeToFreeWorker(baseEnvelope, [primary, backup]);
    expect(result.ok).toBe(true);
    expect(result.workerId).toBe('backup');
  });

  it('skips a worker with no API key configured', async () => {
    const unconfigured = makeWorker({ id: 'unconfigured', priority: 1, configured: false, callImpl: async () => ({ text: 'should never be called' }) });
    const backup = makeWorker({ id: 'backup', priority: 2, callImpl: async () => ({ text: 'used instead' }) });
    const result = await routeToFreeWorker(baseEnvelope, [unconfigured, backup]);
    expect(result.ok).toBe(true);
    expect(result.workerId).toBe('backup');
  });

  it('returns ok:false when every candidate is unavailable — never invents a paid fallback', async () => {
    const primary = makeWorker({
      id: 'primary',
      priority: 1,
      callImpl: async () => {
        const err = new Error('down');
        err.status = 'error';
        throw err;
      },
    });
    const backup = makeWorker({ id: 'backup', priority: 2, configured: false, callImpl: async () => ({ text: 'unreachable' }) });
    const result = await routeToFreeWorker(baseEnvelope, [primary, backup]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('all_free_workers_unavailable');
    expect(result.triedWorkers).toHaveLength(2);
  });

  it('refuses a non-free worker even if it somehow ends up in the registry (defense in depth)', async () => {
    const paidWorker = makeWorker({ id: 'sneaky-paid', priority: 1, free_status: 'paid', callImpl: async () => ({ text: 'should never run' }) });
    const result = await routeToFreeWorker(baseEnvelope, [paidWorker]);
    expect(result.ok).toBe(false);
    expect(result.triedWorkers[0]).toEqual({ workerId: 'sneaky-paid', status: 'policy_blocked' });
  });
});
