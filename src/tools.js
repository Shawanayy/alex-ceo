import { supabase } from './supabaseClient.js';
import { runAdminAgent } from './agents/adminAgent.js';
import { runLearningAgent } from './agents/learningAgent.js';
import { runCareerAgent } from './agents/careerAgent.js';
import { runResumeAgent } from './agents/resumeAgent.js';
import { runSkillAgent } from './agents/skillAgent.js';
import { runScholarshipAgent } from './agents/scholarshipAgent.js';
import { runBudgetingAgent } from './agents/budgetingAgent.js';
import { runBillPayAgent } from './agents/billPayAgent.js';
import { runNetWorthAgent } from './agents/netWorthAgent.js';
import { runInvestmentAgent } from './agents/investmentAgent.js';
import { runTaxAgent } from './agents/taxAgent.js';
import { runSubscriptionAgent } from './agents/subscriptionAgent.js';
import { runCreditScoreAgent } from './agents/creditScoreAgent.js';
import { runFitnessAgent } from './agents/fitnessAgent.js';
import { runNutritionAgent } from './agents/nutritionAgent.js';
import { runSleepAgent } from './agents/sleepAgent.js';
import { runMedicalRecordsAgent } from './agents/medicalRecordsAgent.js';
import { runHabitAgent } from './agents/habitAgent.js';
import { runAppointmentAgent } from './agents/appointmentAgent.js';
import { runMentalWellnessAgent } from './agents/mentalWellnessAgent.js';
import { runTravelAgent } from './agents/travelAgent.js';
import { runShoppingAgent } from './agents/shoppingAgent.js';
import { runHomeMaintenanceAgent } from './agents/homeMaintenanceAgent.js';
import { runEntertainmentAgent } from './agents/entertainmentAgent.js';
import { runGiftAgent } from './agents/giftAgent.js';
import { runEventPlannerAgent } from './agents/eventPlannerAgent.js';
import { runConciergeAgent } from './agents/conciergeAgent.js';
import { runQaAgent } from './agents/qaAgent.js';
import { runMemoryAgent } from './agents/memoryAgent.js';
import { runAutomationAgent } from './agents/automationAgent.js';
import { runSecurityAgent } from './agents/securityAgent.js';
import { runDataAnalyticsAgent } from './agents/dataAnalyticsAgent.js';
import { runNotificationAgent } from './agents/notificationAgent.js';

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

