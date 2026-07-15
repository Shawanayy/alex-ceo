import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Bill Pay Agent, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates recurring-bill requests to. You have real tools backed by Shane's LifeOS dashboard "bills" \
table — use them, don't guess or make up numbers.

Your job: help Shane track recurring bills (rent, utilities, subscriptions billed as bills, etc.), their due \
dates and amounts, mark them paid, verify autopay status so nothing slips through silently, and surface which \
bills need attention soonest so they can show up as top priorities on his dashboard and in his weekly review.

Notes on the data:
- "bills" is one row per recurring bill for Shane, upserted by name via add_or_update_bill (calling it again \
for the same bill name just updates that bill's fields).
- due_day is the day-of-month the bill is due (e.g. 1, 15). paid_this_month/last_paid track whether it's been \
paid for the current cycle — mark_bill_paid updates both.
- priority is a free-text label (e.g. "high", "medium", "low") Shane can set per bill so the most important \
ones surface first. autopay_status is free text too (e.g. "on", "off", "unverified") — treat null or \
"unverified" as needing a nudge to Shane to confirm autopay is actually set up, since a bill silently NOT on \
autopay is exactly how late fees happen.
- get_top_priority_bills returns the bills most worth Shane's attention right now (unpaid this cycle, ranked \
by how soon due_day is and by priority). push_bill_reminders does the same ranking and writes the results \
into the "notifications" table (source_agent, urgency, title, body) — Shane already has a separate weekly- \
review scheduler and dashboard that read from notifications, so this tool is the hand-off point, not a \
scheduler itself. Use push_bill_reminders whenever Shane asks for a bill check-in/summary for his dashboard \
or weekly review, or explicitly asks you to send/push reminders.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting \
with Shane directly. Always include concrete numbers (dollar amounts, due days, days until due) rather than \
vague summaries.`;

const toolDefs = [
  {
    name: 'add_or_update_bill',
    description:
      'Create or update a recurring bill (upserts by bill name). Use this to add a new bill or change its ' +
      'amount, due day, priority, or autopay status.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Bill name, e.g. 'Rent', 'Wifi', 'Electrical', 'Car Insurance'" },
        amount: { type: 'number', description: 'Bill amount in dollars (optional if unknown yet)' },
        due_day: { type: 'integer', description: 'Day of month the bill is due (1-31)' },
        priority: { type: 'string', description: "Free-text priority, e.g. 'high', 'medium', 'low'" },
        autopay_status: { type: 'string', description: "e.g. 'on', 'off', 'unverified'" },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_bills',
    description: "List all of Shane's tracked bills with amount, due day, paid-this-month status, priority, and autopay status.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'mark_bill_paid',
    description: "Mark a bill as paid for this cycle (sets paid_this_month=true and last_paid).",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Bill name (must match an existing bill)' },
        paid_date: { type: 'string', description: 'ISO date (YYYY-MM-DD) it was paid, defaults to today' },
      },
      required: ['name'],
    },
  },
  {
    name: 'check_autopay_status',
    description:
      "Review autopay status across all bills and flag any that are null/'unverified' so Shane can " +
      'confirm autopay is actually set up before a payment gets missed.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_top_priority_bills',
    description:
      "Return the bills most worth Shane's attention right now — unpaid this cycle, ranked by how soon " +
      "due_day is and by priority. Use this for dashboard top-3 and weekly-review reminders.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many bills to return, default 3' },
      },
    },
  },
  {
    name: 'push_bill_reminders',
    description:
      "Push the top-priority unpaid bills into Shane's notifications table so they surface on his " +
      "dashboard and in his existing weekly-review scheduler (which reads from notifications — this tool " +
      "does not itself run on any schedule). Use this when Shane asks for a bill check-in, a bill summary " +
      "for his dashboard/weekly review, or explicitly asks to push/send reminders.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many top-priority bills to push, default 3' },
      },
    },
  },
];

async function addOrUpdateBill({ name, amount, due_day, priority, autopay_status }) {
  const update = {
    user_id: DEFAULT_USER_ID,
    name,
  };
  if (amount !== undefined) update.amount = amount;
  if (due_day !== undefined) update.due_day = due_day;
  if (priority !== undefined) update.priority = priority;
  if (autopay_status !== undefined) update.autopay_status = autopay_status;

  const { data, error } = await supabase
    .from('bills')
    .upsert(update, { onConflict: 'user_id,name' })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, bill: data };
}

async function listBills() {
  const { data, error } = await supabase.from('bills').select('*').order('due_day', { ascending: true });
  if (error) throw error;
  return { ok: true, bills: data };
}

