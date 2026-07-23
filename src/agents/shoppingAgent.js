import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';
import { tavilySearch } from '../tavilyClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Shopping Agent, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates purchase-research requests to. You have real tools backed by Shane's LifeOS dashboard \
"shopping_items" table, plus a live web search tool — use them, don't guess or make up prices/reviews.

Your job: help Shane research purchases — compare products, prices, and reviews via live search, and track \
items he's considering through to a decision or purchase.

Notes on the data:
- "shopping_items" is one row per thing Shane is considering buying (item, category, status, price_found, \
comparison_notes, url). status is 'researching' (default), 'decided', 'purchased', or 'abandoned'.
- search_product_info uses live web search (Tavily) to look up real, current prices, product comparisons, and \
reviews. Use it whenever Shane asks you to research or compare options — don't invent prices, model names, or \
review sentiment. Ground concrete claims in what the search actually returned, and say so if results are thin.
- When Shane decides on something, save the price/url/comparison notes into the item via update_shopping_item \
so it's tracked, and update status accordingly.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete details (prices found, sources) rather than vague summaries, and note \
when info came from live search vs. the dashboard.`;

const toolDefs = [
  {
    name: 'add_shopping_item',
    description: 'Add a new item Shane is considering buying.',
    input_schema: {
      type: 'object',
      properties: {
        item: { type: 'string' },
        category: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['item'],
    },
  },
  {
    name: 'update_shopping_item',
    description: "Update an existing shopping item's status, price, notes, or url. Matches the most recent item by name if multiple match.",
    input_schema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Item name to match' },
        status: { type: 'string', enum: ['researching', 'decided', 'purchased', 'abandoned'] },
        price_found: { type: 'number' },
        comparison_notes: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['item'],
    },
  },
  {
    name: 'list_shopping_items',
    description: "List Shane's tracked shopping items, most recent first. Optionally filter by status.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['researching', 'decided', 'purchased', 'abandoned'] },
        limit: { type: 'integer', description: 'How many to return, default 20' },
      },
    },
  },
  {
    name: 'search_product_info',
    description: 'Live web search for real, current product prices, comparisons, and reviews. Use this to research, not guess.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "best noise cancelling headphones under $300 2026"' },
      },
      required: ['query'],
    },
  },
];

async function findItemByName(item) {
  const { data, error } = await supabase
    .from('shopping_items')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .ilike('item', item)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function addShoppingItem({ item, category, notes }) {
  const row = { user_id: DEFAULT_USER_ID, item };
  if (category !== undefined) row.category = category;
  if (notes !== undefined) row.comparison_notes = notes;

  const { data, error } = await supabase.from('shopping_items').insert(row).select().single();
  if (error) throw error;
  return { ok: true, shopping_item: data };
}

async function updateShoppingItem({ item, status, price_found, comparison_notes, url }) {
  const existing = await findItemByName(item);
  if (!existing) return { ok: false, error: `No shopping item found named '${item}'` };

  const updates = { updated_at: new Date().toISOString() };
  if (status !== undefined) updates.status = status;
  if (price_found !== undefined) updates.price_found = price_found;
  if (comparison_notes !== undefined) updates.comparison_notes = comparison_notes;
  if (url !== undefined) updates.url = url;

  const { data, error } = await supabase.from('shopping_items').update(updates).eq('id', existing.id).select().single();
  if (error) throw error;
  return { ok: true, shopping_item: data };
}

async function listShoppingItems({ status, limit }) {
  const n = limit ?? 20;
  let query = supabase.from('shopping_items').select('*').eq('user_id', DEFAULT_USER_ID).order('created_at', { ascending: false }).limit(n);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, shopping_items: data };
}

async function searchProductInfo({ query }) {
  const result = await tavilySearch(query, { maxResults: 5 });
  return { ok: true, ...result };
}

async function runShoppingTool(name, input) {
  switch (name) {
    case 'add_shopping_item':
      return addShoppingItem(input);
    case 'update_shopping_item':
      return updateShoppingItem(input);
    case 'list_shopping_items':
      return listShoppingItems(input);
    case 'search_product_info':
      return searchProductInfo(input);
    default:
      throw new Error(`Unknown Shopping Agent tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runShoppingAgent(request) {
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
        const result = await runShoppingTool(use.name, use.input);
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

  return finalText || "Shopping Agent got stuck and didn't produce a final answer — try rephrasing the request.";
}
