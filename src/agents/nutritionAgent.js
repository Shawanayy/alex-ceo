import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';
import { todayLocal } from '../utils/localDate.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Nutrition Coach, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates diet/food requests to. You have real tools backed by Shane's LifeOS dashboard "nutrition_logs" \
table — use them, don't guess or make up numbers.

Your job: help Shane log meals, review what he's eaten, report plain factual calorie/macro totals and trends, \
and offer general grocery/meal suggestions when asked — not personalized medical or clinical dietary advice.

Notes on the data:
- "nutrition_logs" is one row per logged meal (not per day) — Shane can log breakfast, lunch, dinner, and \
snacks separately for the same date, so log_meal always inserts a new row rather than upserting.
- calories/protein/carbs/fat are estimates you must ALWAYS provide on every log_meal call, using your general \
nutrition knowledge for the food(s) described — e.g. "2 cans of tuna and a bowl of white rice" ≈ 520 cal / 56g \
protein / 68g carbs / 3g fat. Do not call log_meal with these fields left blank just because Shane didn't give \
exact numbers himself; estimate them yourself every time, including for a second/third/etc. meal that repeats \
something logged earlier today — always attach a fresh estimate to that new row, don't leave it empty. Only \
skip a field if the description is too vague to estimate at all (e.g. "I ate something small"). sugar is \
optional and can stay blank unless known or reasonably estimable.
- IMPORTANT — avoiding duplicate rows: each delegation from Alex is a fresh, memoryless request, so if Shane \
first reports a meal (logged with some fields missing) and then, in a *separate* follow-up delegation, supplies \
the missing calorie/macro numbers for that *same* meal, do NOT call log_meal again — that creates a second, \
orphaned row. Instead call list_meals({ date: today, limit: 5 }) first, find the most recent entry from today \
that's missing those fields and plausibly matches what Shane is describing, and call update_meal on that row's \
id. Only use log_meal when Shane is describing a meal that hasn't been logged yet at all.
- get_daily_totals sums calories/protein/carbs/fat for a given date (default today) across all meals logged \
that day — use it whenever Shane asks "how many calories today" or similar.
- get_nutrition_progress looks at recent history and reports plain facts: average daily calories/protein/carbs/ \
fat over the last 7 and 30 days, and how many days had at least one meal logged. Use it for "how am I doing" / \
progress questions — base any suggestion strictly on what the data shows.
- Grocery/meal suggestions are general free-text ideas (not stored anywhere) — fine to offer when Shane asks, \
but don't present them as personalized medical/dietary advice.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Always include concrete numbers (dates, totals, averages) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'log_meal',
    description:
      'Log a brand-new meal entry that has not been logged yet (always inserts, does not overwrite prior ' +
      'meals for the same date). Use this when Shane describes a meal for the first time. Do NOT use this for ' +
      "a follow-up that's just adding calorie/macro numbers to a meal already logged earlier — use update_meal " +
      'for that instead. Always estimate calories/protein/carbs/fat yourself before calling this — do not leave ' +
      'them blank just because Shane gave no exact numbers, and re-estimate fresh every time even if a similar ' +
      'meal was already logged today.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD), defaults to today' },
        meal_name: { type: 'string', description: "e.g. 'Chicken and rice', 'Protein shake'" },
        calories: { type: 'integer', description: 'Estimated calories — always provide your best estimate' },
        protein: { type: 'integer', description: 'Estimated grams of protein — always provide your best estimate' },
        carbs: { type: 'integer', description: 'Estimated grams of carbs — always provide your best estimate' },
        fat: { type: 'number', description: 'Estimated grams of fat — always provide your best estimate' },
        sugar: { type: 'number', description: 'Grams of sugar, if known or reasonably estimable' },
        image_url: { type: 'string', description: 'Optional photo URL of the meal' },
      },
    },
  },
  {
    name: 'update_meal',
    description:
      'Update an already-logged meal entry by id — use this for follow-up messages that add or correct ' +
      'calorie/macro numbers for a meal Shane already reported, instead of calling log_meal again and creating ' +
      'a duplicate row. Only the fields provided are changed.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id of the nutrition_logs row to update (from list_meals)' },
        meal_name: { type: 'string' },
        calories: { type: 'integer', description: 'Calories, if known' },
        protein: { type: 'integer', description: 'Grams of protein, if known' },
        carbs: { type: 'integer', description: 'Grams of carbs, if known' },
        fat: { type: 'number', description: 'Grams of fat, if known' },
        sugar: { type: 'number', description: 'Grams of sugar, if known' },
        image_url: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_meals',
    description: "List Shane's recently logged meals, most recent first. Optionally filter to a single date.",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD) to filter to a single day, optional' },
        limit: { type: 'integer', description: 'How many to return, default 20' },
      },
    },
  },
  {
    name: 'get_daily_totals',
    description: "Sum calories/protein/carbs/fat across all meals logged for a given date (default today).",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD), defaults to today' },
      },
    },
  },
  {
    name: 'get_nutrition_progress',
    description:
      'Compute plain average-calorie/protein/carbs/fat facts over the last 7 and 30 days, and how many of ' +
      'those days had at least one meal logged. Use this for "how am I doing" / progress questions.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function logMeal({ date, meal_name, calories, protein, carbs, fat, sugar, image_url }) {
  const row = { user_id: DEFAULT_USER_ID, date: date ?? (await todayLocal()) };
  if (meal_name !== undefined) row.meal_name = meal_name;
  if (calories !== undefined) row.calories = calories;
  if (protein !== undefined) row.protein = protein;
  if (carbs !== undefined) row.carbs = carbs;
  if (fat !== undefined) row.fat = fat;
  if (sugar !== undefined) row.sugar = sugar;
  if (image_url !== undefined) row.image_url = image_url;

  const { data, error } = await supabase.from('nutrition_logs').insert(row).select().single();
  if (error) throw error;
  return { ok: true, meal: data };
}

