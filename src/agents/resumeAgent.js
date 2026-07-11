import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Resume & Portfolio Agent, a specialist sub-agent that Alex (Shane Pinho's \
Chief of Staff) delegates resume-maintenance, portfolio-tracking, and cover-letter requests to. You have \
real tools backed by Shane's Supabase data — use them, don't guess or invent resume content, past projects, \
or job details.

Shane is a rising Architectural Engineering student at Oregon State (expected grad June 2028), currently a \
Student Intern I at the State of Hawaii Dept. of Transportation. Your job is to keep his professional \
materials current and ready to use the moment an opportunity comes up ("ready for opportunities").

You share two pieces of state with the Career Coach agent, and changes you make here flow directly into it:
- career_profile.resume_text and cover_letter_samples — the same fields Career Coach's interview prep and \
LinkedIn drafting read from. Keeping resume_text accurate here is what keeps those features accurate too.
- job_applications (owned by Career Coach) — you only ever READ this table, to pull a specific job's title/ \
company/description when generating a cover letter tied to it. Never create, delete, or change the status of \
an application yourself — that's Career Coach's job.

Your three responsibilities:
1. **Resume updates** — when Shane tells you about a new experience, skill, role, or accomplishment, call \
update_resume to fold it into his stored resume_text. Default to 'incremental' mode (merge the new detail \
into the existing resume, preserving its structure/tone) unless Shane has pasted a complete replacement \
resume, in which case use 'replace' mode with the exact text he gave you — never rewrite or embellish text \
he explicitly pasted verbatim. Always call get_resume_profile first if you need to see the current resume.
2. **Portfolio** — maintain a running list of Shane's real projects/work (portfolio_items): title, what it \
was, his role, skills used, dates, and a link if there is one. Use add_portfolio_item when Shane describes \
something new, update_portfolio_item to correct/expand an existing entry, list_portfolio_items to review \
what's tracked, and sync_portfolio_from_resume to auto-extract portfolio-worthy entries out of his resume \
and cover letter samples (useful for an initial fill or after a big resume update) — it skips anything that \
already looks like a duplicate by title.
3. **Cover letters** — generate_cover_letter always ties to a specific tracked job application_id (get it \
from Alex/Shane — never invent one; if unsure, say the Career Coach's list_applications should be checked \
first). It grounds the letter in Shane's real resume, cover letter samples (for tone/structure), and \
portfolio items, tailored to that job's actual saved description. Drafting only — nothing is ever sent \
anywhere. list_cover_letters shows what's already been drafted for review.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Include concrete details (what changed, what was added, job/company for a cover \
letter) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'get_resume_profile',
    description:
      "Fetch Shane's current resume text, cover letter samples, key skills, target fields, field of study, " +
      'school, and education level from his career profile.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'update_resume',
    description:
      "Update Shane's stored resume text. 'incremental' mode (default) merges a described change into the " +
      "existing resume via careful editing, preserving its structure/tone. 'replace' mode overwrites it " +
      "with an exact resume text Shane provided verbatim (use this whenever he pastes a full resume rather " +
      'than describing a change). Every update is logged.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['incremental', 'replace'], description: "Defaults to 'incremental'." },
        change_description: {
          type: 'string',
          description: "Required for 'incremental' mode — what to add/change, in Shane's own words.",
        },
        full_resume_text: {
          type: 'string',
          description: "Required for 'replace' mode — the exact full resume text to save verbatim.",
        },
      },
      required: [],
    },
  },
  {
    name: 'add_portfolio_item',
    description: "Add a new project/work item to Shane's portfolio.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        role: { type: 'string', description: 'His role/title on this project, e.g. "Project Lead"' },
        skills_used: { type: 'array', items: { type: 'string' } },
        link: { type: 'string', description: 'Optional URL (repo, live site, writeup, etc.)' },
        start_date: { type: 'string', description: 'YYYY-MM-DD, optional' },
        end_date: { type: 'string', description: 'YYYY-MM-DD, optional — omit if ongoing' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_portfolio_items',
    description: "List everything currently tracked in Shane's portfolio.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'update_portfolio_item',
    description: "Update fields on an existing portfolio item by its id (get the id from list_portfolio_items).",
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        role: { type: 'string' },
        skills_used: { type: 'array', items: { type: 'string' } },
        link: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'sync_portfolio_from_resume',
    description:
      "Auto-extract portfolio-worthy projects/experiences from Shane's stored resume text and cover letter " +
      'samples, and add any that aren\'t already tracked (matched loosely by title). Good for an initial ' +
      'fill or after a big resume update.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'generate_cover_letter',
    description:
      "Generate a cover letter tailored to one of Shane's tracked job applications (from Career Coach's " +
      "job_applications table), grounded in his real resume, cover letter samples, and portfolio. Saves the " +
      'draft and returns it.',
    input_schema: {
      type: 'object',
      properties: {
        application_id: { type: 'string', description: "UUID from Career Coach's job_applications table." },
        notes: { type: 'string', description: 'Optional extra guidance from Shane on tone/emphasis.' },
      },
      required: ['application_id'],
    },
  },
  {
    name: 'list_cover_letters',
    description: 'List previously generated cover letters, optionally filtered to one application.',
    input_schema: {
      type: 'object',
      properties: {
        application_id: { type: 'string', description: 'Optional — filter to one application.' },
      },
    },
  },
];