async function markBillPaid({ name, paid_date }) {
  const { data, error } = await supabase
    .from('bills')
    .update({
      paid_this_month: true,
      last_paid: paid_date ?? new Date().toISOString().slice(0, 10),
    })
    .eq('user_id', DEFAULT_USER_ID)
    .eq('name', name)
    .select()
    .single();
  if (error) throw error;
  if (!data) return { ok: false, error: `No bill found named '${name}'` };
  return { ok: true, bill: data };
}

async function checkAutopayStatus() {
  const { data, error } = await supabase.from('bills').select('*').order('name');
  if (error) throw error;
  const bills = data ?? [];
  const needsVerification = bills.filter(
    (b) => !b.autopay_status || b.autopay_status.toLowerCase() === 'unverified'
  );
  return {
    ok: true,
    total_bills: bills.length,
    needs_verification: needsVerification.map((b) => ({ name: b.name, due_day: b.due_day, amount: b.amount })),
    verified_on_autopay: bills
      .filter((b) => (b.autopay_status ?? '').toLowerCase() === 'on')
      .map((b) => b.name),
  };
}

// Ranks bills that aren't paid yet this cycle by how soon their due_day is relative to
// today (wrapping to next month if the due day already passed), then by priority label.
function rankBillsByUrgency(bills) {
  const now = new Date();
  const todayDay = now.getUTCDate();
  const priorityWeight = { high: 0, medium: 1, low: 2 };

  return bills
    .filter((b) => !b.paid_this_month)
    .map((b) => {
      const dueDay = b.due_day ?? 28;
      let daysUntilDue = dueDay - todayDay;
      if (daysUntilDue < 0) daysUntilDue += 30; // due day already passed this month, wraps to next cycle
      return { ...b, days_until_due: daysUntilDue };
    })
    .sort((a, b) => {
      const pWeightA = priorityWeight[(a.priority ?? '').toLowerCase()] ?? 1;
      const pWeightB = priorityWeight[(b.priority ?? '').toLowerCase()] ?? 1;
      if (pWeightA !== pWeightB) return pWeightA - pWeightB;
      return a.days_until_due - b.days_until_due;
    });
}

async function getTopPriorityBills({ limit }) {
  const n = limit ?? 3;
  const { data, error } = await supabase.from('bills').select('*');
  if (error) throw error;
  const ranked = rankBillsByUrgency(data ?? []);
  return {
    ok: true,
    top_priority_bills: ranked.slice(0, n).map((b) => ({
      name: b.name,
      amount: b.amount,
      due_day: b.due_day,
      days_until_due: b.days_until_due,
      priority: b.priority,
      autopay_status: b.autopay_status,
    })),
  };
}

// Maps days-until-due into the same urgency vocabulary Shane's dashboard/notifications
// expect: 'high' for anything due within 3 days, 'medium' within a week, 'low' otherwise.
function urgencyFromDaysUntilDue(daysUntilDue) {
  if (daysUntilDue <= 3) return 'high';
  if (daysUntilDue <= 7) return 'medium';
  return 'low';
}

async function pushBillReminders({ limit }) {
  const { top_priority_bills } = await getTopPriorityBills({ limit });

  if (top_priority_bills.length === 0) {
    return { ok: true, pushed: 0, note: 'No unpaid bills to push — nothing to remind about.' };
  }

  const rows = top_priority_bills.map((b) => ({
    source_agent: 'bill_pay_agent',
    urgency: urgencyFromDaysUntilDue(b.days_until_due),
    title: `${b.name} due in ${b.days_until_due} day(s)${b.amount ? ` ($${b.amount})` : ''}`,
    body:
      `Priority: ${b.priority ?? 'unset'}. Autopay: ${b.autopay_status ?? 'unverified'}. ` +
      `Due day: ${b.due_day ?? 'unknown'}.`,
  }));

  const { data, error } = await supabase.from('notifications').insert(rows).select();
  if (error) throw error;
  return { ok: true, pushed: data.length, notifications: data };
}

async function runBillPayTool(name, input) {
  switch (name) {
    case 'add_or_update_bill':
      return addOrUpdateBill(input);
    case 'list_bills':
      return listBills();
    case 'mark_bill_paid':
      return markBillPaid(input);
    case 'check_autopay_status':
      return checkAutopayStatus();
    case 'get_top_priority_bills':
      return getTopPriorityBills(input);
    case 'push_bill_reminders':
      return pushBillReminders(input);
    default:
      throw new Error(`Unknown Bill Pay Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runBillPayAgent(request) {
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
        const result = await runBillPayTool(use.name, use.input);
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

  return finalText || "Bill Pay Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
