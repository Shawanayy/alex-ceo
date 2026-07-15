// Shared helper used by finance sub-agents (Investment, Net Worth, Budgeting) to let Shane set his own
// threshold rules ("alert me if X crosses Y") and have those rules checked against live data. This never
// picks a number for Shane and never recommends an action — it only evaluates rules Shane defined himself
// and, on a breach, writes a plain factual notice into the existing "notifications" table (the same table
// the Bill Pay Agent already pushes reminders into, so breaches surface on Shane's dashboard the same way).

import { supabase } from './supabaseClient.js';

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

// comparison 'gt'  -> alert fires when currentValue > threshold (e.g. concentration % too high)
// comparison 'lt'  -> alert fires when currentValue < threshold (e.g. net worth/cash floor breached)
export async function setAlertRule({ agent, metric, comparison, threshold, category, label }) {
  const row = {
    user_id: DEFAULT_USER_ID,
    agent,
    metric,
    comparison: comparison ?? 'gt',
    threshold,
    category: category ?? null,
    label: label ?? null,
    active: true,
    updated_at: new Date().toISOString(),
  };

  // Upsert-by-hand: one active rule per (agent, metric, category) at a time, so re-setting a rule updates
  // it instead of piling up duplicates.
  const { data: existing, error: findError } = await supabase
    .from('alert_rules')
    .select('id')
    .eq('user_id', DEFAULT_USER_ID)
    .eq('agent', agent)
    .eq('metric', metric)
    .eq('category', category ?? null)
    .maybeSingle();
  if (findError) throw findError;

  if (existing) {
    const { data, error } = await supabase
      .from('alert_rules')
      .update(row)
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return { ok: true, rule: data, updated: true };
  }

  const { data, error } = await supabase.from('alert_rules').insert(row).select().single();
  if (error) throw error;
  return { ok: true, rule: data, updated: false };
}

export async function listAlertRules({ agent }) {
  let query = supabase.from('alert_rules').select('*').eq('user_id', DEFAULT_USER_ID).eq('active', true);
  if (agent) query = query.eq('agent', agent);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;
  return { ok: true, rules: data };
}

export async function deactivateAlertRule({ id }) {
  const { data, error } = await supabase
    .from('alert_rules')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', DEFAULT_USER_ID)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, error: `No active alert rule found with id '${id}'.` };
  return { ok: true, rule: data };
}

// Given the rules for one agent and a map of metric -> current value(s), returns which rules are breached.
// `values` can either be a plain number (for single-value metrics like a net worth floor) or, for
// category-scoped metrics like budgeting overruns, a map of category -> current value.
function isBreached(rule, currentValue) {
  if (currentValue === null || currentValue === undefined) return false;
  return rule.comparison === 'lt' ? currentValue < rule.threshold : currentValue > rule.threshold;
}

export async function evaluateRules(agent, valuesByMetric) {
  const { rules } = await listAlertRules({ agent });
  const breaches = [];

  for (const rule of rules) {
    const metricValues = valuesByMetric[rule.metric];
    if (metricValues === undefined) continue;

    if (rule.category) {
      // Category-scoped metric: metricValues is expected to be a map of category -> value.
      const currentValue = metricValues[rule.category];
      if (isBreached(rule, currentValue)) {
        breaches.push({ rule, current_value: currentValue });
      }
    } else if (typeof metricValues === 'object') {
      // No category on the rule but metric reports per-item values (e.g. per-ticker concentration) —
      // check every item and report each breach separately.
      for (const [key, currentValue] of Object.entries(metricValues)) {
        if (isBreached(rule, currentValue)) {
          breaches.push({ rule, item: key, current_value: currentValue });
        }
      }
    } else if (isBreached(rule, metricValues)) {
      breaches.push({ rule, current_value: metricValues });
    }
  }

  return breaches;
}

export async function pushAlertNotifications(sourceAgent, breaches) {
  if (breaches.length === 0) return { ok: true, pushed: 0, notifications: [] };

  const rows = breaches.map(({ rule, item, current_value }) => ({
    source_agent: sourceAgent,
    urgency: 'medium',
    title: rule.label || `${rule.metric}${item ? ` (${item})` : ''} crossed threshold`,
    body:
      `Rule: ${rule.metric}${rule.category ? ` [${rule.category}]` : ''}${item ? ` [${item}]` : ''} ` +
      `${rule.comparison === 'lt' ? 'below' : 'above'} ${rule.threshold}. Current value: ${current_value}.`,
  }));

  const { data, error } = await supabase.from('notifications').insert(rows).select();
  if (error) throw error;
  return { ok: true, pushed: data.length, notifications: data };
}

export const alertToolDefs = (metricEnum) => [
  {
    name: 'set_alert_rule',
    description:
      "Create or update a threshold rule that Shane defines himself (e.g. 'alert me if any position is " +
      "over 30% of my portfolio'). This never picks the number for Shane — he supplies the metric and " +
      "threshold, this just remembers it for check_alert_rules to evaluate later. Re-calling with the same " +
      'metric/category updates the existing rule instead of creating a duplicate.',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: metricEnum, description: 'Which metric this rule watches.' },
        comparison: {
          type: 'string',
          enum: ['gt', 'lt'],
          description: "'gt' = alert when value goes above threshold, 'lt' = alert when it drops below.",
        },
        threshold: { type: 'number', description: 'The number Shane wants to be alerted against.' },
        category: {
          type: 'string',
          description: 'Only for category-scoped metrics (e.g. a specific budget category). Omit otherwise.',
        },
        label: { type: 'string', description: "Short human-readable label for this rule, e.g. 'NVDA concentration cap'." },
      },
      required: ['metric', 'comparison', 'threshold'],
    },
  },
  {
    name: 'list_alert_rules',
    description: 'List active alert rules Shane has set for this agent.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'deactivate_alert_rule',
    description: 'Turn off an alert rule by id (from list_alert_rules).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The alert_rules row id to deactivate.' } },
      required: ['id'],
    },
  },
  {
    name: 'check_alert_rules',
    description:
      "Evaluate Shane's active rules for this agent against current live data and, for any breach, push a " +
      "plain factual notice into Shane's notifications table (dashboard-visible). Reports facts only — never " +
      'a recommendation of what to do about it.',
    input_schema: { type: 'object', properties: {} },
  },
];
