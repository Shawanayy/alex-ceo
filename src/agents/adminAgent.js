import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { getCalendarClient, getGmailClient } from '../google/googleClient.js';
import { supabase } from '../supabaseClient.js';
import { getUserTimeZone } from '../utils/localDate.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

// create_event/update_event pin bare dateTime strings to Shane's CURRENT timezone (read live
// from Supabase's users.timezone, kept in sync via the set_timezone tool whenever Shane says
// he's switched between Hawaii and Oregon) rather than leaving Google to guess, or hardcoding
// one zone — hardcoding previously caused events to land hours off once he was on the other coast.

const SYSTEM_PROMPT = `You are the Admin Agent, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates Calendar and Gmail requests to. You have real tools for Google Calendar and Gmail — use \
them, don't guess.

Hard rule: you can create email DRAFTS but you must NEVER send an email. There is no send tool available \
to you on purpose — if asked to send, explain (in your final answer) that you created a draft instead and \
Shane needs to review and send it himself from Gmail.

You can create, edit (update), and delete Calendar events. update_event and delete_event both require the \
event's Google Calendar "id" — get it from list_events first if you don't already have it from earlier in \
this conversation. Every create/update/delete you make on Google Calendar is automatically mirrored to \
Shane's LifeOS dashboard, so you don't need a separate step for that.

Every event is either "hard" (class, work, meetings, appointments, flights — can't easily move) or \
"flexible" (gym/workouts, running, studying, reading, meditation, personal projects, meal prep, cleaning, \
planning, downtime — can move). Pass event_type on create_event/update_event when you're confident which \
one it is; if you omit it, keyword-based auto-classification runs and defaults to "hard" when unclear \
(safer than silently treating something as movable). You do NOT need to manually check for scheduling \
conflicts yourself — the system automatically detects when a new/updated "hard" event overlaps an existing \
"flexible" one and pushes Shane a Telegram notification with alternate time options. If Shane later replies \
picking one of those alternate times (or a different time) for the bumped flexible event, call update_event \
on that flexible event's id to actually move it.

Be proactive, not just reactive: when Shane asks you to "plan my day/week", "schedule my workouts", "block \
time for studying", or similar — don't just describe a plan in text, actually create the events. You have \
no access to Shane's actual fitness program or coursework yourself, so use the specific workout names and \
class/assignment names Alex includes in the request — never invent generic "Workout"/"Study" placeholders \
when real ones were given to you. Call find_open_slots first to see genuinely free windows (don't guess or \
assume gaps), then call create_event with event_type: 'flexible' for each block you place. Shane's known \
scheduling preferences (read them from the request context Alex gives you, or ask Alex to include them): \
timing varies by convenience but he \
prefers mornings and, in Oregon, lifting when already on campus; peak focus is usually at night or between \
classes; study sessions run ~45-60 min; he wants 8 hours of sleep with bedtime ~11pm-12am; he wants 1-2 \
hours of daily downtime, not just on weekends; NEVER schedule a workout after 9pm; and in Oregon, keep \
Sundays open for family time. Respect these when placing flexible blocks.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Include concrete details (event times, email subjects/senders) rather than vague \
summaries.`;

