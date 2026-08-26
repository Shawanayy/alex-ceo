import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { getCalendarClient, getGmailClient } from '../google/googleClient.js';
import { supabase } from '../supabaseClient.js';
import { getUserTimeZone } from '../utils/localDate.js';

import { COMPLEX_MODEL } from '../modelTiers.js';

import { fetchAgentMemories, formatCorrectionsBlock } from '../memoryScope.js';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = COMPLEX_MODEL; // real judgment/writing/forecasting — Sonnet tier
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
Shane's LifeOS dashboard, so you don't need a separate step for that. Events live on whichever specific \
Google Calendar matches their category — not just Shane's primary calendar — but list_events, \
find_open_slots, and conflict detection already check across every one of his calendars automatically, so \
you never need to specify which calendar to search.

Every event has a category, which determines which calendar it's placed on and what color it gets. Pass \
\`category\` on create_event/update_event when you're confident which one applies; if you omit it, \
keyword-based auto-classification runs, defaulting to "other" (a hard/inflexible catch-all) when nothing \
matches — safer than silently treating something as movable. The categories:

Hard (can't easily move): \`work\` (anything work-related → Work calendar), \`class\` (classes, midterms, \
finals → all go on the single School calendar, except IM Sports which still has its own; Shane deleted his \
old per-class calendars and is using one calendar for all classes for now — per-class routing/colors can \
come back once he sets his new class list), \
\`hoh\` (Hui O Hawaiʻi club meetings, events, hula practice → Hui calendar), \`php\` (Pocket Home Production \
club meetings, presentations, field trips, events → PHP calendar), \`personal\` (birthdays → \
Birthdays calendar; reminders like pills/creatine/meditation, and flights → Personal calendar), and \`other\` \
(anything that doesn't fit elsewhere → Personal calendar).

Flexible (can move easily — all live on Shane's primary calendar, distinguished only by color): \`study\` \
(tutoring, library study time, at-home studying, reading, planning), \`workout\` (gym, lifts, strength \
training), \`run\` (runs, jogs — kept as its own category/color, separate from \`workout\`, so lifts and runs \
are visually distinguishable at a glance), \`ft_time\` (FaceTiming family, Haliʻa, anyone else), \`chores\` \
(dishes, meal prep, cleaning house). You do NOT need to manually check for scheduling conflicts yourself — the system automatically \
detects when a new/updated hard event overlaps an existing flexible one and pushes Shane a Telegram \
notification with alternate time options. If Shane later replies picking one of those alternate times (or a \
different time) for the bumped flexible event, call update_event on that flexible event's id to actually \
move it.

Be proactive, not just reactive, for study/chores/ft_time: when Shane asks you to "plan my day/week", "block \
time for studying", or similar — don't just describe a plan in text, actually create the events. Use the \
specific class/assignment names Alex includes in the request — never invent generic "Study" placeholders \
when real ones were given to you. Call find_open_slots first to see genuinely free windows (don't guess or \
assume gaps). Then call create_event with the matching category for each block you place. NEVER end your turn \
by asking Shane whether to go ahead, which time he prefers, or "want me to calendar this?" for these — decide \
the time yourself using the stated defaults below and create the events directly. He reviews and edits on the \
calendar after the fact; that's faster for him than reading a text summary and replying with preferences.

Workouts/runs are the one exception to "be proactive": lifting and running are LOW-PRIORITY for Shane, not \
something to auto-fill his calendar with. Only place a workout/run block when Alex's request specifically \
asks for one by name ("schedule my Legs day", "put my run on the calendar") — do NOT auto-add workout/run \
blocks just because a generic "plan my day/week" request came through and a lift day happens to be next in \
the rotation. When you do place one, call find_open_slots first (buffer_min ~20-25 so it doesn't land \
squashed edge-to-edge against another event) and create the event directly, same as above — no need to ask \
Shane first for these either. If no open window exists, skip it and say so; never force a squeezed placement.

Shane's known scheduling preferences (read additional context from Alex when given, but treat these as the \
baseline defaults):
- Workouts (lifting): when Shane does ask for one placed, prefer AFTER work/class first — he's got more slack \
then and is already out/on the road, so it doesn't cost him a separate trip. Fitting it between/before/after \
classes, or first thing in the morning right before a run (so he only has to shower once), are fine fallbacks \
when after-work doesn't have room. A lift block should reserve about 70 minutes of actual lifting time (the \
buffer_min above is separate slack on top of that, not part of it). NEVER schedule a workout after 9pm. If \
find_open_slots turns up NO genuinely open window that day — do not force the block into a squeezed or \
conflicting gap. Skip lifting for that day entirely and say so plainly, without framing it as a problem; a \
missed or skipped lift/run day is a total non-issue for Shane, not something to flag, apologize for, or try \
to make up.
- Runs: mornings preferred.
- Study: place it in the library when he's on campus between/before/after classes, or at night — his two \
most-productive windows. Any length works; he manages his own breaks, so don't force a fixed duration like \
"45-60 min" on a block.
- Sleep: 8 hours is his productive baseline, 6 hours is the functional floor. On any day with a class event \
tagged midterm/final, protect the full 8 hours the night before — don't place flexible blocks that would \
push his bedtime later that night.
- FaceTime (ft_time): one family call a week, one Haliʻa date a month. A separate background check already \
nudges him on Telegram if a week/month is about to pass without one on the calendar, so you don't need to \
proactively schedule these unprompted — but if he asks you to plan his week/month and neither is on the \
calendar yet, flag it and offer to add one.
- General: preserve 1-2 hours of unscheduled personal time daily, not just on weekends — this means leaving \
a genuine gap by not stacking flexible blocks back-to-back, NOT creating an actual "Downtime" (or similar) \
calendar event. Never create a downtime/personal-time block on a generic plan-my-day/week request; only do \
so if Shane explicitly asks for downtime to be blocked out on the calendar. In Oregon, keep Sundays open for \
family time the same way — by leaving it unscheduled, not by adding an event for it.

