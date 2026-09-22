// The free-worker router. Found as an empty placeholder file at this path before this pilot —
// filled in here rather than creating a new file elsewhere, since the path/name already matched
// what this module does.
//
// DESIGN NOTE — how this reconciles "free_only=true, no automatic paid requests" with the fact
// that Alex's agents already call paid Anthropic models today:
//
//   This router (routeToFreeWorker) ONLY ever considers workers in WORKER_REGISTRY, and every
//   entry there is policy-checked as free before each dispatch (see policy.js). It has no code
//   path that can reach a paid worker, automatically or otherwise — there is no "backup to paid"
//   branch in this file. If every free candidate is unavailable, it returns { ok: false }, full
//   stop.
//
//   The existing direct `anthropic.messages.create()` calls in learningAgent.js (and every other
//   agent) are pre-existing, already-paid-for production behavior that predates this router by
//   months — Shane already knowingly pays for those today. This pilot's two migrated call sites
//   (generateStudyGuide, importSyllabus) call routeToFreeWorker() FIRST; only when it returns
//   { ok: false } do they fall through to that same original, byte-for-byte-unchanged Anthropic
//   call. So today, with no free-provider keys configured yet, behavior is 100% identical to
//   before this pilot existed — every request still lands on Anthropic, just one router check
//   earlier. The moment Shane adds e.g. GROQ_API_KEY, that category starts actually being served
//   free, visibly, in the usage table — without any further code change.

import { WORKER_REGISTRY } from './workerRegistry.js';
import { assertPolicyCompliant, PolicyViolation } from './policy.js';
import { logPilotUsage } from './pilotUsageLogger.js';

/**
 * @param {{taskId: string, category: string, userPrompt: string, systemPrompt?: string, maxTokens?: number, responseFormat?: 'text'|'json'}} envelope
 * @param {Array} registry - injectable for tests; defaults to the real WORKER_REGISTRY
 * @returns {Promise<{ok: true, text: string, workerId: string, provider: string, model: string, usage: object} | {ok: false, reason: string, triedWorkers: Array}>}
 */
export async function routeToFreeWorker(envelope, registry = WORKER_REGISTRY) {
  const candidates = registry
    .filter((w) => w.enabled !== false && (w.categories || []).includes(envelope.category))
    .sort((a, b) => a.priority - b.priority);

  if (candidates.length === 0) {
    return { ok: false, reason: 'no_worker_registered_for_category', triedWorkers: [] };
  }

  const tried = [];

  for (const worker of candidates) {
    // Defense in depth — every entry in the registry is already free by construction, but this
    // guarantees a future bad edit to workerRegistry.js can never silently reach a paid call.
    try {
      assertPolicyCompliant(worker);
    } catch (err) {
      if (err instanceof PolicyViolation) {
        tried.push({ workerId: worker.id, status: 'policy_blocked' });
        continue;
      }
      throw err;
    }

    let configured;
    try {
      configured = worker.adapter.isConfigured();
    } catch {
      configured = false;
    }
    if (!configured) {
      tried.push({ workerId: worker.id, status: 'not_configured' });
      continue; // no API key set for this provider yet — silent, expected, not an error
    }

    const startedAt = Date.now();
    try {
      const result = await worker.adapter.call(envelope);
      const latencyMs = Date.now() - startedAt;
      tried.push({ workerId: worker.id, status: 'success' });
      await logPilotUsage({
        taskType: envelope.category,
        taskId: envelope.taskId,
        workerId: worker.id,
        provider: worker.provider,
        model: result.modelUsed || worker.model,
        status: 'success',
        path: 'router_free_worker',
        latencyMs,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        costUsd: 0,
      });
      return {
        ok: true,
        text: result.text,
        workerId: worker.id,
        provider: worker.provider,
        model: result.modelUsed || worker.model,
        usage: result.usage ?? null,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const status = err?.status === 'rate_limited' ? 'rate_limited' : 'error';
      tried.push({ workerId: worker.id, status });
      await logPilotUsage({
        taskType: envelope.category,
        taskId: envelope.taskId,
        workerId: worker.id,
        provider: worker.provider,
        model: worker.model,
        status,
        path: 'router_free_worker',
        latencyMs,
        errorMessage: String(err?.message ?? err),
      });
      // Try the next free candidate. Never escalate to a paid worker here — see design note above.
    }
  }

  await logPilotUsage({
    taskType: envelope.category,
    taskId: envelope.taskId,
    workerId: null,
    provider: null,
    model: null,
    status: 'all_unavailable',
    path: 'router_free_worker',
  });

  return { ok: false, reason: 'all_free_workers_unavailable', triedWorkers: tried };
}
