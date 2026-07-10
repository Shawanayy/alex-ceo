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
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
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
