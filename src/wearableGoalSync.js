import dotenv from 'dotenv';
dotenv.config();
import { supabase } from './supabaseClient.js';

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

// Habit goals that HelioStrip wearable data can confirm on its own, without Shane touching the
// dashboard. Matched by title (same convention as habitAgent.js) rather than a hardcoded id, in
// case the goal ever gets recreated.
const STEPS_GOAL_TITLE = 'Hit 10,000 steps a day';
const STEPS_TARGET = 10000;
const SLEEP_GOAL_TITLE = 'Get 8 hours of sleep every day';
const SLEEP_TARGET_MIN = 480; // 8 hours

// Auto-fills a habit goal from wearable data. Only ever INSERTS a new goal_logs row, for a date
// where the wearable threshold was actually hit AND nothing is logged for that date yet
// (ignoreDuplicates: true on the upsert). Never overwrites an existing entry — manual or a prior
// auto-fill — and never auto-marks a day as NOT done: missing/zero wearable data for a day is
// usually a sync gap (HelioStrip has had a few), not proof Shane actually missed the goal, so
// marking days incomplete stays Shane's call, not this job's.
async function autoFillGoal({ title, targetValue, table, valueColumn }) {
  const { data: goal, error: goalErr } = await supabase.from('goals').select('id').eq('title', title).maybeSingle();
  if (goalErr || !goal) return;

  const since = new Date();
  since.setDate(since.getDate() - 14); // 2-week lookback is plenty for a daily-tick job

  const { data: rows, error } = await supabase
    .from(table)
    .select(`date, ${valueColumn}`)
    .eq('user_id', DEFAULT_USER_ID)
    .gte('date', since.toISOString().slice(0, 10))
    .gte(valueColumn, targetValue);
  if (error) {
    console.error(`[Alex] wearableGoalSync: read failed for "${title}":`, error.message);
    return;
  }
  if (!rows || rows.length === 0) return;

  const logRows = rows.map((r) => ({ goal_id: goal.id, date: r.date, done: true, value: r[valueColumn] }));
  const { error: upsertErr } = await supabase
    .from('goal_logs')
    .upsert(logRows, { onConflict: 'goal_id,date', ignoreDuplicates: true });
  if (upsertErr) console.error(`[Alex] wearableGoalSync: upsert failed for "${title}":`, upsertErr.message);
}

// Called from backgroundLoop.js on every tick. Cheap (2 small reads + a conditional upsert) so
// running it every 5 minutes is fine — it's a no-op once a day's goals are already filled in.
export async function syncWearableGoals() {
  await autoFillGoal({ title: STEPS_GOAL_TITLE, targetValue: STEPS_TARGET, table: 'wearable_daily_metrics', valueColumn: 'steps' });
  await autoFillGoal({ title: SLEEP_GOAL_TITLE, targetValue: SLEEP_TARGET_MIN, table: 'wearable_sleep_sessions', valueColumn: 'total_min' });
}
