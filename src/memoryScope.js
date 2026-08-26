import { supabase } from './supabaseClient.js';

// Learning-loop hook. Sub-agents are deliberately stateless/scoped (no access to Shane's general
// memory feed — that's what keeps their prompts small and cheap). But that meant a correction to
// one specific sub-agent's behavior had nowhere durable to live: it only reached the orchestrator's
// generic memory block, which then had to manually restate it into every delegated request — easy
// to drop. Fix: memories can be tagged with an agent_scope (see the `remember` tool in tools.js).
// Each sub-agent pulls its own small scoped slice here at the start of every run and folds it into
// its system prompt as a short, uncached addendum, so a correction actually persists into that
// agent's future behavior.
export async function fetchAgentMemories(agentScope) {
  const { data, error } = await supabase
    .from('memories')
    .select('content, importance')
    .eq('agent_scope', agentScope)
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) {
    console.error(`[Alex] Failed to load scoped memories for ${agentScope}:`, error.message);
    return [];
  }
  return data ?? [];
}

export function formatCorrectionsBlock(memories) {
  if (!memories.length) return null;
  return `Corrections/preferences Shane has given specifically for you:\n${memories.map((m) => `- ${m.content}`).join('\n')}`;
}
