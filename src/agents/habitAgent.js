import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Habit Tracking Agent, a specialist sub-agent that Alex (Shane Pinho's Chief \
of Staff) delegates habit requests to. You have real tools backed by Shane's LifeOS dashboard "goals" and \
"goal_logs" tables — use them, don't guess or make up numbers.

Your job: help Shane create habits, log daily completions, and report plain factual streaks/consistency/trends \
— not personalized coaching or a program prescription.

Notes on the data:
- "goals" is the dashboard's shared goals table (also used for Savings/Mileage/Completion goals belonging to \
other domains) — you only work with rows where goal_type = 'Habit'. Never read or modify goals of any other \
goal_type; those belong to other parts of the dashboard.
- Existing habits on file include things like "Read every day", "Hit 10,000 steps a day", "Apply to a job \
(2x/week)", and "Meditate every day" — habits are per-title, so always match by title rather than guessing an id.
- create_habit adds a new goal row with goal_type='Habit' (title required; timeframe must be one of 'Yearly', \
'Monthly', 'Seasonal', 'Number' — default to 'Yearly' if Shane doesn't specify).
- "goal_logs" is one row per (habit, date) — log_habit_completion upserts by goal_id+date, so logging again for \
a date already logged just updates that day's entry rather than duplicating it. done is a boolean; value is an \
optional numeric amount for count-based habits (e.g. steps), if Shane gives one.
- get_habit_progress computes, per habit, a consecutive-day streak and completion counts over the last 7/30 \
days — use it whenever Shane asks "how am I doing on my habits" or for a specific habit's consistency. Base any \
observation strictly on what the data shows (e.g. "you've hit meditation 3 of the last 7 days" is fine; a \
specific behavior-change program is not your call to make).
- Fitness workouts and nutrition logging live in separate tables owned by the Fitness Coach and Nutrition Coach \
— don't try to read or write those from here, even if a habit sounds fitness-related (e.g. "Hit 10,000 steps a \
day" is a habit goal, distinct from logged workouts).

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete numbers (dates, counts, streaks) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'create_habit',
    description: "Create a new habit (a goals row with goal_type='Habit'). Use this when Shane wants to start tracking a new habit.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "e.g. 'Read every day', 'Meditate every day'" },
        timeframe: { type: 'string', enum: ['Yearly', 'Monthly', 'Seasonal', 'Number'], description: "Defaults to 'Yearly'" },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_habits',
    description: "List Shane's current habits (goals where goal_type='Habit').",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'log_habit_completion',
    description:
      "Log (or update) whether a habit was done on a given date — upserts by habit+date. Matches the habit " +
      'by title.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Habit title (must match an existing habit)' },
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD), defaults to today' },
        done: { type: 'boolean', description: 'Whether the habit was completed that day, defaults to true' },
        value: { type: 'number', description: 'Optional numeric amount for count-based habits (e.g. steps taken)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'get_habit_progress',
    description:
      'Compute plain per-habit consistency facts: current consecutive-day streak and completion counts over ' +
      'the last 7 and 30 days. Use this for "how am I doing on my habits" questions.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional — limit to one habit by title; omit for all habits' },
      },
    },
  },
];

async function findHabitByTitle(title) {
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('goal_type', 'Habit')
    .eq('title', title)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createHabit({ title, timeframe }) {
  const row = { user_id: DEFAULT_USER_ID, title, goal_type: 'Habit', timeframe: timeframe ?? 'Yearly' };
  const { data, error } = await supabase.from('goals').insert(row).select().single();
  if (error) throw error;
  return { ok: true, habit: data };
}

async function listHabits() {
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('goal_type', 'Habit')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return { ok: true, habits: data };
}

async function logHabitCompletion({ title, date, done, value }) {
  const habit = await findHabitByTitle(title);
  if (!habit) return { ok: false, error: `No habit found named '${title}'` };

  const row = {
    goal_id: habit.id,
    date: date ?? new Date().toISOString().slice(0, 10),
    done: done ?? true,
  };
  if (value !== undefined) row.value = value;

  const { data, error } = await supabase
    .from('goal_logs')
    .upsert(row, { onConflict: 'goal_id,date' })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, habit_log: data };
}

async function computeHabitProgress(habit) {
  const { data, error } = await supabase
    .from('goal_logs')
    .select('*')
    .eq('goal_id', habit.id)
    .order('date', { ascending: false })
    .limit(60);
  if (error) throw error;
  const logs = data ?? [];

  const today = new Date();
  const daysAgo = (dateStr) => Math.floor((today - new Date(dateStr)) / (1000 * 60 * 60 * 24));

  const last7 = logs.filter((l) => daysAgo(l.date) < 7 && l.done).length;
  const last30 = logs.filter((l) => daysAgo(l.date) < 30 && l.done).length;

  let streak = 0;
  const sorted = [...logs].sort((a, b) => new Date(b.date) - new Date(a.date));
  let expectedDate = sorted.length > 0 ? new Date(sorted[0].date) : null;
  for (const l of sorted) {
    if (!l.done) break;
    const lDate = new Date(l.date);
    if (expectedDate && lDate.getTime() === expectedDate.getTime()) {
      streak += 1;
      expectedDate.setDate(expectedDate.getDate() - 1);
    } else {
      break;
    }
  }

  return {
    title: habit.title,
    completions_last_7_days: last7,
    completions_last_30_days: last30,
    current_streak_days: streak,
  };
}

async function getHabitProgress({ title }) {
  if (title) {
    const habit = await findHabitByTitle(title);
    if (!habit) return { ok: false, error: `No habit found named '${title}'` };
    return { ok: true, progress: [await computeHabitProgress(habit)] };
  }

  const { data, error } = await supabase.from('goals').select('*').eq('goal_type', 'Habit');
  if (error) throw error;
  const habits = data ?? [];
  const progress = await Promise.all(habits.map((h) => computeHabitProgress(h)));
  return { ok: true, progress };
}

async function runHabitTool(name, input) {
  switch (name) {
    case 'create_habit':
      return createHabit(input);
    case 'list_habits':
      return listHabits();
    case 'log_habit_completion':
      return logHabitCompletion(input);
    case 'get_habit_progress':
      return getHabitProgress(input);
    default:
      throw new Error(`Unknown Habit Tracking Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runHabitAgent(request) {
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
        const result = await runHabitTool(use.name, use.input);
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

  return finalText || "Habit Tracking Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
