import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Learning & Career Agent, a specialist sub-agent that Alex (Shane Pinho's \
Chief of Staff) delegates coursework and study requests to. Right now you cover two areas: Course Planner \
(classes, assignments, grades, syllabus import) and Study Coach (study sessions, spaced-repetition \
flashcards, study guide generation). You have real tools backed by Shane's Supabase data — use them, don't \
guess.

If a request refers to a class by name (e.g. "CS 361") instead of an ID, look it up with list_classes \
first rather than asking Alex to resolve it.

If the request contains raw syllabus text to import, use import_syllabus — it will create the class if \
needed, log every dated midterm/final as an assignment, and auto-schedule study sessions counting back \
from each exam. If asked for a study guide, use generate_study_guide, which builds the guide from Shane's \
saved flashcards/assignments for that class.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Include concrete details (class names, due dates, statuses) rather than vague \
summaries.`;

const toolDefs = [
  {
    name: 'add_class',
    description: "Add a new class to Shane's course list.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Class name, e.g. "Data Structures"' },
        code: { type: 'string', description: 'Course code, e.g. "CS 361"' },
        professor: { type: 'string' },
        term: { type: 'string', description: 'e.g. "Fall 2026"' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_classes',
    description: "List Shane's classes, optionally filtered by term.",
    input_schema: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'Optional term filter, e.g. "Fall 2026"' },
      },
    },
  },
  {
    name: 'add_assignment',
    description: 'Add an assignment/exam for a class. Provide either class_id or class_name.',
    input_schema: {
      type: 'object',
      properties: {
        class_id: { type: 'string', description: 'UUID of the class, if known' },
        class_name: { type: 'string', description: 'Class name or code to look up if class_id is not known' },
        title: { type: 'string' },
        due_date: { type: 'string', description: 'ISO 8601 datetime' },
        points: { type: 'number' },
        is_exam: { type: 'boolean' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_assignments',
    description: "List Shane's assignments, optionally filtered by class, status, or upcoming-only.",
    input_schema: {
      type: 'object',
      properties: {
        class_id: { type: 'string' },
        class_name: { type: 'string' },
        status: {
          type: 'string',
          enum: ['Not Started', 'In Progress', 'Submitted', 'Graded', 'all'],
        },
        upcoming_only: { type: 'boolean', description: 'If true, only return assignments due in the future' },
      },
    },
  },
  {
    name: 'update_assignment_status',
    description: "Update an assignment's status by its id (get the id from list_assignments first).",
    input_schema: {
      type: 'object',
      properties: {
        assignment_id: { type: 'string' },
        status: { type: 'string', enum: ['Not Started', 'In Progress', 'Submitted', 'Graded'] },
      },
      required: ['assignment_id', 'status'],
    },
  },
  {
    name: 'update_grade',
    description: "Set or update Shane's current grade for a class. Provide either class_id or class_name.",
    input_schema: {
      type: 'object',
      properties: {
        class_id: { type: 'string' },
        class_name: { type: 'string' },
        current_grade: { type: 'string', description: 'e.g. "A-"' },
        percent: { type: 'number' },
      },
    },
  },
  {
    name: 'schedule_study_session',
    description: 'Schedule a study session, optionally tied to a class.',
    input_schema: {
      type: 'object',
      properties: {
        class_id: { type: 'string' },
        class_name: { type: 'string' },
        topic: { type: 'string' },
        scheduled_at: { type: 'string', description: 'ISO 8601 datetime' },
        duration_minutes: { type: 'integer' },
        notes: { type: 'string' },
      },
      required: ['topic', 'scheduled_at'],
    },
  },
  {
    name: 'list_study_sessions',
    description: "List Shane's study sessions.",
    input_schema: {
      type: 'object',
      properties: {
        upcoming_only: { type: 'boolean' },
      },
    },
  },
  {
    name: 'complete_study_session',
    description: 'Mark a study session as completed by its id.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'add_flashcard',
    description: 'Add a spaced-repetition flashcard, optionally tied to a class.',
    input_schema: {
      type: 'object',
      properties: {
        class_id: { type: 'string' },
        class_name: { type: 'string' },
        question: { type: 'string' },
        answer: { type: 'string' },
      },
      required: ['question', 'answer'],
    },
  },
  {
    name: 'list_due_flashcards',
    description: 'List flashcards that are due for review now.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max cards to return, default 20' },
      },
    },
  },
  {
    name: 'review_flashcard',
    description:
      "Record the result of reviewing a flashcard and reschedule its next review using spaced " +
      'repetition (correct answers push the interval out further, incorrect resets it to 1 day).',
    input_schema: {
      type: 'object',
      properties: {
        flashcard_id: { type: 'string' },
        result: { type: 'string', enum: ['correct', 'incorrect'] },
      },
      required: ['flashcard_id', 'result'],
    },
  },
  {
    name: 'generate_study_guide',
    description:
      "Generate a written study guide (overview, key concepts, and practice questions with answers) for " +
      "a class or a narrower topic within it, built from Shane's saved flashcards and assignments for " +
      'that class.',
    input_schema: {
      type: 'object',
      properties: {
        class_id: { type: 'string' },
        class_name: { type: 'string' },
        topic: { type: 'string', description: 'Optional narrower topic within the class' },
      },
    },
  },
  {
    name: 'import_syllabus',
    description:
      'Parse raw syllabus text to find every midterm/final exam date, create the class if it doesn\'t ' +
      'exist yet, log each exam as an assignment, and auto-schedule study sessions counting back from ' +
      'each exam date (14, 7, 3, and 1 day before, skipping any that would fall in the past).',
    input_schema: {
      type: 'object',
      properties: {
        class_id: { type: 'string' },
        class_name: { type: 'string' },
        syllabus_text: { type: 'string', description: 'Raw extracted text of the syllabus' },
      },
      required: ['syllabus_text'],
    },
  },
];

