import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;

const SYSTEM_PROMPT = `You are the Career Coach Agent, a specialist sub-agent that Alex (Shane Pinho's Chief \
of Staff) delegates job-search, LinkedIn, and interview-prep requests to. You have real tools backed by \
Shane's Supabase data — use them, don't guess or make up job listings, resume content, or profile details.

Shane is a rising Architectural Engineering student at Oregon State (expected grad June 2028), currently a \
Student Intern I at the State of Hawaii Dept. of Transportation. He has essentially no prior full-time \
professional engineering experience — treat him as an entry-level/intern candidate. Call get_career_profile \
first whenever you need his education, skills, resume/cover-letter text, or job-search location preferences \
rather than assuming details.

Shane searches jobs on two distinct tracks, both listed in his profile's job_search_locations — always run \
search_jobs once per track when asked for a general job search:
1. "oregon_side_job" — Corvallis, OR (Oregon State area). ANY type of part-time/side job to support college, \
   not necessarily engineering-related. Do not apply a strict field-of-study or years-of-experience filter \
   here — just screen out anything wildly unqualified (e.g. requiring a professional license or degree he \
   doesn't have).
2. "oahu_engineering_internship" — Oahu, HI. Engineering internships specifically (civil, architectural, \
   structural, construction) — NOT software/ML/QA/IT "engineering" roles, which are a completely different \
   field from Shane's. Use a specific "what" search keyword like "civil engineering intern" or "structural \
   engineering intern" or "construction management intern" — never just "engineering intern" or "engineer", \
   which pulls in irrelevant tech roles. Screen for actual fit: field of work must be civil/structural/ \
   architectural/construction-related, and if a listing states a minimum years-of-experience requirement \
   beyond entry-level (roughly 2+ years), exclude it — Shane doesn't have that yet. search_jobs does this \
   filtering automatically and only inserts qualifying, non-duplicate listings as 'suggested' — trust its \
   qualification_notes, but you can still use judgment to leave out a poor fit it let through (e.g. a \
   software role that slipped past the keyword filter).

search_jobs automatically excludes any job Shane has already been shown before (by Adzuna listing id) — \
whether he applied, is interviewing, got an offer, was rejected, or said not interested. Never manually \
re-suggest something list_applications shows as already tracked.

When Shane says he applied to a job (or asks to mark one), use update_application_status to set it to \
'applied', then proactively note that generate_interview_prep is available for that application.

For LinkedIn, Shane does NOT want live LinkedIn posting or scraping — draft_linkedin_post only generates a \
well-formatted post from a description of something he did, grounded in his actual profile/background (tone: \
professional, engineering-student voice, similar to his own LinkedIn About section). It logs the draft but \
never posts anything.

generate_interview_prep pulls the specific job's saved description plus Shane's actual resume and the most \
relevant cover letter on file, and produces prep specific to that application — likely interview questions, \
how to connect his real experience (Pocket Home Production project, DOT internship, club leadership, etc.) \
to the role, and a few smart questions for him to ask. Always pass an application_id from list_applications, \
never invent one.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Include concrete details (job titles, companies, statuses) rather than vague summaries. \
When you call search_jobs, always mention the where_queried value and sample_raw_locations from the tool \
result in your summary if the returned job locations look wrong/mismatched — that pinpoints whether the \
problem is the query sent or something upstream on Adzuna's side.`;