Respect these when placing flexible blocks.

Keep workout event titles short — just the day_type (e.g. 'Legs', 'Chest/Back', 'Arms/Abs'), never the full \
exercise breakdown. Shane doesn't want the entire workout plan on the calendar event, just what day it is \
at a glance.

When Alex gives you workout blocks to place that came from the Fitness Agent's get_upcoming_workouts \
projection (multi-day planning), each projected day still needs its own real start/end time — call \
find_open_slots for that specific date and pick an actual open window using the same defaults as a \
single-day workout (after work first, ~70 minutes reserved, buffer_min ~20-25, never after 9pm). NEVER \
place a full-day or midnight-to-midnight placeholder block just because it's a projection instead of a \
single ask — every workout event needs a genuine specific time slot the same way a single-day one does. \
Pass workout_projection_day_type on create_event for each one, set to \
the exact day_type given (e.g. 'Legs', 'Chest/Back', 'Arms/Abs'). This tags the block so it can be kept \
in sync later — those projections assume every prior day gets completed as planned, and drift (a skipped \
or swapped day) shifts the rotation for everything after it. Whenever Alex tells you a workout was just \
logged, or asks you to refresh/resync the schedule, call resync_workout_projections — it re-checks every \
tagged future block against a fresh projection and corrects any that drifted, with no need to ask Shane \
first.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Include concrete details (event times, email subjects/senders) rather than vague \
summaries.`;

const toolDefs = [
  {
    name: 'list_events',
    description: "List events across all of Shane's Google Calendars within a time range.",
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
    description: "Create a new event on whichever of Shane's Google Calendars matches its category.",
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title' },
        description: { type: 'string', description: 'Optional event description' },
        start: {
          type: 'string',
          description:
            "Start datetime as a bare ISO 8601 local time WITHOUT a UTC offset, e.g. '2026-07-11T14:00:00' " +
            "for 2pm. Whatever number you write here IS the wall-clock time Shane sees on the event — the " +
            "tool tags it with his current configured timezone (from the date/time context you were given) " +
            'automatically. Do NOT append your own offset (no "-07:00", no "Z") and do NOT manually convert ' +
            'between zones yourself — that double-converts and produces a wrong time. Just write the literal ' +
            'clock time Shane means.',
        },
        end: {
          type: 'string',
          description: "End datetime, same bare local-time format as start (no UTC offset, no manual conversion).",
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of attendee email addresses',
        },
        category: {
          type: 'string',
          enum: ['work', 'class', 'hoh', 'php', 'personal', 'other', 'study', 'workout', 'run', 'ft_time', 'chores'],
          description:
            "Determines which calendar the event is placed on and its color. 'work'/'class'/'hoh'/'php'/" +
            "'personal'/'other' are hard (inflexible); 'study'/'workout'/'run'/'ft_time'/'chores' are flexible " +
            "(easy to move). 'workout' is lifts/gym/strength training; 'run' is runs/jogs — kept separate so " +
            "they get different colors. Omit to auto-classify from the title/description (defaults to 'other' " +
            'when unclear).',
        },
        workout_projection_day_type: {
          type: 'string',
          description:
            "Only set this when the event is a workout block placed from the Fitness Agent's " +
            "get_upcoming_workouts projection — pass the exact day_type (e.g. 'Legs', 'Chest/Back', " +
            "'Arms/Abs') for that block. This tags the event so resync_workout_projections can later " +
            'detect drift (if the rotation shifted because a prior day was skipped/swapped) and correct ' +
            'it automatically. Omit for non-workout events or workout events not from a projection.',
        },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'find_open_slots',
    description:
      "Find genuinely free windows across all of Shane's Google Calendars within a date range. Use this " +
      'BEFORE proactively placing flexible blocks (workouts, study, downtime, etc.) so you place them in ' +
      'time that is actually open, not just assumed to be.',
    input_schema: {
      type: 'object',
      properties: {
        date_min: { type: 'string', description: "Start date, 'YYYY-MM-DD', Shane's local time." },
        date_max: { type: 'string', description: "End date (exclusive), 'YYYY-MM-DD'." },
        min_duration_min: { type: 'integer', description: 'Minimum gap length in minutes to report, default 30.' },
        buffer_min: {
          type: 'integer',
          description:
            'Minutes of breathing room to require on both sides of every reported slot, on top of ' +
            'existing events (travel/shower/changing time, etc). Reported slots are guaranteed to have ' +
            'at least this much real gap to neighboring events, not just be adjacent to them. Use ~20-25 ' +
            'when placing lift/run blocks so they never land squashed edge-to-edge against another event. ' +
            'Default 0 (no padding) — fine for things like study blocks that don\'t need transition time.',
        },
      },
      required: ['date_min', 'date_max'],
    },
  },
  {
    name: 'update_event',
    description:
      "Edit an existing event on Shane's Google Calendar. Only include the fields that should " +
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
            "'2026-07-11T14:00:00' for 2pm. Whatever number you write here IS the wall-clock time Shane " +
            'sees — the tool tags it with his current configured timezone automatically. Do NOT append ' +
            'your own offset and do NOT manually convert between zones yourself — that double-converts.',
        },
        end: {
          type: 'string',
          description: "New end datetime, same bare local-time format as start (no UTC offset, no manual conversion).",
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'New list of attendee email addresses (replaces the existing list if provided)',
        },
        category: {
          type: 'string',
          enum: ['work', 'class', 'hoh', 'php', 'personal', 'other', 'study', 'workout', 'run', 'ft_time', 'chores'],
          description:
            'Reclassify the event into a different category — recalculates its color and, if the new ' +
            "category lives on a different calendar, moves the event there. Omit to keep the event's " +
            'current category/calendar.',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_event',
    description: "Delete an event from Shane's Google Calendar. Requires the event id (from list_events).",
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
  {
    name: 'resync_workout_projections',
    description:
      'Re-checks every future calendar block tagged as a workout projection (created via create_event ' +
      "with workout_projection_day_type set) against a fresh get_upcoming_workouts projection, and " +
      'patches any that have drifted (day_type no longer matches, e.g. because an earlier lift day was ' +
      'skipped or swapped, which shifts the rotation). Call this any time the underlying workout log ' +
      'changes — most importantly right after a workout gets logged — so future projected blocks stay ' +
      'accurate without Shane having to ask.',
    input_schema: { type: 'object', properties: {} },
  cache_control: { type: 'ephemeral' },
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

// --- Calendar categorization -------------------------------------------------------------
// Shane's category taxonomy (replaces the old binary hard/flexible-only scheme). Each category
// maps to a specific Google Calendar + color, and implies hard (inflexible) or flexible (movable).
// There's no create_calendar API available, so every calendar referenced here must already exist
// in Shane's Google account — resolved via CALENDAR_ID_BY_NAME below. If he renames/recreates any
// of these calendars, this map needs updating too.
const CALENDAR_ID_BY_NAME = {
  // Shane deleted his per-class calendars (Global Architecture, Civil and Construction,
  // Physics 213, Strengths and Materials) — all class events now route to 'School' below.
  'IM Sports': '30e3c64ae60b68ec4d6b83eb286b5897f42eefc40f4ab537d72705d40f3370da@group.calendar.google.com',
  'Hui': '6c611b596f329c6197c9e6af254a1a734771634e02a6a5373519e70e9fdd6a37@group.calendar.google.com',
  'School': '4c4e00ae05affea43df12dcc20421ff85488f68f3447c0cf3ae132d4822be9a4@group.calendar.google.com',
  'Birthdays': '352e3043d323cc10900c2e38ae632d304f81821d36388ed7d062cb1870bd4f85@group.calendar.google.com',
  'Work': 'ab074c43050109c7881b909535efffb1cf02bcbdbb1299dec44e69707fd85d46@group.calendar.google.com',
  'Personal': 'e79770fee67c86dfe8e6738333b26a3b8997d62d93b6c5b255501f4defa4a6d0@group.calendar.google.com',
  // Shane repurposed his old "Mechanical Facilities" calendar (same id) into the PHP club calendar.
  'PHP': '5bb5d1a211b607cd81c26d1b792e8ffafb5e5a5c602cf02d927fc56baf3b37c8@group.calendar.google.com',
};
// Google's own email works as a calendarId alias for "the account's primary calendar" — used for
// every flexible category, all of which share one calendar and are told apart only by color.
const PRIMARY_CALENDAR_ID = 'shawanayy@gmail.com';

function resolveCalendarId(calendarName) {
  if (calendarName === 'primary') return { id: PRIMARY_CALENDAR_ID, fellBackFromPHP: false };
  const id = CALENDAR_ID_BY_NAME[calendarName];
  if (!id) return { id: CALENDAR_ID_BY_NAME.Personal, fellBackFromPHP: calendarName === 'PHP' };
  return { id, fellBackFromPHP: false };
}

// Google Calendar event colorId palette (fixed 11 values): 1 Lavender, 2 Sage, 3 Grape,
// 4 Flamingo, 5 Banana, 6 Tangerine, 7 Peacock, 8 Graphite, 9 Blueberry, 10 Basil, 11 Tomato.
const CATEGORY_MAP = {
  work: { eventType: 'hard', colorId: '11' }, // Tomato
  class: { eventType: 'hard', colorId: '9' }, // Blueberry
  hoh: { eventType: 'hard', colorId: '10' }, // Basil
  php: { eventType: 'hard', colorId: '3' }, // Grape
  personal: { eventType: 'hard', colorId: '4' }, // Flamingo
  other: { eventType: 'hard', colorId: '8' }, // Graphite
  study: { eventType: 'flexible', colorId: '5' }, // Banana
  workout: { eventType: 'flexible', colorId: '6' }, // Tangerine
  run: { eventType: 'flexible', colorId: '7' }, // Peacock
  ft_time: { eventType: 'flexible', colorId: '1' }, // Lavender
  chores: { eventType: 'flexible', colorId: '2' }, // Sage
};

// Word-boundary match so short keywords like "work" don't fire on "homework"/"coursework".
function includesWord(text, words) {
  return words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
}

const HOH_KEYWORDS = ['hoh', 'hui o hawaii', 'hui o hawaiʻi', "hui o hawai'i", 'hula'];
const PHP_KEYWORDS = ['php', 'pocket home production'];
const WORK_KEYWORDS = ['work', 'shift', 'clock in', 'clock out'];
const CLASS_KEYWORDS = ['class', 'lecture', 'midterm', 'midterms', 'final', 'finals', 'exam', 'quiz', 'lab'];
const PERSONAL_KEYWORDS = ['birthday', 'pills', 'medication', 'creatine', 'meditation', 'flight', 'reminder', 'passport'];
const FT_KEYWORDS = ['facetime', 'ft time', 'halia', 'haliʻa', "hali'a", 'call mom', 'call dad', 'family call'];
// Split out of FT_KEYWORDS for the weekly/monthly reminder check below, which needs to tell a
// Haliʻa date apart from a family call rather than just detecting "some ft_time event exists".
const HALIA_DATE_KEYWORDS = ['halia', 'haliʻa', "hali'a"];
const FAMILY_FT_KEYWORDS = ['facetime', 'ft time', 'call mom', 'call dad', 'family call'];
const CHORES_KEYWORDS = ['chore', 'chores', 'dishes', 'clean', 'cleaning', 'meal prep', 'mealprep', 'cook', 'cooking', 'laundry'];
// Runs get their own category/color, split out from lifts/gym below — checked first in
// classifyCategory so "run"/"jog" never falls through to the lift bucket.
const RUN_KEYWORDS = ['run', 'running', 'jog', 'jogging'];
const LIFT_KEYWORDS = ['gym', 'workout', 'work out', 'lift', 'lifting', 'training', 'train'];
// Combined set — used where lift vs. run doesn't matter (e.g. the "never after 9pm" title check).
const WORKOUT_KEYWORDS = [...LIFT_KEYWORDS, ...RUN_KEYWORDS];
const STUDY_KEYWORDS = ['study', 'studying', 'tutor', 'tutoring', 'library', 'homework', 'coursework', 'read', 'reading', 'plan', 'planning', 'personal project'];

const CLASS_SUBJECT_ROUTES = [
  // Per-class calendars (Physics 213, Global Architecture, Civil and Construction, Strengths
  // and Materials) deleted by Shane — he's using one calendar for all classes now, so those
  // subjects fall through to 'School' below. Re-add per-class routes once he sets up new
  // per-class calendars/colors.
  { name: 'IM Sports', words: ['im sports', 'intramural'] },
];

function resolveClassCalendarName(text) {
  for (const { name, words } of CLASS_SUBJECT_ROUTES) {
    if (includesWord(text, words)) return name;
  }
  return 'School'; // generic class catch-all
}

// Auto-classifies into one of the 10 categories above. Explicit category (from the tool call)
// always wins. Order matters below — checked most-specific-club first, since e.g. "meeting" alone
// is ambiguous but "HOH meeting" or "PHP meeting" isn't. Defaults to 'other' (hard) when nothing
// matches, since silently treating an unrecognized event as movable is the riskier failure mode.
function classifyCategory(summary, description, explicitCategory) {
  if (explicitCategory && CATEGORY_MAP[explicitCategory]) return explicitCategory;
  const text = `${summary || ''} ${description || ''}`;
  if (includesWord(text, HOH_KEYWORDS)) return 'hoh';
  if (includesWord(text, PHP_KEYWORDS)) return 'php';
  if (includesWord(text, WORK_KEYWORDS)) return 'work';
  if (includesWord(text, CLASS_KEYWORDS)) return 'class';
  if (includesWord(text, PERSONAL_KEYWORDS)) return 'personal';
  if (includesWord(text, FT_KEYWORDS)) return 'ft_time';
  if (includesWord(text, CHORES_KEYWORDS)) return 'chores';
  if (includesWord(text, RUN_KEYWORDS)) return 'run';
  if (includesWord(text, LIFT_KEYWORDS)) return 'workout';
  if (includesWord(text, STUDY_KEYWORDS)) return 'study';
  return 'other';
}

function resolveCalendarNameForCategory(category, text) {
  switch (category) {
    case 'work': return 'Work';
    case 'class': return resolveClassCalendarName(text);
    case 'hoh': return 'Hui';
    case 'php': return 'PHP';
    case 'personal': return includesWord(text, ['birthday']) ? 'Birthdays' : 'Personal';
    case 'other': return 'Personal';
    default: return 'primary'; // study, workout, run, ft_time, chores
  }
}

// Back-compat helper: old code paths that only need hard/flexible (not the full category) can
// still call this — it just runs the same classifier and reads off the eventType.
function classifyEventType(summary, description, explicitType) {
  if (explicitType === 'hard' || explicitType === 'flexible') return explicitType;
  const category = classifyCategory(summary, description);
  return CATEGORY_MAP[category].eventType;
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
async function upsertDashboardEvent(googleEvent, eventType, gcalCalendarId, category, colorId) {
  try {
    const row = {
      user_id: DEFAULT_USER_ID,
      google_event_id: googleEvent.id,
      gcal_calendar_id: gcalCalendarId || PRIMARY_CALENDAR_ID,
      title: googleEvent.summary ?? null,
      description: googleEvent.description ?? null,
      start_time: googleEvent.start?.dateTime ?? googleEvent.start?.date ?? null,
      end_time: googleEvent.end?.dateTime ?? googleEvent.end?.date ?? null,
      source: 'alex',
      event_type: eventType ?? 'hard',
      // category/color_id let the dashboard tell flexible events (workout/study/chores/ft_time)
      // apart — they all share one Google Calendar and are only distinguished by colorId there,
      // so without these columns the dashboard had no way to render them differently.
      category: category ?? null,
      color_id: colorId ?? null,
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

    const items = await listEventsAcrossCalendars({
      time_min: dayStart.toISOString(),
      time_max: rangeEnd.toISOString(),
    });
    const busy = items
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

// Events now live across many different Google Calendars (one per category), not just Shane's
// primary one, so anything that needs to know "what's actually busy" has to check every calendar
// in play. Fetches run in parallel; a failure on any single calendar is logged and treated as
// empty for that calendar rather than failing the whole read.
function allKnownCalendarIds() {
  return [PRIMARY_CALENDAR_ID, ...Object.values(CALENDAR_ID_BY_NAME).filter(Boolean)];
}

async function listEventsAcrossCalendars({ time_min, time_max }) {
  const calendar = getCalendarClient();
  const calendarIds = allKnownCalendarIds();
  const results = await Promise.all(
    calendarIds.map((calendarId) =>
      calendar.events
        .list({ calendarId, timeMin: time_min, timeMax: time_max, singleEvents: true, orderBy: 'startTime' })
        .then((res) => (res.data.items ?? []).map((e) => ({ ...e, _calendarId: calendarId })))
        .catch((err) => {
          console.error(`[Admin Agent] listEvents failed for calendar ${calendarId}:`, err?.message ?? err);
          return [];
        })
    )
  );
  return results.flat();
}

// --- FaceTime cadence check (family weekly, Haliʻa monthly) ------------------------------
// Called from backgroundLoop.js on a timer, independent of any Alex conversation — Shane wants a
// Telegram nudge if a week/month is about to pass with nothing on the calendar, not just when he
// happens to ask Alex to plan his time. Checks real events, not just "did N days elapse", so it
// only fires when the thing is actually missing.
function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function hasEventMatching({ time_min, time_max, words }) {
  const items = await listEventsAcrossCalendars({ time_min, time_max });
  return items.some((e) => includesWord(`${e.summary || ''} ${e.description || ''}`, words));
}

// Returns { familyMissing, haliaMissing }. Only evaluates each once the window is far enough
// along to be worth flagging (Thu onward for the week, 20th onward for the month) so this doesn't
// nag on day one — backgroundLoop.js calls this daily and it naturally stays quiet until then.
export async function checkFacetimeStatus() {
  const now = new Date();
  const weekStart = startOfWeek(now);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const dayOfWeek = now.getDay(); // 0 Sun .. 6 Sat
  const dayOfMonth = now.getDate();
  const result = { familyMissing: false, haliaMissing: false };

  if ([4, 5, 6, 0].includes(dayOfWeek)) {
    const hasFamily = await hasEventMatching({
      time_min: weekStart.toISOString(),
      time_max: weekEnd.toISOString(),
      words: FAMILY_FT_KEYWORDS,
    });
    result.familyMissing = !hasFamily;
  }

  if (dayOfMonth >= 20) {
    const hasHalia = await hasEventMatching({
      time_min: monthStart.toISOString(),
      time_max: monthEnd.toISOString(),
      words: HALIA_DATE_KEYWORDS,
    });
    result.haliaMissing = !hasHalia;
  }

  return result;
}

async function findOpenSlots({ date_min, date_max, min_duration_min, buffer_min }) {
  const timeZone = await getUserTimeZone();
  const minDuration = (min_duration_min ?? 30) * 60 * 1000;
  const buffer = (buffer_min ?? 0) * 60 * 1000;
  const rangeStart = new Date(`${date_min}T00:00:00`);
  const rangeEnd = new Date(`${date_max}T00:00:00`);

  const items = await listEventsAcrossCalendars({
    time_min: rangeStart.toISOString(),
    time_max: rangeEnd.toISOString(),
  });
  const rawBusy = items
    .filter((e) => e.start?.dateTime && e.end?.dateTime)
    .map((e) => ({ start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) }))
    .sort((a, b) => a.start - b.start);

  // Merge overlaps across calendars before gap-finding — two different calendars can carry
  // overlapping busy blocks, which would otherwise double-count as separate busy windows.
  const busy = [];
  for (const b of rawBusy) {
    const last = busy[busy.length - 1];
    if (last && b.start <= last.end) {
      if (b.end > last.end) last.end = b.end;
    } else {
      busy.push({ ...b });
    }
  }

  // Pad every busy block by buffer_min on each side before gap-finding, then re-merge (padding
  // can bridge two previously-separate busy blocks into one). This is how "don't squash a
  // workout right up against another event" gets enforced — a reported slot's real edges always
  // have at least buffer_min of breathing room to travel/shower/change, since it's built from the
  // padded busy times rather than the raw event times. Clamped to the requested range.
  let gapBusy = busy;
  if (buffer > 0) {
    const padded = busy
      .map((b) => ({
        start: new Date(Math.max(rangeStart.getTime(), b.start.getTime() - buffer)),
        end: new Date(Math.min(rangeEnd.getTime(), b.end.getTime() + buffer)),
      }))
      .sort((a, b) => a.start - b.start);
    gapBusy = [];
    for (const b of padded) {
      const last = gapBusy[gapBusy.length - 1];
      if (last && b.start <= last.end) {
        if (b.end > last.end) last.end = b.end;
      } else {
        gapBusy.push({ ...b });
      }
    }
  }

  // NOTE: MVP gap-finder — treats the whole range as one open block minus busy events, rather
  // than clamping each day to a wake/sleep window. Good enough for Alex to reason over when
  // placing flexible blocks; Alex is instructed to respect Shane's stated prefs (e.g. no workouts
  // after 9pm) on top of these raw gaps.
  const slots = [];
  let cursor = rangeStart;
  for (const b of gapBusy) {
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
  const items = await listEventsAcrossCalendars({ time_min, time_max });
  items.sort(
    (a, b) => new Date(a.start?.dateTime ?? a.start?.date) - new Date(b.start?.dateTime ?? b.start?.date)
  );
  const events = items.slice(0, max_results ?? 20).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    attendees: (e.attendees ?? []).map((a) => a.email),
    calendar_id: e._calendarId,
  }));
  return { ok: true, events };
}

// Tag format: a `[workout_projection:<day_type>]` marker appended to the description. Kept as a
// plain-text marker rather than a new schema column (smaller migration surface) — parsed back out
// by resyncWorkoutProjections() via WORKOUT_PROJECTION_TAG_RE.
const WORKOUT_PROJECTION_TAG_RE = /\[workout_projection:([^\]]+)\]/;

function tagWorkoutProjectionDescription(description, dayType) {
  const base = description ?? '';
  const stripped = base.replace(WORKOUT_PROJECTION_TAG_RE, '').trim();
  const tag = `[workout_projection:${dayType}]`;
  return stripped ? `${stripped}\n\n${tag}` : tag;
}

// Guard against a flexible block (workout/study/ft_time/chores) landing on top of an existing
// event. Alex is *instructed* to call find_open_slots first, but that's prompt discipline, not a
// guarantee — this re-checks at insert time regardless of whether the LLM actually did that, so a
// bad placement gets rejected instead of silently created. Classifies each existing overlapping
// event the same way createEvent classifies new ones, so it doesn't need a separate DB round-trip
// to know which calendar/category an existing event belongs to.
//
// `types` controls which existing events count as blocking. Entries can be an eventType
// ('hard' or 'flexible', blocking against every category of that type) or a specific category
// name (e.g. 'ft_time', blocking against just that one category regardless of type). Pass
// ['hard'] to only block against inflexible events (the original behavior), ['hard','flexible']
// to also block against every other flexible event, or a narrower mix like ['hard','ft_time']
// to only protect specific categories. Workouts use the narrow form — see createEvent/updateEvent
// below for why. Hard events themselves are still allowed to overlap flexible ones (that's what
// checkAndNotifyConflicts' bump-and-notify flow is for).
async function findConflicts({ startISO, endISO, types = ['hard'] }) {
  const newStart = new Date(startISO);
  const newEnd = new Date(endISO);
  const items = await listEventsAcrossCalendars({ time_min: startISO, time_max: endISO });
  return items
    .filter((e) => e.start?.dateTime && e.end?.dateTime)
    .filter((e) => {
      const s = new Date(e.start.dateTime);
      const en = new Date(e.end.dateTime);
      return newStart < en && s < newEnd; // real overlap, not just adjacent
    })
    .filter((e) => {
      const category = classifyCategory(e.summary, e.description);
      const eventType = CATEGORY_MAP[category]?.eventType;
      return types.includes(eventType) || types.includes(category);
    })
    .map((e) => ({ summary: e.summary, start: e.start.dateTime, end: e.end.dateTime }));
}

// Every category — including workout/run — guards against both hard AND flexible overlaps, so a
// lift/run block can never land on top of another soft event (study, chores, ft_time, another
// workout) any more than it can land on a hard commitment. Shane previously wanted workouts/runs
// exempted from the flexible-vs-flexible guard, but changed his mind after a lift landed on top
// of a Hali'a Date — he'd rather workouts/runs just get skipped or moved than ever overlap
// something else already on the calendar.
function conflictTypesFor() {
  return ['hard', 'flexible'];
}

// Defensive backstop for the create_event/update_event "bare local time, no offset" rule.
// The model is instructed not to include a UTC offset, but when it slips and includes one
// anyway (e.g. "2026-08-19T10:15:00-07:00"), Google treats that offset as authoritative for
// the real instant and effectively ignores the separate `timeZone` label — producing an event
// that's genuinely at the wrong wall-clock time, mislabeled with whichever zone was passed
// alongside it. This is exactly how the HDOT Work event ended up 3 hours off. Strip any
// trailing "Z" or "+HH:MM"/"-HH:MM" so the timeZone field is always what actually applies.
function stripUtcOffset(dt) {
  if (typeof dt !== 'string') return dt;
  return dt.replace(/(?:Z|[+-]\d{2}:?\d{2})$/, '');
}

async function createEvent({ summary, description, start, end, attendees, category, workout_projection_day_type }) {
  const calendar = getCalendarClient();
  start = stripUtcOffset(start);
  end = stripUtcOffset(end);
  const timeZone = await getUserTimeZone();
  const resolvedDescription = workout_projection_day_type
    ? tagWorkoutProjectionDescription(description, workout_projection_day_type)
    : description;

  const text = `${summary || ''} ${resolvedDescription || ''}`;
  const resolvedCategory = classifyCategory(summary, resolvedDescription, category);
  const calendarName = resolveCalendarNameForCategory(resolvedCategory, text);
  const target = resolveCalendarId(calendarName);
  const meta = CATEGORY_MAP[resolvedCategory];

  if (meta.eventType === 'flexible') {
    // See conflictTypesFor above — workouts only hard-block against real commitments (hard events
    // + ft_time), not against every other flexible block.
    const conflicts = await findConflicts({ startISO: start, endISO: end, types: conflictTypesFor(resolvedCategory) });
    if (conflicts.length > 0) {
      return {
        ok: false,
        error:
          `Can't place "${summary}" at that time — it overlaps ${conflicts.length} existing event(s): ` +
          conflicts.map((c) => `"${c.summary}" (${c.start}–${c.end})`).join(', ') +
          '. Call find_open_slots again (with buffer_min for workouts/runs) and retry with a genuinely open time.',
      };
    }
  }

  const res = await calendar.events.insert({
    calendarId: target.id,
    requestBody: {
      summary,
      description: resolvedDescription ?? undefined,
      start: { dateTime: start, timeZone },
      end: { dateTime: end, timeZone },
      attendees: (attendees ?? []).map((email) => ({ email })),
      colorId: meta.colorId,
    },
  });
  await upsertDashboardEvent(res.data, meta.eventType, target.id, resolvedCategory, meta.colorId);
  await checkAndNotifyConflicts({ newEvent: res.data, eventType: meta.eventType });
  return {
    ok: true,
    event: {
      id: res.data.id,
      htmlLink: res.data.htmlLink,
      category: resolvedCategory,
      event_type: meta.eventType,
      calendar: calendarName,
    },
    note: target.fellBackFromPHP
      ? "PHP calendar doesn't exist yet — placed on Personal until Shane creates one named \"PHP\"."
      : undefined,
  };
}

