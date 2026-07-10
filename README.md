# Alex — Phase 1 Setup Guide

This walks through getting Alex running on your MacBook Air, assuming you've never used
Terminal or Node.js before. Follow it top to bottom — nothing here is skippable.

**Important:** the project lives at
`/Users/susanpinho/Downloads/Cowork Playground/Alex CEO` — not `/Users/susanpinho/Alex CEO`.
Use the path below exactly.

## 1. Open Terminal

Terminal is the app you'll use for every step below. Press `Cmd + Space` to open
Spotlight search, type `Terminal`, and press Enter. A plain window with white/black
text and a blinking cursor will open — that's it.

Every line below that starts with `$` is a command: type or paste just the part after
the `$` into that window and press Enter. (Don't type the `$` itself.)

## 2. Check if Node.js is installed

```
$ node -v
```

- If you see something like `v20.11.0`, you're good — skip to step 3.
- If you see `command not found: node`, install it:
  1. Go to https://nodejs.org in your browser.
  2. Click the big green button (it'll say "LTS").
  3. Open the downloaded `.pkg` file and click through the installer, entering your Mac
     password when it asks.
  4. Close Terminal completely (Cmd+Q, then reopen), then run `node -v` again to
     confirm it shows a version number.

## 3. Navigate to the Alex project folder

```
$ cd "/Users/susanpinho/Downloads/Cowork Playground/Alex CEO"
```

You won't see any output — that's normal. If you ever close and reopen Terminal, run
this command again before doing anything else in this guide.

## 4. Install Alex's dependencies

```
$ npm install
```

Takes 10-30 seconds. You only need to run this once (and again later only if new
dependencies get added).

## 5. Set up your .env file

1. Still in Terminal, in the Alex CEO folder, run:
   ```
   $ cp .env.example .env
   ```
2. In Finder, go to the `Alex CEO` folder, press `Cmd+Shift+.` to reveal hidden files,
   right-click `.env`, and open it with TextEdit.
3. Fill in the blank values:
   - `TELEGRAM_BOT_TOKEN` — from @BotFather on Telegram.
   - `OWNER_TELEGRAM_USER_ID` — message @userinfobot on Telegram, it replies with your
     numeric ID. This restricts Alex to only respond to you.
   - `SUPABASE_SERVICE_ROLE_KEY` — in the Supabase dashboard for the project called
     "shawanayy@gmail.com's Project" (id `ymfuulgwqyjpmtegcvrc`), go to
     Settings → API → service_role key (click reveal, then copy). `SUPABASE_URL` is
     already filled in for you.
   - `ANTHROPIC_API_KEY` — from https://console.anthropic.com/settings/keys. Click
     "Create Key," name it anything (e.g. "alex-ceo"), copy it immediately (you can't
     view it again later). This is a separate pay-as-you-go key from your regular
     Claude subscription.
4. Save the file (Cmd+S) and close it.

## 6. Start Alex

Back in Terminal (still in the Alex CEO folder from step 3):

```
$ npm start
```

You should see:
```
[Alex] Starting up...
[Alex] Telegram bot is live (long polling). Message him anytime.
```

That means it worked. Open Telegram, find your bot, and message it — try
"what's on my to-do list?"

Leave this Terminal window open and running — closing it or pressing `Ctrl+C` stops
Alex. Step 8 below covers making him run permanently.

If you see red error text instead, copy it and send it to me — don't try to debug it
yourself.

## 7. What Alex can and can't do right now

Can: chat with you, add/list/complete tasks in your real Supabase task list, remember
facts/preferences you tell him, and tell you honestly when he can't do something yet
instead of pretending.

Can't yet: calendar, email, reminders with real alerts, meeting prep, daily briefing, or
anything in Finance, Health, Learning, Lifestyle, Research — those come in later phases.
When you ask for one of these, Alex will say so and log it rather than fake it.

## 8. Make Alex run permanently (24/7)

Two things need to happen so Alex is always reachable, not just while Terminal's open.

### 8a. Auto-restart with PM2

Stop Alex first if it's running (`Ctrl+C`), then:

```
$ npm install -g pm2
$ pm2 start ecosystem.config.cjs
$ pm2 save
$ pm2 startup
```

This uses `ecosystem.config.cjs` (already in this folder) instead of a raw `pm2 start`
command — it sets a memory cap, writes logs to `logs/alex-out.log` and
`logs/alex-error.log`, and restarts Alex automatically if he crashes.

`pm2 startup` prints one long command starting with `sudo env PATH=...`. Copy that
exact line, paste it into Terminal, press Enter, and enter your Mac password when
asked (you won't see it as you type — that's normal).

Check on Alex anytime with:
```
$ pm2 status
$ pm2 logs alex
```
(`Ctrl+C` stops watching logs, doesn't stop Alex.)

### 8b. Stop your MacBook from sleeping

1. System Settings → Lock Screen → set both "Turn display off" options to "Never" (or
   the longest option).
2. System Settings → Battery → Options → turn off "Put hard disks to sleep," turn on
   "Prevent automatic sleeping on power adapter when the display is off" if present.
3. Keep the MacBook plugged in. Closing the lid while plugged into an external display
   is fine (clamshell mode); with no external display, leave the lid open.

## Security notes

- `.env` contains real secrets — never share it, upload it, or paste its contents
  anywhere public. It's already excluded from git via `.gitignore`.
- Row-Level Security is currently OFF on most tables in your Supabase project,
  including the ones Alex uses. `supabase-rls-review.sql` in this folder has SQL to
  turn it on for Alex's 5 tables specifically — review it and run it in the Supabase
  SQL editor whenever you're ready. It won't break anything for Alex (he uses the
  service_role key, which bypasses RLS), it just stops the anon key from being able to
  read/write those tables.