async function resolveClassId({ class_id, class_name }) {
  if (class_id) return class_id;
  if (!class_name) return null;
  const { data, error } = await supabase
    .from('classes')
    .select('id')
    .ilike('name', `%${class_name}%`)
    .limit(1);
  if (error) throw error;
  return data?.[0]?.id ?? null;
}

async function addClass({ name, code, professor, term }) {
  const { data, error } = await supabase
    .from('classes')
    .insert({ user_id: DEFAULT_USER_ID, name, code: code ?? null, professor: professor ?? null, term: term ?? null })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, class: data };
}

async function listClasses({ term }) {
  let query = supabase.from('classes').select('*').order('created_at', { ascending: false });
  if (term) query = query.eq('term', term);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, classes: data };
}

async function addAssignment({ class_id, class_name, title, due_date, points, is_exam }) {
  const resolvedClassId = await resolveClassId({ class_id, class_name });
  if ((class_id || class_name) && !resolvedClassId) {
    return { ok: false, error: `No class found matching "${class_name ?? class_id}". Try list_classes first.` };
  }
  const { data, error } = await supabase
    .from('assignments')
    .insert({
      user_id: DEFAULT_USER_ID,
      class_id: resolvedClassId,
      title,
      due_date: due_date ?? null,
      points: points ?? null,
      is_exam: is_exam ?? false,
    })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, assignment: data };
}

async function listAssignments({ class_id, class_name, status, upcoming_only }) {
  const resolvedClassId = await resolveClassId({ class_id, class_name });
  let query = supabase.from('assignments').select('*').order('due_date', { ascending: true });
  if (resolvedClassId) query = query.eq('class_id', resolvedClassId);
  if (status && status !== 'all') query = query.eq('status', status);
  if (upcoming_only) query = query.gte('due_date', new Date().toISOString());
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, assignments: data };
}

async function updateAssignmentStatus({ assignment_id, status }) {
  const { data, error } = await supabase
    .from('assignments')
    .update({ status })
    .eq('id', assignment_id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, assignment: data };
}

async function updateGrade({ class_id, class_name, current_grade, percent }) {
  const resolvedClassId = await resolveClassId({ class_id, class_name });
  if (!resolvedClassId) {
    return { ok: false, error: `No class found matching "${class_name ?? class_id}". Try list_classes first.` };
  }
  const { data: existing } = await supabase
    .from('grades')
    .select('id')
    .eq('class_id', resolvedClassId)
    .limit(1);

  let result;
  if (existing?.[0]?.id) {
    const { data, error } = await supabase
      .from('grades')
      .update({ current_grade: current_grade ?? null, percent: percent ?? null, last_updated: new Date().toISOString() })
      .eq('id', existing[0].id)
      .select()
      .single();
    if (error) throw error;
    result = data;
  } else {
    const { data, error } = await supabase
      .from('grades')
      .insert({ user_id: DEFAULT_USER_ID, class_id: resolvedClassId, current_grade: current_grade ?? null, percent: percent ?? null })
      .select()
      .single();
    if (error) throw error;
    result = data;
  }
  return { ok: true, grade: result };
}

