// One-time setup script. Run manually with:
//
//   node src/google/googleAuth.js
//
// It opens a consent URL for you to approve in your browser, catches the redirect
// on GOOGLE_REDIRECT_URI (a local server), exchanges the code for tokens, and prints
// the refresh token to paste into .env as GOOGLE_REFRESH_TOKEN. Only needs to be run
// once (re-run only if the refresh token is ever revoked or lost).
import http from 'node:http';
import dotenv from 'dotenv';
dotenv.config();

import { createOAuthClient, SCOPES } from './googleClient.js';

const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

if (!REDIRECT_URI) {
  console.error('[google-auth] Missing GOOGLE_REDIRECT_URI in .env');
  process.exit(1);
}

const port = Number(new URL(REDIRECT_URI).port) || 80;
const oAuth2Client = createOAuthClient();

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  // Forces Google to hand back a refresh_token even if this app was previously
  // authorized (Google only sends it on the very first consent otherwise).
  prompt: 'consent',
  scope: SCOPES,
});

console.log('\n[google-auth] 1. Open this URL and approve access:\n');
console.log(authUrl);
console.log(`\n[google-auth] 2. Waiting for the redirect back to ${REDIRECT_URI} ...\n`);

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, REDIRECT_URI);
    const code = reqUrl.searchParams.get('code');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      res.end(`Google returned an error: ${error}. Check the terminal.`);
      console.error(`[google-auth] Google returned an error: ${error}`);
      server.close();
      process.exit(1);
      return;
    }

    if (!code) {
      res.end('No ?code= in the redirect — check the terminal.');
      return;
    }

    const { tokens } = await oAuth2Client.getToken(code);
    res.end('Success — you can close this tab and go back to the terminal.');
    server.close();

    if (!tokens.refresh_token) {
      console.log('\n[google-auth] No refresh_token came back. This can happen if you already');
      console.log('granted this app access before. Revoke it at https://myaccount.google.com/permissions');
      console.log('and re-run this script.\n');
      process.exit(1);
      return;
    }

    console.log('\n[google-auth] Success. Add this line to Alex CEO/.env:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    process.exit(0);
  } catch (err) {
    console.error('[google-auth] Error exchanging code for tokens:', err.message);
    res.end('Error exchanging code for tokens — check the terminal.');
    server.close();
    process.exit(1);
  }
});

server.listen(port, () => {});
