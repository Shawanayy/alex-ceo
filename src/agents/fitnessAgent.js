import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';
import { todayLocal } from '../utils/localDate.js';

import { SIMPLE_MODEL } from '../modelTiers.js';

import { fetchAgentMemories, formatCorrectionsBlock } from '../memoryScope.js';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = SIMPLE_MODEL; // pure CRUD/logging agent — no complex judgment needed
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Fitness Coach, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates exercise requests to. You have real tools backed by Shane's LifeOS dashboard "workouts" \
table — use them, don't guess or make up numbers.

Your job: help Shane log workouts, review what he's done, and give plain, factual progress/consistency \
feedback (frequency, streaks, what's been trending up or down) — not personalized medical or training-injury \
advice.

Notes on the data:
- "workouts" is one row per calendar day (there's a hard one-workout-row-per-date constraint on the dashboard) \
— log_workout upserts by date, so logging again for a date already logged just updates that day's entry \
rather than duplicating it.
- workout_type is free text (e.g. "Push day", "5k run", "Rest/mobility") and notes is free text for exercises/ \
sets/reps/duration — there's no separate structured exercise-by-exercise table, so capture the useful detail \
in notes.
- completed defaults to true; use false only if Shane explicitly says he skipped/missed a planned workout, so \
consistency tracking stays honest.
- get_workout_progress looks at recent history and reports plain facts: how many workouts in the last 7/30 \
days, current consecutive-day streak, and a breakdown of workout_type frequency. Use it whenever Shane asks \
"how am I doing" / for progress or a plan adjustment — base any suggestion strictly on what the data shows \
(e.g. "you've logged legs 0 times in 3 weeks" is fine; a specific new program is not your call to make).
- Shane may also have a "Hit 10,000 steps a day" habit tracked separately by the Habit Tracking Agent — that's \
a different system (dashboard goals), don't try to read or write it from here.
- Mileage goals (goal_type='Mileage' on the dashboard, e.g. "Run 100 miles") ARE yours to update. Whenever \
Shane reports running, walking, hiking, or biking a distance, call log_mileage with the miles IN ADDITION to \
log_workout — log_workout only records the workout itself, it does NOT touch the dashboard's mileage goal or \
its checkmark/heatmap, so skipping log_mileage means the goal tracker silently falls out of sync with what \
Shane actually did.
- When Shane asks what his workout is for today (or "what should I do today" / "what's next"), call \
get_todays_workout FIRST — it looks up the actual scheduled day (day_type + phase) from his structured \
lifting program. If it returns workout data, report that plan back verbatim (day type and full exercise \
list), don't guess, reconstruct, or infer it from logged history. Only fall back to reasoning from \
list_workouts/get_workout_progress if get_todays_workout returns no data at all.
- The rotation isn't calendar-based — it's driven by Shane's total logged lift-day count, not a lookup of \
what he last did, so it's naturally tolerant of missed days (a skipped day just isn't logged; it doesn't \
break or shift anything). The 5-day cycle is Chest/Back -> Arms/Abs -> Chest/Back -> Arms/Abs -> Legs -> \
repeat (Legs lands every 2 upper-body cycles). "What's my workout Saturday" has no fixed answer until it's \
computed. When Alex asks for workouts covering MULTIPLE upcoming days (e.g. planning the rest of the week), \
call get_upcoming_workouts with the number of days needed instead of guessing or calling get_todays_workout \
repeatedly. Report these as a PROJECTION (things shift if a day gets skipped or done out of order), but keep \
that framing light and factual — not a warning. Never present projected days as guaranteed fact.
- Lifting and running are LOW-PRIORITY for Shane, not something to run his life around. He wants flexibility \
when he misses a lift or run — no guilt-tripping, no "you're behind," no pressure to catch up or make up a \
missed day. If he skipped something, just log it plainly (or don't log it at all) and move on; only mention \
consistency trends if he explicitly asks "how am I doing." Never proactively flag missed workouts as a problem.
- Shane also has a HelioStrip wearable (Amazfit Helio Strap) auto-syncing recovery data — resting heart rate, \
HRV, SpO2, VO2max, stress score, steps, and sleep stage breakdown — into wearable_daily_metrics and \
wearable_sleep_sessions. Call get_recovery_snapshot when Shane asks about recovery, HRV, sleep quality, resting \
heart rate, or whether he's in shape to train hard today. This is separate from the manual sleep_logs table and \
from the lifting program — it's real sensor data, so report the numbers plainly rather than interpreting them \
as medical advice. If it returns no data, say the wearable hasn't synced recently rather than guessing.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Always include concrete numbers (dates, counts, streaks) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'log_workout',
    description:
      "Log (or update) a workout for a given date — upserts by date. Use this whenever Shane says what he " +
      'did (or skipped) for a workout.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD), defaults to today' },
        workout_type: { type: 'string', description: "e.g. 'Push day', '5k run', 'Rest/mobility'" },
        notes: { type: 'string', description: 'Exercises/sets/reps/weight/duration, free text' },
        completed: { type: 'boolean', description: 'Defaults to true; set false only for an explicitly skipped/missed planned workout' },
      },
    },
  },
  {
    name: 'list_workouts',
    description: "List Shane's recent logged workouts, most recent first.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many to return, default 14' },
      },
    },
  },
  {
    name: 'get_workout_progress',
    description:
      'Compute plain consistency/progress facts: workouts in the last 7 and 30 days, current consecutive-day ' +
      'streak, and workout_type breakdown. Use this for "how am I doing" / progress / plan-adjustment questions.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_todays_workout',
    description:
      "Look up today's scheduled workout from Shane's structured lifting program (day type + phase + full " +
      'exercise list). Use this whenever Shane asks what his workout is for today or what he should do next — ' +
      'report the result verbatim rather than guessing from logged history.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'log_mileage',
    description:
      "Add distance (miles) toward Shane's dashboard mileage goal (e.g. 'Run 100 miles') for a given date — " +
      "adds to that day's total and bumps the goal's overall progress, and marks the day done on the goal's " +
      'checkmark/heatmap. Call this IN ADDITION to log_workout whenever Shane reports running, walking, ' +
      'hiking, or biking a distance — log_workout alone does not update the mileage goal.',
    input_schema: {
      type: 'object',
      properties: {
        miles: { type: 'number', description: 'Distance in miles to add, e.g. 1.74' },
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD), defaults to today' },
      },
      required: ['miles'],
    },
  },
  {
    name: 'get_upcoming_workouts',
    description:
      "Project Shane's next N lift days forward (day type + phase + full exercise list each), starting from " +
      "today's actual next lift day and continuing the Chest/Back -> Arms/Abs -> Chest/Back -> Arms/Abs -> " +
      "Legs rotation. This is a " +
      'projection, not a fixed schedule — it assumes each prior projected day gets completed on schedule, ' +
      'and always recomputes fresh from whatever was actually last logged. Use this for multi-day planning ' +
      'requests instead of guessing future days yourself.',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'How many upcoming lift days to project, e.g. 3' },
      },
      required: ['count'],
    },
  },
  {
    name: 'get_recovery_snapshot',
    description:
      "Get Shane's latest synced HelioStrip wearable data: resting heart rate, HRV, SpO2, VO2max, stress " +
      'score, steps, and last night\'s sleep (duration + deep/REM/light minutes + sleep score). Use whenever ' +
      'Shane asks about recovery, HRV, sleep quality, resting heart rate, or readiness to train.',
    input_schema: { type: 'object', properties: {} },
  cache_control: { type: 'ephemeral' },
    },
];

