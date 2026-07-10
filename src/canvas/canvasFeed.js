// Canvas LMS integration for the Learning & Career Agent — via calendar feed, not the REST API.
//
// WHY: OSU's Canvas admin has personal API access tokens disabled for Shane's account ("can't add
// a new access token because of admin restrictions"), and OAuth Developer Keys are gated the same
// way. Neither is something we can or should work around — that's an explicit institutional
// security control. Canvas's Calendar Feed is a different, un-gated mechanism: a long secret .ics
// URL Canvas itself generates for exactly this kind of external consumption
// (Canvas > Calendar > "Calendar Feed", bottom-right of the calendar page).
//
// TRADEOFF: the feed only gives us assignment/event titles, due dates, and a link back to the
// assignment (which embeds the numeric course_id/assignment_id we use for idempotent syncing).
// No grades, no points_possible, no submission status, no explicit exam/assignment type — is_exam
// is guessed from the title, the same way import_syllabus already does it.

const CANVAS_ICS_URL = process.env.CANVAS_ICS_URL;

export function isCanvasConfigured() {
  return Boolean(CANVAS_ICS_URL);
}

// RFC5545: a line starting with a single space or tab is a continuation of the previous line.
function unfoldLines(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  const unfolded = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

function unescapeText(value) {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// Canvas emits DTSTART either as a UTC instant (20260715T235900Z) or an all-day date
// (20260715). We treat both as UTC — close enough for scheduling purposes here.
function parseIcsDate(raw) {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseVEvents(icsText) {
  const lines = unfoldLines(icsText);
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    // NAME(;PARAM=...)*:VALUE — we only care about the name and the raw value.
    const match = line.match(/^([A-Z0-9-]+)(;[^:]*)?:(.*)$/i);
    if (!match) continue;
    const [, rawName, , rawValue] = match;
    const name = rawName.toUpperCase();

    if (name === 'SUMMARY') current.summary = unescapeText(rawValue);
    else if (name === 'URL') current.url = rawValue.trim();
    else if (name === 'UID') current.uid = rawValue.trim();
    else if (name === 'DTSTART') current.dtstart = parseIcsDate(rawValue.trim());
  }

  return events;
}

// Fetches and parses Shane's Canvas calendar feed, returning only entries that link back to a
// real Canvas assignment (skips lecture reminders, office hours, and other plain calendar events
// Canvas also stuffs into this feed).
export async function fetchCanvasEvents() {
  if (!isCanvasConfigured()) {
    throw new Error(
      'Canvas sync is not configured — set CANVAS_ICS_URL in .env (Canvas > Calendar > "Calendar Feed").'
    );
  }

  const res = await fetch(CANVAS_ICS_URL);
  if (!res.ok) {
    throw new Error(
      `Couldn't fetch the Canvas calendar feed (HTTP ${res.status}). The feed URL may have changed — ` +
        'get a fresh one from Canvas > Calendar > "Calendar Feed".'
    );
  }
  const text = await res.text();
  const events = parseVEvents(text);

  const assignmentEvents = [];
  for (const ev of events) {
    if (!ev.url || !ev.dtstart) continue;
    const m = ev.url.match(/\/courses\/(\d+)\/assignments\/(\d+)/);
    if (!m) continue;
    const [, courseId, assignmentId] = m;

    // Canvas appends the course code in brackets at the end of the summary, e.g.
    // "Homework 3 [CS_361_001]" — strip it out for the title, keep it to identify the class.
    let title = ev.summary || 'Untitled Assignment';
    let courseCode = null;
    const bracketMatch = title.match(/^(.*)\s\[([^\]]+)\]\s*$/);
    if (bracketMatch) {
      title = bracketMatch[1].trim();
      courseCode = bracketMatch[2].trim();
    }

    assignmentEvents.push({
      courseId,
      assignmentId,
      courseCode,
      title,
      dueDate: ev.dtstart,
    });
  }

  return assignmentEvents;
}
