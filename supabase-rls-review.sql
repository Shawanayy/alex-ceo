-- REVIEW BEFORE RUNNING. Not auto-applied.
--
-- Enables Row-Level Security on the 5 tables Alex uses, then adds a policy
-- that allows the service_role key (what Alex's .env uses) full access,
-- while blocking the anon/authenticated keys (what any client-side app
-- would use) from reading or writing anything.
--
-- This is safe for Alex specifically because Alex only ever talks to
-- Supabase using the service_role key, which bypasses RLS by design.
-- What this actually fixes: it stops the anon key (which is not secret —
-- it can end up embedded in client-side code) from being able to read or
-- write these 5 tables.
--
-- Run this in the Supabase SQL editor for project ymfuulgwqyjpmtegcvrc
-- ("shawanayy@gmail.com's Project") once you're ready. It does NOT touch
-- your other 18 tables (goals, todos, stocks, etc.) — those are a separate
-- decision since other things may depend on anon-key access to them.

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- No policies are created for anon/authenticated, so once RLS is enabled
-- above, those roles lose all access to these 5 tables by default.
-- service_role always bypasses RLS, so Alex keeps working unchanged.
