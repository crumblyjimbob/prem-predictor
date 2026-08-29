# Contributing / Developer Guide

Welcome! This is the working guide for editing **Prem Predictor** — how to get it
running on your machine and how to ship changes safely. If you just want to
understand what the app is, read [README.md](README.md) first.

---

## 1. What the project is (30-second version)

- A **Vite + React** single-page app. The whole UI is one big component:
  `src/PremPredictor.jsx`.
- **Data** lives in a **Supabase** table (`kv`) — a simple key-value store. The
  app never talks to Supabase directly; it goes through a small shim in
  `src/lib/storage.js`.
- **Live football data** (Premier League table, fixtures, live scores, scorers,
  assists) comes from [football-data.org](https://www.football-data.org) via a
  serverless function at `api/football.js`.
- **Hosting** is on **Vercel**. Every push to the `main` branch auto-deploys to
  the live site.

---

## 2. One-time setup

### You'll need
- **Node 18 or newer** — check with `node -v`. Install from
  [nodejs.org](https://nodejs.org) if you don't have it.
- A **GitHub account**, and Evan needs to add you as a collaborator on the repo
  (`crumblyjimbob/prem-predictor`). Accept the email invite first.

### Clone and install
```bash
git clone https://github.com/crumblyjimbob/prem-predictor.git
cd prem-predictor
npm install
```

### Add your environment file
The app reads secrets from a `.env` file in the project root. This file is **not**
in the repo (it's gitignored on purpose), so you need to create it.

1. Copy the template:
   ```bash
   cp .env.example .env
   ```
2. Fill in the real values. **Ask Evan for these directly** — send them over
   something private (a DM, a password manager share), not a public channel.
   The file should end up looking like:
   ```
   VITE_SUPABASE_URL=https://<the-project>.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
   FOOTBALL_DATA_TOKEN=<football-data.org token>
   ```

> ⚠️ **Never commit `.env` or paste these keys into the code, a PR, or a
> screenshot.** If a key ever leaks, it has to be rotated.

---

## 3. Running it locally

There are two ways to run it, and the difference matters:

### Option A — `npm run dev` (fast, UI work)
```bash
npm run dev
```
Opens on http://localhost:5173. Good for anything visual — layout, styling,
components, wording.

**Caveat:** this does *not* run the `api/football.js` serverless function, so the
live football data (league table, live scores) won't load locally. That's normal.

### Option B — `vercel dev` (full, incl. live data)
If you need the football API working locally too:
```bash
npm i -g vercel      # once
vercel dev
```
This runs both the app and the `/api/football` function.

---

## 4. ⚠️ Important: we share ONE live database

Local development and the live site both point at the **same Supabase database**.
There is currently no separate dev database. That means:

- If you create, edit, or delete a league while testing locally, **you are
  changing the real data our friends are using.**
- Be careful with **Admin-tab actions** (removing players, resetting matchweeks,
  entering scores) while experimenting.
- Safe things to do freely: browse the UI, change styling/layout, work on
  components. Risky things: destructive admin actions, the "Restore from file"
  button.

If this becomes a real risk, ask Evan — we can spin up a separate Supabase
project for development so local work is fully isolated.

---

## 5. How to make and ship an edit

**Never commit straight to `main`** — a push to `main` deploys instantly to the
live site. Use a branch and a pull request instead.

### The loop
1. Make sure you're up to date:
   ```bash
   git checkout main
   git pull
   ```
2. Create a branch for your change:
   ```bash
   git checkout -b short-description-of-change
   ```
3. Make your edits, then commit them:
   ```bash
   git add -A
   git commit -m "Describe what you changed"
   ```
4. Push the branch:
   ```bash
   git push -u origin short-description-of-change
   ```
5. Open a **Pull Request** on GitHub (it'll prompt you after the push, or go to
   the repo → *Pull requests* → *New*). Target `main`.

### What happens next
- Vercel automatically builds a **preview deployment** for your branch and posts a
  link in the PR — a private, disposable copy of the site with your changes. Test
  there before merging.
- Once it looks good and Evan has reviewed it, **merge the PR**. That's what
  deploys the change to the live site.
- Delete the branch after merging (GitHub offers a button). Start the next change
  from a fresh branch off `main`.

---

## 6. Where things live (quick map)

| What you want to change | Where to look |
|---|---|
| Anything in the UI (screens, styling, wording, scoring rules) | `src/PremPredictor.jsx` (it's big — use search) |
| The visual theme / CSS | the `CSS` template string inside `src/PremPredictor.jsx` |
| How data is saved/loaded | `src/lib/storage.js`, `src/lib/supabase.js` |
| Live football data (API calls, data mapping) | `api/football.js` |
| Which matchweek the real API takes over | `API_FROM_GW` constant near the top of `src/PremPredictor.jsx` |
| Build / dependencies | `package.json`, `vite.config.js` |

---

## 7. Gotchas worth knowing

- **`API_FROM_GW`** (top of `src/PremPredictor.jsx`) is the matchweek from which
  fixtures and live scoring switch to the real football API. Earlier weeks were
  built on older data and are managed by hand — don't expect the "Refresh scores"
  button to work on them.
- **The football API is rate-limited** (free tier, ~10 requests/minute). The app
  already spaces its calls out; just don't hammer refresh in a loop.
- **Env vars on Vercel** only take effect on deployments created *after* they're
  saved. If you add or change one, trigger a redeploy.
- **Don't reproduce or share player data** (names, PINs) outside the app.

---

Questions that aren't answered here → ask Evan.