// Anthropic tool-use definitions. Keep this list honest: only include a tool
// here once the underlying capability actually works end-to-end.
export const toolDefs = [
  {
    name: 'add_task',
    description:
      "Add a new task to Alex's OWN internal task list in Supabase (separate from Shane's LifeOS " +
      "dashboard). Do NOT use this for todos Shane wants tracked on his dashboard — use trigger_n8n for " +
      'those instead. Only use add_task when Shane explicitly wants something tracked just within Alex, ' +
      'not on the dashboard.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Optional longer detail' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_tasks',
    description: "List Shane's tasks, optionally filtered by status.",
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done', 'all'],
          description: "Filter by status, or 'all' for everything. Defaults to pending.",
        },
      },
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done by its id (get the id from list_tasks first).',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'UUID of the task' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'remember',
    description:
      "Save a fact, preference, or routine about Shane to long-term memory, so future conversations can use it.",
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact/preference to remember, written plainly' },
        memory_type: {
          type: 'string',
          enum: ['Preference', 'Vocabulary', 'Pattern', 'Fact'],
          description:
            "'Preference' for how Shane wants things done, 'Pattern' for a routine/recurring behavior " +
            "(e.g. a categorization rule), 'Vocabulary' for a term/shorthand Shane uses, 'Fact' for " +
            'anything else worth remembering.',
        },
        importance: {
          type: 'integer',
          description: '1 (minor) to 5 (critical, always keep in context)',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'delegate_to_admin_agent',
    description:
      "Hand a Calendar or Gmail request off to the Admin Agent, a specialist sub-agent with real Google " +
      'Calendar and Gmail access. Use this for: checking/creating calendar events, and reading email or ' +
      'creating email drafts (the Admin Agent can NEVER send email — drafts only). Pass along enough ' +
      'context in the request for it to act without needing to ask Shane anything else.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do (include dates/times, names, email addresses, etc. as needed).',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_learning_agent',
    description:
      'Hand a coursework or study request off to the Learning & Career Agent, a specialist sub-agent with ' +
      "real access to Shane's classes, assignments, grades, study sessions, and spaced-repetition " +
      'flashcards. Use this for: adding/listing classes or assignments, updating assignment status or ' +
      'grades, scheduling or completing study sessions, adding/reviewing flashcards, generating a written ' +
      'study guide for a class or topic, and importing a syllabus (raw extracted text) to log its exams ' +
      'and auto-schedule study sessions. Pass along enough context (class name, due dates, syllabus text, ' +
      'etc.) for it to act without asking Shane anything else.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_career_coach',
    description:
      "Hand a job search, LinkedIn, or interview prep request off to the Career Coach, a specialist " +
      "sub-agent with real access to Shane's career profile (resume, cover letters, education, skills), " +
      'live job search via Adzuna, and his tracked applications. Use this for: searching for jobs (side ' +
      "jobs/part-time work near Corvallis/OSU, or engineering internships in Oahu), listing or updating the " +
      "status of jobs he's applied to (applied, interviewing, offer, rejected, not interested), drafting a " +
      "LinkedIn post about something he did (draft only, never actually posted), and generating interview " +
      'prep tied to a specific application. Pass along enough context (job title/company/id when updating ' +
      'status, event description for LinkedIn posts, which application for interview prep) for it to act ' +
      'without asking Shane anything else.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_resume_agent',
    description:
      "Hand a resume, portfolio, or cover letter request off to the Resume & Portfolio Agent, a " +
      "specialist sub-agent with real access to Shane's resume text, portfolio items, and cover letters " +
      "(shares his career_profile with the Career Coach, but only the Career Coach updates application " +
      "status). Use this for: updating/adding to his resume text, adding or listing portfolio " +
      "projects/work, syncing portfolio items automatically from his resume, and generating a cover " +
      "letter tied to a specific tracked job application (need the application — company/title is enough, " +
      "it will look up the id). Pass along enough context (the exact update/addition, or which application " +
      'the cover letter is for) for it to act without asking Shane anything else.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_skill_agent',
    description:
      "Hand a skill-building request off to the Skill Development Agent, a specialist sub-agent with real " +
      "access to Shane's tracked skills, milestones, practice sessions, and saved resources. Covers ANY " +
      "skill he wants to get better at, technical or not, even if it overlaps with a class (e.g. \"get " +
      "better at Python for CS 361\" belongs here, not the Learning & Career Agent — that agent only owns " +
      "actual classes/assignments/grades/Canvas sync). Use this for: starting to track a new skill, setting " +
      "or completing milestones, scheduling or logging practice sessions, and saving links/materials tied to " +
      "a skill. Pass along enough context (skill name, milestone/session details, resource link) for it to " +
      'act without asking Shane anything else.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_scholarship_agent',
    description:
      "Hand a scholarship or funding request off to the Scholarship & Funding Agent, a specialist sub-agent " +
      "with real access to Shane's tracked scholarships and generated essay drafts. Runs on its own " +
      "deadline-driven cadence, separate from job applications (Career Coach's domain). Use this for: " +
      "tracking a new scholarship/funding opportunity, listing tracked scholarships, updating a " +
      "scholarship's status (researching/drafting/submitted/awarded/rejected/not_pursuing) or details, and " +
      "generating an essay/personal-statement draft tied to a specific tracked scholarship (name is enough " +
      "— it will look up the id). Its final answer always states any scholarship deadline plainly — surface " +
      "that deadline back to Shane and apply the deadline capture rule above. Pass along enough context " +
      '(scholarship name/provider/amount/deadline, or which scholarship an essay is for) for it to act ' +
      'without asking Shane anything else.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_budgeting_agent',
    description:
      "Hand a spending-plan request off to the Budgeting Agent, a specialist sub-agent with real access " +
      "to Shane's LifeOS dashboard finance tables (accounts, budgets, transactions). Use this for: " +
      'setting or updating a monthly budget for a category, logging an expense or income transaction, ' +
      "comparing actual spend against budget for this month, checking account balances, and forecasting " +
      'cash flow forward based on recent spending trends. Do NOT use trigger_n8n for these — this is a ' +
      'real, working finance capability. Pass along enough context (category, amount, dates) for it to ' +
      'act without asking Shane anything else.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_bill_pay_agent',
    description:
      "Hand a recurring-bill request off to the Bill Pay Agent, a specialist sub-agent with real access " +
      "to Shane's LifeOS dashboard bills table. Use this for: adding or updating a recurring bill (amount, " +
      'due day, priority, autopay status), listing tracked bills, marking a bill as paid, checking which ' +
      'bills lack verified autopay, getting the top-priority bills (unpaid, ranked by urgency), and ' +
      'pushing bill reminders into Shane\'s notifications table for his dashboard and existing weekly- ' +
      "review scheduler. Do NOT use trigger_n8n for these — this is a real, working capability. Pass " +
      'along enough context (bill name, amount, due day) for it to act without asking Shane anything else.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_net_worth_agent',
    description:
      "Hand a net-worth request off to the Net Worth Tracker Agent, a specialist sub-agent with real " +
      "access to Shane's LifeOS dashboard (portfolio_summary, accounts, and a net_worth_history table it " +
      'keeps for trend reporting). Use this for: recording/checking his current net worth, listing past ' +
      'snapshots, and month-over-month or longer trend/progress questions. This is assets only (investments ' +
      '+ cash) — there is no debt/liability tracking yet, so never imply otherwise. Do NOT use trigger_n8n ' +
      'for these — this is a real, working capability.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_investment_agent',
    description:
      "Hand an investment/portfolio request off to the Investment Analyst Agent, a specialist sub-agent " +
      "with real access to Shane's holdings and portfolio_summary tables, plus live Alpha Vantage market " +
      'data. Use this for: listing his holdings, portfolio totals and returns, concentration/allocation ' +
      'questions, best/worst performers, live stock quotes, company research, market news, his ' +
      'personal "bull and bear of the day," and Wall Street analyst consensus (price target, Buy/Hold/Sell ' +
      'rating counts — attributed third-party data, not its own opinion). It will NOT give personalized ' +
      'buy/sell investment advice — that\'s an honest limitation of the agent itself, not a reason to route ' +
      'elsewhere. Do NOT use trigger_n8n for these — this is a real, working capability.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_tax_agent',
    description:
      "Hand a tax-prep request off to the Tax Prep Agent, a specialist sub-agent with real access to " +
      "Shane's LifeOS dashboard tax_items table. Use this for: tracking a deduction, income document he's " +
      'waiting on (W-2, 1099), or estimated payment for a given tax year, listing tracked tax items, marking ' +
      'one collected/filed/paid, and checking upcoming tax deadlines. It will NOT give personalized tax ' +
      'advice — that\'s an honest limitation of the agent itself, not a reason to route elsewhere. Do NOT use ' +
      'trigger_n8n for these — this is a real, working capability.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_subscription_agent',
    description:
      "Hand a recurring-subscription request off to the Subscription Monitoring Agent, a specialist " +
      "sub-agent with real access to Shane's LifeOS dashboard subscriptions table. Use this for: " +
      'adding/updating a subscription (amount, billing cycle, next charge date, trial status), listing ' +
      'tracked subscriptions, cancelling one, checking upcoming charges or trials about to convert, totaling ' +
      'monthly subscription spend, and pushing subscription reminders to the dashboard. Do NOT use ' +
      'trigger_n8n for these — this is a real, working capability.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_credit_agent',
    description:
      "Hand a credit-score request off to the Credit Score Monitoring Agent, a specialist sub-agent with " +
      "real access to Shane's LifeOS dashboard credit_score_history table. Use this for: recording a credit " +
      'score Shane reports, checking his current/most recent score, listing past snapshots, and ' +
      'month-over-month or longer trend questions. There is no live credit bureau integration — it only ' +
      'records scores Shane tells it. Do NOT use trigger_n8n for these — this is a real, working capability.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A clear, self-contained description of what to do.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_fitness_agent',
    description:
      "Hand an exercise/workout request off to the Fitness Coach, a specialist sub-agent with real access " +
      "to Shane's LifeOS dashboard workouts table. Use this for: logging a workout (or a skipped one), " +
      'listing recent workouts, and progress/consistency questions (streaks, frequency, workout-type ' +
      'breakdown). It gives plain factual feedback only, not personalized training/injury advice.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_nutrition_agent',
    description:
      "Hand a diet/food request off to the Nutrition Coach, a specialist sub-agent with real access to " +
      "Shane's LifeOS dashboard nutrition_logs table. Use this for: logging a meal, listing recent meals, " +
      'daily calorie/macro totals, progress/trend questions, and general grocery/meal suggestions. Not for ' +
      'personalized medical/clinical dietary advice.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_sleep_agent',
    description:
      "Hand a sleep request off to the Sleep Coach, a specialist sub-agent with real access to Shane's " +
      "LifeOS dashboard sleep_logs table. Use this for: logging a night's sleep, listing recent sleep logs, " +
      'and average-hours/quality trend questions. Not for personalized clinical sleep-disorder advice.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_medical_records_agent',
    description:
      "Hand a health-record request off to the Medical Records Agent, a specialist sub-agent with real " +
      "access to Shane's LifeOS dashboard medical_records table. Use this for: adding a prescription/lab " +
      'result/vaccination/other record, listing records (optionally filtered), and updating a record\'s ' +
      'status. Structured data only — it does not interpret lab results or give medical advice.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_habit_agent',
    description:
      "Hand a habit-tracking request off to the Habit Tracking Agent, a specialist sub-agent with real " +
      "access to Shane's LifeOS dashboard goals/goal_logs tables (goal_type='Habit' only — Savings/Mileage/" +
      'Completion goals belong elsewhere). Use this for: creating a new habit, listing habits, logging a ' +
      "day's completion, and streak/consistency questions.",
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_appointment_agent',
    description:
      "Hand a healthcare-appointment request off to the Appointment Coordinator, a specialist sub-agent " +
      "with real access to Shane's LifeOS dashboard appointments table. Use this for: scheduling/tracking " +
      'an appointment, listing appointments, checking what\'s coming up soonest, and marking one completed/ ' +
      'cancelled. It does not create Calendar events itself — see the Appointment → Calendar rule below.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_mental_wellness_agent',
    description:
      "Hand a mood/stress check-in request off to the Mental Wellness Agent, a specialist sub-agent with " +
      "real access to Shane's LifeOS dashboard mood_logs table. Use this for: logging a mood/stress check-" +
      'in, listing recent check-ins, and mood/stress trend questions, plus generic mindfulness suggestions. ' +
      'Deliberately conservative — it does not diagnose or give clinical/therapeutic advice, and will flag ' +
      'anything that sounds beyond a routine check-in rather than handle it itself.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_travel_agent',
    description:
      "Hand a trip-planning request off to the Travel Planner, a specialist sub-agent with real access to " +
      "Shane's LifeOS dashboard trips/trip_packing_items tables plus live web search. Use this for: tracking " +
      'a trip, researching flights/hotels/itineraries, and managing a packing checklist.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_shopping_agent',
    description:
      "Hand a purchase-research request off to the Shopping Agent, a specialist sub-agent with real access " +
      "to Shane's LifeOS dashboard shopping_items table plus live web search. Use this for: comparing " +
      'products/prices/reviews and tracking items through to a purchase decision.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_home_maintenance_agent',
    description:
      "Hand a home-upkeep request off to the Home Maintenance Agent, a specialist sub-agent with real " +
      "access to Shane's LifeOS dashboard home_maintenance_records table. Use this for: tracking recurring " +
      'maintenance tasks, warranties, and household supplies, and checking what\'s due soon.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_entertainment_agent',
    description:
      "Hand a leisure-planning request off to the Entertainment Planner, a specialist sub-agent with real " +
      "access to Shane's LifeOS dashboard entertainment_log table plus live web search. Use this for: " +
      'finding movies/books/restaurants/local events and tracking want-to vs. done with ratings.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_gift_agent',
    description:
      "Hand a gift-tracking request off to the Gift Planner, a specialist sub-agent with real access to " +
      "Shane's LifeOS dashboard contacts/gifts tables. Use this for: tracking people and their birthdays/" +
      'occasions, gift ideas, and ordering reminders.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_event_planner_agent',
    description:
      "Hand an event-organizing request off to the Event Planner, a specialist sub-agent with real access " +
      "to Shane's LifeOS dashboard events table. Use this for: tracking an event's date/budget/guest count/" +
      'vendors/status and checking what\'s coming up soonest.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_concierge_agent',
    description:
      'Hand a miscellaneous one-off request off to the Personal Concierge, a lightweight specialist sub-' +
      'agent with live web search and no dashboard storage. Use this for: quick reservations/errands/' +
      "recommendations lookups that don't need ongoing tracking (if it needs tracking, prefer the relevant " +
      'Lifestyle specialist instead).',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_qa_agent',
    description:
      'Hand a piece of drafted content off to the QA / Review Agent for a final check before Shane sees it — ' +
      'no tools, no dashboard state, a pure text review pass. Use this BEFORE sending anything with dollar ' +
      "figures, dates/commitments, or content going somewhere external (a drafted email, a LinkedIn post, an " +
      'appointment/event confirmation, a financial summary) — not for routine chat replies. Include the ' +
      'drafted content plus any context needed to judge it (source numbers/facts it should match).',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'The drafted content to review, plus context needed to judge it.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_memory_agent',
    description:
      'Hand a memory-management request off to the Memory Agent — for browsing, correcting, re-prioritizing, ' +
      "or deleting what's been remembered about Shane. Do NOT use this to save a NEW memory — use the " +
      "'remember' tool for that (it's lighter-weight and already auto-injects into every conversation). Use " +
      "this agent when Shane wants to search/list past memories, fix a wrong one, change its importance, or " +
      'forget something.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_automation_agent',
    description:
      'Hand an automation/workflow request off to the Automation Agent. Real scope: tracking automation ' +
      'ideas and if-this-then-that rules as a backlog/wishlist, and running schedule-based rules Shane marks ' +
      "active via the background loop. Alex cannot sign Shane up for new services or connect new apps — say " +
      'so if asked for that.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_security_agent',
    description:
      'Hand a digital-hygiene request off to the Security & Privacy Agent — a hygiene CHECKLIST tracker ' +
      '(password rotation reminders, 2FA reminders, device/app-permission review reminders), not a real ' +
      "security system. Alex never handles actual passwords/credentials or logs into accounts — if Shane " +
      'asks for a real password audit or live account monitoring, this agent will say that needs to be done ' +
      'by Shane himself.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_data_analytics_agent',
    description:
      'Hand a trends/insights request off to the Data Analytics Agent — read-only across finance, health, ' +
      'and productivity data, can log computed metrics into the kpis table for tracking over time. Use for ' +
      'requests like "how am I trending", dashboards, or cross-department summaries.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'delegate_to_notification_agent',
    description:
      "Hand a notification-triage request off to the Notification Manager — what's pending, what's urgent, " +
      "reviewing or clearing notifications, or manually flagging something. Note: proactively pushing " +
      "high/medium urgency notifications to Telegram happens automatically via a background loop, not through " +
      'this tool — this tool is for on-demand queries/management.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'A clear, self-contained description of what to do.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'trigger_n8n',
    description:
      "DEFAULT tool for anything that belongs on Shane's LifeOS dashboard. Use this — not add_task, not " +
      'remember, not log_gap — whenever Shane mentions a todo, a goal, a calendar-related note (that is ' +
      "not a request to actually create/check a real Google Calendar event — that's the Admin Agent's " +
      'job), a finance item, coursework/learning item, or anything else that sounds like something his ' +
      'dashboard tracks. If in doubt whether something is a dashboard capture, prefer trigger_n8n over ' +
      'other tools. Pass along the relevant text from what Shane said so the workflow has full context.',
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: "The text to send to the n8n workflow — what Shane said/wants captured.",
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'log_gap',
    description:
      "Log a request Alex couldn't fulfill — either because no department/sub-agent exists for it yet, " +
      'or because something failed. Do NOT use this for coursework/study/Canvas-sync requests — those ' +
      'have a real sub-agent (delegate_to_learning_agent), nor for budgeting/expense/cash-flow requests ' +
      '— those have a real sub-agent (delegate_to_budgeting_agent) — nor for recurring-bill requests — ' +
      'those have a real sub-agent (delegate_to_bill_pay_agent) — nor for net-worth requests — those have ' +
      'a real sub-agent (delegate_to_net_worth_agent) — nor for portfolio/holdings/stock-quote/company-' +
      'research requests — those have a real sub-agent (delegate_to_investment_agent) — nor for tax-prep ' +
      'requests — those have a real sub-agent (delegate_to_tax_agent) — nor for subscription requests — ' +
      'those have a real sub-agent (delegate_to_subscription_agent) — nor for credit-score requests — ' +
      'those have a real sub-agent (delegate_to_credit_agent) — nor for exercise/workout requests — those ' +
      'have a real sub-agent (delegate_to_fitness_agent) — nor for diet/food requests — those have a real ' +
      'sub-agent (delegate_to_nutrition_agent) — nor for sleep requests — those have a real sub-agent ' +
      '(delegate_to_sleep_agent) — nor for prescription/lab-result/vaccination/health-record requests — ' +
      'those have a real sub-agent (delegate_to_medical_records_agent) — nor for habit-tracking requests — ' +
      'those have a real sub-agent (delegate_to_habit_agent) — nor for healthcare-appointment requests — ' +
      'those have a real sub-agent (delegate_to_appointment_agent) — nor for mood/stress check-in requests ' +
      '— those have a real sub-agent (delegate_to_mental_wellness_agent) — nor for trip-planning requests ' +
      '— those have a real sub-agent (delegate_to_travel_agent) — nor for purchase-research requests — ' +
      'those have a real sub-agent (delegate_to_shopping_agent) — nor for home-maintenance/warranty/supply ' +
      'requests — those have a real sub-agent (delegate_to_home_maintenance_agent) — nor for movie/book/' +
      'restaurant/local-event requests — those have a real sub-agent (delegate_to_entertainment_agent) — ' +
      'nor for gift/birthday/occasion requests — those have a real sub-agent (delegate_to_gift_agent) — nor ' +
      'for event-organizing requests — those have a real sub-agent (delegate_to_event_planner_agent) — nor ' +
      'for miscellaneous one-off reservation/errand/recommendation requests — those have a real sub-agent ' +
      '(delegate_to_concierge_agent) — nor for content-review requests — those have a real sub-agent ' +
      '(delegate_to_qa_agent) — nor for browsing/correcting/forgetting past memories — those have a real ' +
      'sub-agent (delegate_to_memory_agent) — nor for automation/workflow-idea requests — those have a real ' +
      'sub-agent (delegate_to_automation_agent) — nor for password-hygiene/security-checklist requests — ' +
      'those have a real sub-agent (delegate_to_security_agent) — nor for cross-department trend/dashboard ' +
      'requests — those have a real sub-agent (delegate_to_data_analytics_agent) — nor for notification-' +
      'triage requests — those have a real sub-agent (delegate_to_notification_agent) — always try those ' +
      'first. ALWAYS call this instead of pretending to do something you cannot actually do (e.g. Research ' +
      'requests — that department does not exist yet).',
    input_schema: {
      type: 'object',
      properties: {
        request_summary: { type: 'string', description: "One-line summary of what Shane asked for" },
        reason: { type: 'string', description: 'Why it could not be done' },
      },
      required: ['request_summary', 'reason'],
    },
  },
];

