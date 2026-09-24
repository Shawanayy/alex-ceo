import { supabase } from './supabaseClient.js';
import { checkFacetimeStatus, selfHealCalendarEvents } from './agents/adminAgent.js';
import { runDailyInvestmentBriefing } from './agents/investmentAgent.js';
import { getUserTimeZone } from './utils/localDate.js';
import { syncWearableGoals } from './wearableGoalSync.js';

// The only proactive/background process in the app. Everything else is purely reactive to
// incoming Telegram messages (see index.js). This loop does five things on a timer:
//   1. Evaluates 'active' schedule-based automation_rules and fires them (creates a
//      notification) once their cadence interval has elapsed since last_run_at.
//   2. Checks the calendar for a missing weekly family FaceTime / monthly Haliʻa date and
//      queues a notification if one's actually missing (see checkFacetimeReminders below).
//   3. Backfills colorId on any flexible-category event (workout/study/ft_time/chores) that's
//      missing one or has drifted — mainly catches events Shane types directly into Google
//      Calendar himself, which skip Alex's create_event color-assignment entirely.
//   4. Once/day, past 7am Shane's local time, runs the Investment Analyst Agent's daily
//      briefing and writes it to investment_briefings for the dashboard's Investments widget
//      (see checkDailyInvestmentBriefing below) — no longer pushed to Telegram/notifications.
//   5. Pushes undelivered 'high'/'medium' urgency notifications to Shane's Telegram and
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

// Shane wants a Telegram nudge if a week passes with no family FaceTime, or a month with no
// Haliʻa date, on the calendar. checkFacetimeStatus() (in adminAgent.js) only reports missing
// once the window's far enough along to be worth flagging; here we just dedupe so the same
// week/month doesn't queue a duplicate notification on every 5-min tick — keyed by a title that
// encodes the week-start/month so a re-check that still finds it missing is a no-op, not a re-fire.
async function checkFacetimeReminders() {
  let status;
  try {
    status = await checkFacetimeStatus();
  } catch (err) {
    console.error('[Alex] Background loop: FaceTime status check failed:', err?.message ?? err);
    return;
  }

  const now = new Date();

  async function queueIfNew(title, body) {
    const { data: existing, error } = await supabase.from('notifications').select('id').eq('title', title).limit(1);
    if (error) {
      console.error('[Alex] Background loop: FaceTime reminder dedupe check failed:', error.message);
      return;
    }
    if (existing && existing.length > 0) return;
    const { error: insErr } = await supabase.from('notifications').insert({
      source_agent: 'admin_agent',
      urgency: 'medium',
      title,
      body,
    });
    if (insErr) console.error('[Alex] Background loop: failed to queue FaceTime reminder:', insErr.message);
  }

  if (status.familyMissing) {
    const day = now.getDay();
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() + (day === 0 ? -6 : 1 - day));
    const weekKey = weekStart.toISOString().slice(0, 10);
    await queueIfNew(
      `Reminder: no family FaceTime scheduled this week (week of ${weekKey})`,
      "You haven't got a family FaceTime on the calendar this week — want me to find a time and add it?"
    );
  }

  if (status.haliaMissing) {
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await queueIfNew(
      `Reminder: no Haliʻa date scheduled this month (${monthKey})`,
      "You haven't got a Haliʻa date on the calendar this month — want me to find a time and add it?"
    );
  }
}

// Rent reminder — mirrors n8n's old "LifeOS — Rent Reminder" workflow (same bills row, same
// due_day check), moved here so it doesn't depend on n8n/Tailscale being up. n8n's version is
// left running in parallel until Shane's compared a full cycle and is ready to turn it off.
const RENT_BILL_ID = '29b24a6c-8518-40c0-9a43-1bc5d16b43ad';
const RENT_WARNING_DAYS_BEFORE = 3; // TODO: confirm this matches n8n's exact warning window

async function checkRentReminder() {
  const { data: bill, error } = await supabase
    .from('bills')
    .select('id, name, amount, due_day, paid_this_month')
    .eq('id', RENT_BILL_ID)
    .single();
  if (error || !bill) {
    if (error) console.error('[Alex] Background loop: rent reminder bill lookup failed:', error.message);
    return;
  }
  if (bill.paid_this_month) return;

  const now = new Date();
  const daysUntilDue = bill.due_day - now.getDate();
  if (daysUntilDue > RENT_WARNING_DAYS_BEFORE || daysUntilDue < 0) return; // not in the warning window

  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const title = `Reminder: ${bill.name} due (${monthKey})`;

  const { data: existing, error: dedupeErr } = await supabase
    .from('notifications')
    .select('id')
    .eq('title', title)
    .limit(1);
  if (dedupeErr) {
    console.error('[Alex] Background loop: rent reminder dedupe check failed:', dedupeErr.message);
    return;
  }
  if (existing && existing.length > 0) return;

  const { error: insErr } = await supabase.from('notifications').insert({
    source_agent: 'automation_agent',
    urgency: 'medium',
    title,
    body: `${bill.name} ($${bill.amount}) is due on day ${bill.due_day} and isn't marked paid yet.`,
  });
  if (insErr) console.error('[Alex] Background loop: failed to queue rent reminder:', insErr.message);
}

// Runs the Investment Analyst Agent's daily briefing once/day, past 7am Shane's local time
// (loose target — this loop only ticks every 5 min and the process can sleep on Render's free
// tier, so "past 7am" rather than "exactly 7am" is what's actually achievable). Dedupes by
// checking whether today's investment_briefings row already exists (that table upserts on
// user_id+date, so this is exact — no more approximating with a 20-hour notification lookback).
async function checkDailyInvestmentBriefing() {
  try {
    const timeZone = await getUserTimeZone();
    const localHour = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone }).format(new Date())
    );
    if (localHour < 7) return; // too early — try again on a later tick today

    const today = new Date().toISOString().slice(0, 10);
    const { data: recent, error } = await supabase
      .from('investment_briefings')
      .select('id')
      .eq('date', today)
      .limit(1);
    if (error) {
      console.error('[Alex] Background loop: daily briefing dedupe check failed:', error.message);
      return;
    }
    if (recent && recent.length > 0) return; // already generated today

    const result = await runDailyInvestmentBriefing();
    if (!result.ok) {
      console.error('[Alex] Background loop: daily investment briefing failed:', result.error ?? result.reason);
    }
  } catch (err) {
    console.error('[Alex] Background loop: daily investment briefing crashed:', err?.message ?? err);
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
      await checkFacetimeReminders();
      try {
        await checkRentReminder();
      } catch (err) {
        console.error('[Alex] Background loop: checkRentReminder failed:', err?.message ?? err);
      }
      try {
        await selfHealCalendarEvents();
      } catch (err) {
        console.error('[Alex] Background loop: selfHealCalendarEvents failed:', err?.message ?? err);
      }
      try {
        await syncWearableGoals();
      } catch (err) {
        console.error('[Alex] Background loop: syncWearableGoals failed:', err?.message ?? err);
      }
      await checkDailyInvestmentBriefing();
      await pushPendingNotifications(bot, ownerId);
    } catch (err) {
      console.error('[Alex] Background loop tick failed:', err);
    }
  };

  tick(); // run once at startup rather than waiting a full interval
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[Alex] Background loop started (checks every ${POLL_INTERVAL_MS / 60000} min).`);
}
