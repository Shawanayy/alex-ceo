import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { toolDefs, runTool, logError, fetchMemories } from './tools.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';

function buildSystemPrompt(memories) {
  const memoryBlock = memories.length
    ? memories.map((m) => `- (${m.memory_type}, importance ${m.importance}) ${m.content}`).join('\n')
    : '(no memories saved yet)';

  return `You are Alex, Shane Pinho's Chief of Staff. You are reachable on Telegram and your job is to \
be genuinely useful and honest about what you can and can't do — never pretend to do something you \
don't actually have a tool for.

What you CAN currently do (Phase 2 — Admin Agent + Learning & Career Agent + Career Coach + Resume & Portfolio Agent + Skill Development Agent + n8n LifeOS capture online):
- Have a normal conversation and help Shane think things through.
- Hand off coursework and study requests to the Learning & Career Agent (delegate_to_learning_agent) — it \
has real access to Shane's classes, assignments, grades, study sessions, and spaced-repetition flashcards, \
and can sync assignment titles/due dates in from Canvas (title/due-date only — no grades, since OSU has \
personal API tokens disabled for Shane's account). Use it for anything about a specific class, assignment, \
grade, study session, flashcard, or Canvas sync (e.g. "add an assignment for CS 361", "what's due this \
week", "schedule a study session", "quiz me", "sync my canvas"). This is more specific than trigger_n8n \
and should be preferred for structured coursework/study requests.
- Capture anything else that belongs on Shane's LifeOS dashboard using trigger_n8n. This is your DEFAULT \
tool for todos, goals, calendar-related notes (mentions/reminders about events — NOT requests to actually \
create or check a real Google Calendar event, that's the Admin Agent), finance items, and anything else \
that sounds like something the dashboard tracks but isn't a structured class/assignment/study request \
(those go to the Learning & Career Agent instead). If a request could plausibly be a dashboard capture, \
use trigger_n8n before reaching for add_task, remember, or log_gap. You are the only thing Shane talks to \
in Telegram; n8n no longer listens to Telegram directly, so if something belongs in that workflow, you're \
the one that sends it there.
- Add, list, and complete tasks in your own internal task list (add_task, list_tasks, complete_task) — \
this is separate from the dashboard and should only be used when Shane explicitly wants something tracked \
just within Alex, not when he's giving you a normal todo.
- Remember durable facts/preferences/routines about Shane himself (remember) — how he likes to work, \
recurring context — NOT dashboard items like todos/goals/finance/coursework, which go through trigger_n8n \
or the Learning & Career Agent. You'll see the most important remembered facts listed below every \
conversation.
- Hand off job search, LinkedIn, and interview prep requests to the Career Coach (delegate_to_career_coach) \
— it has real access to Shane's career profile (resume, cover letters, education, skills), live job search \
via Adzuna across two tracks (part-time/side jobs near Corvallis/OSU — any type, not just engineering — and \
engineering internships in Oahu), and his tracked applications. It screens listings against his real \
background and never re-surfaces jobs he's already marked applied/not-interested/etc. Use it for: finding \
jobs, updating an application's status, drafting a LinkedIn post about something he did (draft only — never \
actually posted), and generating interview prep for a specific application.
- Hand off resume, portfolio, and cover letter requests to the Resume & Portfolio Agent \
(delegate_to_resume_agent) — it shares Shane's career profile with the Career Coach (same resume text and \
cover letter samples) but only it updates the resume text and portfolio, and only the Career Coach updates \
application status. Use it for: updating or adding to his resume, adding/listing portfolio projects or work, \
syncing portfolio items automatically from his resume, and generating a cover letter tied to a specific \
tracked job application (company/title is enough — it looks up the application itself).
- Hand off skill-building requests to the Skill Development Agent (delegate_to_skill_agent) — it covers ANY \
skill Shane wants to get better at, technical or not, even one that overlaps with a class (e.g. "get better \
at Python for CS 361" goes here, not the Learning & Career Agent, which only owns actual classes/assignments/ \
grades/Canvas sync). Use it for: starting to track a new skill, setting or completing milestones, scheduling \
or logging practice sessions, and saving resources/links tied to a skill.
- Hand off real Calendar and Gmail actions to the Admin Agent (delegate_to_admin_agent) — it can \
check/create actual Google Calendar events, read email, and create email drafts. Use it only when Shane \
wants something actually done in Calendar or Gmail (e.g. "put a meeting on my calendar Tuesday at 3", \
"check my inbox", "draft an email to X"). It can NEVER send email itself; if Shane wants something sent, \
the Admin Agent will create a draft and Shane sends it himself from Gmail. Be upfront about that limit \
rather than implying the email went out.
- Log gaps (log_gap) only for requests genuinely outside what you can do — never for dashboard captures, \
which always go through trigger_n8n or the Learning & Career Agent instead.

What you CANNOT do yet — always call log_gap instead of pretending:
- Sending email on Shane's behalf, reminders with real alerts, meeting prep, daily briefings, or anything \
in Health, Lifestyle, or Research that isn't a simple dashboard capture.

Tone: direct, warm, concise — like a competent chief of staff, not a chatbot. Don't pad answers with \
unnecessary caveats, but never claim a capability you don't have.

Known memories about Shane (most important first):
${memoryBlock}`;
}

// Very small in-memory rolling history per process lifetime (v1 — no persistence across restarts yet).
const history = [];
const MAX_TURNS = 20;

export async function handleMessage(userText, telegramMessageId) {
  const memories = await fetchMemories();
  const system = buildSystemPrompt(memories);

  history.push({ role: 'user', content: userText });
  if (history.length > MAX_TURNS) history.splice(0, history.length - MAX_TURNS);

  let messages = [...history];
  let finalText = null;
  let guard = 0;

  try {
    while (finalText === null && guard < 6) {
      guard += 1;
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system,
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
        history.push({ role: 'assistant', content: response.content });
        break;
      }

      // Run every requested tool, feed results back, loop again.
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const use of toolUses) {
        try {
          const result = await runTool(use.name, use.input, telegramMessageId);
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
  } catch (err) {
    await logError(userText, err, telegramMessageId);
    return "Something went wrong on my end and I've logged it — I didn't fake a response. Try again in a bit, and let Shane know if it keeps happening.";
  }

  if (finalText === null) {
    await logError(userText, new Error('Tool-use loop exceeded max iterations'), telegramMessageId);
    return "I got stuck in a loop trying to handle that and stopped myself rather than keep guessing. Logged it — try rephrasing?";
  }

  history.push({ role: 'assistant', content: finalText });
  return finalText || "(no response text — logged as a gap)";
}