const toolDefs = [
  {
    name: 'get_career_profile',
    description:
      "Fetch Shane's career profile: education, field of study, years of experience, target fields, key " +
      'skills, resume text, cover letter samples, LinkedIn info, and job-search location/track preferences.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_jobs',
    description:
      'Search live job listings via Adzuna for one of Shane\'s two job-search tracks, screen them against ' +
      'his career profile (field of work, education, experience range), skip anything he has already been ' +
      'shown before, and save new qualifying results as \'suggested\' applications. Returns the top options.',
    input_schema: {
      type: 'object',
      properties: {
        track: {
          type: 'string',
          enum: ['oregon_side_job', 'oahu_engineering_internship', 'other'],
          description: "Which of Shane's job-search tracks this search is for.",
        },
        what: { type: 'string', description: 'Search keywords, e.g. "civil engineering intern" or "part time"' },
        where: {
          type: 'string',
          description:
            'Location as a clean "City, ST" string ONLY, e.g. "Corvallis, OR" or "Honolulu, HI" — no ' +
            'parenthetical notes or extra text, that breaks Adzuna\'s geocoding. If pulling from the career ' +
            'profile\'s job_search_locations, use the location field verbatim (it is already clean), never ' +
            'the notes field.',
        },
        results_limit: { type: 'integer', description: 'Max new results to save/return, default 8' },
      },
      required: ['track', 'what', 'where'],
    },
  },
  {
    name: 'list_applications',
    description: "List Shane's tracked job listings/applications, optionally filtered by status.",
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['suggested', 'applied', 'interviewing', 'offer', 'rejected', 'not_interested', 'all'],
          description: "Filter by status, or 'all' for everything. Defaults to 'suggested'.",
        },
      },
    },
  },
  {
    name: 'update_application_status',
    description:
      "Update a tracked job listing's status by its id (get the id from list_applications or search_jobs " +
      "results first) — e.g. mark 'applied', 'interviewing', 'offer', 'rejected', or 'not_interested'. " +
      "Setting status to 'applied' also records the current time as applied_at.",
    input_schema: {
      type: 'object',
      properties: {
        application_id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['suggested', 'applied', 'interviewing', 'offer', 'rejected', 'not_interested'],
        },
      },
      required: ['application_id', 'status'],
    },
  },
  {
    name: 'draft_linkedin_post',
    description:
      "Generate a properly formatted LinkedIn post from a description of an event/activity Shane did, " +
      "grounded in his real background, to help build his career profile. Drafting only — never posts or " +
      'publishes anything to LinkedIn.',
    input_schema: {
      type: 'object',
      properties: {
        event_description: { type: 'string', description: 'What Shane did, in his own words' },
      },
      required: ['event_description'],
    },
  },
  {
    name: 'generate_interview_prep',
    description:
      "Generate interview prep specific to one of Shane's tracked applications, using the job's saved " +
      "description plus Shane's actual resume and cover letter content.",
    input_schema: {
      type: 'object',
      properties: {
        application_id: { type: 'string' },
        round: { type: 'string', description: 'Optional interview round, e.g. "phone screen", "onsite"' },
      },
      required: ['application_id'],
    },
  },
];

async function getCareerProfile() {
  const { data, error } = await supabase
    .from('career_profile')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .single();
  if (error) throw error;
  return { ok: true, profile: data };
}

// Pulls a minimum years-of-experience requirement out of free text, if stated. Not exhaustive —
// good enough to catch the clear-cut "8 years of experience" style disqualifiers Shane cares about.
function extractMinYearsRequired(text) {
  if (!text) return null;
  const match = text.match(/(\d+)\+?\s*(?:-\s*\d+\s*)?\s*years?\s+(?:of\s+)?(?:relevant\s+|professional\s+|related\s+)?experience/i);
  return match ? parseInt(match[1], 10) : null;
}

// Deliberately narrow: generic "engineer"/"engineering"/"design" alone would also match software,
// ML, QA, and other unrelated engineering-titled roles. Require a civil/structural/architectural/
// construction-specific term instead.
const ENGINEERING_KEYWORDS =
  /\b(civil engineer|civil engineering|structural engineer|structural engineering|architectural engineer|architectural engineering|construction engineer|construction management|geotechnical|transportation engineer|site engineer|CAD|BIM|drafting|surveying|building information modeling)\b/i;

