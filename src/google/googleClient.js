import { google } from 'googleapis';
import dotenv from 'dotenv';
dotenv.config();

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_REFRESH_TOKEN } = process.env;

// Scopes requested for the Admin Agent. Kept as narrow as Gmail's API allows:
// - gmail.readonly: read the inbox (list/get messages).
// - gmail.compose: create/read/update/delete DRAFTS. Note: this scope's name is a bit
//   misleading — Google's own scope also technically permits sending drafts/messages.
//   The Admin Agent code only ever calls draft-create methods and never calls send,
//   so in practice nothing gets sent, but this is an app-level restriction, not a
//   hard OAuth-level one (Gmail has no "drafts only, cannot send" scope).
// - calendar: full calendar read/write, needed for create_event.
// - spreadsheets.readonly: added for the Investment Analyst Agent's daily briefing, to read
//   (never write) Shane's STOCKS Google Sheet for entry-price/date history. Read-only at the
//   OAuth level as a hard guarantee the sheet can't be modified, on top of the app-level rule
//   that nothing ever calls a write method against it.
// Adding a scope here requires re-running src/google/googleAuth.js once to mint a new
// refresh token that actually covers it — existing refresh tokens don't retroactively gain
// new scopes.
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

export function createOAuthClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI in .env');
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

let cachedClient = null;

function getAuthedClient() {
  if (cachedClient) return cachedClient;

  if (!GOOGLE_REFRESH_TOKEN) {
    throw new Error(
      'Missing GOOGLE_REFRESH_TOKEN in .env — run `node src/google/googleAuth.js` once to generate one.'
    );
  }

  const oAuth2Client = createOAuthClient();
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  // googleapis auto-refreshes the access token from the refresh_token as needed —
  // no manual refresh logic required here.
  cachedClient = oAuth2Client;
  return oAuth2Client;
}

export function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: getAuthedClient() });
}

export function getGmailClient() {
  return google.gmail({ version: 'v1', auth: getAuthedClient() });
}

export function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthedClient() });
}
