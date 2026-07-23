import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
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
- Shane may also have a "Hit 10,000 steps a day" or mileage-type habit/goal tracked separately by the Habit \
Tracking Agent — that's a different system (dashboard goals), don't try to read or write it from here.

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
];

async function logWorkout({ date, workout_type, notes, completed }) {
  const row = { user_id: DEFAULT_USER_ID, date: date ?? new Date().toISOString().slice(0, 10) };
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

async function runFitnessTool(name, input) {
  switch (name) {
    case 'log_workout':
      return logWorkout(input);
    case 'list_workouts':
      return listWorkouts(input);
    case 'get_workout_progress':
      return getWorkoutProgress();
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

  while (finalText === null && guard < 6) {
    guard += 1;
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
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
