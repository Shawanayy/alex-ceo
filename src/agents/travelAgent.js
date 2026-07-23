import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../supabaseClient.js';
import { tavilySearch } from '../tavilyClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

const SYSTEM_PROMPT = `You are the Travel Planner, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates trip-planning requests to. You have real tools backed by Shane's LifeOS dashboard "trips" and \
"trip_packing_items" tables, plus a live web search tool — use them, don't guess or make up numbers.

Your job: help Shane plan trips — track destination/dates/status, research flights/hotels/itineraries via live \
search, and manage packing checklists.

Notes on the data:
- "trips" is one row per trip (destination, start_date, end_date, status, flight_notes, hotel_notes, \
itinerary_notes, budget, notes). status is 'planning' (default), 'booked', 'completed', or 'cancelled'.
- "trip_packing_items" is one row per packing-list item, linked to a trip by trip_id. packed is a boolean.
- search_travel_info uses live web search (Tavily) to look up real, current flight options, hotel options, \
things to do, or general trip-planning info. Use it whenever Shane asks you to research or find options — don't \
invent flight prices, hotel names, or availability. Always ground concrete claims (prices, names, dates) in what \
the search actually returned, and say so if results are thin or unclear.
- When Shane decides on something from your research (a flight, hotel, itinerary), save it into the trip's \
flight_notes/hotel_notes/itinerary_notes via update_trip so it's tracked.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete details (dates, destinations, prices found) rather than vague summaries, \
and note when info came from live search vs. the dashboard.`;

const toolDefs = [
  {
    name: 'create_trip',
    description: 'Add a new trip to track. Use this when Shane wants to start planning a new trip.',
    input_schema: {
      type: 'object',
      properties: {
        destination: { type: 'string' },
        start_date: { type: 'string', description: 'ISO date (YYYY-MM-DD), if known' },
        end_date: { type: 'string', description: 'ISO date (YYYY-MM-DD), if known' },
        budget: { type: 'number', description: 'Trip budget, if given' },
        notes: { type: 'string' },
      },
      required: ['destination'],
    },
  },
  {
    name: 'update_trip',
    description: "Update an existing trip's status, notes, or budget. Matches the most recent trip for the given destination if multiple match.",
    input_schema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Destination to match' },
        status: { type: 'string', enum: ['planning', 'booked', 'completed', 'cancelled'] },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        flight_notes: { type: 'string' },
        hotel_notes: { type: 'string' },
        itinerary_notes: { type: 'string' },
        budget: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['destination'],
    },
  },
  {
    name: 'list_trips',
    description: "List Shane's tracked trips, most recent first. Optionally filter by status.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['planning', 'booked', 'completed', 'cancelled'] },
        limit: { type: 'integer', description: 'How many to return, default 20' },
      },
    },
  },
  {
    name: 'add_packing_item',
    description: 'Add an item to a trip packing checklist.',
    input_schema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Destination to match the trip' },
        item: { type: 'string' },
      },
      required: ['destination', 'item'],
    },
  },
  {
    name: 'set_packing_item_status',
    description: 'Mark a packing item as packed or not packed.',
    input_schema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Destination to match the trip' },
        item: { type: 'string', description: 'Item text to match' },
        packed: { type: 'boolean' },
      },
      required: ['destination', 'item', 'packed'],
    },
  },
  {
    name: 'get_packing_list',
    description: 'Get the packing checklist for a trip.',
    input_schema: {
      type: 'object',
      properties: {
        destination: { type: 'string' },
      },
      required: ['destination'],
    },
  },
  {
    name: 'search_travel_info',
    description: 'Live web search for real, current flight options, hotel options, itinerary ideas, or general trip-planning info. Use this to research, not guess.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "flights from Columbus to Tokyo October 2026"' },
      },
      required: ['query'],
    },
  },
];