async function updateEvent({ event_id, summary, description, start, end, attendees, category }) {
  const calendar = getCalendarClient();
  start = stripUtcOffset(start);
  end = stripUtcOffset(end);
  const timeZone = await getUserTimeZone();

  const { data: existingRow } = await supabase
    .from('calendar_events')
    .select('*')
    .eq('google_event_id', event_id)
    .maybeSingle();

  const currentCalendarId = existingRow?.gcal_calendar_id || PRIMARY_CALENDAR_ID;

  let targetCalendarId = currentCalendarId;
  let resolvedCategory = null;
  let colorId;
  let fellBackFromPHP = false;

  if (category) {
    const text = `${summary ?? existingRow?.title ?? ''} ${description ?? existingRow?.description ?? ''}`;
    resolvedCategory = classifyCategory(summary, description, category);
    const calendarName = resolveCalendarNameForCategory(resolvedCategory, text);
    const target = resolveCalendarId(calendarName);
    targetCalendarId = target.id;
    fellBackFromPHP = target.fellBackFromPHP;
    colorId = CATEGORY_MAP[resolvedCategory].colorId;
  }

  // Same conflict guard as createEvent — only matters when this update touches timing and the
  // event ends up flexible (a moved/rescheduled workout/study/etc block shouldn't be able to land
  // on a hard event OR another flexible event any more than a newly-created one should).
  if (start !== undefined || end !== undefined) {
    const effectiveType = resolvedCategory ? CATEGORY_MAP[resolvedCategory].eventType : existingRow?.event_type;
    if (effectiveType === 'flexible') {
      const checkStart = start ?? existingRow?.start_time;
      const checkEnd = end ?? existingRow?.end_time;
      if (checkStart && checkEnd) {
        const effectiveCategory = resolvedCategory ?? existingRow?.category;
        const conflicts = await findConflicts({ startISO: checkStart, endISO: checkEnd, types: conflictTypesFor(effectiveCategory) });
        // Exclude the event being moved from conflicting against its own prior placement.
        const realConflicts = conflicts.filter((c) => !(c.start === existingRow?.start_time && c.end === existingRow?.end_time));
        if (realConflicts.length > 0) {
          return {
            ok: false,
            error:
              `Can't move this event to that time — it overlaps ${realConflicts.length} existing event(s): ` +
              realConflicts.map((c) => `"${c.summary}" (${c.start}–${c.end})`).join(', ') +
              '. Call find_open_slots again and retry with a genuinely open time.',
          };
        }
      }
    }
  }

  // Google Calendar has no "patch across calendars" — a calendar change requires an explicit
  // move first, then the rest of the field updates happen against the new calendar.
  if (targetCalendarId !== currentCalendarId) {
    await calendar.events.move({ calendarId: currentCalendarId, eventId: event_id, destination: targetCalendarId });
  }

  const requestBody = {};
  if (summary !== undefined) requestBody.summary = summary;
  if (description !== undefined) requestBody.description = description;
  if (start !== undefined) requestBody.start = { dateTime: start, timeZone };
  if (end !== undefined) requestBody.end = { dateTime: end, timeZone };
  if (attendees !== undefined) requestBody.attendees = attendees.map((email) => ({ email }));
  if (colorId !== undefined) requestBody.colorId = colorId;

  const res = await calendar.events.patch({
    calendarId: targetCalendarId,
    eventId: event_id,
    requestBody,
  });

  const resolvedType = resolvedCategory
    ? CATEGORY_MAP[resolvedCategory].eventType
    : existingRow?.event_type || classifyEventType(res.data.summary, res.data.description);

  // If this update didn't touch category, keep whatever the row already had rather than
  // wiping it back to null — colorId follows the same rule.
  const finalCategory = resolvedCategory ?? existingRow?.category ?? null;
  const finalColorId = colorId ?? existingRow?.color_id ?? null;

  await upsertDashboardEvent(res.data, resolvedType, targetCalendarId, finalCategory, finalColorId);
  await checkAndNotifyConflicts({ newEvent: res.data, eventType: resolvedType });
  return {
    ok: true,
    event: { id: res.data.id, htmlLink: res.data.htmlLink, event_type: resolvedType, calendar_id: targetCalendarId },
    note: fellBackFromPHP
      ? "PHP calendar doesn't exist yet — moved to Personal until Shane creates one named \"PHP\"."
      : undefined,
  };
}

