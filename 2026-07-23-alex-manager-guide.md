# Alex Manager Guide — How to Get the Most Out of Every Sub-Agent

This is a full reference for the 33 specialist "managers" (sub-agents) that Alex, your Chief-of-Staff bot, delegates to. For each one you'll find what it actually does, the exact levers it can pull (its tools), how to prompt it well, when to reach for it, ideas for folding it into a daily/weekly rhythm, and anything I noticed while reading the code that's worth fixing or watching for. A findings section at the end rolls up system-wide issues, bugs, and ideas for new agents.

A note on how to read this: you never talk to these agents directly — you always talk to Alex on Telegram, and Alex decides which agent(s) to delegate to. So every "prompt" example below is something you'd type to Alex, not to the sub-agent by name. Alex is generally good at figuring out routing on its own, but naming the domain ("for my budget...", "on the fitness side...") speeds it up and avoids ambiguity when two agents could plausibly own a request.

---

## How delegation actually works (read this once)

Alex's brain (`src/alex.js`) holds a system prompt describing all 33 agents and a routing rulebook, then calls whichever `delegate_to_*_agent` tool fits your message. Each sub-agent is its own mini Claude loop with its own narrow toolset and its own slice of your Supabase database — it can only see and touch the tables it owns. A few things are true system-wide and worth internalizing so you can predict how Alex will behave:

- **QA gate.** Before Alex sends you anything with a dollar figure pulled from a sub-agent, anything drafted for the outside world (an email, a LinkedIn post, a cover letter), or anything confirming a new date/time commitment, it's supposed to silently run that content through the QA / Review Agent first and fix flagged issues before you ever see them. You won't see this happen — you'll just (ideally) get cleaner answers.
- **New appointment → real calendar event.** If a sub-agent's answer confirms a *new* appointment, Alex is supposed to automatically also call the Admin Agent to put it on your real Google Calendar. This only fires for newly-learned appointments, not every time an existing one is mentioned.
- **New deadline → dashboard + maybe calendar.** Same idea for deadlines (scholarships, tax dates, etc.) — Alex should push it to your n8n dashboard todo list, and to your real calendar if it's a hard deadline.
- **Single-user system.** There's no multi-user support or login — everything is scoped to one hardcoded `DEFAULT_USER_ID`. That's fine for you alone, but it means if you ever wanted a partner, assistant, or family member to have their own Alex data, the current build can't separate it.
- **No cross-request memory of "who verified what."** Agents don't know what's already been shown to you in a prior message — each delegation is a fresh, short-lived reasoning loop grounded only in your live database.

---

## Career & Learning

### 1. Admin Agent — real Calendar + Gmail
**What it does:** The only agent with real access to your actual Google Calendar and Gmail. Lists, creates, updates, and deletes calendar events; reads email; creates Gmail drafts. It can never send an email — drafts only, by design.

**Prompts that work well:**
- "Put a dentist appointment on my calendar for next Tuesday at 2pm."
- "What's on my calendar this week?"
- "Draft an email to my professor asking for an extension on the lab report, but don't send it."
- "Check if I got any emails from OSU financial aid recently."

**Best use cases:** Anything that needs to actually land on your real calendar or in your real Gmail drafts folder — this is the one agent with live write access to systems outside the dashboard.

**Daily/repetitive usage:** Morning "what's on my calendar today" check; end-of-day "add tomorrow's follow-up call" habit; batch-drafting routine emails (rent inquiries, professor follow-ups) so they're waiting for a final read-and-send from you.

**Notes/issues:** Every write is mirrored into the dashboard's `calendar_events` table, but that mirror is best-effort — if it fails, it fails silently (only logged to a console you don't see), so the dashboard could quietly drift out of sync with your real calendar over time. Worth periodically sanity-checking the dashboard against Google Calendar directly. Time zone is hardcoded to Pacific — fine while you're in Corvallis/Oahu-adjacent time zones, but if you travel somewhere with a different zone for a while, double-check event times land correctly.

---

