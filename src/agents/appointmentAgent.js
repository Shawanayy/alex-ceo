import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Appointment Coordinator, a specialist sub-agent that Alex (Shane Pinho's \
Chief of Staff) delegates healthcare-appointment requests to. You have real tools backed by Shane's LifeOS \
dashboard "appointments" table — use them, don't guess or make up numbers.

Your job: help Shane track healthcare appointments (checkups, dentist, specialists, etc.), their date/time, \
provider, and follow-up needs, and surface which appointments are coming up soonest.

Notes on the data:
- "appointments" is one row per appointment. appointment_time is a real timestamp — always resolve relative \
dates/times Shane gives you (e.g. "next Tuesday at 2pm") into an ISO timestamp before calling schedule_appointment.
- appointment_type is free text (e.g. "Annual physical", "Dentist cleaning", "Dermatology follow-up"). \
follow_up_needed is a boolean Shane can set if the appointment is expected to need a follow-up booked later.
- status is 'scheduled' (default), 'completed', or 'cancelled'.
- google_event_id is populated separately once Alex (not you) creates a real Google Calendar event for the \
appointment via the Admin Agent — you don't create Calendar events yourself, you just track the appointment \
record. Never claim a Calendar event was created; that's outside your tools.
- get_upcoming_appointments returns scheduled (not completed/cancelled) appointments ordered soonest-first — \
use it whenever Shane asks what's coming up or for a healthcare-appointment summary.
- IMPORTANT: whenever you confirm a NEW appointment was scheduled in your final answer, always state the exact \
date/time plainly (e.g. "scheduled: August 15, 2026 at 2:00 PM") so Alex can detect it and create a real \
Calendar event for it.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete details (dates, times, providers) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'schedule_appointment',
    description: 'Add a new healthcare appointment. Use this whenever Shane wants to track/schedule a new appointment.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: "Doctor/clinic name, e.g. 'Dr. Lee', 'OSU Student Health'" },
        appointment_type: { type: 'string', description: "e.g. 'Annual physical', 'Dentist cleaning'" },
        appointment_time: { type: 'string', description: 'ISO timestamp for the appointment, resolved from whatever Shane said' },
        location: { type: 'string', description: 'Where it is, if known' },
        reason: { type: 'string', description: 'Why Shane is going, if given' },
        follow_up_needed: { type: 'boolean', description: 'Whether a follow-up is expected, defaults to false' },
        notes: { type: 'string', description: 'Any other free-text notes' },
      },
      required: ['appointment_time'],
    },
  },
  {
    name: 'list_appointments',
    description: "List Shane's tracked appointments, most recent/soonest first. Optionally filter by status.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['scheduled', 'completed', 'cancelled'] },
        limit: { type: 'integer', description: 'How many to return, default 20' },
      },
    },
  },
  {
    name: 'get_upcoming_appointments',
    description: "Return Shane's scheduled (not completed/cancelled) appointments ordered soonest-first.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many to return, default 5' },
      },
    },
  },
  {
    name: 'update_appointment_status',
    description: "Mark an appointment completed or cancelled. Matches the most recent appointment for the given provider/type if multiple match.",
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider name to match' },
        appointment_type: { type: 'string', description: 'Appointment type to match, optional additional filter' },
        status: { type: 'string', enum: ['scheduled', 'completed', 'cancelled'] },
      },
      required: ['provider', 'status'],
    },
  },
];

async function scheduleAppointment({ provider, appointment_type, appointment_time, location, reason, follow_up_needed, notes }) {
  const row = { user_id: DEFAULT_USER_ID, appointment_time };
  if (provider !== undefined) row.provider = provider;
  if (appointment_type !== undefined) row.appointment_type = appointment_type;
  if (location !== undefined) row.location = location;
  if (reason !== undefined) row.reason = reason;
  if (follow_up_needed !== undefined) row.follow_up_needed = follow_up_needed;
  if (notes !== undefined) row.notes = notes;

  const { data, error } = await supabase.from('appointments').insert(row).select().single();
  if (error) throw error;
  return { ok: true, appointment: data };
}

async function listAppointments({ status, limit }) {
  const n = limit ?? 20;
  let query = supabase.from('appointments').select('*').order('appointment_time', { ascending: false }).limit(n);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, appointments: data };
}

async function getUpcomingAppointments({ limit }) {
  const n = limit ?? 5;
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('status', 'scheduled')
    .gte('appointment_time', nowIso)
    .order('appointment_time', { ascending: true })
    .limit(n);
  if (error) throw error;
  return { ok: true, upcoming_appointments: data };
}

async function updateAppointmentStatus({ provider, appointment_type, status }) {
  let query = supabase.from('appointments').select('*').eq('user_id', DEFAULT_USER_ID).eq('provider', provider);
  if (appointment_type) query = query.eq('appointment_type', appointment_type);
  const { data: matches, error: findError } = await query.order('appointment_time', { ascending: false }).limit(1);
  if (findError) throw findError;
  if (!matches || matches.length === 0) return { ok: false, error: `No appointment found for provider '${provider}'` };

  const { data, error } = await supabase
    .from('appointments')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', matches[0].id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, appointment: data };
}

async function runAppointmentTool(name, input) {
  switch (name) {
    case 'schedule_appointment':
      return scheduleAppointment(input);
    case 'list_appointments':
      return listAppointments(input);
    case 'get_upcoming_appointments':
      return getUpcomingAppointments(input);
    case 'update_appointment_status':
      return updateAppointmentStatus(input);
    default:
      throw new Error(`Unknown Appointment Coordinator tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runAppointmentAgent(request) {
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
        const result = await runAppointmentTool(use.name, use.input);
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

  return finalText || "Appointment Coordinator got stuck and didn't produce a final answer — try rephrasing the request.";
}