async function deleteEvent({ event_id }) {
  const calendar = getCalendarClient();
  const { data: existingRow } = await supabase
    .from('calendar_events')
    .select('gcal_calendar_id')
    .eq('google_event_id', event_id)
    .maybeSingle();
  const calendarId = existingRow?.gcal_calendar_id || PRIMARY_CALENDAR_ID;
  await calendar.events.delete({ calendarId, eventId: event_id });
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

// Finds every future calendar block tagged [workout_projection:<day_type>], re-projects the same
// number of upcoming lift days fresh from the log (via get_upcoming_workouts, which always
// recomputes from whatever was actually last logged), and patches any block whose day_type no
// longer matches — e.g. because a prior projected day got skipped or swapped, shifting the
// Chest/Back -> Arms/Abs -> Legs rotation for everything after it. Tagged blocks are matched to
// fresh projection days positionally (1st future tagged block <-> day_offset 1, 2nd <-> offset 2,
// etc.) since that's the same order the Admin Agent placed them in originally.
async function resyncWorkoutProjections() {
  const nowIso = new Date().toISOString();
  const { data: tagged, error } = await supabase
    .from('calendar_events')
    .select('google_event_id, title, description, start_time')
    .eq('user_id', DEFAULT_USER_ID)
    .eq('event_type', 'flexible')
    .ilike('description', '%[workout_projection:%')
    .gt('start_time', nowIso)
    .order('start_time', { ascending: true });
  if (error) throw error;

  const events = tagged ?? [];
  if (events.length === 0) {
    return { ok: true, checked: 0, updated: 0, updated_events: [], message: 'No future workout-projection blocks found.' };
  }

  const { data: fresh, error: rpcError } = await supabase.rpc('get_upcoming_workouts', {
    p_user_id: DEFAULT_USER_ID,
    p_count: events.length,
  });
  if (rpcError) throw rpcError;
  const freshDays = fresh ?? [];

  const calendar = getCalendarClient();
  const updated = [];

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    const freshDay = freshDays[i];
    if (!freshDay) continue;

    const match = ev.description?.match(WORKOUT_PROJECTION_TAG_RE);
    const storedDayType = match?.[1];
    if (!storedDayType || storedDayType === freshDay.day_type) continue;

    // Description stays just the tag marker — Shane doesn't want the full exercise plan on the
    // event (title or description), only the day_type. Previously this pulled in freshDay.workout
    // (the full "Legs (Squat, RDL/Trap-bar DL, ...)" text) on every drift-correction, silently
    // re-adding the plan text he'd asked to have kept off the event.
    const newDescription = `[workout_projection:${freshDay.day_type}]`;
    const oldTitle = ev.title ?? '';
    const newTitle = oldTitle.includes(storedDayType)
      ? oldTitle.replaceAll(storedDayType, freshDay.day_type)
      : freshDay.day_type;

    const res = await calendar.events.patch({
      calendarId: 'primary',
      eventId: ev.google_event_id,
      requestBody: { summary: newTitle, description: newDescription },
    });
    // Every event this function touches is a workout-projection block by definition (the query
    // above only pulls [workout_projection:...] tagged rows) — pass category/colorId explicitly
    // instead of leaving them undefined, which would otherwise null them back out on the
    // dashboard row every time a projection resyncs.
    await upsertDashboardEvent(res.data, 'flexible', PRIMARY_CALENDAR_ID, 'workout', CATEGORY_MAP.workout.colorId);

    updated.push({
      event_id: ev.google_event_id,
      start_time: ev.start_time,
      from_day_type: storedDayType,
      to_day_type: freshDay.day_type,
    });
  }

  return {
    ok: true,
    checked: events.length,
    updated: updated.length,
    updated_events: updated,
    message:
      updated.length === 0
        ? 'Checked all future projected workout blocks — none had drifted.'
        : `Corrected ${updated.length} drifted workout block(s).`,
  };
}

