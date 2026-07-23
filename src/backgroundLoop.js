import { supabase } from './supabaseClient.js';

// The only proactive/background process in the app. Everything else is purely reactive to
// incoming Telegram messages (see index.js). This loop does two things on a timer:
//   1. Evaluates 'active' schedule-based automation_rules and fires them (creates a
//      notification) once their cadence interval has elapsed since last_run_at.
//   2. Pushes undelivered 'high'/'medium' urgency notifications to Shane's Telegram and
//      marks them delivered. 'low' urgency notifications are never proactively pushed —
//      they just sit in the table for on-demand review via the Notification Manager.
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function cadenceToMs(cadence) {
  switch (cadence) {
    case 'hourly':
      return 60 * 60 * 1000;
    case 'daily':
      return 24 * 60 * 60 * 1000;
    case 'weekly':
      return 7 * 24 * 60 * 60 * 1000;
    default:
      return null; // unrecognized/missing cadence — skip the rule rather than guess
  }
}

async function evaluateAutomationRules() {
  const { data: rules, error } = await supabase
    .from('automation_rules')
    .select('*')
    .eq('status', 'active')
    .eq('trigger_type', 'schedule');
  if (error) {
    console.error('[Alex] Background loop: failed to load automation_rules:', error.message);
    return;
  }

  const now = Date.now();
  for (const rule of rules ?? []) {
    const intervalMs = cadenceToMs(rule.trigger_config?.cadence);
    if (!intervalMs) continue;

    const lastRun = rule.last_run_at ? new Date(rule.last_run_at).getTime() : 0;
    if (now - lastRun < intervalMs) continue;

    const { error: insErr } = await supabase.from('notifications').insert({
      source_agent: 'automation_agent',
      urgency: 'medium',
      title: `Automation: ${rule.name}`,
      body: rule.action_description || 'Scheduled automation rule fired.',
    });
    if (insErr) {
      console.error(`[Alex] Background loop: failed to push notification for rule '${rule.name}':`, insErr.message);
      continue;
    }

    const { error: updErr } = await supabase
      .from('automation_rules')
      .update({ last_run_at: new Date().toISOString() })
      .eq('id', rule.id);
    if (updErr) console.error(`[Alex] Background loop: failed to update last_run_at for '${rule.name}':`, updErr.message);
  }
}

async function pushPendingNotifications(bot, ownerId) {
  const { data: pending, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('delivered', false)
    .in('urgency', ['high', 'medium']);
  if (error) {
    console.error('[Alex] Background loop: failed to load pending notifications:', error.message);
    return;
  }

  for (const n of pending ?? []) {
    try {
      const prefix = n.urgency === 'high' ? 'Urgent' : 'Heads up';
      const text = `${prefix} (${n.source_agent ?? 'alex'}): ${n.title}${n.body ? `\n${n.body}` : ''}`;
      await bot.sendMessage(ownerId, text);
      await supabase.from('notifications').update({ delivered: true, delivered_at: new Date().toISOString() }).eq('id', n.id);
    } catch (err) {
      console.error(`[Alex] Background loop: failed to push notification '${n.title}':`, err.message);
    }
  }
}

// Starts the shared background loop. Call once at startup from index.js with the live bot
// instance and Shane's Telegram user id (used directly as the chat id for a 1:1 DM).
export function startBackgroundLoop(bot, ownerId) {
  const tick = async () => {
    try {
      await evaluateAutomationRules();
      await pushPendingNotifications(bot, ownerId);
    } catch (err) {
      console.error('[Alex] Background loop tick failed:', err);
    }
  };

  tick(); // run once at startup rather than waiting a full interval
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[Alex] Background loop started (checks every ${POLL_INTERVAL_MS / 60000} min).`);
}