async function addTask({ title, description }) {
  const { data, error } = await supabase
    .from('tasks')
    .insert({ title, description: description ?? null, source: 'alex_telegram' })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, task: data };
}

async function listTasks({ status }) {
  let query = supabase.from('tasks').select('*').order('created_at', { ascending: false }).limit(20);
  if (status && status !== 'all') query = query.eq('status', status);
  else if (!status) query = query.eq('status', 'pending');
  const { data, error } = await query;
  if (error) throw error;
  return { ok: true, tasks: data };
}

async function completeTask({ task_id }) {
  const { data, error } = await supabase
    .from('tasks')
    .update({ status: 'done' })
    .eq('id', task_id)
    .select()
    .single();
  if (error) throw error;
  return { ok: true, task: data };
}

async function remember({ content, memory_type, importance }) {
  const { data, error } = await supabase
    .from('memories')
    .insert({
      content,
      memory_type: memory_type ?? 'Fact',
      importance: importance ?? 3,
    })
    .select()
    .single();
  if (error) throw error;
  return { ok: true, memory: data };
}

async function delegateToAdminAgent({ request }) {
  const result = await runAdminAgent(request);
  return { ok: true, result };
}

async function delegateToLearningAgent({ request }) {
  const result = await runLearningAgent(request);
  return { ok: true, result };
}