async function scheduleStudySession({ class_id, class_name, topic, scheduled_at, duration_minutes, notes }) {
  const resolvedClassId = await resolveClassId({ class_id, class_name });
  const { data, error } = await supabase
    .from('study_sessions')
    .insert({
      user_id: DEFAULT_USER_ID,
      class_id: resolvedClassId,
      topic,
      scheduled_at,
      duration_minutes: duration_minutes ?? null,
      notes: notes ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, study_session: data };
}

async function listStudySessions({ upcoming_only }) {
  let query = supabase.from('study_sessions').select('*').order('scheduled_at', { ascending: true });
  if (upcoming_only) query = query.gte('scheduled_at', new Date().toISOString());
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, study_sessions: data };
}

async function completeStudySession({ session_id }) {
  const { data, error } = await supabase
    .from('study_sessions')
    .update({ status: 'Completed' })
    .eq('id', session_id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, study_session: data };
}

async function addFlashcard({ class_id, class_name, question, answer }) {
  const resolvedClassId = await resolveClassId({ class_id, class_name });
  const { data, error } = await supabase
    .from('flashcards')
    .insert({ user_id: DEFAULT_USER_ID, class_id: resolvedClassId, question, answer })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, flashcard: data };
}

async function listDueFlashcards({ limit }) {
  const { data, error } = await supabase
    .from('flashcards')
    .select('*')
    .lte('next_review_at', new Date().toISOString())
    .order('next_review_at', { ascending: true })
    .limit(limit ?? 20);
  if (error) throw error;
  return { ok: true, flashcards: data };
}

// Simple SM-2-lite scheduling: correct answers grow the interval (interval * ease_factor,
// capped at reasonable minimum), incorrect resets to 1 day and drops ease factor slightly.
async function reviewFlashcard({ flashcard_id, result }) {
  const { data: card, error: fetchError } = await supabase
    .from('flashcards')
    .select('*')
    .eq('id', flashcard_id)
    .single();
  if (fetchError) throw fetchError;

  let nextIntervalDays;
  let nextEaseFactor = card.ease_factor ?? 2.5;

  if (result === 'correct') {
    nextIntervalDays = Math.max(1, Math.round((card.interval_days ?? 1) * nextEaseFactor));
    nextEaseFactor = Math.min(3.0, nextEaseFactor + 0.1);
  } else {
    nextIntervalDays = 1;
    nextEaseFactor = Math.max(1.3, nextEaseFactor - 0.2);
  }

  const nextReviewAt = new Date(Date.now() + nextIntervalDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('flashcards')
    .update({ interval_days: nextIntervalDays, ease_factor: nextEaseFactor, next_review_at: nextReviewAt })
    .eq('id', flashcard_id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, flashcard: data };
}

async function generateStudyGuide({ class_id, class_name, topic }) {
  const resolvedClassId = await resolveClassId({ class_id, class_name });
  if ((class_id || class_name) && !resolvedClassId) {
    return { ok: false, error: `No class found matching "${class_name ?? class_id}". Try list_classes first.` };
  }

  let cls = null;
  let flashcards = [];
  let assignments = [];

  if (resolvedClassId) {
    const [clsRes, cardsRes, assignRes] = await Promise.all([
      supabase.from('classes').select('*').eq('id', resolvedClassId).single(),
      supabase.from('flashcards').select('question, answer').eq('class_id', resolvedClassId),
      supabase.from('assignments').select('title, due_date, is_exam').eq('class_id', resolvedClassId),
    ]);
    cls = clsRes.data ?? null;
    flashcards = cardsRes.data ?? [];
    assignments = assignRes.data ?? [];
  }

  const className = cls?.name ?? class_name ?? 'this class';
  const cardBlock = flashcards.length
    ? flashcards.map((f, i) => `${i + 1}. Q: ${f.question}\n   A: ${f.answer}`).join('\n')
    : '(no flashcards saved for this class yet)';
  const assignmentBlock = assignments.length
    ? assignments
        .map((a) => `- ${a.title}${a.due_date ? ` (due ${String(a.due_date).slice(0, 10)})` : ''}${a.is_exam ? ' [EXAM]' : ''}`)
        .join('\n')
    : '(no assignments saved for this class yet)';

  const prompt = `Write a focused study guide for "${className}"${topic ? `, specifically on the topic "${topic}"` : ''}.

Use the flashcards and assignments below as your source of truth about what Shane is actually studying — \
don't invent facts that aren't grounded in or a reasonable expansion of this material. Structure the guide \
with: a short overview, key concepts, and 5-8 practice questions with answers at the end.

Flashcards on file:
${cardBlock}

Assignments/exams on file:
${assignmentBlock}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const guide = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return { ok: true, study_guide: guide };
}

function isoDateAtHour(dateStr, hour) {
  return new Date(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`).toISOString();
}

