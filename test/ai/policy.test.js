import { describe, it, expect } from 'vitest';
import { FREE_ONLY, MAX_AUTOMATIC_COST_USD, PAID_FALLBACK, assertPolicyCompliant, PolicyViolation } from '../../src/ai/policy.js';

describe('policy.js — hardcoded safety constants', () => {
  it('FREE_ONLY is true', () => {
    expect(FREE_ONLY).toBe(true);
  });
  it('MAX_AUTOMATIC_COST_USD is 0', () => {
    expect(MAX_AUTOMATIC_COST_USD).toBe(0);
  });
  it('PAID_FALLBACK is false', () => {
    expect(PAID_FALLBACK).toBe(false);
  });
});

describe('assertPolicyCompliant', () => {
  it('allows a documented_free_tier worker', () => {
    expect(() => assertPolicyCompliant({ id: 'ok', free_status: 'documented_free_tier' })).not.toThrow();
  });

  it('allows a local_tool worker', () => {
    expect(() => assertPolicyCompliant({ id: 'ok-local', free_status: 'local_tool' })).not.toThrow();
  });

  it('rejects a paid worker', () => {
    expect(() => assertPolicyCompliant({ id: 'bad', free_status: 'paid' })).toThrow(PolicyViolation);
  });

  it('rejects a worker with unknown free_status', () => {
    expect(() => assertPolicyCompliant({ id: 'unknown', free_status: 'unknown' })).toThrow(PolicyViolation);
  });

  it('rejects a worker with a nonzero estimated cost even if flagged free_status', () => {
    expect(() =>
      assertPolicyCompliant({ id: 'sneaky', free_status: 'documented_free_tier', estimated_cost_usd: 0.01 })
    ).toThrow(PolicyViolation);
  });
});
