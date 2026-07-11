import { supabase } from './supabaseClient.js';
import { runAdminAgent } from './agents/adminAgent.js';
import { runLearningAgent } from './agents/learningAgent.js';
import { runCareerAgent } from './agents/careerAgent.js';
import { runResumeAgent } from './agents/resumeAgent.js';

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

// Anthropic tool-use definitions. Keep this list honest: only include a tool
// here once the underlying capability actually works end-to-end.
export const toolDefs = [
  {
    name: 'add_task',
    description:
      "Add a new task to Alex's OWN internal task list in Supabase (separate from Shane's LifeOS " +
      "dashboard). Do NOT use this for todos Shane wants tracked on his dashboard — use trigger_n8n for " +
      'those instead. Only use add_task when Shane explicitly wants something tracked just within Alex, ' +
      'not on the dashboard.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Optional longer detail' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_tasks',
    description: "List Shane's tasks, optionally filtered by status.",
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done', 'all'],
          description: "Filter by status, or 'all' for everything. Defaults to pending.",
        },
      },
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done by its id (get the id from list_tasks first).',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'UUID of the task' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'remember',
    description:
      "Save a fact, preference, or routine about Shane to long-term memory, so future conversations can use it.",
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact/preference to remember, written plainly' },
        memory_type: {
          type: 'string',
          enum: ['preference', 'fact', 'routine', 'other'],
        },
        importance: {
          type: 'integer',
          description: '1 (minor) to 5 (critical, always keep in context)',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'delegate_to_admin_agent',
    description:
      "Hand a Calendar or Gmail request off to the Admin Agent, a specialist sub-agent with real Google " +
      'Calendar and Gmail access. Use this for: checking/creating calendar events, and reading email or ' +
      'creating email drafts (the Admin Agent can NEVER send email — drafts only). Pass along enough ' +
      'context in the request for it to act without needing to ask Shane anything else.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do (include dates/times, names, email addresses, etc. as needed).',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_learning_agent',
    description:
      'Hand a coursework or study request off to the Learning & Career Agent, a specialist sub-agent with ' +
      "real access to Shane's classes, assignments, grades, study sessions, and spaced-repetition " +
      'flashcards. Use this for: adding/listing classes or assignments, updating assignment status or ' +
      'grades, scheduling or completing study sessions, adding/reviewing flashcards, generating a written ' +
      'study guide for a class or topic, and importing a syllabus (raw extracted text) to log its exams ' +
      'and auto-schedule study sessions. Pass along enough context (class name, due dates, syllabus text, ' +
      'etc.) for it to act without asking Shane anything else.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_career_coach',
    description:
      "Hand a job search, LinkedIn, or interview prep request off to the Career Coach, a specialist " +
      "sub-agent with real access to Shane's career profile (resume, cover letters, education, skills), " +
      'live job search via Adzuna, and his tracked applications. Use this for: searching for jobs (side ' +
      "jobs/part-time work near Corvallis/OSU, or engineering internships in Oahu), listing or updating the " +
      "status of jobs he's applied to (applied, interviewing, offer, rejected, not interested), drafting a " +
      "LinkedIn post about something he did (draft only, never actually posted), and generating interview " +
      'prep tied to a specific application. Pass along enough context (job title/company/id when updating ' +
      'status, event description for LinkedIn posts, which application for interview prep) for it to act ' +
      'without asking Shane anything else.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_resume_agent',
    description:
      "Hand a resume, portfolio, or cover letter request off to the Resume & Portfolio Agent, a " +
      "specialist sub-agent with real access to Shane's resume text, portfolio items, and cover letters " +
      "(shares his career_profile with the Career Coach, but only the Career Coach updates application " +
      "status). Use this for: updating/adding to his resume text, adding or listing portfolio " +
      "projects/work, syncing portfolio items automatically from his resume, and generating a cover " +
      "letter tied to a specific tracked job application (need the application — company/title is enough, " +
      "it will look up the id). Pass along enough context (the exact update/addition, or which application " +
      'the cover letter is for) for it to act without asking Shane anything else.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'trigger_n8n',
    description:
      "DEFAULT tool for anything that belongs on Shane's LifeOS dashboard. Use this — not add_task, not " +
      'remember, not log_gap — whenever Shane mentions a todo, a goal, a calendar-related note (that is ' +
      "not a request to actually create/check a real Google Calendar event — that's the Admin Agent's " +
      'job), a finance item, coursework/learning item, or anything else that sounds like something his ' +
      'dashboard tracks. If in doubt whether something is a dashboard capture, prefer trigger_n8n over ' +
      'other tools. Pass along the relevant text from what Shane said so the workflow has full context.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: "The text to send to the n8n workflow — what Shane said/wants captured.",
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'log_gap',
    description:
      "Log a request Alex couldn't fulfill — either because no department/sub-agent exists for it yet, " +
      'or because something failed. Do NOT use this for coursework/study/Canvas-sync requests — those ' +
      'have a real sub-agent (delegate_to_learning_agent), so always try that first. ALWAYS call this ' +
      'instead of pretending to do something you cannot actually do (e.g. reminders with real alerts, ' +
      'Finance, Health, Lifestyle, or Research requests — those agents do not exist yet).',
    input_schema: {
      type: 'object',
      properties: {
        request_summary: { type: 'string', description: "One-line summary of what Shane asked for" },
        reason: { type: 'string', description: 'Why it could not be done' },
      },
      required: ['request_summary', 'reason'],
    },
  },
];