### 2. Learning & Career Agent — classes, assignments, study, Canvas
**What it does: **Classes, assignments, grades, scheduled study sessions, spaced-repetition flashcards, and syllabus import. Pulls assignment titles and due dates from Canvas automatically (grades aren't available since OSU disabled personal API tokens, so those still need manual entry).

**Prompts that work well:**
- "Add my Statics midterm — it's October 14th, worth 25% of my grade."
- "What assignments do I have due this week?"
- "I just uploaded my syllabus PDF for Thermo — pull the exam dates and schedule study sessions."
- "Quiz me on my due flashcards."
- "I got an 88 on the Statics homework, log that."

**Best use cases:** Start of each term, upload every syllabus so exam dates and a full study schedule get generated automatically. Use flashcards for anything with pure memorization (formulas, vocabulary, definitions).

**Daily/repetitive usage:** Daily flashcard review ("what's due today"), weekly "what's coming up in the next 7 days" sweep, logging grades right after they're posted so your GPA picture stays current.

**Notes/issues:** Grades require manual entry — a real gap, not a bug, but worth knowing so you don't assume grade sync is automatic. The exam-detection regex used during syllabus import deliberately skips generic words like "final" and "test" to avoid false positives — reasonable, but means a syllabus with unusually worded exam listings might need manual confirmation. Auto-scheduled study sessions land at 14/7/3/1 days before an exam; if you want a different cadence (e.g., you cram more or start earlier), you'd need to ask for a custom schedule rather than relying on the default.

---

### 3. Career Coach — job search, applications, interview prep
**What it does:** Live job search via Adzuna against two pre-built tracks (part-time/side jobs near Corvallis/OSU, and engineering internships in Oahu), application status tracking, LinkedIn post drafts (never posted), and interview prep generation.

**Prompts that work well:**
- "Find me part-time jobs near campus this week."
- "Any new engineering internships in Oahu?"
- "Mark my Boeing application as 'interviewing.'"
- "Draft a LinkedIn post about finishing my capstone project."
- "Help me prep for my interview with [company] — it's a behavioral interview."

**Best use cases:** Recurring job-market checks without you manually browsing boards; keeping a single source of truth for where every application stands; interview-day prep.

**Daily/repetitive usage:** Weekly "any new postings on either track" check; updating application status the same day you hear back so nothing goes stale; pre-interview prep session the night before.

**Notes/issues:** The two search tracks (location + keyword filters) are hardcoded — if your job search geography or field focus changes (say you start looking in Portland, or outside engineering), the agent won't automatically pick that up; you'd need the underlying config updated. Duplicate detection relies on Adzuna's own listing IDs, so the same job re-posted under a new ID could show up twice.

---

### 4. Resume & Portfolio Agent — resume, portfolio, cover letters
**What it does:** Updates your resume text (incremental merge or full replace), manages portfolio items, auto-syncs portfolio from resume content, and generates cover letters tied to a specific tracked job application.

**Prompts that work well:**
- "Update my resume — I just finished a machine design project for [class]."
- "Add my capstone project to my portfolio."
- "Sync my portfolio from my current resume."
- "Write me a cover letter for the Boeing internship application."

**Best use cases:** Keeping resume/portfolio current in small increments right after something noteworthy happens, rather than a stressful rewrite before each application. Cover letters specifically for applications already tracked in Career Coach.

**Daily/repetitive usage:** "Update resume" habit right after finishing a project, certification, or notable class outcome; portfolio sync every term.

**Notes/issues:** None of concern — this is one of the cleaner, lower-risk agents. It reads but never writes application status, so it can't accidentally step on Career Coach's tracking.

---

### 5. Skill Development Agent — any skill, technical or not
**What it does:** Tracks any skill you're building (coding, a language, a sport, an instrument — anything), with milestones, scheduled practice sessions, and saved resources/links. Deliberately distinct from the Learning Agent, even if a skill overlaps a class.

**Prompts that work well:**
- "I want to get better at CAD modeling — track it as a skill."
- "Log a practice session — 45 minutes of SolidWorks."
- "Add a milestone: finish the intro Python course by end of August."
- "What resources have I saved for guitar?"

**Best use cases:** Anything self-directed and open-ended that doesn't fit neatly into a class or a job skill — hobbies, side projects, long-term technical growth.

**Daily/repetitive usage:** Logging practice sessions right after you do them (keeps streak/progress data honest); weekly milestone check-in.

**Notes/issues:** None found — straightforward, no external dependencies, nothing fragile.

---

### 6. Scholarship & Funding Agent — funding search, deadlines, essays
**What it does:** Tracks scholarships/funding opportunities through their lifecycle (researching → drafting → submitted → awarded/rejected), and can generate essay drafts grounded in your resume/portfolio data.

**Prompts that work well:**
- "Add the [name] scholarship — deadline is November 1st."
- "What scholarships do I have coming up?"
- "Draft an essay for the [name] scholarship about overcoming a challenge."
- "Mark the [name] scholarship as submitted."

**Best use cases:** Any time you're juggling more than one or two scholarship/funding deadlines — this is exactly the kind of thing that's easy to lose track of manually.

**Daily/repetitive usage:** Monthly scholarship search sweep; deadline check every time Alex proactively surfaces one (this agent is built to always state deadlines plainly specifically so Alex's automatic deadline-capture rule catches them).

**Notes/issues:** Has a built-in duplicate guard (case-insensitive name matching) so re-adding the same scholarship won't create a second row — good, no action needed there.

---

## Finance

### 7. Budgeting Agent — budgets, transactions, real bank sync
**What it does:** Category budgets, transaction logging, budget-vs-actual comparison, account balances, cash-flow forecasting, and **real Plaid bank sync** (this one actually pulls live transactions from your linked accounts, not just what you log manually).

**Prompts that work well:**
- "Sync my bank transactions."
- "How am I doing against my grocery budget this month?"
- "Set my dining-out budget to $200/month."
- "Forecast my cash flow for the next 30 days."
- "Alert me if I go over 90% of any category budget."

**Best use cases:** This is a real, live financial tool — lean on it for actual month-to-month budget tracking, not just aspirational logging.

**Daily/repetitive usage:** Weekly Plaid sync + budget-vs-actual check (ideally Sunday night, planning the week ahead); monthly cash-flow forecast before big planned expenses; set-and-forget alert rules for overspend categories.

**Notes/issues:** Linking a *new* bank account can't be done through chat at all — it requires a separate local flow (`npm run link`, opening `localhost:5544` on your machine). That's a real friction point if you open a new account and expect to just tell Alex about it. One bad institution connection sets that item to an error status without breaking sync for your other accounts, which is good resilience — but it also means a silently broken single-account sync could go unnoticed unless you specifically ask about connection health.

---

### 8. Bill Pay Agent — recurring bills, autopay, reminders
**What it does:** Recurring bills with amount/due day/priority/autopay flag, marks bills paid, flags anything lacking autopay, surfaces top-priority upcoming bills, and pushes reminder notifications.

**Prompts that work well:**
- "Add my rent — $1400, due the 1st, autopay is off."
- "What bills are coming up this week?"
- "Mark my phone bill as paid."
- "Which of my bills don't have autopay set up?"

**Best use cases:** Anything with a recurring due date you don't want to forget, especially non-autopay bills where a missed payment has real consequences (late fees, service interruption).

**Daily/repetitive usage:** Weekly "what's due" check; immediately marking bills paid so the priority list stays accurate; periodic "show me everything without autopay" audit.

**Notes/issues:** None of concern — logic for figuring out urgency (including wrapping to next month once a due day has passed) looks solid.

---

### 9. Net Worth Tracker — assets, trend over time
**What it does:** Logs net worth snapshots and reports current value/trend. **Assets only — no debt or liability tracking.**

**Prompts that work well:**
- "Log my net worth for this month."
- "What's my current net worth?"
- "Show me my net worth trend over the last 6 months."
- "Alert me if my net worth drops below $X."

**Best use cases:** Monthly financial check-ins, tracking progress toward a savings/net-worth goal.

**Daily/repetitive usage:** Monthly snapshot logging (same day each month keeps trend data clean and comparable).

**Notes/issues:** The lack of liability tracking is explicit and by design, but it means "net worth" here is really "gross assets" — worth remembering so you don't read more into the number than it represents. If you ever take on a loan or carry meaningful debt, this number will overstate your real net worth until a liabilities feature is added (see Findings).

---

### 10. Investment Analyst Agent — holdings, live market data
**What it does:** Holdings, portfolio summary/allocation, top/bottom performers, live stock quotes, company overviews, market news, daily portfolio movers, and analyst consensus — all via Alpha Vantage. Explicitly never gives personalized buy/sell advice (an honest limitation, not something to push around).

**Prompts that work well:**
- "How's my portfolio doing today?"
- "What's the quote on [ticker]?"
- "What's my portfolio allocation look like?"
- "Give me the analyst consensus on [ticker]."
- "Alert me if any position exceeds 20% of my portfolio."

**Best use cases:** Quick market checks, portfolio composition review, staying aware of concentration risk.

**Daily/repetitive usage:** Quick morning market/portfolio check — but see the rate-limit note below before making this a daily habit across many tickers.

**Notes/issues:** Alpha Vantage's free tier caps you at **25 requests/day**, and the "daily movers" feature calls once per ticker you hold — if you hold more than a handful of positions, a single "how are my movers doing" request could burn through a meaningful chunk of your daily quota. Worth being deliberate about when you ask for full-portfolio-movers versus a single quote.

---

### 11. Tax Prep Agent — deductions, docs, deadlines
**What it does:** Tracks deductions, W-2/1099 documents, estimated payment status, and upcoming tax deadlines. Not a licensed CPA — no personalized tax advice.

**Prompts that work well:**
- "Log a deduction — $300 in textbooks for school."
- "What tax deadlines are coming up?"
- "Mark my 1099 from [employer] as received."

**Best use cases:** Year-round deduction capture (much easier than reconstructing everything in April), deadline awareness for estimated payments if you're doing any freelance/1099 work.

**Daily/repetitive usage:** Log deductions as they happen rather than batching; quarterly deadline check ahead of estimated tax dates.

**Notes/issues:** None of concern beyond the explicit (correct) limitation that it won't give real tax advice — for anything beyond organizing/tracking, that's still a job for an actual tax professional.

---

### 12. Subscription Monitoring Agent — recurring subscriptions
**What it does:** Recurring subscriptions, billing cycles (monthly/annual/weekly all normalized to a monthly-equivalent figure), trial-to-paid conversions, upcoming charges, total monthly spend, and reminder pushes.

**Prompts that work well:**
- "Add my Spotify subscription — $11.99/month."
- "What's my total monthly subscription spend?"
- "What subscriptions do I have coming up for renewal?"
- "Cancel my [service] subscription." (this logs the cancellation in the tracker — see note below)

**Best use cases:** Catching subscription creep, especially annual ones that are easy to forget about until the charge hits.

**Daily/repetitive usage:** Monthly "total subscription spend" review; immediately logging any new sign-up or free trial so the trial-conversion tracking is useful.

**Notes/issues:** "Cancel" here means *marking it cancelled in the tracker* — it does **not** actually cancel the subscription with the vendor. Worth being very clear with yourself (and maybe with Alex's phrasing) that this is a record-keeping action, not an execution action, so you don't walk away assuming the real subscription was cancelled.

---

### 13. Credit Score Monitoring Agent — manual score log
**What it does:** Records credit scores you report to it and shows history/trend. No live credit bureau integration — purely what you tell it.

**Prompts that work well:**
- "My credit score is 740 as of this month, log it."
- "What's my credit score trend been?"
- "Alert me if my credit score drops below X."

**Best use cases:** A simple trend line if you're actively working on credit (e.g., building history, paying down a balance) and check your score periodically through a bank/card app.

**Daily/repetitive usage:** Log it each time you happen to check your score elsewhere (monthly is typical for most apps that offer free score checks).

**Notes/issues:** Since there's no live bureau pull, this is only as good as how consistently you feed it — it won't warn you of a change you haven't reported.

---

## Health & Wellness

### 14. Fitness Coach — workouts, streaks
**What it does:** Logs workouts (one per day — the table enforces a single workout entry per date), shows 7/30-day counts, streaks, and workout-type breakdown. Gives plain factual feedback only, not personalized training or injury advice.

**Prompts that work well:**
- "I did a 45-minute upper body workout today."
- "What's my workout streak right now?"
- "How many workouts have I done this month, broken down by type?"

**Best use cases:** Consistency tracking and factual progress review — not a substitute for an actual trainer or physical therapist.

**Daily/repetitive usage:** Log immediately after each workout; weekly streak/progress check as a motivation nudge.

**Notes/issues:** The one-workout-per-day constraint means if you do two sessions in a day (e.g., morning run + evening lift), only one row exists for that date — logging the second would need to either update the first entry or you'd want to check how the agent handles double sessions before assuming both get tracked separately.

---

### 15. Nutrition Coach — meal logging, daily totals
**What it does:** Logs meals (multiple per day, no daily cap), daily calorie/macro totals, and trend over time. Not for clinical dietary advice.

**Prompts that work well:**
- "I had chicken and rice for lunch, log it."
- "What are my totals for today?"
- "How's my macro trend looked this week?"

**Best use cases:** Casual food logging and awareness — not medical nutrition therapy.

**Daily/repetitive usage:** Log meals as you eat them (most useful in the moment rather than reconstructed at day's end); weekly trend check.

**Notes/issues:** None found.

---

### 16. Sleep Coach — sleep logging, trend
**What it does:** Logs sleep (hours/quality), one entry per date, and reports trend. No wearable integration yet — everything is manual.

**Prompts that work well:**
- "I slept about 7 hours last night, decent quality."
- "What's my sleep trend been the last two weeks?"

**Best use cases:** Basic sleep awareness, especially useful around exam periods or travel to spot patterns.

**Daily/repetitive usage:** Morning log right after waking up, before the estimate fades.

**Notes/issues:** No wearable sync (Oura, Apple Watch, etc.) means data quality depends entirely on how consistently you self-report — a real gap if you actually own a sleep-tracking wearable already (see Findings for a suggested integration).

---

### 17. Medical Records Agent — structured record storage
**What it does:** Stores prescriptions, lab results, vaccinations, and other medical records with status tracking. Never interprets clinical meaning — pure storage.

**Prompts that work well:**
- "Log my flu shot from today."
- "Add my new prescription — [medication], [dosage]."
- "What active prescriptions do I have on file?"

**Best use cases:** A personal medical record backup, especially useful across provider changes or when filling out new-patient paperwork.

**Daily/repetitive usage:** Log immediately after any appointment, prescription change, or lab result.

**Notes/issues:** None found — appropriately conservative in scope.

---

### 18. Habit Tracking Agent — habits and streaks
**What it does:** Habits and completions, scoped specifically to `goals` rows tagged as type "Habit" (other goal types — Savings, Mileage, Completion — belong to other parts of the system, not this agent).

**Prompts that work well:**
- "Track a new habit — drink 8 glasses of water a day."
- "I did my habit today — log it."
- "What's my current streak on [habit]?"

**Best use cases:** Small daily behaviors you're trying to build or maintain — separate from one-off fitness/nutrition logs even when they sound similar (e.g., "10,000 steps a day" is a habit, distinct from actual workout logs).

**Daily/repetitive usage:** This is inherently a daily-check-in agent — log completions same-day for accurate streaks.

**Notes/issues:** None found — the type-based filtering is clean and well-documented in the code.

---

### 19. Appointment Coordinator — appointment tracking (not calendar itself)
**What it does:** Tracks appointments (scheduled/completed/cancelled) but does **not** create the real calendar event itself — it hands that off to the Admin Agent automatically when a new appointment is confirmed.

**Prompts that work well:**
- "I have a doctor's appointment next Thursday at 10am."
- "What appointments do I have coming up?"
- "Mark my dentist appointment as completed."

**Best use cases:** Any appointment you want tracked with status (not just calendared) — e.g., health appointments you also want to review history on.

**Daily/repetitive usage:** Log the moment you book something new (triggers the automatic calendar sync); weekly upcoming-appointments check.

**Notes/issues:** None found — the handoff design (tracking here, real calendar write via Admin Agent) is sound, just good to know so you understand why two agents are involved in what feels like one action.

---

### 20. Mental Wellness Agent — mood check-ins
**What it does:** Logs mood/stress check-ins and shows trend. Deliberately conservative: never diagnoses, never gives clinical/therapeutic advice, and is built to flag — not handle — anything that sounds beyond a routine check-in (persistent hopelessness, self-harm mentions), directing you to real support instead.

**Prompts that work well:**
- "Quick mood check-in — feeling pretty stressed about finals."
- "How's my mood trend looked this month?"

**Best use cases:** Lightweight, regular emotional check-ins, especially during known high-stress periods (finals, application deadlines).

**Daily/repetitive usage:** A short daily or every-few-days check-in works well here — enough cadence to catch a trend without turning it into a chore.

**Notes/issues:** None found — the conservative design is appropriate and intentional, not a bug.

---

## Lifestyle & Home

### 21. Travel Planner — trips, packing, live research
**What it does:** Trips and packing checklists, plus live web research for flights/hotels/itineraries. Grounds any concrete claim (price, availability) in an actual search result rather than guessing.

**Prompts that work well:**
- "I'm planning a trip to Oahu in December — start tracking it."
- "Research flights from Portland to Honolulu for early December."
- "What's on my packing list for the Oahu trip?"
- "Add sunscreen to my packing list."

**Best use cases:** Any trip with more than one moving piece — worth starting the moment a trip becomes real, not right before departure.

**Daily/repetitive usage:** Not daily by nature, but useful as a pre-trip checklist ritual (packing list review a few days out).

**Notes/issues:** None found.

---

### 22. Shopping Agent — purchase research and tracking
**What it does:** Tracks items through a purchase decision (researching → decided → purchased → abandoned) with live product/price/review search.

**Prompts that work well:**
- "I'm looking at a new laptop for school — help me compare options."
- "What have I decided on but not bought yet?"
- "Mark the laptop as purchased."

**Best use cases:** Any purchase where you actually want to compare a few options rather than impulse-buy — bigger-ticket items especially.

**Daily/repetitive usage:** Not daily, but good practice for anything above a personal threshold (e.g., anything over $50-100) to force a "researching" stage before buying.

**Notes/issues:** None found.

---

### 23. Home Maintenance Agent — recurring tasks, warranties, supplies
**What it does:** Maintenance tasks, warranties, and household supplies, with due/overdue surfacing.

**Prompts that work well:**
- "Log that I changed my air filter today — it's a 90-day recurring task."
- "What home maintenance is due soon?"
- "Add my washing machine warranty — expires in 2 years."

**Best use cases:** Anything recurring around the home you'd otherwise forget (filters, smoke detector batteries, gutter cleaning) plus a single place to look up warranty coverage.

**Daily/repetitive usage:** Weekly or monthly "what's due" sweep.

**Notes/issues:** When you complete a recurring item, the agent is *instructed* (via its prompt, not enforced by the database) to also create the next occurrence — meaning this depends on the model reliably following that instruction every time rather than the system guaranteeing it. Worth spot-checking after a few completions that the next occurrence actually got created, especially early on.

---

### 24. Entertainment Planner — movies, books, restaurants, events
**What it does:** Tracks want-to vs. done entertainment items (movies/books/restaurants/local events) with ratings, plus live search for finding new options.

**Prompts that work well:**
- "Find some good restaurants near campus I haven't tried."
- "Add [movie] to my want-to-watch list."
- "I watched [movie] — rate it a 4/5."
- "What have I marked as want-to but not done yet?"

**Best use cases:** Building a running list so decision fatigue ("what should we watch/eat") has an actual answer to pull from.

**Daily/repetitive usage:** Casual, as-you-go logging; occasional "what's on my want-to list" pull when you need a suggestion.

**Notes/issues:** None found.

---

### 25. Gift Planner — contacts, occasions, gift ideas
**What it does:** Contacts with birthdays/occasions, gift ideas, and ordering reminders. Shares its `contacts` table with the Event Planner.

**Prompts that work well:**
- "Add my mom's birthday — March 15th."
- "What occasions are coming up in the next month?"
- "I have an idea for [contact]'s gift — [idea]."

**Best use cases:** Anyone you regularly buy gifts for — removes the "wait, when is their birthday again" scramble.

**Daily/repetitive usage:** Monthly "upcoming occasions" check gives enough lead time to actually shop rather than scrambling last-minute.

**Notes/issues:** Adding a gift for someone not already in your contacts auto-creates a new contact by name match — convenient, but a typo'd name (e.g., "Mike" vs "Mikey") would silently create a duplicate contact instead of erroring, so it's worth double-checking contact lists occasionally for near-duplicate names.

---

### 26. Event Planner — events, budget, guests, vendors
**What it does:** Events with date/budget/guest count/vendor notes/status. Deliberately does not build its own guest list — named guests live in Gift Planner's shared contacts table.

**Prompts that work well:**
- "I'm planning a birthday party for [date] — budget is $300."
- "Add [vendor] to the party planning — they're doing catering."
- "What events do I have coming up?"

**Best use cases:** Anything with enough moving parts (budget, vendors, guest count) that a single "events" thread would get messy in your head otherwise.

**Daily/repetitive usage:** Not daily, but a solid weekly check-in in the run-up to a planned event.

**Notes/issues:** "Vendors" is stored as free text meant to be appended to, not overwritten — if you ask to "add" a vendor make sure Alex is appending rather than replacing what's there; worth a spot check the first few times you use it.

---

### 27. Personal Concierge — quick one-off lookups
**What it does:** The lightest agent in the system — one tool (live web search), no database table, no persistent state at all. For quick one-off questions/recommendations that don't need ongoing tracking. It cannot actually make reservations, place orders, or complete bookings — only surfaces information for you to act on.

**Prompts that work well:**
- "What's a good gluten-free restaurant near downtown Corvallis right now?"
- "Quick — what's the return policy at [store]?"

**Best use cases:** Genuinely one-off asks. If you catch yourself wanting to track the outcome ("did I end up going," "did I buy it"), that's a sign to route to the relevant specialist (Entertainment, Shopping, Travel, etc.) instead.

**Daily/repetitive usage:** As-needed, not a routine habit by design.

**Notes/issues:** None — this agent is intentionally minimal and self-aware about redirecting you elsewhere when a request actually needs tracking.

---

## System / Meta Agents

### 28. QA / Review Agent — invisible safety net
**What it does:** A stateless, single-turn reviewer with zero tools. Alex is supposed to run drafted external content, dollar figures, and new date/time commitments past this agent before showing them to you, checking for factual/numeric consistency, missing info, contradictions, and hallucinated details (never style).

**Prompts that work well:** You never call this directly — it's invisible infrastructure. You could, in theory, ask Alex "did you QA-check that?" if you want confirmation it ran.

**Best use cases:** N/A — this is a background safety mechanism, not a tool you invoke.

**Daily/repetitive usage:** N/A.

**Notes/issues:** This is enforced purely through Alex's system prompt, not through code that forces the call — meaning it's a "should always happen" behavior rather than a guaranteed one. If you ever notice a dollar figure or external draft that feels off, it's worth asking Alex directly whether it ran QA on that response, since there's no hard guarantee visible from your side.

---

### 29. Memory Agent — browsing/managing what Alex remembers about you
**What it does:** Search, list, correct, re-prioritize, or delete things Alex has remembered about you (preferences, vocabulary, patterns, facts with an importance rating). Notably, this is **not** for saving new memories — that's a separate lightweight `remember` tool Alex uses on its own.

**Prompts that work well:**
- "What do you remember about my scheduling preferences?"
- "Forget that I said I don't like mornings — that's changed."
- "What memories do you have tagged as high importance?"

**Best use cases:** Correcting drift over time — if Alex is acting on an outdated preference, this is how you fix it directly rather than hoping it self-corrects.

**Daily/repetitive usage:** Occasional audit (monthly-ish) of what's been remembered, especially after a big life change (new job, moved, schedule shift).

**Notes/issues:** Queries here don't filter by user at all — harmless for you alone, but confirms (along with the Notification Manager, below) that this system has zero real multi-tenancy; don't expect to safely add a second person's data into the same instance.

---

### 30. Automation Agent — automation idea backlog
**What it does:** Tracks automation/IFTTT-style rule ideas as a backlog (schedule/event/manual triggers). Active schedule-based rules are actually evaluated and run by a separate background process, not by this agent conversationally. Explicitly cannot sign you up for new services, install software, or connect new accounts.

**Prompts that work well:**
- "I want an automation idea logged — remind me every Sunday to review my budget."
- "What automation ideas do I have sitting in the backlog?"
- "Mark my Sunday budget reminder as active."

**Best use cases:** Capturing "it'd be nice if Alex just did X automatically" ideas as they occur to you, then periodically reviewing and activating the ones worth turning on.

**Daily/repetitive usage:** Log ideas as they come to you; monthly backlog review to decide what to activate.

**Notes/issues:** New rules default to inactive ("backlog") unless you clearly say you want it active now — but that default is enforced by the model following instructions, not by the database itself, so it's technically possible (if unlikely) for a rule to get marked active when you only meant to log an idea. Worth double-checking status right after creating anything you intend to stay dormant.

---

### 31. Security & Privacy Agent — digital hygiene checklist
**What it does:** A checklist tracker for things like password rotation, 2FA setup, device/permission reviews — categorized, with recurrence intervals and overdue detection. Explicitly **not** a real security system: Alex can never see, enter, or store actual passwords/credentials/2FA codes, and cannot log into any of your accounts.

**Prompts that work well:**
- "Add a checklist item — rotate my email password every 90 days."
- "What security items are overdue?"
- "I just enabled 2FA on my bank account, mark it done."

**Best use cases:** A lightweight nudge system for good digital hygiene habits — not a substitute for an actual password manager or security audit.

**Daily/repetitive usage:** Periodic (monthly-ish) "what's overdue" check.

**Notes/issues:** None found — appropriately and clearly scoped down from anything resembling real credential handling, which is the right call.

---

### 32. Data Analytics Agent — cross-department trends
**What it does:** Read-only aggregator across finance, health, and productivity data (accounts, net worth, portfolio, workouts, sleep, mood, todos, goals) to surface trends/snapshots. Its only write is logging computed metrics into a dedicated KPI table for tracking over time.

**Prompts that work well:**
- "Give me a finance snapshot."
- "How's my health data trending — sleep, mood, workouts together?"
- "Log my current savings rate as a KPI to track over time."

**Best use cases:** Periodic big-picture check-ins that pull from multiple domains at once, rather than checking each specialist agent one at a time.

**Daily/repetitive usage:** Weekly or monthly cross-domain review — this is the natural home for a "how am I doing overall" ritual.

**Notes/issues:** Each snapshot type runs its underlying queries in parallel and is all-or-nothing — if one of the several tables it queries for a snapshot has a hiccup, the whole snapshot request fails rather than returning partial data. Not a major issue at your current scale, but means an occasional "no data" reply might actually be a transient failure worth retrying rather than a sign the table is truly empty.

---

### 33. Notification Manager — on-demand notification queries
**What it does:** On-demand triage over a shared notifications table that other agents (Bill Pay, various alert-capable finance agents) write into — list all, get pending, create manually, mark delivered. The actual *proactive* push of high/medium urgency notifications to your Telegram happens automatically via a separate background process every 5 minutes, not through this agent.

**Prompts that work well:**
- "Any pending notifications?"
- "Mark that bill reminder as delivered."
- "Create a manual notification to remind me about [thing] with high urgency."

**Best use cases:** Manually checking or clearing the notification queue outside of the automatic 5-minute push cycle.

**Daily/repetitive usage:** Rarely needed manually since the background loop already pushes anything urgent — mostly useful if you want to double-check nothing's stuck as undelivered.

**Notes/issues:** Like the Memory Agent, queries here don't filter by user at all (single-tenant assumption). Sorting of pending-by-urgency happens in application code rather than the database, which is fine now but wouldn't scale gracefully if notification volume grew substantially — not a concern at your current usage level.

---

## Findings — System-Wide Observations, Ideas, and Issues

### Real bugs / gaps worth addressing
1. **Bank account linking can't happen through chat at all.** The Plaid linking flow (`npm run link` + a local `localhost:5544` server) requires you to be at your computer running the app directly — there's no way to add a new linked bank account purely by texting Alex. If you open new accounts with any frequency, this is real friction.
2. **Calendar mirror can fail silently.** The Admin Agent mirrors every Google Calendar write into the dashboard's `calendar_events` table, but if that mirror write fails, it's only logged to a console you'll never see — the dashboard could quietly drift out of sync with your real calendar with no visible warning.
3. **QA gate and appointment/deadline auto-capture are prompt-enforced, not code-enforced.** Both rules live entirely in Alex's system prompt instructions rather than in code that guarantees the behavior. In practice this should work reliably, but there's no hard backstop if a particular response happens to slip through — worth an occasional spot check (e.g., confirm a newly mentioned appointment actually landed in your real calendar).
4. **Home Maintenance recurrence and Automation Agent's "default to backlog" are similarly prompt-enforced, not database-enforced.** Same caveat — recurring maintenance items and new automation rules rely on the model consistently following instructions rather than a hard constraint.
5. **Investment Analyst can burn through Alpha Vantage's 25-requests/day limit quickly** if you ask for full-portfolio "daily movers" across many holdings in one request, since it calls the API once per ticker. Worth using targeted single-ticker requests most of the time and saving the full portfolio sweep for occasional use.
6. **Net Worth Tracker is assets-only — no liabilities/debt.** If you ever take on meaningful debt (student loans, a car loan, credit card balances), the "net worth" number here will overstate your real position until liability tracking exists.
7. **No multi-tenancy at all.** The system is single-user by hardcoded ID; several tables (`memories`, `notifications`) don't even filter by user in their queries. This is fine for solo use but rules out ever safely sharing one Alex instance with someone else without real rework.
8. **No wearable integration.** Sleep and fitness data are 100% self-reported — if you already own a device that tracks sleep or workouts automatically, that data isn't flowing in, which likely means lower-quality logging than what you're already generating passively elsewhere.
9. **"Cancel a subscription" only cancels it in Alex's tracker, not with the actual vendor** — worth keeping this framing in mind so a "cancel my [service]" request to Alex doesn't get mentally conflated with the real cancellation, which you'd still need to do yourself.
10. **A true Anthropic API failure (not a tool error, but the underlying model call itself failing) isn't retried anywhere** — in any of the 33 agents or in Alex's own core loop. A transient outage would surface as an ugly error rather than a graceful retry. Low-priority given how rarely this happens, but worth knowing if you ever get a confusing failure with no clear cause.

### Ideas for new agents / additions
- **Liabilities/Debt Tracker** — pairs naturally with the existing Net Worth Tracker to get a true net worth picture (assets minus debts) rather than assets alone.
- **A "which agent should I ask" meta-helper** — not strictly necessary since Alex already routes well, but could be handy given how many domains now exist (33 is a lot to keep a mental map of); this document is effectively that reference for now.
- **Wearable sync (sleep/fitness)** — if you have an Apple Watch, Oura, Whoop, or similar, an integration here would meaningfully improve data quality over manual self-reporting.
- **In-chat Plaid account linking** — even a guided "here's the link, open it on your phone" flow triggered from chat would remove the current requirement to be at your computer.
- **A lightweight "weekly digest" companion to Data Analytics** — since Data Analytics already aggregates finance/health/productivity snapshots, a scheduled (rather than on-demand) weekly rollup pushed to you automatically could turn a manual habit into a passive one.

### Quick tips for getting the most out of Alex day-to-day
- Name the domain when your request could plausibly span two agents (e.g., "on the budgeting side, log this expense" vs. just "log this expense," which could theoretically be budgeting or a shopping/entertainment log depending on context).
- Lean on the finance agents that explicitly say "this is a real, working capability" (Budgeting, Bill Pay, Subscription Monitoring) with confidence — they're not simulated, they write real tracked data.
- Treat anything from Career Coach, Resume Agent, or QA-gated responses as a draft-first system by design — nothing external ever goes out without your explicit send action.
- Use the Data Analytics Agent as your "zoom out" tool when you want a cross-domain gut check instead of pinging five separate agents one at a time.

## Roadmap — Shane's Notes (added 2026-08-14)

*Numbering below picks up from Shane's own running list — items 1-2 live elsewhere and aren't captured in this doc yet.*

### 3. The Biggest Upgrade: Proactive AI
The most important evolution should be moving from a reactive assistant to a proactive assistant. The AI should continuously look for opportunities to help.

Example — instead of: *"Schedule my workout."*
Eventually: *"Keep me on track with my workouts."*

The assistant would then look at:
- Calendar
- Available time
- Workout goals
- Previous workouts
- Preferred workout times
- Upcoming commitments

...and automatically suggest or schedule the best time.

### 4. Dynamic Scheduling
A dynamic personal scheduler that distinguishes:

**Hard Events** (can't easily move) — class, work, meetings, appointments, flights, important events.

**Flexible Events** (need to happen, but can move) — gym, running, studying, reading, meditation, personal projects, meal prep, cleaning, planning.

The AI should automatically place flexible activities around hard commitments.

### 5. Calendar as a Motivation System
The calendar shouldn't just tell Shane where he needs to be — it should help him actually do the things he wants to do.

Example — instead of remembering *"I should probably run today,"* the AI puts **5:00–6:00 PM — Run** on the calendar directly. This creates a visible commitment, a specific time, less decision-making, less procrastination, and a record of what he intended to accomplish. The calendar becomes both an organization system and a behavioral system.

### 6. Automatic Rescheduling
The assistant should recognize that life changes and handle conflicts gracefully.

Example: Shane has a 5 PM workout, 7 PM dinner, 8 PM study session. An unexpected event appears at 4:30 PM. Instead of making him reorganize everything, the AI says: *"Your 5 PM workout conflicts with your new commitment. I found an opening tomorrow at 6 AM and another Thursday at 4 PM. Which would you prefer?"* Eventually, Shane could grant permission for flexible activities to be moved automatically according to his preferences.

### 7. Personal Scheduling Preferences
Over time, the assistant should learn:
- When Shane prefers working out
- When he's most productive
- How much sleep he needs
- How long he typically studies
- How long certain tasks actually take
- When he prefers free time
- When he dislikes scheduling things
- How much downtime he needs
- How much activity he can realistically handle

Eventually, Shane should be able to say *"Plan my week"* and have the assistant understand how he likes weeks structured, rather than generating a generic schedule.

**Shane's actual preferences (interviewed 2026-08-14):**
- **Workout timing:** Varies — prefers mornings when possible, but mainly goes by convenience. In Oregon: likes lifting whenever he's already on campus for class/clubs. At home in Hawaii: prefers lifting with family, so timing follows their availability rather than a fixed slot.
- **Peak focus hours:** Varies, but usually at night or in the gaps between classes.
- **Study session length:** ~45–60 min before needing a break.
- **Sleep:** Prefers 8 hours, not a strict requirement. Usual bedtime ~11pm–12am.
- **Downtime:** Wants daily downtime — an hour or two every day, not just batched on weekends.
- **No-go zones:** Never schedule workouts after 9pm. Keep room for family time when he's in Oregon, preferably on Sundays.