async function updateMeal({ id, meal_name, calories, protein, carbs, fat, sugar, image_url }) {
  if (!id) throw new Error('update_meal requires an id (use list_meals to find it)');
  const patch = {};
  if (meal_name !== undefined) patch.meal_name = meal_name;
  if (calories !== undefined) patch.calories = calories;
  if (protein !== undefined) patch.protein = protein;
  if (carbs !== undefined) patch.carbs = carbs;
  if (fat !== undefined) patch.fat = fat;
  if (sugar !== undefined) patch.sugar = sugar;
  if (image_url !== undefined) patch.image_url = image_url;

  const { data, error } = await supabase.from('nutrition_logs').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return { ok: true, meal: data };
}

async function listMeals({ date, limit }) {
  const n = limit ?? 20;
  let query = supabase.from('nutrition_logs').select('*').order('date', { ascending: false }).order('created_at', { ascending: false }).limit(n);
  if (date) query = query.eq('date', date);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, meals: data };
}

async function getDailyTotals({ date }) {
  const day = date ?? (await todayLocal());
  const { data, error } = await supabase.from('nutrition_logs').select('*').eq('date', day);
  if (error) throw error;
  const meals = data ?? [];
  const totals = meals.reduce(
    (acc, m) => ({
      calories: acc.calories + (m.calories ?? 0),
      protein: acc.protein + (m.protein ?? 0),
      carbs: acc.carbs + (m.carbs ?? 0),
      fat: acc.fat + Number(m.fat ?? 0),
      sugar: acc.sugar + Number(m.sugar ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0 }
  );
  return { ok: true, date: day, meals_logged: meals.length, totals };
}

async function getNutritionProgress() {
  const { data, error } = await supabase
    .from('nutrition_logs')
    .select('*')
    .order('date', { ascending: false })
    .limit(300);
  if (error) throw error;
  const meals = data ?? [];

  const today = new Date();
  const daysAgo = (dateStr) => Math.floor((today - new Date(dateStr)) / (1000 * 60 * 60 * 24));

  function averagesFor(windowDays) {
    const inWindow = meals.filter((m) => daysAgo(m.date) < windowDays);
    const daysLogged = new Set(inWindow.map((m) => m.date)).size;
    if (daysLogged === 0) {
      return {
        days_logged: 0,
        avg_daily_calories: 0,
        avg_daily_protein: 0,
        avg_daily_carbs: 0,
        avg_daily_fat: 0,
        avg_daily_sugar: 0,
      };
    }
    const totals = inWindow.reduce(
      (acc, m) => ({
        calories: acc.calories + (m.calories ?? 0),
        protein: acc.protein + (m.protein ?? 0),
        carbs: acc.carbs + (m.carbs ?? 0),
        fat: acc.fat + Number(m.fat ?? 0),
        sugar: acc.sugar + Number(m.sugar ?? 0),
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0 }
    );
    return {
      days_logged: daysLogged,
      avg_daily_calories: Math.round(totals.calories / daysLogged),
      avg_daily_protein: Math.round(totals.protein / daysLogged),
      avg_daily_carbs: Math.round(totals.carbs / daysLogged),
      avg_daily_fat: Math.round((totals.fat / daysLogged) * 10) / 10,
      avg_daily_sugar: Math.round((totals.sugar / daysLogged) * 10) / 10,
    };
  }

  return {
    ok: true,
    last_7_days: averagesFor(7),
    last_30_days: averagesFor(30),
  };
}

async function runNutritionTool(name, input) {
  switch (name) {
    case 'log_meal':
      return logMeal(input);
    case 'update_meal':
      return updateMeal(input);
    case 'list_meals':
      return listMeals(input);
    case 'get_daily_totals':
      return getDailyTotals(input);
    case 'get_nutrition_progress':
      return getNutritionProgress();
    default:
      throw new Error(`Unknown Nutrition Coach tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runNutritionAgent(request) {
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
        const result = await runNutritionTool(use.name, use.input);
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

  return finalText || "Nutrition Coach got stuck and didn't produce a final answer — try rephrasing the request.";
}