async function delegateToCareerCoach({ request }) {
  const result = await runCareerAgent(request);
  return { ok: true, result };
}

async function delegateToResumeAgent({ request }) {
  const result = await runResumeAgent(request);
  return { ok: true, result };
}

async function delegateToSkillAgent({ request }) {
  const result = await runSkillAgent(request);
  return { ok: true, result };
}

async function delegateToScholarshipAgent({ request }) {
  const result = await runScholarshipAgent(request);
  return { ok: true, result };
}

async function delegateToBudgetingAgent({ request }) {
  const result = await runBudgetingAgent(request);
  return { ok: true, result };
}

async function delegateToBillPayAgent({ request }) {
  const result = await runBillPayAgent(request);
  return { ok: true, result };
}

async function delegateToNetWorthAgent({ request }) {
  const result = await runNetWorthAgent(request);
  return { ok: true, result };
}

async function delegateToInvestmentAgent({ request }) {
  const result = await runInvestmentAgent(request);
  return { ok: true, result };
}

async function delegateToTaxAgent({ request }) {
  const result = await runTaxAgent(request);
  return { ok: true, result };
}

async function delegateToSubscriptionAgent({ request }) {
  const result = await runSubscriptionAgent(request);
  return { ok: true, result };
}

async function delegateToCreditAgent({ request }) {
  const result = await runCreditScoreAgent(request);
  return { ok: true, result };
}