async function importSyllabus({ class_id, class_name, syllabus_text }) {
  if (!syllabus_text || !syllabus_text.trim()) {
    return { ok: false, error: 'No syllabus text provided.' };
  }

  const extractionPrompt = `Extract exam information from this course syllabus. Respond with ONLY valid \
JSON (no markdown, no commentary) matching this exact shape:
{"class_name": string|null, "class_code": string|null, "exams": [{"title": string, "type": "midterm"|"final"|"exam", "date": "YYYY-MM-DD"}]}
Only include exams (midterms, finals, tests) that have an actual date stated in the syllabus. If no year is \
given, infer a reasonable one from context. If you can't find a class name/code, use null. If no dated \
exams are found, return an empty exams array.

Syllabus text:
${syllabus_text.slice(0, 12000)}`;

  const extraction = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: extractionPrompt }],
  });

  const raw = extraction.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (err) {
    return { ok: false, error: `Couldn't parse exam dates out of that syllabus: ${err.message}` };
  }

  if (!parsed.exams || parsed.exams.length === 0) {
    return { ok: false, error: "Didn't find any dated midterms/finals in that syllabus." };
  }

  let resolvedClassId = await resolveClassId({ class_id, class_name });
  if (!resolvedClassId) {
    const nameToUse = class_name || parsed.class_name || parsed.class_code || 'Untitled Class';
    const { data: newClass, error } = await supabase
      .from('classes')
      .insert({ user_id: DEFAULT_USER_ID, name: nameToUse, code: parsed.class_code ?? null })
      .select()
      .single();
    if (error) throw error;
    resolvedClassId = newClass.id;
  }

  const createdExams = [];
  const createdSessions = [];
  const now = Date.now();
  const offsetsDays = [14, 7, 3, 1];

  for (const exam of parsed.exams) {
    if (!exam.date) continue;
    const defaultTitle = exam.type === 'final' ? 'Final Exam' : exam.type === 'midterm' ? 'Midterm' : 'Exam';
    const dueIso = isoDateAtHour(exam.date, 23);

    const { data: assignment, error } = await supabase
      .from('assignments')
      .insert({
        user_id: DEFAULT_USER_ID,
        class_id: resolvedClassId,
        title: exam.title || defaultTitle,
        due_date: dueIso,
        is_exam: true,
      })
      .select()
      .single();
    if (error) throw error;
    createdExams.push(assignment);

    const examTime = new Date(dueIso).getTime();
    for (const daysBefore of offsetsDays) {
      const sessionTime = examTime - daysBefore * 24 * 60 * 60 * 1000;
      if (sessionTime <= now) continue; // skip sessions that would fall in the past

      const { data: session, error: sessionError } = await supabase
        .from('study_sessions')
        .insert({
          user_id: DEFAULT_USER_ID,
          class_id: resolvedClassId,
          topic: `Review for ${assignment.title}`,
          scheduled_at: new Date(sessionTime).toISOString(),
          duration_minutes: 60,
          notes: `Auto-scheduled ${daysBefore} day(s) before ${assignment.title}.`,
        })
        .select()
        .single();
      if (sessionError) throw sessionError;
      createdSessions.push(session);
    }
  }

  return {
    ok: true,
    class_id: resolvedClassId,
    exams: createdExams.map((e) => ({ title: e.title, due_date: e.due_date })),
    exams_created: createdExams.length,
    study_sessions_created: createdSessions.length,
  };
}

async function runLearningTool(name, input) {
  switch (name) {
    case 'add_class':
      return addClass(input);
    case 'list_classes':
      return listClasses(input);
    case 'add_assignment':
      return addAssignment(input);
    case 'list_assignments':
      return listAssignments(input);
    case 'update_assignment_status':
      return updateAssignmentStatus(input);
    case 'update_grade':
      return updateGrade(input);
    case 'schedule_study_session':
      return scheduleStudySession(input);
    case 'list_study_sessions':
      return listStudySessions(input);
    case 'complete_study_session':
      return completeStudySession(input);
    case 'add_flashcard':
      return addFlashcard(input);
    case 'list_due_flashcards':
      return listDueFlashcards(input);
    case 'review_flashcard':
      return reviewFlashcard(input);
    case 'generate_study_guide':
      return generateStudyGuide(input);
    case 'import_syllabus':
      return importSyllabus(input);
    default:
      throw new Error(`Unknown Learning & Career Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runLearningAgent(request) {
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
        const result = await runLearningTool(use.name, use.input);
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

  return finalText || "Learning & Career Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
