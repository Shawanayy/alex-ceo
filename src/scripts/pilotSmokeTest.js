// One-off manual smoke test for the free-worker router pilot (src/ai/*).
// Run locally with: node src/scripts/pilotSmokeTest.js
//
// What it does:
//   1. Calls the REAL generateStudyGuide path end-to-end via runLearningAgent — safe, makes no
//      database writes (no class is specified, so it skips every DB read/write in that function).
//   2. Exercises the REAL importSyllabus LLM-extraction leg directly (same routeToFreeWorker +
//      fallback code the migrated function uses) WITHOUT running the rest of importSyllabus, so
//      it never creates a class/assignment/study_session row in your real data. If you want a
//      full end-to-end importSyllabus test including the DB writes, ask and we'll do that
//      separately with an obviously-tagged test class you can delete after.
//
// If none of GROQ_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY are set in .env yet, both steps
// below will report routed.ok === false and fall through to the same Anthropic call that already
// runs in production today — that's expected, not a failure.

import { runLearningAgent } from '../agents/learningAgent.js';
import { routeToFreeWorker } from '../ai/workerRouter.js';

console.log('=== Pilot smoke test ===\n');

console.log('--- Step 1: generateStudyGuide via the real runLearningAgent path ---');
console.log('(waiting on Claude — this takes a few sequential API calls, usually 15-30 seconds, nothing wrong if it sits quietly here)');
const t1 = Date.now();
const guideResult = await runLearningAgent(
  "Call the generate_study_guide tool with topic \"Newton's three laws of motion\" and no " +
    'class_id or class_name (leave them unset). Call it exactly once, then reply with the ' +
    "tool's study_guide output verbatim, nothing else added."
);
console.log(`elapsed: ${Date.now() - t1}ms`);
console.log(guideResult);

console.log('\n--- Step 2: importSyllabus extraction leg only (no DB writes) ---');
console.log('(waiting on a response, usually a few seconds)');
const fakeSyllabus = `
CS 361 — Data Structures, Fall 2026
Midterm Exam: October 15, 2026
Final Exam: December 10, 2026
`;
const extractionPrompt = `Extract exam information from this course syllabus. Respond with ONLY valid \
JSON (no markdown, no commentary) matching this exact shape:
{"class_name": string|null, "class_code": string|null, "exams": [{"title": string, "type": "midterm"|"final"|"exam", "date": "YYYY-MM-DD"}]}
Only include exams (midterms, finals, tests) that have an actual date stated in the syllabus. If no year is \
given, infer a reasonable one from context. If you can't find a class name/code, use null. If no dated \
exams are found, return an empty exams array.

Syllabus text:
${fakeSyllabus}`;

const t2 = Date.now();
const routed = await routeToFreeWorker({
  taskId: crypto.randomUUID(),
  category: 'learning.syllabus_extraction',
  userPrompt: extractionPrompt,
  maxTokens: 1024,
  responseFormat: 'json',
});
console.log(`router result: ok=${routed.ok}${routed.ok ? `, workerId=${routed.workerId}` : `, reason=${routed.reason}`}`);
console.log(`elapsed so far: ${Date.now() - t2}ms`);

if (!routed.ok) {
  console.log('No free worker available/configured — this is the expected fallback path today.');
  console.log('(Not calling Anthropic here to keep this script side-effect-free and fast; the real');
  console.log(' importSyllabus function already proves that leg works via its own unchanged code.)');
} else {
  console.log('Free worker responded:');
  console.log(routed.text);
}

console.log('\n=== Done ===');