async function searchJobs({ track, what, where, results_limit }) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    return { ok: false, error: 'Adzuna is not configured — ADZUNA_APP_ID/ADZUNA_APP_KEY missing from .env.' };
  }

  const { data: profile, error: profileError } = await supabase
    .from('career_profile')
    .select('years_experience, job_search_locations')
    .eq('user_id', DEFAULT_USER_ID)
    .single();
  if (profileError) throw profileError;
  const yearsExperience = profile?.years_experience ?? 0;

  // For the two known tracks, the location is authoritative server-side — pulled straight from
  // career_profile.job_search_locations — rather than trusting whatever `where` string the model
  // passed in. The model has previously reconstructed "Corvallis, OR" from memory instead of using
  // the profile's saved (disambiguated, zip-qualified) value, which Adzuna's geocoder then silently
  // resolved to a same-named town in a different state. Only the freeform 'other' track uses the
  // model-supplied `where` as-is.
  const TRACK_LOCATION_TYPE = {
    oregon_side_job: 'any side job for college',
    oahu_engineering_internship: 'engineering internship',
  };
  let effectiveWhere = where;
  if (TRACK_LOCATION_TYPE[track]) {
    const savedLocation = (profile?.job_search_locations ?? []).find(
      (l) => l.type === TRACK_LOCATION_TYPE[track]
    );
    if (savedLocation?.location) effectiveWhere = savedLocation.location;
  }

  const limit = results_limit ?? 8;
  // Defensive: strip parenthetical notes / anything past a comma-separated "City, ST" so a stray
  // profile note (e.g. "Corvallis, OR (Oregon State area preferred)") never reaches Adzuna's
  // geocoder — that has previously caused it to silently fall back to an unrelated location.
  const cleanWhere = (effectiveWhere ?? '').replace(/\([^)]*\)/g, '').trim();

  const params = new URLSearchParams({
    app_id: ADZUNA_APP_ID,
    app_key: ADZUNA_APP_KEY,
    what,
    where: cleanWhere,
    results_per_page: '25',
    'content-type': 'application/json',
  });
  const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Adzuna API returned ${res.status} ${res.statusText}`);
  }
  const payload = await res.json();
  const results = payload.results ?? [];

  // Already-seen listings (any status) for this user, so we never re-suggest something Shane
  // already applied to, is interviewing for, or said he's not interested in.
  const { data: seen, error: seenError } = await supabase
    .from('job_applications')
    .select('external_id')
    .eq('user_id', DEFAULT_USER_ID)
    .eq('source', 'adzuna');
  if (seenError) throw seenError;
  const seenIds = new Set((seen ?? []).map((r) => r.external_id));

  const qualifying = [];
  for (const job of results) {
    const id = String(job.id);
    if (seenIds.has(id)) continue;

    const title = job.title ?? '';
    const description = job.description ?? '';
    const combined = `${title} ${description}`;

    if (track === 'oahu_engineering_internship' && !ENGINEERING_KEYWORDS.test(combined)) {
      continue; // not actually an engineering/construction-field listing
    }

    const minYears = extractMinYearsRequired(combined);
    if (track !== 'oregon_side_job' && minYears !== null && minYears > Math.ceil(yearsExperience) + 1) {
      continue; // requires more experience than Shane has (with a small buffer)
    }

    qualifying.push({ job, minYears });
    if (qualifying.length >= limit) break;
  }

  const inserted = [];
  for (const { job, minYears } of qualifying) {
    const notes =
      minYears !== null
        ? `Requires ~${minYears} yr(s) experience — within range for an entry-level/intern candidate.`
        : 'No explicit years-of-experience requirement found; matches track criteria.';

    const { data, error } = await supabase
      .from('job_applications')
      .insert({
        user_id: DEFAULT_USER_ID,
        source: 'adzuna',
        external_id: String(job.id),
        title: job.title,
        company: job.company?.display_name ?? null,
        location: job.location?.display_name ?? null,
        url: job.redirect_url ?? null,
        description: job.description ?? null,
        salary_min: job.salary_min ?? null,
        salary_max: job.salary_max ?? null,
        status: 'suggested',
        qualification_notes: `[${track}] ${notes}`,
      })
      .select()
      .single();
    if (error) throw error;
    inserted.push(data);
  }

  return {
    ok: true,
    track,
    where_queried: cleanWhere,
    total_results_from_adzuna: results.length,
    // Unfiltered sample of raw Adzuna result locations, for diagnosing geo-mismatch issues —
    // if these don't match where_queried, the problem is upstream (Adzuna/query), not our filtering.
    sample_raw_locations: [...new Set(results.slice(0, 10).map((j) => j.location?.display_name))].slice(0, 5),
    already_seen_skipped: results.filter((j) => seenIds.has(String(j.id))).length,
    new_qualifying_jobs: inserted.length,
    jobs: inserted.map((j) => ({
      id: j.id,
      title: j.title,
      company: j.company,
      location: j.location,
      url: j.url,
      salary_min: j.salary_min,
      salary_max: j.salary_max,
      qualification_notes: j.qualification_notes,
    })),
  };
}

async function listApplications({ status }) {
  let query = supabase.from('job_applications').select('*').order('created_at', { ascending: false }).limit(30);
  if (status && status !== 'all') query = query.eq('status', status);
  else if (!status) query = query.eq('status', 'suggested');
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, applications: data };
}

async function updateApplicationStatus({ application_id, status }) {
  const payload = { status, updated_at: new Date().toISOString() };
  if (status === 'applied') payload.applied_at = new Date().toISOString();
  const { data, error } = await supabase
    .from('job_applications')
    .update(payload)
    .eq('id', application_id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, application: data };
}

async function draftLinkedinPost({ event_description }) {
  const { data: profile, error: profileError } = await supabase
    .from('career_profile')
    .select('linkedin_about, field_of_study, school, target_fields, key_skills')
    .eq('user_id', DEFAULT_USER_ID)
    .single();
  if (profileError) throw profileError;

  const prompt = `Write a LinkedIn post for Shane Pinho, a ${profile?.field_of_study ?? 'Architectural Engineering'} \