async function getResumeProfile() {
  const { data, error } = await supabase
    .from('career_profile')
    .select('resume_text, cover_letter_samples, key_skills, target_fields, field_of_study, school, education_level')
    .eq('user_id', DEFAULT_USER_ID)
    .single();
  if (error) throw error;
  return { ok: true, profile: data };
}

async function updateResume({ mode, change_description, full_resume_text }) {
  const effectiveMode = mode ?? 'incremental';

  if (effectiveMode === 'replace') {
    if (!full_resume_text) {
      return { ok: false, error: "'replace' mode requires full_resume_text." };
    }
    const { error } = await supabase
      .from('career_profile')
      .update({ resume_text: full_resume_text, updated_at: new Date().toISOString() })
      .eq('user_id', DEFAULT_USER_ID);
    if (error) throw error;

    const { data: logRow, error: logError } = await supabase
      .from('resume_update_log')
      .insert({ user_id: DEFAULT_USER_ID, change_summary: 'Full resume replaced with provided text.' })
      .select()
      .single();
    if (logError) throw logError;

    return { ok: true, mode: 'replace', log: logRow };
  }

  if (!change_description) {
    return { ok: false, error: "'incremental' mode requires change_description." };
  }

  const { data: profile, error: profileError } = await supabase
    .from('career_profile')
    .select('resume_text')
    .eq('user_id', DEFAULT_USER_ID)
    .single();
  if (profileError) throw profileError;

  const prompt = `Here is Shane Pinho's current resume text:

${profile?.resume_text ?? '(no resume on file yet)'}

Update it to incorporate the following new information, in his own words:

${change_description}

Rules:
- Preserve the existing structure, section headers, and overall formatting style as closely as possible.
- Integrate the new information into the most appropriate section (add a new bullet/entry, or a new section \
if none fits).
- Do not invent details beyond what's given or already present.
- Do not remove or alter unrelated existing content.
Return ONLY the full updated resume text, no commentary or preamble.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const updatedResume = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const { error: updateError } = await supabase
    .from('career_profile')
    .update({ resume_text: updatedResume, updated_at: new Date().toISOString() })
    .eq('user_id', DEFAULT_USER_ID);
  if (updateError) throw updateError;

  const { data: logRow, error: logError } = await supabase
    .from('resume_update_log')
    .insert({ user_id: DEFAULT_USER_ID, change_summary: change_description })
    .select()
    .single();
  if (logError) throw logError;

  return { ok: true, mode: 'incremental', updated_resume_text: updatedResume, log: logRow };
}

async function addPortfolioItem({ title, description, role, skills_used, link, start_date, end_date }) {
  const { data, error } = await supabase
    .from('portfolio_items')
    .insert({
      user_id: DEFAULT_USER_ID,
      title,
      description: description ?? null,
      role: role ?? null,
      skills_used: skills_used ?? null,
      link: link ?? null,
      start_date: start_date ?? null,
      end_date: end_date ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, item: data };
}

async function listPortfolioItems() {
  const { data, error } = await supabase
    .from('portfolio_items')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return { ok: true, items: data };
}

async function updatePortfolioItem({ item_id, ...fields }) {
  const payload = { updated_at: new Date().toISOString() };
  for (const key of ['title', 'description', 'role', 'skills_used', 'link', 'start_date', 'end_date']) {
    if (fields[key] !== undefined) payload[key] = fields[key];
  }
  const { data, error } = await supabase
    .from('portfolio_items')
    .update(payload)
    .eq('id', item_id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, item: data };
}

async function syncPortfolioFromResume() {
  const { data: profile, error: profileError } = await supabase
    .from('career_profile')
    .select('resume_text, cover_letter_samples')
    .eq('user_id', DEFAULT_USER_ID)
    .single();
  if (profileError) throw profileError;

  const { data: existing, error: existingError } = await supabase
    .from('portfolio_items')
    .select('title')
    .eq('user_id', DEFAULT_USER_ID);
  if (existingError) throw existingError;
  const existingTitles = (existing ?? []).map((i) => i.title.toLowerCase());

  const coverLetters = (profile?.cover_letter_samples ?? [])
    .map((c) => `--- ${c.title} ---\n${c.text}`)
    .join('\n\n');

  const prompt = `Extract a list of distinct portfolio-worthy projects, roles, or experiences from the \
following resume and cover letter samples for Shane Pinho. For each, give a short title, a 1-3 sentence \
description, his role, and a list of skills used (if inferable). Only include real, concrete projects/roles \
— not generic skills or education entries alone.

RESUME
${profile?.resume_text ?? '(none on file)'}

COVER LETTER SAMPLES
${coverLetters || '(none on file)'}

Return ONLY a JSON array, no commentary, in this exact shape:
[{"title": "...", "description": "...", "role": "...", "skills_used": ["...", "..."]}]`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  let extracted;
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    extracted = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    return { ok: false, error: 'Failed to parse extracted portfolio items from model output.' };
  }

  const toInsert = (extracted ?? []).filter(
    (item) => item?.title && !existingTitles.includes(item.title.toLowerCase())
  );

  const inserted = [];
  for (const item of toInsert) {
    const { data, error } = await supabase
      .from('portfolio_items')
      .insert({
        user_id: DEFAULT_USER_ID,
        title: item.title,
        description: item.description ?? null,
        role: item.role ?? null,
        skills_used: item.skills_used ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    inserted.push(data);
  }

  return {
    ok: true,
    extracted_total: (extracted ?? []).length,
    already_tracked_skipped: (extracted ?? []).length - toInsert.length,
    newly_added: inserted.length,
    items: inserted,
  };
}

async function generateCoverLetter({ application_id, notes }) {
  const [{ data: application, error: appError }, { data: profile, error: profileError }, { data: portfolio, error: portfolioError }] =
    await Promise.all([
      supabase.from('job_applications').select('*').eq('id', application_id).single(),
      supabase
        .from('career_profile')
        .select('resume_text, cover_letter_samples, field_of_study, school')
        .eq('user_id', DEFAULT_USER_ID)
        .single(),
      supabase.from('portfolio_items').select('*').eq('user_id', DEFAULT_USER_ID),
    ]);
  if (appError) throw appError;
  if (profileError) throw profileError;
  if (portfolioError) throw portfolioError;

  if (!application) {
    return { ok: false, error: `No tracked application found with id "${application_id}". Check Career Coach's list_applications first.` };
  }

  const coverLetterSamples = (profile?.cover_letter_samples ?? [])
    .map((c) => `--- ${c.title} ---\n${c.text}`)
    .join('\n\n');

  const portfolioSummary = (portfolio ?? [])
    .map((p) => `- ${p.title} (${p.role ?? 'role n/a'}): ${p.description ?? ''}`)
    .join('\n');

  const prompt = `Write a cover letter for Shane Pinho, a ${profile?.field_of_study ?? 'Architectural Engineering'} \
student at ${profile?.school ?? 'Oregon State University'}, applying to the following job.

JOB
Title: ${application.title}
Company: ${application.company ?? 'Unknown'}
Location: ${application.location ?? 'Unknown'}
Description:
${(application.description ?? '(no description saved)').slice(0, 4000)}

SHANE'S RESUME
${profile?.resume_text ?? '(no resume on file)'}

SHANE'S PORTFOLIO
${portfolioSummary || '(no portfolio items on file)'}

HIS PAST COVER LETTERS (match his voice/structure/tone — don't copy verbatim)
${coverLetterSamples || '(none on file)'}

${notes ? `ADDITIONAL GUIDANCE FROM SHANE\n${notes}\n` : ''}
Ground every claim in his real resume/portfolio content — never invent experience or accomplishments. \
Return ONLY the cover letter text, no commentary or preamble.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });

  const letterContent = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const { data, error } = await supabase
    .from('cover_letters')
    .insert({ user_id: DEFAULT_USER_ID, application_id, letter_content: letterContent })
    .select()
    .single();
  if (error) throw error;

  return { ok: true, cover_letter: data, job_title: application.title, job_company: application.company };
}

async function listCoverLetters({ application_id }) {
  let query = supabase
    .from('cover_letters')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('created_at', { ascending: false });
  if (application_id) query = query.eq('application_id', application_id);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, cover_letters: data };
}

async function runResumeTool(name, input) {
  switch (name) {
    case 'get_resume_profile':
      return getResumeProfile();
    case 'update_resume':
      return updateResume(input);
    case 'add_portfolio_item':
      return addPortfolioItem(input);
    case 'list_portfolio_items':
      return listPortfolioItems();
    case 'update_portfolio_item':
      return updatePortfolioItem(input);
    case 'sync_portfolio_from_resume':
      return syncPortfolioFromResume();
    case 'generate_cover_letter':
      return generateCoverLetter(input);
    case 'list_cover_letters':
      return listCoverLetters(input);
    default:
      throw new Error(`Unknown Resume & Portfolio Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runResumeAgent(request) {
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
        const result = await runResumeTool(use.name, use.input);
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

  return finalText || "Resume & Portfolio Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