async function addTask({ title, description }) {
  const { data, error } = await supabase
    .from('tasks')
    .insert({ title, description: description ?? null, source: 'alex_telegram' })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, task: data };
}

async function listTasks({ status }) {
  let query = supabase.from('tasks').select('*').order('created_at', { ascending: false }).limit(20);
  if (status && status !== 'all') query = query.eq('status', status);
  else if (!status) query = query.eq('status', 'pending');
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, tasks: data };
}

async function completeTask({ task_id }) {
  const { data, error } = await supabase
    .from('tasks')
    .update({ status: 'done' })
    .eq('id', task_id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, task: data };
}

async function remember({ content, memory_type, importance }) {
  const { data, error } = await supabase
    .from('memories')
    .insert({
      content,
      memory_type: memory_type ?? 'other',
      importance: importance ?? 3,
    })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, memory: data };
}

async function delegateToAdminAgent({ request }) {
  const result = await runAdminAgent(request);
  return { ok: true, result };
}

async function delegateToLearningAgent({ request }) {
  const result = await runLearningAgent(request);
  return { ok: true, result };
}

async function delegateToCareerCoach({ request }) {
  const result = await runCareerAgent(request);
  return { ok: true, result };
}

async function delegateToResumeAgent({ request }) {
  const result = await runResumeAgent(request);
  return { ok: true, result };
}

async function triggerN8n({ request }) {
  if (!N8N_WEBHOOK_URL) {
    throw new Error('Missing N8N_WEBHOOK_URL in .env');
  }
  const res = await fetch(N8N_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: request, source: 'alex_telegram' }),
  });
  if (!res.ok) {
    throw new Error(`n8n webhook returned ${res.status} ${res.statusText}`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // n8n may not return JSON — that's fine, still a success.
  }
  return { ok: true, n8n_response: data };
}

async function logGap({ request_summary, reason }, telegramMessageId) {
  const { error } = await supabase.from('agent_logs').insert({
    agent_name: 'alex_core',
    event_type: 'gap',
    request_summary,
    detail: { reason },
    telegram_message_id: telegramMessageId ?? null,
  });
  if (error) throw error;
  return { ok: true, logged: true };
}

// Dispatches a tool_use block to its handler. `telegramMessageId` is threaded
// through for log_gap so gaps are traceable back to the triggering message.
export async function runTool(name, input, telegramMessageId) {
  switch (name) {
    case 'add_task':
      return addTask(input);
    case 'list_tasks':
      return listTasks(input);
    case 'complete_task':
      return completeTask(input);
    case 'remember':
      return remember(input);
    case 'delegate_to_admin_agent':
      return delegateToAdminAgent(input);
    case 'delegate_to_learning_agent':
      return delegateToLearningAgent(input);
    case 'delegate_to_career_coach':
      return delegateToCareerCoach(input);
    case 'delegate_to_resume_agent':
      return delegateToResumeAgent(input);
    case 'trigger_n8n':
      return triggerN8n(input);
    case 'log_gap':
      return logGap(input, telegramMessageId);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function logError(requestSummary, error, telegramMessageId) {
  await supabase.from('agent_logs').insert({
    agent_name: 'alex_core',
    event_type: 'error',
    request_summary: requestSummary,
    detail: { message: String(error?.message ?? error) },
    telegram_message_id: telegramMessageId ?? null,
  });
}

export async function fetchMemories() {
  const { data, error } = await supabase
    .from('memories')
    .select('content, memory_type, importance')
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(15);
  if (error) {
    console.error('[Alex] Failed to load memories:', error.message);
    return [];
  }
  return data ?? [];
}