async function delegateToFitnessAgent({ request }) {
  const result = await runFitnessAgent(request);
  return { ok: true, result };
}

async function delegateToNutritionAgent({ request }) {
  const result = await runNutritionAgent(request);
  return { ok: true, result };
}

async function delegateToSleepAgent({ request }) {
  const result = await runSleepAgent(request);
  return { ok: true, result };
}

async function delegateToMedicalRecordsAgent({ request }) {
  const result = await runMedicalRecordsAgent(request);
  return { ok: true, result };
}

async function delegateToHabitAgent({ request }) {
  const result = await runHabitAgent(request);
  return { ok: true, result };
}

async function delegateToAppointmentAgent({ request }) {
  const result = await runAppointmentAgent(request);
  return { ok: true, result };
}

async function delegateToMentalWellnessAgent({ request }) {
  const result = await runMentalWellnessAgent(request);
  return { ok: true, result };
}

async function delegateToTravelAgent({ request }) {
  const result = await runTravelAgent(request);
  return { ok: true, result };
}

async function delegateToShoppingAgent({ request }) {
  const result = await runShoppingAgent(request);
  return { ok: true, result };
}

async function delegateToHomeMaintenanceAgent({ request }) {
  const result = await runHomeMaintenanceAgent(request);
  return { ok: true, result };
}

