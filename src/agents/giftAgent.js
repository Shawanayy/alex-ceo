import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Gift Planner, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates gift-tracking requests to. You have real tools backed by Shane's LifeOS dashboard "contacts" \
and "gifts" tables — use them, don't guess or make up numbers.

Your job: help Shane keep track of people, their birthdays/occasions, gift ideas, and ordering reminders so he \
never misses an occasion.

Notes on the data:
- "contacts" is a shared table (also usable by the Event Planner for guest info) — one row per person: name, \
relationship (e.g. "sister", "friend"), occasion (e.g. "Birthday", "Anniversary"), occasion_date, notes. Always \
match by name rather than guessing an id; if a contact doesn't exist yet when logging a gift, create one first.
- "gifts" is one row per gift idea/plan, linked to a contact via contact_id. status is 'idea' (default), \
'ordered', or 'given'. order_by_date is when Shane should order by to make sure it arrives in time — set it if \
Shane gives one or if it can be reasonably inferred from the occasion_date (e.g. a few days before).
- get_upcoming_occasions returns contacts with an occasion_date within a given number of days (default 30), \
soonest-first, along with any gifts already planned for them — use it whenever Shane asks what occasions are \
coming up or wants a gift-planning summary.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete details (names, dates, gift status) rather than vague summaries.`;

const toolDefs = [
  {
    name: 'add_contact',
    description: 'Add a new contact to track (for gifts and/or events).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        relationship: { type: 'string' },
        occasion: { type: 'string', description: "e.g. 'Birthday', 'Anniversary'" },
        occasion_date: { type: 'string', description: 'ISO date (YYYY-MM-DD), if known' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_contact',
    description: "Update a contact's relationship, occasion, occasion_date, or notes. Matches by name.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to match' },
        relationship: { type: 'string' },
        occasion: { type: 'string' },
        occasion_date: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_contacts',
    description: "List Shane's tracked contacts.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'add_gift',
    description: 'Add a gift idea/plan for a contact. Creates the contact first if they do not already exist and contact details are given.',
    input_schema: {
      type: 'object',
      properties: {
        contact_name: { type: 'string', description: 'Name of the contact this gift is for' },
        occasion: { type: 'string' },
        occasion_date: { type: 'string', description: 'ISO date (YYYY-MM-DD), if known' },
        gift_idea: { type: 'string' },
        order_by_date: { type: 'string', description: 'ISO date (YYYY-MM-DD), if known or inferable' },
        notes: { type: 'string' },
      },
      required: ['contact_name'],
    },
  },
  {
    name: 'update_gift',
    description: "Update a gift's status, idea, order_by_date, or notes. Matches the most recent gift for the given contact if multiple match.",
    input_schema: {
      type: 'object',
      properties: {
        contact_name: { type: 'string', description: 'Contact name to match' },
        status: { type: 'string', enum: ['idea', 'ordered', 'given'] },
        gift_idea: { type: 'string' },
        order_by_date: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['contact_name'],
    },
  },
  {
    name: 'list_gifts',
    description: "List Shane's tracked gifts, most recent first. Optionally filter by status.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['idea', 'ordered', 'given'] },
        limit: { type: 'integer', description: 'How many to return, default 20' },
      },
    },
  },
  {
    name: 'get_upcoming_occasions',
    description: 'Get contacts with an occasion_date within N days, soonest first, with any planned gifts.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Look-ahead window in days, default 30' },
      },
    },
  },
];

async function findContactByName(name) {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .ilike('name', name)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function addContact({ name, relationship, occasion, occasion_date, notes }) {
  const row = { user_id: DEFAULT_USER_ID, name };
  if (relationship !== undefined) row.relationship = relationship;
  if (occasion !== undefined) row.occasion = occasion;
  if (occasion_date !== undefined) row.occasion_date = occasion_date;
  if (notes !== undefined) row.notes = notes;

  const { data, error } = await supabase.from('contacts').insert(row).select().single();
  if (error) throw error;
  return { ok: true, contact: data };
}

async function updateContact({ name, relationship, occasion, occasion_date, notes }) {
  const existing = await findContactByName(name);
  if (!existing) return { ok: false, error: `No contact found named '${name}'` };

  const updates = { updated_at: new Date().toISOString() };
  if (relationship !== undefined) updates.relationship = relationship;
  if (occasion !== undefined) updates.occasion = occasion;
  if (occasion_date !== undefined) updates.occasion_date = occasion_date;
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await supabase.from('contacts').update(updates).eq('id', existing.id).select().single();
  if (error) throw error;
  return { ok: true, contact: data };
}

async function listContacts() {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .order('occasion_date', { ascending: true });
  if (error) throw error;
  return { ok: true, contacts: data };
}

async function addGift({ contact_name, occasion, occasion_date, gift_idea, order_by_date, notes }) {
  let contact = await findContactByName(contact_name);
  if (!contact) {
    const { data, error } = await supabase
      .from('contacts')
      .insert({ user_id: DEFAULT_USER_ID, name: contact_name, occasion, occasion_date })
      .select()
      .single();
    if (error) throw error;
    contact = data;
  }

  const row = { contact_id: contact.id };
  if (occasion !== undefined) row.occasion = occasion;
  if (occasion_date !== undefined) row.occasion_date = occasion_date;
  if (gift_idea !== undefined) row.gift_idea = gift_idea;
  if (order_by_date !== undefined) row.order_by_date = order_by_date;
  if (notes !== undefined) row.notes = notes;

  const { data, error } = await supabase.from('gifts').insert(row).select().single();
  if (error) throw error;
  return { ok: true, gift: data, contact };
}

async function updateGift({ contact_name, status, gift_idea, order_by_date, notes }) {
  const contact = await findContactByName(contact_name);
  if (!contact) return { ok: false, error: `No contact found named '${contact_name}'` };

  const { data: matches, error: findError } = await supabase
    .from('gifts')
    .select('*')
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (findError) throw findError;
  if (!matches || matches.length === 0) return { ok: false, error: `No gift found for contact '${contact_name}'` };

  const updates = { updated_at: new Date().toISOString() };
  if (status !== undefined) updates.status = status;
  if (gift_idea !== undefined) updates.gift_idea = gift_idea;
  if (order_by_date !== undefined) updates.order_by_date = order_by_date;
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await supabase.from('gifts').update(updates).eq('id', matches[0].id).select().single();
  if (error) throw error;
  return { ok: true, gift: data };
}

async function listGifts({ status, limit }) {
  const n = limit ?? 20;
  let query = supabase.from('gifts').select('*, contacts(name)').order('created_at', { ascending: false }).limit(n);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, gifts: data };
}

async function getUpcomingOccasions({ days }) {
  const windowDays = days ?? 30;
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + windowDays);

  const { data: contacts, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .not('occasion_date', 'is', null)
    .lte('occasion_date', cutoff.toISOString().slice(0, 10))
    .gte('occasion_date', today.toISOString().slice(0, 10))
    .order('occasion_date', { ascending: true });
  if (error) throw error;

  const contactIds = (contacts ?? []).map((c) => c.id);
  let gifts = [];
  if (contactIds.length > 0) {
    const { data: giftRows, error: giftError } = await supabase
      .from('gifts')
      .select('*')
      .in('contact_id', contactIds);
    if (giftError) throw giftError;
    gifts = giftRows ?? [];
  }

  const upcoming = (contacts ?? []).map((c) => ({
    ...c,
    gifts: gifts.filter((g) => g.contact_id === c.id),
  }));

  return { ok: true, upcoming_occasions: upcoming };
}

async function runGiftTool(name, input) {
  switch (name) {
    case 'add_contact':
      return addContact(input);
    case 'update_contact':
      return updateContact(input);
    case 'list_contacts':
      return listContacts();
    case 'add_gift':
      return addGift(input);
    case 'update_gift':
      return updateGift(input);
    case 'list_gifts':
      return listGifts(input);
    case 'get_upcoming_occasions':
      return getUpcomingOccasions(input);
    default:
      throw new Error(`Unknown Gift Planner tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runGiftAgent(request) {
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
        const result = await runGiftTool(use.name, use.input);
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

  return finalText || "Gift Planner got stuck and didn't produce a final answer — try rephrasing the request.";
}
