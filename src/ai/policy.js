// Hard safety policy for the free-worker router pilot (src/ai/workerRouter.js).
//
// These three values are intentionally hardcoded, not read from environment variables or the
// database. Shane's explicit requirement: "No automatic paid API requests under any
// circumstance." An env var can be edited by accident (a typo, a copy-pasted .env from another
// project, a bad default); a constant in code cannot be flipped without a deliberate PR-style
// change to this file, which is the point.
//
// What this policy does NOT cover: the existing, pre-pilot direct Anthropic calls in
// learningAgent.js (and every other agent) are untouched legacy behavior that predates this
// router entirely — Shane already knowingly pays for those. This policy only governs what the
// NEW router (routeToFreeWorker) is allowed to automatically select. The router never calls a
// paid worker, full stop — see workerRouter.js's design note at the top of that file.

export const FREE_ONLY = true;
export const MAX_AUTOMATIC_COST_USD = 0;
export const PAID_FALLBACK = false;

export class PolicyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyViolation';
  }
}

// Defense in depth: even though every entry in workerRegistry.js is hand-verified as free before
// it's added, this check runs on every single dispatch so a future bad registry edit can't slip
// a paid worker through silently.
export function assertPolicyCompliant(worker) {
  if (!FREE_ONLY) return; // unreachable today — FREE_ONLY is a hardcoded true above
  const allowedStatuses = ['documented_free_tier', 'local_tool'];
  if (!allowedStatuses.includes(worker.free_status)) {
    throw new PolicyViolation(
      `Worker "${worker.id}" has free_status="${worker.free_status}", not one of ${allowedStatuses.join('/')} — ` +
        `refusing to dispatch under FREE_ONLY=true. PAID_FALLBACK=${PAID_FALLBACK}, so this worker is never tried automatically.`
    );
  }
  if ((worker.estimated_cost_usd ?? 0) > MAX_AUTOMATIC_COST_USD) {
    throw new PolicyViolation(
      `Worker "${worker.id}" has a nonzero estimated cost — refusing under MAX_AUTOMATIC_COST_USD=${MAX_AUTOMATIC_COST_USD}.`
    );
  }
}
