# Prem Predictor

A Premier League score-prediction game for a small group of friends. One file,
one React component, no build config of its own.

- Component: `src/PremPredictor.jsx`
- Build: 2026-08-25e
- Stack: Vite + React 18, persistence via Supabase

## What it is

Everyone signs in with a name and PIN, predicts scores for the week's fixtures
before the deadline, and points are worked out automatically once results land:
**5 points for an exact score, 2 for the right result.** There's a league table,
a positions chart, season-long predictions, and live Premier League tables plus
top scorers and top assists.

One person is the admin — they set the matchweek, enter results, manage players,
and choose the typeface and colour theme for everyone.

## Running it

This is a standard Vite + React project.

1. **Create the database table.** Open your Supabase project → SQL Editor → New
   query, paste in `supabase/schema.sql`, and run it. That creates the `kv`
   table the app uses for storage.

2. **Set your credentials.** Copy `.env.example` to `.env` and fill in your
   project URL and publishable key (a `.env` with the current values is already
   in place):

   ```
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
   ```

3. **Install and run:**

   ```bash
   npm install
   ```

   ```bash
   npm run dev
   ```

   Then open the URL Vite prints (usually http://localhost:5173).

Requirements: Node 18+. Tailwind is **not** needed — all styling is a
self-contained CSS block inside the component.

## How persistence works

The app talks to storage only through `window.storage`, a small key-value API
(`get` / `set` / `list` / `delete`). `src/lib/storage.js` re-implements that API
on top of a single Supabase table (`kv`), and `src/main.jsx` assigns it to
`window.storage` before the first render. The component itself is unchanged — it
still only ever calls its `sGet` / `sSet` / `sList` helpers.

Because the app has no Supabase Auth login (players sign in with a name + PIN
stored inside the data), the browser uses the publishable key for all reads and
writes, and the `kv` table's RLS policy allows the `anon` role full access.
Shared league data (the league, fixtures, everyone's picks) is therefore visible
to anyone with the URL and key — the same as the original. Don't put anything
private in it.

### About the `users` / `matches` / `predictions` tables

The app's data model is a set of opaque JSON blobs keyed by strings (e.g.
`league`, `preds:gw1:<id>`, `season:ans:<id>`), which doesn't map cleanly onto a
relational schema, so it currently persists everything into the single `kv`
table. Your `users`, `matches`, and `predictions` tables are left untouched; we
can wire specific data into them later if you want a queryable schema.

## Live league data

Premier League tables, fixtures, scorers and assists are fetched on demand and
refresh on their own every 30 minutes. If a lookup comes back empty, the panel
hides itself rather than showing a broken table — hit **Refresh league data**
and try again.
