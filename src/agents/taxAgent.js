import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Tax Prep Agent, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates tax-prep requests to. You have real tools backed by Shane's LifeOS dashboard "tax_items" \
table — use them, don't guess or make up numbers.

Your job: help Shane keep a running list of the things he'll need at tax time — deductible expenses, income \
documents he's waiting on (W-2s, 1099s), estimated quarterly payments, and anything else tied to a specific \
tax year — track whether each item has been collected/filed/paid, and surface upcoming tax deadlines.

Notes on the data:
- "tax_items" is one row per tracked item, scoped to a tax_year. There is no upsert-by-name here (unlike \
bills/subscriptions) since Shane may have many similarly-named items in the same year (e.g. multiple \
"Charitable donation" rows) — add_tax_item always inserts a new row.
- status is one of 'pending', 'collected', 'filed', 'paid' — pending is the default for anything just added.
- due_date is optional and only meaningful for items with a real deadline (estimated payments, filing itself) \
— not every item has one (e.g. a deduction receipt doesn't expire).
- get_upcoming_tax_deadlines looks at all items with a due_date in the future (or overdue) and ranks them \
soonest-first — use this for "what tax stuff is coming up" questions.

Important boundary: you are not a licensed tax professional or CPA and must not give personalized tax advice \
(what to deduct, how to file, whether something is taxable). You CAN track and report the plain facts Shane \
gives you. If Shane asks for tax advice, say you can help him track items but he should consult a CPA or tax \
professional for actual guidance.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Always include concrete numbers (amounts, counts, due dates) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'add_tax_item',
    description:
      'Add a new tracked tax item for a given tax year — a deduction, an income document Shane is waiting ' +
      'on, an estimated payment, etc. Always inserts a new row (no upsert), since multiple similar items can ' +
      'exist in the same year.',
    input_schema: {
      type: 'object',
      properties: {
        tax_year: { type: 'integer', description: 'e.g. 2026' },
        category: { type: 'string', description: "e.g. 'deduction', 'income_document', 'estimated_payment', 'credit'" },
        description: { type: 'string', description: "Short description, e.g. 'W-2 from employer', 'Charitable donation - Goodwill'" },
        amount: { type: 'number', description: 'Dollar amount, if known/applicable' },
        due_date: { type: 'string', description: 'ISO date (YYYY-MM-DD), only if this item has a real deadline' },
        notes: { type: 'string', description: 'Any extra context' },
      },
      required: ['tax_year', 'category'],
    },
  },
  {
    name: 'list_tax_items',
    description: 'List tracked tax items, optionally filtered by tax year and/or status.',
    input_schema: {
      type: 'object',
      properties: {
        tax_year: { type: 'integer', description: 'Optional — limit to one tax year' },
        status: { type: 'string', enum: ['pending', 'collected', 'filed', 'paid'], description: 'Optional — limit to one status' },
      },
    },
  },
  {
    name: 'mark_tax_item_status',
    description: "Update a tax item's status (e.g. mark a document collected, or a payment paid) by its id.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the tax_items row (from list_tax_items)' },
        status: { type: 'string', enum: ['pending', 'collected', 'filed', 'paid'] },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'get_upcoming_tax_deadlines',
    description:
      "List tracked tax items that have a due_date, soonest-first (including overdue ones), for a given tax " +
      'year or across all years.',
    input_schema: {
      type: 'object',
      properties: {
        tax_year: { type: 'integer', description: 'Optional — limit to one tax year' },
      },
    },
  },
];

async function addTaxItem({ tax_year, category, description, amount, due_date, notes }) {
  const { data, error } = await supabase
    .from('tax_items')
    .insert({
      user_id: DEFAULT_USER_ID,
      tax_year,
      category,
      description: description ?? null,
      amount: amount ?? null,
      status: 'pending',
      due_date: due_date ?? null,
      notes: notes ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, tax_item: data };
}

async function listTaxItems({ tax_year, status }) {
  let query = supabase.from('tax_items').select('*').order('tax_year', { ascending: false }).order('due_date', { ascending: true, nullsFirst: false });
  if (tax_year !== undefined) query = query.eq('tax_year', tax_year);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, tax_items: data };
}

async function markTaxItemStatus({ id, status }) {
  const { data, error } = await supabase
    .from('tax_items')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', DEFAULT_USER_ID)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, error: `No tax item found with id '${id}'.` };
  return { ok: true, tax_item: data };
}

async function getUpcomingTaxDeadlines({ tax_year }) {
  let query = supabase
    .from('tax_items')
    .select('*')
    .not('due_date', 'is', null)
    .order('due_date', { ascending: true });
  if (tax_year !== undefined) query = query.eq('tax_year', tax_year);
  const { data, error } = await query;
  if (error) throw error;

  const today = new Date().toISOString().slice(0, 10);
  const deadlines = (data ?? []).map((item) => ({
    id: item.id,
    tax_year: item.tax_year,
    category: item.category,
    description: item.description,
    amount: item.amount,
    due_date: item.due_date,
    status: item.status,
    overdue: item.due_date < today && item.status !== 'filed' && item.status !== 'paid',
  }));

  return { ok: true, deadlines };
}

async function runTaxTool(name, input) {
  switch (name) {
    case 'add_tax_item':
      return addTaxItem(input);
    case 'list_tax_items':
      return listTaxItems(input);
    case 'mark_tax_item_status':
      return markTaxItemStatus(input);
    case 'get_upcoming_tax_deadlines':
      return getUpcomingTaxDeadlines(input);
    default:
      throw new Error(`Unknown Tax Prep Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runTaxAgent(request) {
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
        const result = await runTaxTool(use.name, use.input);
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

  return finalText || "Tax Prep Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