// Colors only get set on events created THROUGH create_event/update_event above. Anything Shane
// adds directly on his phone/Google Calendar (e.g. typing "Hali'a Date" straight into the primary
// calendar) skips that code path entirely and lands with no colorId — Google then renders it in
// the calendar's default color, indistinguishable from workouts/study/etc at a glance. This scans
// the primary calendar (where every flexible category lives) for a rolling window and backfills
// colorId on any event that's missing one or has drifted from what its classified category implies,
// so manual additions self-heal into the right color within one background-loop tick without Shane
// having to ask. Only touches events that classify as FLEXIBLE — hard events Shane adds by hand stay
// whatever color they land in, since this is specifically about the flexible categories that all
// share one calendar and are otherwise indistinguishable.
export async function recolorFlexibleEvents({ daysBehind = 2, daysAhead = 45 } = {}) {
  const calendar = getCalendarClient();
  const now = new Date();
  const rangeStart = new Date(now);
  rangeStart.setDate(rangeStart.getDate() - daysBehind);
  const rangeEnd = new Date(now);
  rangeEnd.setDate(rangeEnd.getDate() + daysAhead);

  let items;
  try {
    const res = await calendar.events.list({
      calendarId: PRIMARY_CALENDAR_ID,
      timeMin: rangeStart.toISOString(),
      timeMax: rangeEnd.toISOString(),
      singleEvents: true,
    });
    items = res.data.items ?? [];
  } catch (err) {
    console.error('[Admin Agent] recolorFlexibleEvents: list failed:', err?.message ?? err);
    return { ok: false, error: String(err?.message ?? err) };
  }

  const recolored = [];
  for (const ev of items) {
    if (!ev.start?.dateTime) continue; // skip all-day events
    const category = classifyCategory(ev.summary, ev.description);
    const meta = CATEGORY_MAP[category];
    if (!meta || meta.eventType !== 'flexible') continue; // only self-heal the 4 flexible categories
    if (ev.colorId === meta.colorId) continue; // already correct

    try {
      const res = await calendar.events.patch({
        calendarId: PRIMARY_CALENDAR_ID,
        eventId: ev.id,
        requestBody: { colorId: meta.colorId },
      });
      await upsertDashboardEvent(res.data, 'flexible', PRIMARY_CALENDAR_ID, category, meta.colorId);
      recolored.push({ event_id: ev.id, summary: ev.summary, category, colorId: meta.colorId });
    } catch (err) {
      console.error(`[Admin Agent] recolorFlexibleEvents: patch failed for "${ev.summary}":`, err?.message ?? err);
    }
  }

  return { ok: true, checked: items.length, recolored: recolored.length, recolored_events: recolored };
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
    case 'resync_workout_projections':
      return resyncWorkoutProjections();
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

  const scopedMemories = await fetchAgentMemories('admin_agent');
  const correctionsBlock = formatCorrectionsBlock(scopedMemories);
  const system = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ...(correctionsBlock ? [{ type: 'text', text: correctionsBlock }] : []),
  ];


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
