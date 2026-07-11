import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Scholarship & Funding Agent, a specialist sub-agent that Alex (Shane \
Pinho's Chief of Staff) delegates scholarship and funding requests to. You have real tools backed by Shane's \
Supabase data — use them, don't guess or invent scholarships, deadlines, or amounts.

Scholarship applications run on their own deadline-driven cadence, separate from job applications (Career \
Coach's job) — that's why you exist as your own tracker rather than folding into that agent.

You share Shane's resume/portfolio state with the Resume & Portfolio Agent and Career Coach (read-only) so \
essay drafts are grounded in his real background — you never invent experience or accomplishments.

Your two responsibilities:
1. **Tracking** — add_scholarship to log a new one (name, provider, amount, deadline, requirements, link). \
list_scholarships to review what's tracked, optionally by status. update_scholarship to move it through \
statuses (researching → drafting → submitted → awarded/rejected/not_pursuing) or fix details. Always resolve \
scholarship_id via list_scholarships (matching by name) rather than asking Shane for a UUID.
2. **Essay drafts** — generate_scholarship_essay writes a draft tied to a specific tracked scholarship_id, \
grounded in Shane's short resume and portfolio items, tailored to the scholarship's prompt/requirements if \
given. Drafting only — Shane reviews and submits himself. list_scholarship_essays shows what's already been \
drafted.

IMPORTANT — deadlines matter here more than almost anywhere else in this system: whenever you add or learn \
about a scholarship deadline, always state the deadline clearly and plainly in your final answer back to \
Alex (e.g. "deadline: August 15, 2026") so it can be surfaced to Shane's dashboard and calendar. Never bury \
or omit a deadline.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Always include the deadline explicitly when one exists.`;

const toolDefs = [
  {
    name: 'add_scholarship',
    description: "Start tracking a new scholarship or funding opportunity.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        provider: { type: 'string', description: 'Who offers it, e.g. "OSU College of Engineering"' },
        amount: { type: 'number', description: 'Dollar amount, if known' },
        deadline: { type: 'string', description: 'YYYY-MM-DD' },
        requirements: { type: 'string', description: 'Eligibility/requirements, essay prompt, etc.' },
        url: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_scholarships',
    description: "List tracked scholarships, optionally filtered by status. Sorted by soonest deadline first.",
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['researching', 'drafting', 'submitted', 'awarded', 'rejected', 'not_pursuing', 'all'],
          description: "Defaults to everything except 'rejected'/'not_pursuing'.",
        },
      },
    },
  },
  {
    name: 'update_scholarship',
    description: "Update a scholarship's status or details by its id (get the id from list_scholarships).",
    input_schema: {
      type: 'object',
      properties: {
        scholarship_id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['researching', 'drafting', 'submitted', 'awarded', 'rejected', 'not_pursuing'],
        },
        amount: { type: 'number' },
        deadline: { type: 'string' },
        requirements: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['scholarship_id'],
    },
  },
  {
    name: 'generate_scholarship_essay',
    description:
      "Generate an essay/personal statement draft tied to a specific tracked scholarship, grounded in " +
      "Shane's real resume and portfolio. Saves the draft and returns it.",
    input_schema: {
      type: 'object',
      properties: {
        scholarship_id: { type: 'string', description: 'Get from list_scholarships by matching the name.' },
        prompt: { type: 'string', description: "The essay prompt/question, if the scholarship has one." },
        notes: { type: 'string', description: 'Optional extra guidance from Shane on tone/emphasis.' },
      },
      required: ['scholarship_id'],
    },
  },
  {
    name: 'list_scholarship_essays',
    description: 'List previously generated essay drafts, optionally filtered to one scholarship.',
    input_schema: {
      type: 'object',
      properties: {
        scholarship_id: { type: 'string' },
      },
    },
  },
];

async function addScholarship({ name, provider, amount, deadline, requirements, url, notes }) {
  const { data, error } = await supabase
    .from('scholarships')
    .insert({
      user_id: DEFAULT_USER_ID,
      name,
      provider: provider ?? null,
      amount: amount ?? null,
      deadline: deadline ?? null,
      requirements: requirements ?? null,
      url: url ?? null,
      notes: notes ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, scholarship: data };
}

async function listScholarships({ status }) {
  let query = supabase
    .from('scholarships')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('deadline', { ascending: true, nullsFirst: false });
  if (status && status !== 'all') {
    query = query.eq('status', status);
  } else if (!status) {
    query = query.not('status', 'in', '("rejected","not_pursuing")');
  }
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, scholarships: data };
}

