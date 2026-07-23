import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Mental Wellness Agent, a specialist sub-agent that Alex (Shane Pinho's Chief \
of Staff) delegates mood/stress check-in requests to. You have real tools backed by Shane's LifeOS dashboard \
"mood_logs" table — use them, don't guess or make up numbers.

Your job is strictly limited to: logging mood/stress check-ins, reporting plain factual trends over time, and \
offering general, well-known mindfulness suggestions (e.g. a short breathing exercise, taking a walk, journaling) \
when Shane asks for one.

Hard limits — this is a deliberately conservative agent, not a therapist:
- You do NOT diagnose, interpret symptoms clinically, or give therapeutic/clinical mental-health advice.
- You do NOT try to talk Shane through an acute crisis. If anything in a check-in sounds like it could be more \
than routine stress (e.g. persistent hopelessness, distress that sounds serious, mentions of self-harm), do not \
attempt to handle it yourself — say plainly in your final answer that this sounds like more than a routine \
check-in and that Shane should reach out to a real support resource or someone he trusts, and note it clearly \
so Alex sees it. Never minimize what he's told you and never diagnose.
- Mindfulness suggestions you offer should be generic, low-risk, and well-known (breathing exercises, short \
walks, journaling prompts) — never anything positioned as treatment.

Notes on the data:
- "mood_logs" is one row per check-in — there's no unique constraint, so Shane can log multiple check-ins per \
day (e.g. morning and evening) and log_mood_checkin always inserts a new row.
- mood and stress are both integers 1-5 (mood: 1=very low, 5=very good; stress: 1=very low stress, 5=very high \
stress). Only set them if Shane actually gives a number or a clear equivalent (e.g. "pretty stressed today" ~4); \
don't force a number if he doesn't give one.
- get_mood_trend looks at recent history and reports plain facts: average mood and average stress over the \
last 7 and 30 days, and how many check-ins were logged. Use it whenever Shane asks how he's been doing \
emotionally lately — report the numbers plainly, don't editorialize on what they mean clinically.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete numbers (dates, mood/stress scores, averages) rather than vague \
summaries, except when flagging a possible crisis per the hard limits above.`;

const toolDefs = [
  {
    name: 'log_mood_checkin',
    description: 'Log a new mood/stress check-in (always inserts, multiple per day allowed).',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD), defaults to today' },
        mood: { type: 'integer', description: 'Mood 1-5 (1=very low, 5=very good), if given' },
        stress: { type: 'integer', description: 'Stress 1-5 (1=very low, 5=very high), if given' },
        notes: { type: 'string', description: 'Free-text notes about how Shane is feeling' },
      },
    },
  },
  {
    name: 'list_mood_checkins',
    description: "List Shane's recent mood/stress check-ins, most recent first.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many to return, default 14' },
      },
    },
  },
  {
    name: 'get_mood_trend',
    description:
      'Compute plain average mood/stress facts over the last 7 and 30 days, and how many check-ins were ' +
      'logged in each window. Use this for "how have I been feeling" / trend questions.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function logMoodCheckin({ date, mood, stress, notes }) {
  const row = { user_id: DEFAULT_USER_ID, date: date ?? new Date().toISOString().slice(0, 10) };
  if (mood !== undefined) row.mood = mood;
  if (stress !== undefined) row.stress = stress;
  if (notes !== undefined) row.notes = notes;

  const { data, error } = await supabase.from('mood_logs').insert(row).select().single();
  if (error) throw error;
  return { ok: true, checkin: data };
}

async function listMoodCheckins({ limit }) {
  const n = limit ?? 14;
  const { data, error } = await supabase
    .from('mood_logs')
    .select('*')
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(n);
  if (error) throw error;
  return { ok: true, checkins: data };
}

async function getMoodTrend() {
  const { data, error } = await supabase
    .from('mood_logs')
    .select('*')
    .order('date', { ascending: false })
    .limit(200);
  if (error) throw error;
  const checkins = data ?? [];

  const today = new Date();
  const daysAgo = (dateStr) => Math.floor((today - new Date(dateStr)) / (1000 * 60 * 60 * 24));

  function statsFor(windowDays) {
    const inWindow = checkins.filter((c) => daysAgo(c.date) < windowDays);
    const moodLogs = inWindow.filter((c) => c.mood != null);
    const stressLogs = inWindow.filter((c) => c.stress != null);
    return {
      checkins_logged: inWindow.length,
      avg_mood: moodLogs.length > 0 ? Math.round((moodLogs.reduce((a, c) => a + c.mood, 0) / moodLogs.length) * 10) / 10 : null,
      avg_stress: stressLogs.length > 0 ? Math.round((stressLogs.reduce((a, c) => a + c.stress, 0) / stressLogs.length) * 10) / 10 : null,
    };
  }

  return {
    ok: true,
    last_7_days: statsFor(7),
    last_30_days: statsFor(30),
  };
}

async function runMentalWellnessTool(name, input) {
  switch (name) {
    case 'log_mood_checkin':
      return logMoodCheckin(input);
    case 'list_mood_checkins':
      return listMoodCheckins(input);
    case 'get_mood_trend':
      return getMoodTrend();
    default:
      throw new Error(`Unknown Mental Wellness Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runMentalWellnessAgent(request) {
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
        const result = await runMentalWellnessTool(use.name, use.input);
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

  return finalText || "Mental Wellness Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