const toolDefs = [
  {
    name: 'list_events',
    description: "List events on Shane's primary Google Calendar within a time range.",
    input_schema: {
      type: 'object',
      properties: {
        time_min: { type: 'string', description: 'ISO 8601 start of range, e.g. 2026-07-09T00:00:00Z' },
        time_max: { type: 'string', description: 'ISO 8601 end of range' },
        max_results: { type: 'integer', description: 'Max events to return, default 20' },
      },
      required: ['time_min', 'time_max'],
    },
  },
  {
    name: 'create_event',
    description: "Create a new event on Shane's primary Google Calendar.",
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title' },
        description: { type: 'string', description: 'Optional event description' },
        start: {
          type: 'string',
          description:
            "Start datetime as a bare ISO 8601 local time WITHOUT a UTC offset, e.g. '2026-07-11T14:00:00' " +
            "for 2pm. Always Shane's local time (America/Los_Angeles) — never include a timezone offset " +
            'yourself, the tool applies it automatically.',
        },
        end: {
          type: 'string',
          description: "End datetime, same bare local-time format as start (no UTC offset).",
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of attendee email addresses',
        },
        event_type: {
          type: 'string',
          enum: ['hard', 'flexible'],
          description:
            "'hard' (class/work/meeting/appointment/flight — can't easily move) or 'flexible' " +
            '(gym/study/reading/meditation/personal project/meal prep/cleaning/planning/downtime — can ' +
            'move). Omit to auto-classify from the title/description.',
        },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'find_open_slots',
    description:
      "Find genuinely free windows on Shane's primary Google Calendar within a date range. Use this " +
      'BEFORE proactively placing flexible blocks (workouts, study, downtime, etc.) so you place them in ' +
      'time that is actually open, not just assumed to be.',
    input_schema: {
      type: 'object',
      properties: {
        date_min: { type: 'string', description: "Start date, 'YYYY-MM-DD', Shane's local time." },
        date_max: { type: 'string', description: "End date (exclusive), 'YYYY-MM-DD'." },
        min_duration_min: { type: 'integer', description: 'Minimum gap length in minutes to report, default 30.' },
      },
      required: ['date_min', 'date_max'],
    },
  },
  {
    name: 'update_event',
    description:
      "Edit an existing event on Shane's primary Google Calendar. Only include the fields that should " +
      'change — omitted fields keep their current value. Requires the event id (from list_events).',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: "The Google Calendar event id to edit." },
        summary: { type: 'string', description: 'New event title' },
        description: { type: 'string', description: 'New event description' },
        start: {
          type: 'string',
          description:
            "New start datetime as a bare ISO 8601 local time WITHOUT a UTC offset, e.g. " +
            "'2026-07-11T14:00:00' for 2pm. Always Shane's local time (America/Los_Angeles) — never " +
            'include a timezone offset yourself, the tool applies it automatically.',
        },
        end: {
          type: 'string',
          description: "New end datetime, same bare local-time format as start (no UTC offset).",
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'New list of attendee email addresses (replaces the existing list if provided)',
        },
        event_type: {
          type: 'string',
          enum: ['hard', 'flexible'],
          description: "Reclassify the event as 'hard' or 'flexible'. Omit to keep its current classification.",
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_event',
    description: "Delete an event from Shane's primary Google Calendar. Requires the event id (from list_events).",
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The Google Calendar event id to delete.' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'list_emails',
    description: "Search/list messages in Shane's Gmail inbox.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Gmail search query, e.g. 'is:unread' or 'from:someone@example.com'. Defaults to 'is:unread'.",
        },
        max_results: { type: 'integer', description: 'Max messages to return, default 10' },
      },
    },
  },
  {
    name: 'create_draft',
    description: 'Create an email draft in Gmail. Does NOT send it — Shane reviews and sends manually.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Plain-text email body' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

function buildRawEmail({ to, subject, body }) {
  const messageParts = [
    `To: ${to}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body,
  ];
  const message = messageParts.join('\n');
  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Hard = class/work/meeting/appointment/flight/exam/interview — can't easily move.
// Flexible = gym/workout/study/reading/meditation/personal project/meal prep/cleaning/planning/
// downtime — can move. Defaults to 'hard' when nothing matches, since silently treating an
// unrecognized event as movable is the riskier failure mode.
const FLEXIBLE_KEYWORDS = [
  'gym', 'workout', 'work out', 'run', 'running', 'jog', 'lift', 'lifting',
  'study', 'studying', 'homework', 'read', 'reading', 'meditate', 'meditation',
  'personal project', 'meal prep', 'mealprep', 'clean', 'cleaning', 'plan', 'planning', 'downtime',
];
const HARD_KEYWORDS = ['class', 'work', 'meeting', 'appointment', 'flight', 'exam', 'interview', 'shift'];
const WORKOUT_KEYWORDS = ['gym', 'workout', 'work out', 'run', 'running', 'jog', 'lift', 'lifting'];

function classifyEventType(summary, description, explicitType) {
  if (explicitType === 'hard' || explicitType === 'flexible') return explicitType;
  const text = `${summary || ''} ${description || ''}`.toLowerCase();
  if (FLEXIBLE_KEYWORDS.some((k) => text.includes(k))) return 'flexible';
  if (HARD_KEYWORDS.some((k) => text.includes(k))) return 'hard';
  return 'hard';
}

function isWorkoutTitle(title) {
  const t = (title || '').toLowerCase();
  return WORKOUT_KEYWORDS.some((k) => t.includes(k));
}

// Mirrors a created/updated Google Calendar event into the LifeOS dashboard's calendar_events
// table, keyed on google_event_id, so Shane's dashboard reflects edits Alex makes without
// depending on the (currently broken) n8n calendar sync workflow. Sync failures are logged but
// never thrown — a dashboard mirroring hiccup shouldn't fail the actual Calendar write, which is
// the part Shane actually asked for.
async function upsertDashboardEvent(googleEvent, eventType) {
  try {
    const row = {
      user_id: DEFAULT_USER_ID,
      google_event_id: googleEvent.id,
      gcal_calendar_id: 'primary',
      title: googleEvent.summary ?? null,
      description: googleEvent.description ?? null,
      start_time: googleEvent.start?.dateTime ?? googleEvent.start?.date ?? null,
      end_time: googleEvent.end?.dateTime ?? googleEvent.end?.date ?? null,
      source: 'alex',
      event_type: eventType ?? 'hard',
    };
    const { error } = await supabase
      .from('calendar_events')
      .upsert(row, { onConflict: 'google_event_id' });
    if (error) console.error('[Admin Agent] Dashboard sync (upsert) failed:', error.message);
  } catch (err) {
    console.error('[Admin Agent] Dashboard sync (upsert) threw:', err?.message ?? err);
  }
}

// Looks 2 calendar days ahead for a genuinely open slot the same length as the bumped flexible
// event, respecting the 6am-11pm window and (for workout titles) the "never after 9pm" rule.
// Best-effort: on any failure, returns no candidates rather than throwing, so a conflict
// notification still goes out (just without suggested times) instead of silently vanishing.
async function suggestAlternateSlots({ flexEvent, durationMs, excludeGoogleEventId }) {
  const DAY_START_HOUR = 6;
  const DAY_END_HOUR = 23;
  const NO_GO_WORKOUT_AFTER_HOUR = 21; // from sched_no_go_workout_after preference
  try {
    const origStart = new Date(flexEvent.start_time);
    const dayStart = new Date(origStart);
    dayStart.setHours(0, 0, 0, 0);
    const rangeEnd = new Date(dayStart);
    rangeEnd.setDate(rangeEnd.getDate() + 2);

    const calendar = getCalendarClient();
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: dayStart.toISOString(),
      timeMax: rangeEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    const busy = (res.data.items ?? [])
      .filter((e) => e.id !== excludeGoogleEventId && e.start?.dateTime && e.end?.dateTime)
      .map((e) => ({ start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) }));

    const isWorkout = isWorkoutTitle(flexEvent.title);
    const stepMs = 30 * 60 * 1000;
    const candidates = [];
    for (
      let slotStart = new Date(dayStart.getTime() + DAY_START_HOUR * 3600000);
      slotStart < rangeEnd && candidates.length < 3;
      slotStart = new Date(slotStart.getTime() + stepMs)
    ) {
      const slotEnd = new Date(slotStart.getTime() + durationMs);
      const startHour = slotStart.getHours() + slotStart.getMinutes() / 60;
      const endHour = startHour + durationMs / 3600000;
      if (startHour < DAY_START_HOUR || endHour > DAY_END_HOUR) continue;
      if (isWorkout && startHour >= NO_GO_WORKOUT_AFTER_HOUR) continue;
      const clash = busy.some((b) => slotStart < b.end && b.start < slotEnd);
      if (clash) continue;
      candidates.push(slotStart);
    }
    return candidates;
  } catch (err) {
    console.error('[Admin Agent] suggestAlternateSlots failed:', err?.message ?? err);
    return [];
  }
}

// Automatic conflict detection: fires whenever a HARD event is created/updated. Checks the
// dashboard's calendar_events for FLEXIBLE events it now overlaps. Never auto-moves anything —
// only pushes a high-urgency notification (delivered to Telegram by the background loop within
// 5 min) with suggested alternate times, so Shane stays in control of the reschedule.
async function checkAndNotifyConflicts({ newEvent, eventType }) {
  try {
    if (eventType !== 'hard') return;
    const startISO = newEvent.start?.dateTime;
    const endISO = newEvent.end?.dateTime;
    if (!startISO || !endISO) return; // skip all-day events — nothing meaningful to overlap-check

    const { data: flexEvents, error } = await supabase
      .from('calendar_events')
      .select('*')
      .eq('event_type', 'flexible')
      .neq('google_event_id', newEvent.id)
      .lt('start_time', endISO)
      .gt('end_time', startISO);
    if (error) {
      console.error('[Admin Agent] Conflict check query failed:', error.message);
      return;
    }
    if (!flexEvents || flexEvents.length === 0) return;

    for (const flex of flexEvents) {
      const durationMs = new Date(flex.end_time) - new Date(flex.start_time);
      const alternates = await suggestAlternateSlots({
        flexEvent: flex,
        durationMs,
        excludeGoogleEventId: flex.google_event_id,
      });
      const altText = alternates.length
        ? alternates
            .map(
              (d, i) =>
                `${i + 1}. ${d.toLocaleString('en-US', {
                  weekday: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })}`
            )
            .join('\n')
        : "Couldn't find an open alternate slot in the next 2 days — you'll need to pick a time manually.";

      const { error: notifErr } = await supabase.from('notifications').insert({
        source_agent: 'admin_agent',
        urgency: 'high',
        title: `Conflict: "${newEvent.summary}" overlaps "${flex.title}"`,
        body:
          `You just added "${newEvent.summary}" which overlaps your flexible block "${flex.title}". ` +
          `Move it?\n${altText}\nReply with a number, a different time, or "leave it" to keep both as-is.`,
      });
      if (notifErr) console.error('[Admin Agent] Failed to push conflict notification:', notifErr.message);
    }
  } catch (err) {
    console.error('[Admin Agent] Conflict detection threw:', err?.message ?? err);
  }
}

async function findOpenSlots({ date_min, date_max, min_duration_min }) {
  const calendar = getCalendarClient();
  const timeZone = await getUserTimeZone();
  const minDuration = (min_duration_min ?? 30) * 60 * 1000;
  const rangeStart = new Date(`${date_min}T00:00:00`);
  const rangeEnd = new Date(`${date_max}T00:00:00`);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: rangeStart.toISOString(),
    timeMax: rangeEnd.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  const busy = (res.data.items ?? [])
    .filter((e) => e.start?.dateTime && e.end?.dateTime)
    .map((e) => ({ start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) }))
    .sort((a, b) => a.start - b.start);

  // NOTE: MVP gap-finder — treats the whole range as one open block minus busy events, rather
  // than clamping each day to a wake/sleep window. Good enough for Alex to reason over when
  // placing flexible blocks; Alex is instructed to respect Shane's stated prefs (e.g. no workouts
  // after 9pm) on top of these raw gaps.
  const slots = [];
  let cursor = rangeStart;
  for (const b of busy) {
    if (b.start - cursor >= minDuration) {
      slots.push({ start: cursor.toISOString(), end: b.start.toISOString() });
    }
    if (b.end > cursor) cursor = b.end;
  }
  if (rangeEnd - cursor >= minDuration) {
    slots.push({ start: cursor.toISOString(), end: rangeEnd.toISOString() });
  }
  return { ok: true, time_zone: timeZone, slots };
}

async function deleteDashboardEvent(googleEventId) {
  try {
    const { error } = await supabase.from('calendar_events').delete().eq('google_event_id', googleEventId);
    if (error) console.error('[Admin Agent] Dashboard sync (delete) failed:', error.message);
  } catch (err) {
    console.error('[Admin Agent] Dashboard sync (delete) threw:', err?.message ?? err);
  }
}

async function listEvents({ time_min, time_max, max_results }) {
  const calendar = getCalendarClient();
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: time_min,
    timeMax: time_max,
    maxResults: max_results ?? 20,
    singleEvents: true,
    orderBy: 'startTime',
  });
  const events = (res.data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    attendees: (e.attendees ?? []).map((a) => a.email),
  }));
  return { ok: true, events };
}

async function createEvent({ summary, description, start, end, attendees, event_type }) {
  const calendar = getCalendarClient();
  const timeZone = await getUserTimeZone();
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary,
      description: description ?? undefined,
      start: { dateTime: start, timeZone },
      end: { dateTime: end, timeZone },
      attendees: (attendees ?? []).map((email) => ({ email })),
    },
  });
  const resolvedType = classifyEventType(summary, description, event_type);
  await upsertDashboardEvent(res.data, resolvedType);
  await checkAndNotifyConflicts({ newEvent: res.data, eventType: resolvedType });
  return { ok: true, event: { id: res.data.id, htmlLink: res.data.htmlLink, event_type: resolvedType } };
}

async function updateEvent({ event_id, summary, description, start, end, attendees, event_type }) {
  const calendar = getCalendarClient();
  const timeZone = await getUserTimeZone();
  const requestBody = {};
  if (summary !== undefined) requestBody.summary = summary;
  if (description !== undefined) requestBody.description = description;
  if (start !== undefined) requestBody.start = { dateTime: start, timeZone };
  if (end !== undefined) requestBody.end = { dateTime: end, timeZone };
  if (attendees !== undefined) requestBody.attendees = attendees.map((email) => ({ email }));

  const res = await calendar.events.patch({
    calendarId: 'primary',
    eventId: event_id,
    requestBody,
  });

  let resolvedType = event_type;
  if (resolvedType !== 'hard' && resolvedType !== 'flexible') {
    const { data: existing } = await supabase
      .from('calendar_events')
      .select('event_type')
      .eq('google_event_id', event_id)
      .maybeSingle();
    resolvedType = existing?.event_type || classifyEventType(res.data.summary, res.data.description);
  }
  await upsertDashboardEvent(res.data, resolvedType);
  await checkAndNotifyConflicts({ newEvent: res.data, eventType: resolvedType });
  return { ok: true, event: { id: res.data.id, htmlLink: res.data.htmlLink, event_type: resolvedType } };
}

async function deleteEvent({ event_id }) {
  const calendar = getCalendarClient();
  await calendar.events.delete({ calendarId: 'primary', eventId: event_id });
  await deleteDashboardEvent(event_id);
  return { ok: true, deleted_event_id: event_id };
}

async function listEmails({ query, max_results }) {
  const gmail = getGmailClient();
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query || 'is:unread',
    maxResults: max_results ?? 10,
  });
  const messages = listRes.data.messages ?? [];
  const details = await Promise.all(
    messages.map(async (m) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const headers = msg.data.payload?.headers ?? [];
      const get = (name) => headers.find((h) => h.name === name)?.value ?? null;
      return {
        id: m.id,
        from: get('From'),
        subject: get('Subject'),
        date: get('Date'),
        snippet: msg.data.snippet,
      };
    })
  );
  return { ok: true, emails: details };
}

async function createDraft({ to, subject, body }) {
  const gmail = getGmailClient();
  const raw = buildRawEmail({ to, subject, body });
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });
  return {
    ok: true,
    draft_id: res.data.id,
    note: 'Draft created — not sent. Review and send manually in Gmail.',
  };
}

async function runAdminTool(name, input) {
  switch (name) {
    case 'list_events':
      return listEvents(input);
    case 'create_event':
      return createEvent(input);
    case 'find_open_slots':
      return findOpenSlots(input);
    case 'update_event':
      return updateEvent(input);
    case 'delete_event':
      return deleteEvent(input);
    case 'list_emails':
      return listEmails(input);
    case 'create_draft':
      return createDraft(input);
    default:
      throw new Error(`Unknown Admin Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runAdminAgent(request) {
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
        const result = await runAdminTool(use.name, use.input);
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

  return finalText || "Admin Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