async function logWorkout({ date, workout_type, notes, completed }) {
  const row = { user_id: DEFAULT_USER_ID, date: date ?? (await todayLocal()) };
  if (workout_type !== undefined) row.workout_type = workout_type;
  if (notes !== undefined) row.notes = notes;
  if (completed !== undefined) row.completed = completed;

  const { data, error } = await supabase.from('workouts').upsert(row, { onConflict: 'date' }).select().single();
  if (error) throw error;
  return { ok: true, workout: data };
}

async function listWorkouts({ limit }) {
  const n = limit ?? 14;
  const { data, error } = await supabase
    .from('workouts')
    .select('*')
    .order('date', { ascending: false })
    .limit(n);
  if (error) throw error;
  return { ok: true, workouts: data };
}

async function getWorkoutProgress() {
  const { data, error } = await supabase
    .from('workouts')
    .select('*')
    .order('date', { ascending: false })
    .limit(60);
  if (error) throw error;
  const workouts = data ?? [];

  const today = new Date();
  const daysAgo = (dateStr) => Math.floor((today - new Date(dateStr)) / (1000 * 60 * 60 * 24));

  const last7 = workouts.filter((w) => daysAgo(w.date) < 7 && w.completed).length;
  const last30 = workouts.filter((w) => daysAgo(w.date) < 30 && w.completed).length;

  // Consecutive-day streak of completed workouts, walking back from the most recent logged day.
  let streak = 0;
  const sorted = [...workouts].sort((a, b) => new Date(b.date) - new Date(a.date));
  let expectedDate = sorted.length > 0 ? new Date(sorted[0].date) : null;
  for (const w of sorted) {
    if (!w.completed) break;
    const wDate = new Date(w.date);
    if (expectedDate && wDate.getTime() === expectedDate.getTime()) {
      streak += 1;
      expectedDate.setDate(expectedDate.getDate() - 1);
    } else {
      break;
    }
  }

  const typeBreakdown = {};
  for (const w of workouts) {
    if (!w.workout_type) continue;
    typeBreakdown[w.workout_type] = (typeBreakdown[w.workout_type] ?? 0) + 1;
  }

  return {
    ok: true,
    workouts_last_7_days: last7,
    workouts_last_30_days: last30,
    current_streak_days: streak,
    workout_type_breakdown: typeBreakdown,
  };
}

