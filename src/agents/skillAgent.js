import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Skill Development Agent, a specialist sub-agent that Alex (Shane Pinho's \
Chief of Staff) delegates skill-building requests to. You have real tools backed by Shane's Supabase data — \
use them, don't guess or invent skills, milestones, sessions, or resources that aren't actually there.

Your job covers ANY skill Shane wants to get better at — technical or not, whether or not it overlaps with \
a class he's taking (e.g. "get better at Python for CS 361" belongs here just as much as "learn public \
speaking" or "get better at Revit"). This is distinct from the Learning & Career Agent, which owns his actual \
classes, assignments, grades, and Canvas sync — if Shane wants an assignment logged or a grade updated, that's \
not you. If he wants to build a durable capability through deliberate practice, that's you.

Your four responsibilities:
1. **Skills** — add_skill to start tracking something new (name, category, what he's aiming for). list_skills \
to review what's active/paused/completed. update_skill to change its status or description (e.g. mark \
'completed' once he's satisfied with where it's at, or 'paused' if he's stepping away from it).
2. **Milestones** — add_milestone to set a concrete checkpoint for a skill (e.g. "finish the intro AutoCAD \
course", "give a 5-minute practice talk"). list_milestones to review progress. complete_milestone to mark one \
done. Always resolve the skill_id via list_skills first if you don't already have it — never invent one.
3. **Practice sessions** — schedule_practice_session logs a planned or just-completed practice block tied to \
a skill (when, how long, notes). list_practice_sessions reviews history/upcoming sessions. \
complete_practice_session marks a scheduled one done and can attach notes on how it went. If Shane just tells \
you about practice he already did, log it as scheduled_at = now and immediately call \
complete_practice_session, or just note it directly — use judgment based on his phrasing.
4. **Resources** — add_resource saves a link/material (article, course, video, book) tied to a skill so it \
can be found later. list_resources pulls up what's saved for a skill.

Always resolve skill_id from list_skills (matching by name) rather than asking Shane for a UUID — he'll refer \
to skills by name in conversation.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Include concrete details (skill name, milestone/session specifics) rather than vague \
summaries.`;

const toolDefs = [
  {
    name: 'add_skill',
    description: "Start tracking a new skill Shane wants to develop.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name, e.g. "Public speaking" or "Revit"' },
        category: { type: 'string', description: 'Optional grouping, e.g. "engineering software", "soft skill"' },
        description: { type: 'string', description: 'What he wants to achieve / current level, in his words' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_skills',
    description: "List Shane's tracked skills, optionally filtered by status.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'paused', 'completed', 'all'], description: "Defaults to 'active'." },
      },
    },
  },
  {
    name: 'update_skill',
    description: "Update a skill's status, category, or description by its id (get the id from list_skills).",
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused', 'completed'] },
        category: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['skill_id'],
    },
  },
  {
    name: 'add_milestone',
    description: "Add a concrete checkpoint/milestone for a skill.",
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'Get from list_skills by matching the skill name.' },
        title: { type: 'string' },
        description: { type: 'string' },
        target_date: { type: 'string', description: 'YYYY-MM-DD, optional' },
      },
      required: ['skill_id', 'title'],
    },
  },
  {
    name: 'list_milestones',
    description: "List milestones, optionally filtered to one skill and/or status.",
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'done', 'all'], description: "Defaults to 'all'." },
      },
    },
  },
  {
    name: 'complete_milestone',
    description: "Mark a milestone as done by its id (get the id from list_milestones).",
    input_schema: {
      type: 'object',
      properties: { milestone_id: { type: 'string' } },
      required: ['milestone_id'],
    },
  },
  {
    name: 'schedule_practice_session',
    description:
      "Log a practice session for a skill — either a planned future session or one Shane just completed. " +
      "Use status: 'completed' with completed_notes if he's describing practice he already did.",
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'Get from list_skills by matching the skill name.' },
        scheduled_at: { type: 'string', description: 'ISO datetime — when it is/was, defaults to now.' },
        duration_minutes: { type: 'integer' },
        status: { type: 'string', enum: ['scheduled', 'completed'], description: "Defaults to 'scheduled'." },
        notes: { type: 'string' },
      },
      required: ['skill_id'],
    },
  },
  {
    name: 'list_practice_sessions',
    description: "List practice sessions, optionally filtered to one skill and/or status.",
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string' },
        status: { type: 'string', enum: ['scheduled', 'completed', 'all'], description: "Defaults to 'all'." },
      },
    },
  },
  {
    name: 'complete_practice_session',
    description: "Mark a scheduled practice session as completed, with optional notes on how it went.",
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'add_resource',
    description: "Save a link/material (article, course, video, book) tied to a skill.",
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'Get from list_skills by matching the skill name.' },
        title: { type: 'string' },
        url: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['skill_id'],
    },
  },
  {
    name: 'list_resources',
    description: "List saved resources, optionally filtered to one skill.",
    input_schema: {
      type: 'object',
      properties: { skill_id: { type: 'string' } },
    },
  },
];