async function updateScholarship({ scholarship_id, status, amount, deadline, requirements, notes }) {
  const payload = { updated_at: new Date().toISOString() };
  if (status !== undefined) payload.status = status;
  if (amount !== undefined) payload.amount = amount;
  if (deadline !== undefined) payload.deadline = deadline;
  if (requirements !== undefined) payload.requirements = requirements;
  if (notes !== undefined) payload.notes = notes;
  const { data, error } = await supabase
    .from('scholarships')
    .update(payload)
    .eq('id', scholarship_id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, scholarship: data };
}

async function generateScholarshipEssay({ scholarship_id, prompt, notes }) {
  const [{ data: scholarship, error: schError }, { data: profile, error: profileError }, { data: portfolio, error: portfolioError }] =
    await Promise.all([
      supabase.from('scholarships').select('*').eq('id', scholarship_id).single(),
      supabase
        .from('career_profile')
        .select('resume_text_short, field_of_study, school')
        .eq('user_id', DEFAULT_USER_ID)
        .single(),
      supabase.from('portfolio_items').select('*').eq('user_id', DEFAULT_USER_ID),
    ]);
  if (schError) throw schError;
  if (profileError) throw profileError;
  if (portfolioError) throw portfolioError;

  if (!scholarship) {
    return { ok: false, error: `No tracked scholarship found with id "${scholarship_id}". Check list_scholarships first.` };
  }

  const portfolioSummary = (portfolio ?? [])
    .map((p) => `- ${p.title} (${p.role ?? 'role n/a'}): ${p.description ?? ''}`)
    .join('\n');

  const essayPrompt = `Write a scholarship essay/personal statement for Shane Pinho, a \
${profile?.field_of_study ?? 'Architectural Engineering'} student at ${profile?.school ?? 'Oregon State University'}, \
applying to the following scholarship.

SCHOLARSHIP
Name: ${scholarship.name}
Provider: ${scholarship.provider ?? 'Unknown'}
Requirements/context: ${scholarship.requirements ?? '(none saved)'}
${prompt ? `Essay prompt/question: ${prompt}` : ''}

SHANE'S RESUME
${profile?.resume_text_short ?? '(no resume on file)'}

SHANE'S PORTFOLIO
${portfolioSummary || '(no portfolio items on file)'}

${notes ? `ADDITIONAL GUIDANCE FROM SHANE\n${notes}\n` : ''}
Ground every claim in his real resume/portfolio content — never invent experience, accomplishments, or \
circumstances. Write in first person, a genuine and specific personal voice, not generic scholarship-essay \
filler. Return ONLY the essay text, no commentary or preamble.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: essayPrompt }],
  });

  const essayContent = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const { data, error } = await supabase
    .from('scholarship_essays')
    .insert({
      user_id: DEFAULT_USER_ID,
      scholarship_id,
      prompt: prompt ?? null,
      essay_content: essayContent,
    })
    .select()
    .single();
  if (error) throw error;

  return {
    ok: true,
    essay: data,
    scholarship_name: scholarship.name,
    deadline: scholarship.deadline,
  };
}

async function listScholarshipEssays({ scholarship_id }) {
  let query = supabase
    .from('scholarship_essays')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('created_at', { ascending: false });
  if (scholarship_id) query = query.eq('scholarship_id', scholarship_id);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, essays: data };
}

async function runScholarshipTool(name, input) {
  switch (name) {
    case 'add_scholarship':
      return addScholarship(input);
    case 'list_scholarships':
      return listScholarships(input);
    case 'update_scholarship':
      return updateScholarship(input);
    case 'generate_scholarship_essay':
      return generateScholarshipEssay(input);
    case 'list_scholarship_essays':
      return listScholarshipEssays(input);
    default:
      throw new Error(`Unknown Scholarship & Funding Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runScholarshipAgent(request) {
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
        const result = await runScholarshipTool(use.name, use.input);
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

  return finalText || "Scholarship & Funding Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