student at ${profile?.school ?? 'Oregon State University'}. Match the tone of his own LinkedIn About section \
below — genuine, engineering-student voice, proud but not braggy, community/leadership-minded.

His LinkedIn About section (for voice reference only, don't copy it):
${profile?.linkedin_about ?? '(none on file)'}

Write a post (150-300 words) about the following thing he did, framed to help his career/professional \
profile in ${(profile?.target_fields ?? []).join(', ') || 'engineering/construction'}:

${event_description}

Include 4-8 relevant hashtags at the end, similar in style to: #Engineering #CivilEngineering #Construction \
#StructuralEngineering #Leadership #ProjectManagement. Return ONLY the post text, no commentary or preamble.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  const post = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const { data, error } = await supabase
    .from('linkedin_posts')
    .insert({ user_id: DEFAULT_USER_ID, event_description, generated_post: post })
    .select()
    .single();
  if (error) throw error;

  return { ok: true, linkedin_post: data };
}

async function generateInterviewPrep({ application_id, round }) {
  const [{ data: application, error: appError }, { data: profile, error: profileError }] = await Promise.all([
    supabase.from('job_applications').select('*').eq('id', application_id).single(),
    supabase.from('career_profile').select('resume_text, cover_letter_samples').eq('user_id', DEFAULT_USER_ID).single(),
  ]);
  if (appError) throw appError;
  if (profileError) throw profileError;

  if (!application) {
    return { ok: false, error: `No tracked application found with id "${application_id}". Try list_applications first.` };
  }

  const coverLetters = (profile?.cover_letter_samples ?? [])
    .map((c) => `--- ${c.title} ---\n${c.text}`)
    .join('\n\n');

  const prompt = `Generate interview prep for Shane Pinho for the following job. Ground everything in his \
actual resume and cover letter samples below — reference specific real experience (projects, roles, \
skills), don't invent accomplishments.

JOB
Title: ${application.title}
Company: ${application.company ?? 'Unknown'}
Location: ${application.location ?? 'Unknown'}
Description:
${(application.description ?? '(no description saved)').slice(0, 4000)}

SHANE'S RESUME
${profile?.resume_text ?? '(no resume on file)'}

SHANE'S COVER LETTER SAMPLES (for tone/background reference — pick the most relevant if one applies)
${coverLetters || '(none on file)'}

Produce:
1. 6-10 likely interview questions specific to this role (mix of behavioral and technical/role-specific).
2. For each, a brief talking point connecting one of Shane's REAL experiences to a strong answer.
3. 3-5 smart questions Shane should ask the interviewer.
Keep it practical and specific to this job, not generic advice.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const prepContent = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const { data, error } = await supabase
    .from('interview_preps')
    .insert({
      user_id: DEFAULT_USER_ID,
      application_id,
      prep_content: prepContent,
      round: round ?? null,
    })
    .select()
    .single();
  if (error) throw error;

  return { ok: true, interview_prep: data };
}

async function runCareerTool(name, input) {
  switch (name) {
    case 'get_career_profile':
      return getCareerProfile();
    case 'search_jobs':
      return searchJobs(input);
    case 'list_applications':
      return listApplications(input);
    case 'update_application_status':
      return updateApplicationStatus(input);
    case 'draft_linkedin_post':
      return draftLinkedinPost(input);
    case 'generate_interview_prep':
      return generateInterviewPrep(input);
    default:
      throw new Error(`Unknown Career Coach Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runCareerAgent(request) {
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
        const result = await runCareerTool(use.name, use.input);
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

  return finalText || "Career Coach Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
