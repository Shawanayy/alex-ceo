import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

import { tavilySearch } from '../tavilyClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-5';

const SYSTEM_PROMPT = `You are the Personal Concierge, a specialist sub-agent that Alex (Shane Pinho's Chief of \
Staff) delegates miscellaneous one-off requests to — reservations, errands, and recommendations that don't \
belong to any other Lifestyle specialist.

You are deliberately lightweight: you have no dashboard table and keep no persistent state. You have one real \
tool — live web search — for looking up current, real information. Use it, don't guess or make up names, \
hours, prices, or availability.

Your job: answer quick miscellaneous requests like "find a good Italian place near downtown open tonight", \
"what's the number for X", "recommend a barber near me", or "look up Y for me" — using live search to ground \
concrete details, then giving Shane a clear, actionable answer.

Scope notes:
- If a request is really about travel, shopping/price comparison, home maintenance, entertainment/events, gift \
tracking, or event planning with ongoing tracking needs, say so plainly in your final answer so Alex can route \
it to the right specialist instead (Travel Planner, Shopping Agent, Home Maintenance Agent, Entertainment \
Planner, Gift Planner, Event Planner) — you're for quick one-off asks, not things that need ongoing tracking.
- You cannot actually make reservations, place orders, or complete bookings — you can find options and give \
Shane what he needs to do it himself (phone numbers, links, hours), but never claim to have completed a \
real-world booking or purchase.

Be concise and factual in your final answer — you're reporting back to another agent (Alex), not chatting with \
Shane directly. Always include concrete details (names, numbers, hours, sources) rather than vague summaries, \
and note when info came from live search.`;

const toolDefs = [
  {
    name: 'search_web',
    description: 'Live web search for real, current information to answer a one-off request. Use this to research, not guess.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "Italian restaurants open now near downtown Columbus"' },
      },
      required: ['query'],
    },
  },
];

async function searchWeb({ query }) {
  const result = await tavilySearch(query, { maxResults: 5 });
  return { ok: true, ...result };
}

async function runConciergeTool(name, input) {
  switch (name) {
    case 'search_web':
      return searchWeb(input);
    default:
      throw new Error(`Unknown Personal Concierge tool: ${name}`);
  }
}

// Runs a small, stateless tool-use loop for a single delegated request from Alex and
// returns a final text summary. No conversation history persists between calls — each
// delegation from Alex is treated as a self-contained request.
export async function runConciergeAgent(request) {
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
        const result = await runConciergeTool(use.name, use.input);
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

  return finalText || "Personal Concierge got stuck and didn't produce a final answer — try rephrasing the request.";
}