async function findMileageGoal() {
  const { data, error } = await supabase.from('goals').select('*').eq('goal_type', 'Mileage');
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return data.find((g) => g.pinned) || data[0];
}

async function logMileage({ miles, date }) {
  const goal = await findMileageGoal();
  if (!goal) return { ok: false, error: 'No Mileage-type goal found on the dashboard.' };

  const logDate = date ?? (await todayLocal());

  const { data: existingLog, error: existingErr } = await supabase
    .from('goal_logs')
    .select('value')
    .eq('goal_id', goal.id)
    .eq('date', logDate)
    .maybeSingle();
  if (existingErr) throw existingErr;

  const newDayValue = (parseFloat(existingLog?.value) || 0) + miles;

  const { error: logErr } = await supabase
    .from('goal_logs')
    .upsert({ goal_id: goal.id, date: logDate, done: true, value: newDayValue }, { onConflict: 'goal_id,date' });
  if (logErr) throw logErr;

  const newTotal = (parseFloat(goal.current_value) || 0) + miles;
  const { error: goalErr } = await supabase.from('goals').update({ current_value: newTotal }).eq('id', goal.id);
  if (goalErr) throw goalErr;

  return {
    ok: true,
    goal_title: goal.title,
    date: logDate,
    miles_added: miles,
    day_total: newDayValue,
    goal_total: newTotal,
    target: goal.target_value,
    unit: goal.unit,
  };
}

async function getTodaysWorkout() {
  const { data, error } = await supabase.rpc('get_todays_workout');
  if (error) throw error;
  return { ok: true, ...data };
}

async function getUpcomingWorkouts({ count }) {
  const { data, error } = await supabase.rpc('get_upcoming_workouts', {
    p_user_id: DEFAULT_USER_ID,
    p_count: count,
  });
  if (error) throw error;
  return { ok: true, is_projection: true, days: data ?? [] };
}

async function getRecoverySnapshot() {
  const [{ data: metricsRows, error: metricsErr }, { data: sleepRows, error: sleepErr }] = await Promise.all([
    supabase
      .from('wearable_daily_metrics')
      .select('*')
      .eq('user_id', DEFAULT_USER_ID)
      .order('date', { ascending: false })
      .limit(1),
    supabase
      .from('wearable_sleep_sessions')
      .select('*')
      .eq('user_id', DEFAULT_USER_ID)
      .order('date', { ascending: false })
      .limit(1),
  ]);
  if (metricsErr) throw metricsErr;
  if (sleepErr) throw sleepErr;

  const metrics = metricsRows?.[0] ?? null;
  const sleep = sleepRows?.[0] ?? null;

  if (!metrics && !sleep) {
    return { ok: true, has_data: false };
  }

  return {
    ok: true,
    has_data: true,
    date: metrics?.date ?? sleep?.date,
    resting_hr: metrics?.resting_hr ?? null,
    hrv_ms: metrics?.hrv_ms ?? null,
    spo2: metrics?.spo2 ?? null,
    vo2max: metrics?.vo2max ?? null,
    stress_score: metrics?.stress_score ?? null,
    steps: metrics?.steps ?? null,
    active_calories: metrics?.active_calories ?? null,
    sleep: sleep
      ? {
          date: sleep.date,
          total_min: sleep.total_min,
          deep_min: sleep.deep_min,
          rem_min: sleep.rem_min,
          light_min: sleep.light_min,
          awake_min: sleep.awake_min,
          sleep_score: sleep.sleep_score,
          bedtime: sleep.bedtime,
          wake_time: sleep.wake_time,
        }
      : null,
  };
}

async function runFitnessTool(name, input) {
  switch (name) {
    case 'log_workout':
      return logWorkout(input);
    case 'list_workouts':
      return listWorkouts(input);
    case 'get_workout_progress':
      return getWorkoutProgress();
    case 'log_mileage':
      return logMileage(input);
    case 'get_todays_workout':
      return getTodaysWorkout();
    case 'get_upcoming_workouts':
      return getUpcomingWorkouts(input);
    case 'get_recovery_snapshot':
      return getRecoverySnapshot();
    default:
      throw new Error(`Unknown Fitness Coach tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runFitnessAgent(request) {
  let messages = [{ role: 'user', content: request }];
  let finalText = null;
  let guard = 0;

  const scopedMemories = await fetchAgentMemories('fitness_agent');
  const correctionsBlock = formatCorrectionsBlock(scopedMemories);
  const system = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ...(correctionsBlock ? [{ type: 'text', text: correctionsBlock }] : []),
  ];


  while (finalText === null && guard < 6) {
    guard += 1;
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: toolDefs,
      messages,
    });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');

    if (toolUses.length === 0) {
      finalText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const use of toolUses) {
      try {
        const result = await runFitnessTool(use.name, use.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
          is_error: true,
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return finalText || "Fitness Coach got stuck and didn't produce a final answer — try rephrasing the request.";
}
