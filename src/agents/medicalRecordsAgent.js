import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Medical Records Agent, a specialist sub-agent that Alex (Shane Pinho's Chief \
of Staff) delegates health-record requests to. You have real tools backed by Shane's LifeOS dashboard \
"medical_records" table — use them, don't guess or make up numbers.

Your job: help Shane store and retrieve structured medical records — prescriptions, lab results, vaccinations, \
and other records — so they're easy to find later. You organize and surface data; you do not interpret lab \
results, diagnose, or give medical advice.

Notes on the data:
- "medical_records" is one row per record. record_type must be one of: 'prescription', 'lab_result', \
'vaccination', 'other'.
- name is the record's title (e.g. "Lisinopril 10mg", "A1C panel", "Flu shot"). provider is who administered/ \
prescribed it, if known. record_date defaults to today if not given. value is free text for a result/dosage \
(e.g. "5.4%", "10mg once daily") — only fill it in if Shane actually gives a value, never infer one.
- status is 'active' (default), 'completed', or 'cancelled' — e.g. a prescription Shane is currently on is \
'active'; one he's finished or stopped is 'completed'/'cancelled'.
- list_records supports filtering by record_type and/or status so Shane can ask things like "what \
prescriptions am I currently on" or "show my lab results."
- update_record_status is for marking a record completed/cancelled (e.g. finished a prescription course) — \
find the record by name first if you don't have its id.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Never interpret or comment on the clinical meaning of a lab value or medication — just report \
what's on file. Always include concrete details (dates, names, statuses) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'add_record',
    description: 'Add a new medical record (prescription, lab result, vaccination, or other).',
    input_schema: {
      type: 'object',
      properties: {
        record_type: { type: 'string', enum: ['prescription', 'lab_result', 'vaccination', 'other'] },
        name: { type: 'string', description: "Record title, e.g. 'Lisinopril 10mg', 'A1C panel', 'Flu shot'" },
        provider: { type: 'string', description: 'Doctor/pharmacy/clinic that administered or prescribed it, if known' },
        record_date: { type: 'string', description: 'ISO date (YYYY-MM-DD), defaults to today' },
        value: { type: 'string', description: 'Result/dosage/free-text value, only if Shane provides one' },
        status: { type: 'string', enum: ['active', 'completed', 'cancelled'], description: "Defaults to 'active'" },
        notes: { type: 'string', description: 'Any other free-text notes' },
      },
      required: ['record_type', 'name'],
    },
  },
  {
    name: 'list_records',
    description: "List Shane's medical records, most recent first. Optionally filter by record_type and/or status.",
    input_schema: {
      type: 'object',
      properties: {
        record_type: { type: 'string', enum: ['prescription', 'lab_result', 'vaccination', 'other'] },
        status: { type: 'string', enum: ['active', 'completed', 'cancelled'] },
        limit: { type: 'integer', description: 'How many to return, default 20' },
      },
    },
  },
  {
    name: 'update_record_status',
    description: "Update a record's status (e.g. mark a prescription completed or cancelled). Matches by name.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Record name to match (must match an existing record)' },
        status: { type: 'string', enum: ['active', 'completed', 'cancelled'] },
      },
      required: ['name', 'status'],
    },
  },
];

async function addRecord({ record_type, name, provider, record_date, value, status, notes }) {
  const row = { user_id: DEFAULT_USER_ID, record_type, name };
  if (provider !== undefined) row.provider = provider;
  if (record_date !== undefined) row.record_date = record_date;
  if (value !== undefined) row.value = value;
  if (status !== undefined) row.status = status;
  if (notes !== undefined) row.notes = notes;

  const { data, error } = await supabase.from('medical_records').insert(row).select().single();
  if (error) throw error;
  return { ok: true, record: data };
}

async function listRecords({ record_type, status, limit }) {
  const n = limit ?? 20;
  let query = supabase.from('medical_records').select('*').order('record_date', { ascending: false }).limit(n);
  if (record_type) query = query.eq('record_type', record_type);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, records: data };
}

async function updateRecordStatus({ name, status }) {
  const { data, error } = await supabase
    .from('medical_records')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('user_id', DEFAULT_USER_ID)
    .eq('name', name)
    .select();
  if (error) throw error;
  if (!data || data.length === 0) return { ok: false, error: `No record found named '${name}'` };
  return { ok: true, records: data };
}

async function runMedicalRecordsTool(name, input) {
  switch (name) {
    case 'add_record':
      return addRecord(input);
    case 'list_records':
      return listRecords(input);
    case 'update_record_status':
      return updateRecordStatus(input);
    default:
      throw new Error(`Unknown Medical Records Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runMedicalRecordsAgent(request) {
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
        const result = await runMedicalRecordsTool(use.name, use.input);
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

  return finalText || "Medical Records Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