async function findTripByDestination(destination) {
  const { data, error } = await supabase
    .from('trips')
    .select('*')
    .eq('user_id', DEFAULT_USER_ID)
    .ilike('destination', destination)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createTrip({ destination, start_date, end_date, budget, notes }) {
  const row = { user_id: DEFAULT_USER_ID, destination };
  if (start_date !== undefined) row.start_date = start_date;
  if (end_date !== undefined) row.end_date = end_date;
  if (budget !== undefined) row.budget = budget;
  if (notes !== undefined) row.notes = notes;

  const { data, error } = await supabase.from('trips').insert(row).select().single();
  if (error) throw error;
  return { ok: true, trip: data };
}

async function updateTrip({ destination, status, start_date, end_date, flight_notes, hotel_notes, itinerary_notes, budget, notes }) {
  const trip = await findTripByDestination(destination);
  if (!trip) return { ok: false, error: `No trip found for destination '${destination}'` };

  const updates = { updated_at: new Date().toISOString() };
  if (status !== undefined) updates.status = status;
  if (start_date !== undefined) updates.start_date = start_date;
  if (end_date !== undefined) updates.end_date = end_date;
  if (flight_notes !== undefined) updates.flight_notes = flight_notes;
  if (hotel_notes !== undefined) updates.hotel_notes = hotel_notes;
  if (itinerary_notes !== undefined) updates.itinerary_notes = itinerary_notes;
  if (budget !== undefined) updates.budget = budget;
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await supabase.from('trips').update(updates).eq('id', trip.id).select().single();
  if (error) throw error;
  return { ok: true, trip: data };
}

async function listTrips({ status, limit }) {
  const n = limit ?? 20;
  let query = supabase.from('trips').select('*').eq('user_id', DEFAULT_USER_ID).order('created_at', { ascending: false }).limit(n);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, trips: data };
}

async function addPackingItem({ destination, item }) {
  const trip = await findTripByDestination(destination);
  if (!trip) return { ok: false, error: `No trip found for destination '${destination}'` };

  const { data, error } = await supabase
    .from('trip_packing_items')
    .insert({ trip_id: trip.id, item })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, packing_item: data };
}

async function setPackingItemStatus({ destination, item, packed }) {
  const trip = await findTripByDestination(destination);
  if (!trip) return { ok: false, error: `No trip found for destination '${destination}'` };

  const { data: matches, error: findError } = await supabase
    .from('trip_packing_items')
    .select('*')
    .eq('trip_id', trip.id)
    .ilike('item', item)
    .limit(1);
  if (findError) throw findError;
  if (!matches || matches.length === 0) return { ok: false, error: `No packing item found matching '${item}'` };

  const { data, error } = await supabase
    .from('trip_packing_items')
    .update({ packed })
    .eq('id', matches[0].id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, packing_item: data };
}

async function getPackingList({ destination }) {
  const trip = await findTripByDestination(destination);
  if (!trip) return { ok: false, error: `No trip found for destination '${destination}'` };

  const { data, error } = await supabase
    .from('trip_packing_items')
    .select('*')
    .eq('trip_id', trip.id)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return { ok: true, packing_list: data };
}

async function searchTravelInfo({ query }) {
  const result = await tavilySearch(query, { maxResults: 5 });
  return { ok: true, ...result };
}

async function runTravelTool(name, input) {
  switch (name) {
    case 'create_trip':
      return createTrip(input);
    case 'update_trip':
      return updateTrip(input);
    case 'list_trips':
      return listTrips(input);
    case 'add_packing_item':
      return addPackingItem(input);
    case 'set_packing_item_status':
      return setPackingItemStatus(input);
    case 'get_packing_list':
      return getPackingList(input);
    case 'search_travel_info':
      return searchTravelInfo(input);
    default:
      throw new Error(`Unknown Travel Planner tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runTravelAgent(request) {
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
        const result = await runTravelTool(use.name, use.input);
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

  return finalText || "Travel Planner got stuck and didn't produce a final answer — try rephrasing the request.";
}