async function addSkill({ name, category, description }) {
  const { data, error } = await supabase
    .from('skills')
    .insert({
      user_id: DEFAULT_USER_ID,
      name,
      category: category ?? null,
      description: description ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, skill: data };
}

async function listSkills({ status }) {
  let query = supabase.from('skills').select('*').eq('user_id', DEFAULT_USER_ID).order('created_at', { ascending: false });
  if (status && status !== 'all') query = query.eq('status', status);
  else if (!status) query = query.eq('status', 'active');
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, skills: data };
}

async function updateSkill({ skill_id, status, category, description }) {
  const payload = { updated_at: new Date().toISOString() };
  if (status !== undefined) payload.status = status;
  if (category !== undefined) payload.category = category;
  if (description !== undefined) payload.description = description;
  const { data, error } = await supabase
    .from('skills')
    .update(payload)
    .eq('id', skill_id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, skill: data };
}

async function addMilestone({ skill_id, title, description, target_date }) {
  const { data, error } = await supabase
    .from('skill_milestones')
    .insert({
      user_id: DEFAULT_USER_ID,
      skill_id,
      title,
      description: description ?? null,
      target_date: target_date ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, milestone: data };
}

async function listMilestones({ skill_id, status }) {
  let query = supabase
    .from('skill_milestones')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('created_at', { ascending: false });
  if (skill_id) query = query.eq('skill_id', skill_id);
  if (status && status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, milestones: data };
}

async function completeMilestone({ milestone_id }) {
  const { data, error } = await supabase
    .from('skill_milestones')
    .update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('id', milestone_id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, milestone: data };
}

async function schedulePracticeSession({ skill_id, scheduled_at, duration_minutes, status, notes }) {
  const effectiveStatus = status ?? 'scheduled';
  const payload = {
    user_id: DEFAULT_USER_ID,
    skill_id,
    scheduled_at: scheduled_at ?? new Date().toISOString(),
    duration_minutes: duration_minutes ?? null,
    status: effectiveStatus,
    notes: notes ?? null,
  };
  if (effectiveStatus === 'completed') payload.completed_at = new Date().toISOString();
  const { data, error } = await supabase.from('practice_sessions').insert(payload).select().single();
  if (error) throw error;
  return { ok: true, session: data };
}

async function listPracticeSessions({ skill_id, status }) {
  let query = supabase
    .from('practice_sessions')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('scheduled_at', { ascending: false });
  if (skill_id) query = query.eq('skill_id', skill_id);
  if (status && status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, sessions: data };
}

async function completePracticeSession({ session_id, notes }) {
  const payload = { status: 'completed', completed_at: new Date().toISOString() };
  if (notes !== undefined) payload.notes = notes;
  const { data, error } = await supabase
    .from('practice_sessions')
    .update(payload)
    .eq('id', session_id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, session: data };
}

async function addResource({ skill_id, title, url, notes }) {
  const { data, error } = await supabase
    .from('skill_resources')
    .insert({
      user_id: DEFAULT_USER_ID,
      skill_id,
      title: title ?? null,
      url: url ?? null,
      notes: notes ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, resource: data };
}

async function listResources({ skill_id }) {
  let query = supabase
    .from('skill_resources')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('created_at', { ascending: false });
  if (skill_id) query = query.eq('skill_id', skill_id);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, resources: data };
}

async function runSkillTool(name, input) {
  switch (name) {
    case 'add_skill':
      return addSkill(input);
    case 'list_skills':
      return listSkills(input);
    case 'update_skill':
      return updateSkill(input);
    case 'add_milestone':
      return addMilestone(input);
    case 'list_milestones':
      return listMilestones(input);
    case 'complete_milestone':
      return completeMilestone(input);
    case 'schedule_practice_session':
      return schedulePracticeSession(input);
    case 'list_practice_sessions':
      return listPracticeSessions(input);
    case 'complete_practice_session':
      return completePracticeSession(input);
    case 'add_resource':
      return addResource(input);
    case 'list_resources':
      return listResources(input);
    default:
      throw new Error(`Unknown Skill Development Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runSkillAgent(request) {
  let messages = [{ role: 'user', content: request }];
  let finalText = null;
  let guard = 0;

  while (finalText === null && guard < 6) {
    guard += 1;
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
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
        const result = await runSkillTool(use.name, use.input);
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

  return finalText || "Skill Development Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
