// Shared helpers for "what timezone is Shane actually in right now" — used by every
// logging agent (nutrition, fitness, sleep, habits, mood) and the Calendar agent, so a
// single stored value drives every date/time decision instead of each file guessing.
//
// Bug this originally fixed: `new Date().toISOString().slice(0, 10)` always returns the
// UTC calendar date, never the user's local one. Shane splits time between Hawaii
// (Pacific/Honolulu, UTC-10) and Oregon (America/Los_Angeles, UTC-7/-8) — a hardcoded
// timezone breaks the moment he's on the other one. Instead, the live value lives in
// Supabase (`public.users.timezone`) and Shane tells Alex directly when he switches
// ("I'm back in Oregon" / "switch me to Hawaii time"), which calls setUserTimezone below.
// Every date computation should read that same column rather than assuming a fixed zone.
import { supabase } from '../supabaseClient.js';

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;
const FALLBACK_TIME_ZONE = 'Pacific/Honolulu'; // only used if the users row/column is somehow missing

// Friendly aliases Shane might actually say, mapped to canonical IANA zones. Anything not
// in this list is passed through as-is, so a raw IANA string ("America/Denver") also works.
const TIMEZONE_ALIASES = {
  hawaii: 'Pacific/Honolulu',
  "hawai'i": 'Pacific/Honolulu',
  'hawaiʻi': 'Pacific/Honolulu',
  honolulu: 'Pacific/Honolulu',
  oregon: 'America/Los_Angeles',
  portland: 'America/Los_Angeles',
  pacific: 'America/Los_Angeles',
  'pacific time': 'America/Los_Angeles',
  'pacific standard time': 'America/Los_Angeles',
  hst: 'Pacific/Honolulu',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
};

export function resolveTimeZoneAlias(input) {
  if (!input) return input;
  const key = input.trim().toLowerCase();
  return TIMEZONE_ALIASES[key] ?? input.trim();
}

export async function getUserTimeZone() {
  const { data, error } = await supabase.from('users').select('timezone').eq('id', DEFAULT_USER_ID).single();
  if (error || !data?.timezone) return FALLBACK_TIME_ZONE;
  return data.timezone;
}

export async function setUserTimeZone(timezoneInput) {
  const timezone = resolveTimeZoneAlias(timezoneInput);
  // Sanity-check it's a real IANA zone before writing it — Intl throws on garbage input.
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  } catch {
    throw new Error(`"${timezoneInput}" isn't a recognized timezone.`);
  }
  // `timezone_mode` has a DB check constraint allowing only 'auto' | 'oregon' | 'hawaii' —
  // writing 'manual' here always violated it, which is why set_timezone silently failed.
  const timezoneMode =
    timezone === 'Pacific/Honolulu' ? 'hawaii' : timezone === 'America/Los_Angeles' ? 'oregon' : 'auto';
  const { error } = await supabase
    .from('users')
    .update({ timezone, timezone_mode: timezoneMode })
    .eq('id', DEFAULT_USER_ID);
  if (error) throw error;
  return timezone;
}

export async function todayLocal() {
  const timeZone = await getUserTimeZone();
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}