async function delegateToEntertainmentAgent({ request }) {
  const result = await runEntertainmentAgent(request);
  return { ok: true, result };
}

async function delegateToGiftAgent({ request }) {
  const result = await runGiftAgent(request);
  return { ok: true, result };
}

async function delegateToEventPlannerAgent({ request }) {
  const result = await runEventPlannerAgent(request);
  return { ok: true, result };
}

async function delegateToConciergeAgent({ request }) {
  const result = await runConciergeAgent(request);
  return { ok: true, result };
}

async function delegateToQaAgent({ request }) {
  const result = await runQaAgent(request);
  return { ok: true, result };
}

async function delegateToMemoryAgent({ request }) {
  const result = await runMemoryAgent(request);
  return { ok: true, result };
}

async function delegateToAutomationAgent({ request }) {
  const result = await runAutomationAgent(request);
  return { ok: true, result };
}

async function delegateToSecurityAgent({ request }) {
  const result = await runSecurityAgent(request);
  return { ok: true, result };
}

async function delegateToDataAnalyticsAgent({ request }) {
  const result = await runDataAnalyticsAgent(request);
  return { ok: true, result };
}

async function delegateToNotificationAgent({ request }) {
  const result = await runNotificationAgent(request);
  return { ok: true, result };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The n8n webhook is self-hosted behind Tailscale, which can occasionally have transient
// network blips. Retry a few times with a short backoff before giving up, so a real dashboard
// capture doesn't get silently dropped by one bad request.
const N8N_MAX_ATTEMPTS = 3;
const N8N_RETRY_DELAY_MS = 700;

async function triggerN8n({ request }) {
  if (!N8N_WEBHOOK_URL) {
    throw new Error('Missing N8N_WEBHOOK_URL in .env');
  }

  let lastError = null;
  for (let attempt = 1; attempt <= N8N_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: request, source: 'alex_telegram' }),
      });
      if (!res.ok) {
        throw new Error(`n8n webhook returned ${res.status} ${res.statusText}`);
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        // n8n may not return JSON — that's fine, still a success.
      }
      return { ok: true, n8n_response: data, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < N8N_MAX_ATTEMPTS) {
        await sleep(N8N_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw new Error(`n8n webhook failed after ${N8N_MAX_ATTEMPTS} attempts: ${String(lastError?.message ?? lastError)}`);
}

async function logGap({ request_summary, reason }, telegramMessageId) {
  const { error } = await supabase.from('agent_logs').insert({
    agent_name: 'alex_core',
    event_type: 'gap',
    request_summary,
    detail: { reason },
    telegram_message_id: telegramMessageId ?? null,
  });
  if (error) throw error;
  return { ok: true, logged: true };
}

// Dispatches a tool_use block to its handler. `telegramMessageId` is threaded
// through for log_gap so gaps are traceable back to the triggering message.
export async function runTool(name, input, telegramMessageId) {
  switch (name) {
    case 'add_task':
      return addTask(input);
    case 'list_tasks':
      return listTasks(input);
    case 'complete_task':
      return completeTask(input);
    case 'remember':
      return remember(input);
    case 'delegate_to_admin_agent':
      return delegateToAdminAgent(input);
    case 'delegate_to_learning_agent':
      return delegateToLearningAgent(input);
    case 'delegate_to_career_coach':
      return delegateToCareerCoach(input);
    case 'delegate_to_resume_agent':
      return delegateToResumeAgent(input);
    case 'delegate_to_skill_agent':
      return delegateToSkillAgent(input);
    case 'delegate_to_scholarship_agent':
      return delegateToScholarshipAgent(input);
    case 'delegate_to_budgeting_agent':
      return delegateToBudgetingAgent(input);
    case 'delegate_to_bill_pay_agent':
      return delegateToBillPayAgent(input);
    case 'delegate_to_net_worth_agent':
      return delegateToNetWorthAgent(input);
    case 'delegate_to_investment_agent':
      return delegateToInvestmentAgent(input);
    case 'delegate_to_tax_agent':
      return delegateToTaxAgent(input);
    case 'delegate_to_subscription_agent':
      return delegateToSubscriptionAgent(input);
    case 'delegate_to_credit_agent':
      return delegateToCreditAgent(input);
    case 'delegate_to_fitness_agent':
      return delegateToFitnessAgent(input);
    case 'delegate_to_nutrition_agent':
      return delegateToNutritionAgent(input);
    case 'delegate_to_sleep_agent':
      return delegateToSleepAgent(input);
    case 'delegate_to_medical_records_agent':
      return delegateToMedicalRecordsAgent(input);
    case 'delegate_to_habit_agent':
      return delegateToHabitAgent(input);
    case 'delegate_to_appointment_agent':
      return delegateToAppointmentAgent(input);
    case 'delegate_to_mental_wellness_agent':
      return delegateToMentalWellnessAgent(input);
    case 'delegate_to_travel_agent':
      return delegateToTravelAgent(input);
    case 'delegate_to_shopping_agent':
      return delegateToShoppingAgent(input);
    case 'delegate_to_home_maintenance_agent':
      return delegateToHomeMaintenanceAgent(input);
    case 'delegate_to_entertainment_agent':
      return delegateToEntertainmentAgent(input);
    case 'delegate_to_gift_agent':
      return delegateToGiftAgent(input);
    case 'delegate_to_event_planner_agent':
      return delegateToEventPlannerAgent(input);
    case 'delegate_to_concierge_agent':
      return delegateToConciergeAgent(input);
    case 'delegate_to_qa_agent':
      return delegateToQaAgent(input);
    case 'delegate_to_memory_agent':
      return delegateToMemoryAgent(input);
    case 'delegate_to_automation_agent':
      return delegateToAutomationAgent(input);
    case 'delegate_to_security_agent':
      return delegateToSecurityAgent(input);
    case 'delegate_to_data_analytics_agent':
      return delegateToDataAnalyticsAgent(input);
    case 'delegate_to_notification_agent':
      return delegateToNotificationAgent(input);
    case 'trigger_n8n':
      return triggerN8n(input);
    case 'log_gap':
      return logGap(input, telegramMessageId);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function logError(requestSummary, error, telegramMessageId) {
  await supabase.from('agent_logs').insert({
    agent_name: 'alex_core',
    event_type: 'error',
    request_summary: requestSummary,
    detail: { message: String(error?.message ?? error) },
    telegram_message_id: telegramMessageId ?? null,
  });
}

export async function fetchMemories() {
  const { data, error } = await supabase
    .from('memories')
    .select('content, memory_type, importance')
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(15);
  if (error) {
    console.error('[Alex] Failed to load memories:', error.message);
    return [];
  }
  return data ?? [];
}
