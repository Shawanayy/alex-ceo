import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Sleep Coach, a specialist sub-agent that Alex (Shane Pinho's Chief of Staff) \
delegates sleep requests to. You have real tools backed by Shane's LifeOS dashboard "sleep_logs" table — use \
them, don't guess or make up numbers.

Your job: help Shane log a night's sleep, review recent sleep history, report plain factual trends (average \
hours, average quality, consistency), and offer general bedtime-routine suggestions grounded in what the data \
actually shows — not personalized medical or clinical sleep-disorder advice.

Notes on the data:
- "sleep_logs" is one row per calendar date, unique per (user, date) — log_sleep upserts by date, so logging \
again for a date already logged just updates that night's entry rather than duplicating it.
- bedtime/wake_time are timestamps (accept whatever time Shane gives you, e.g. "11:30pm" / "6:45am" — combine \
with the given date as needed); hours_slept is a plain number of hours; quality is an integer 1-5 (1=terrible, \
5=great).
- source defaults to 'Manual'. Shane doesn't have a wearable yet — once he gets one (e.g. Apple Watch), sleep \
data may start arriving with source set to that device instead; don't worry about that path for now.
- get_sleep_progress looks at recent history and reports plain facts: average hours slept and average quality \
over the last 7 and 30 days, and how many nights were logged. Use it whenever Shane asks "how's my sleep been" \
or for a trend/routine suggestion — base any suggestion strictly on what the data shows (e.g. "you've averaged \
5.5 hours the last 7 days, well below your usual 7" is fine; specific clinical advice is not your call to make).

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete numbers (dates, hours, quality scores, averages) rather than vague \
summaries.`;

const toolDefs = [
  {
    name: 'log_sleep',
    description:
      "Log (or update) a night's sleep for a given date — upserts by date. Use this whenever Shane says how " +
      'he slept.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD) the sleep is attributed to, defaults to today' },
        bedtime: { type: 'string', description: 'ISO timestamp or time Shane went to bed, if known' },
        wake_time: { type: 'string', description: 'ISO timestamp or time Shane woke up, if known' },
        hours_slept: { type: 'number', description: 'Total hours slept, if known' },
        quality: { type: 'integer', description: 'Sleep quality 1-5 (1=terrible, 5=great), if given' },
        notes: { type: 'string', description: 'Any free-text notes, e.g. woke up multiple times' },
      },
    },
  },
  {
    name: 'list_sleep_logs',
    description: "List Shane's recently logged sleep, most recent first.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many to return, default 14' },
      },
    },
  },
  {
    name: 'get_sleep_progress',
    description:
      'Compute plain average-hours/average-quality facts over the last 7 and 30 days, and how many nights ' +
      'were logged in each window. Use this for "how is my sleep" / trend / routine-suggestion questions.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function logSleep({ date, bedtime, wake_time, hours_slept, quality, notes }) {
  const row = { user_id: DEFAULT_USER_ID, date: date ?? new Date().toISOString().slice(0, 10) };
  if (bedtime !== undefined) row.bedtime = bedtime;
  if (wake_time !== undefined) row.wake_time = wake_time;
  if (hours_slept !== undefined) row.hours_slept = hours_slept;
  if (quality !== undefined) row.quality = quality;
  if (notes !== undefined) row.notes = notes;

  const { data, error } = await supabase
    .from('sleep_logs')
    .upsert(row, { onConflict: 'user_id,date' })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, sleep_log: data };
}

async function listSleepLogs({ limit }) {
  const n = limit ?? 14;
  const { data, error } = await supabase
    .from('sleep_logs')
    .select('*')
    .order('date', { ascending: false })
    .limit(n);
  if (error) throw error;
  return { ok: true, sleep_logs: data };
}

async function getSleepProgress() {
  const { data, error } = await supabase
    .from('sleep_logs')
    .select('*')
    .order('date', { ascending: false })
    .limit(60);
  if (error) throw error;
  const logs = data ?? [];

  const today = new Date();
  const daysAgo = (dateStr) => Math.floor((today - new Date(dateStr)) / (1000 * 60 * 60 * 24));

  function statsFor(windowDays) {
    const inWindow = logs.filter((l) => daysAgo(l.date) < windowDays);
    const nightsLogged = inWindow.length;
    if (nightsLogged === 0) return { nights_logged: 0, avg_hours_slept: 0, avg_quality: 0 };
    const hoursSum = inWindow.reduce((acc, l) => acc + Number(l.hours_slept ?? 0), 0);
    const qualityLogs = inWindow.filter((l) => l.quality != null);
    const qualitySum = qualityLogs.reduce((acc, l) => acc + l.quality, 0);
    return {
      nights_logged: nightsLogged,
      avg_hours_slept: Math.round((hoursSum / nightsLogged) * 10) / 10,
      avg_quality: qualityLogs.length > 0 ? Math.round((qualitySum / qualityLogs.length) * 10) / 10 : null,
    };
  }

  return {
    ok: true,
    last_7_days: statsFor(7),
    last_30_days: statsFor(30),
  };
}

async function runSleepTool(name, input) {
  switch (name) {
    case 'log_sleep':
      return logSleep(input);
    case 'list_sleep_logs':
      return listSleepLogs(input);
    case 'get_sleep_progress':
      return getSleepProgress();
    default:
      throw new Error(`Unknown Sleep Coach tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runSleepAgent(request) {
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
        const result = await runSleepTool(use.name, use.input);
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

  return finalText || "Sleep Coach got stuck and didn't produce a final answer — try rephrasing the request.";
}
