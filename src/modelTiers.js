// Centralized model tiers for every sub-agent (replaces the same 3 lines duplicated 33x across
// alex.js and every file in src/agents/). Two tiers, matching what each agent actually needs:
//
// SIMPLE_MODEL — pure CRUD/logging agents: read/write a dashboard table, compute a streak or
// total, no real judgment call being made (habit, sleep, nutrition, medical records, bill pay,
// subscriptions, credit score, net worth snapshots, appointments, security checklist, etc.).
// Defaults from ALEX_MODEL so existing deploys keep behaving exactly as they do today.
//
// COMPLEX_MODEL — agents doing real reasoning: forecasting, screening/judgment calls, drafted
// writing that goes external, calendar conflict resolution, or acting as the QA gate that's
// supposed to catch mistakes (Admin, Career Coach, Resume, Budgeting, Investment, Data
// Analytics, Scholarship, Skill, Learning, QA). Defaults to Sonnet regardless of ALEX_MODEL so
// this upgrade takes effect without needing a new env var — override with ALEX_MODEL_COMPLEX if
// you want something else.
export const SIMPLE_MODEL = process.env.ALEX_MODEL || 'claude-haiku-4-5-20251001';
export const COMPLEX_MODEL = process.env.ALEX_MODEL_COMPLEX || 'claude-sonnet-5';
