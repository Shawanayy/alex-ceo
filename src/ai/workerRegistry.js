// Worker registry for the free-worker router pilot. Every entry here has already been verified
// against that provider's OFFICIAL documentation (not blogs/aggregators) per Shane's decision #6
// — see verified_source on each entry. This is a plain in-code config, not a database table:
// Shane's decision #2 asked for the pilot's DATA (usage logs) to live in an easily-droppable
// table; the registry itself is just code review, so it stays a file for now. Promoting it to a
// DB-backed `workers` table is a natural post-pilot step once category routing is finalized
// (Shane's decision #8 — NOT decided yet).
//
// `priority` below is a PROVISIONAL ordering used only to pick among free workers during this
// pilot's live testing. It is explicitly not the final category-routing decision — Shane said to
// build the abstraction now and configure real primary/backup assignments after reviewing test
// results.
//
// Every worker in this file must have free_status: 'documented_free_tier' or 'local_tool'.
// policy.js enforces this at dispatch time regardless of what's written here — this file is not
// the only thing standing between the router and a paid call.

import * as groqProvider from './providers/groqProvider.js';
import * as openrouterProvider from './providers/openrouterProvider.js';
import * as geminiProvider from './providers/geminiProvider.js';

export const WORKER_REGISTRY = [
  {
    id: 'groq-gpt-oss-20b',
    provider: 'groq',
    model: groqProvider.MODEL,
    categories: ['learning.study_guide', 'learning.syllabus_extraction'],
    free_status: 'documented_free_tier',
    verified_at: '2026-09-21',
    verified_source: 'https://console.groq.com/docs/rate-limits (official)',
    requires_payment_method: false,
    rate_limits_summary: '30 RPM / 1,000 RPD / 8K TPM / 200K TPD (Groq free plan, official docs)',
    privacy_notes: 'See https://console.groq.com/docs/your-data — review current retention/training policy before sending sensitive content.',
    priority: 10,
    envVar: 'GROQ_API_KEY',
    adapter: groqProvider,
    enabled: true,
  },
  {
    id: 'openrouter-dynamic-free',
    provider: 'openrouter',
    model: openrouterProvider.MODEL,
    categories: ['learning.study_guide', 'learning.syllabus_extraction'],
    free_status: 'documented_free_tier',
    verified_at: '2026-09-21',
    verified_source: 'https://openrouter.ai/docs/api-reference/limits (official)',
    requires_payment_method: false,
    rate_limits_summary: '20 RPM always; 50 RPD at $0 credits purchased, 1,000 RPD after a one-time $10 purchase (OpenRouter official docs)',
    privacy_notes: 'Free models are served by third-party providers OpenRouter selects — data handling varies by underlying provider. See https://openrouter.ai/docs/guides/overview/data-controls before sending sensitive content.',
    priority: 20,
    envVar: 'OPENROUTER_API_KEY',
    adapter: openrouterProvider,
    enabled: true,
  },
  {
    id: 'gemini-2.5-flash-lite',
    provider: 'gemini',
    model: geminiProvider.MODEL,
    categories: ['learning.study_guide', 'learning.syllabus_extraction'],
    free_status: 'documented_free_tier',
    verified_at: '2026-09-21',
    verified_source:
      'https://ai.google.dev/gemini-api/docs/rate-limits (official, confirms a Free tier exists) ' +
      '+ Shane\'s own AI Studio dashboard check, 2026-09-21, for this specific model\'s live limits.',
    requires_payment_method: false,
    rate_limits_summary:
      '15 RPM / 1,000 RPD / 250,000 TPM (confirmed by Shane via AI Studio, 2026-09-21). Free as long as ' +
      'usage stays under these — no spend-based limit on the Free tier at all (per official docs).',
    privacy_notes: 'See https://ai.google.dev/gemini-api/docs/logs-policy — review before sending sensitive content.',
    priority: 30,
    envVar: 'GEMINI_API_KEY',
    adapter: geminiProvider,
    enabled: true,
  },
];
