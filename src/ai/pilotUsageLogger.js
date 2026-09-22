// Writes one row per router dispatch attempt to a dedicated, disposable pilot table —
// deliberately NOT the existing `agent_logs` table (Shane's decision #2: don't mix experimental
// worker-usage data into production logs; keep it easy to DROP TABLE after testing).
//
//   drop table if exists public.pilot_ai_worker_usage;
//
// is always safe to run once the pilot is retired or promoted — nothing else reads this table.

import { supabase } from '../supabaseClient.js';

const TABLE = 'pilot_ai_worker_usage';

export async function logPilotUsage(entry) {
  try {
    const { error } = await supabase.from(TABLE).insert({
      task_type: entry.taskType,
      task_id: entry.taskId ?? null,
      worker_id: entry.workerId,
      provider: entry.provider,
      model: entry.model,
      status: entry.status,
      path: entry.path,
      latency_ms: entry.latencyMs ?? null,
      input_tokens: entry.inputTokens ?? null,
      output_tokens: entry.outputTokens ?? null,
      cost_usd: entry.costUsd ?? 0,
      error_message: entry.errorMessage ?? null,
    });
    if (error) {
      console.error('[pilotUsageLogger] insert failed:', error.message);
    }
  } catch (err) {
    // Observability must never break the actual task it's observing.
    console.error('[pilotUsageLogger] unexpected error:', err?.message ?? err);
  }
}
