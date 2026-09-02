/*
  Serverless proxy for football-data.org (Vercel Function).

  The browser can't call football-data.org directly — the API token must stay
  server-side. This function sits in between: the app calls
  `/api/football?type=...`, we add the token, and we reshape the response into
  the small shapes the app already understands.

  The app and this function are served from the same origin, so no CORS headers
  are needed (and none are sent — adding `Access-Control-Allow-Origin: *` would
  hand the endpoint to any site that wanted it).

  Set the token in Vercel: Settings -> Environment Variables -> FOOTBALL_DATA_TOKEN
  (NOT prefixed with VITE_, so it is never shipped to the browser).
  Get a free token at https://www.football-data.org/client/register
*/

const BASE = "https://api.football-data.org/v4/competitions/PL";

// football-data names clubs "Arsenal FC", "Manchester United FC"; the app (and
// the restored data) use the short form. Drop a trailing " FC" so the two agree.
const clubName = (s) => String(s || "").replace(/\s+FC$/, "").trim();

const num = (v) => (Number.isFinite(+v) ? +v : 0);

/* The free tier allows ~10 requests a minute for the whole deployment, shared
   by every player at once. Left uncached, one open browser per person is enough
   to exhaust it — and the endpoint is public, so anyone who finds the URL can
   exhaust it deliberately. These let Vercel's edge answer repeat calls without
   touching football-data at all: each distinct query string is its own cache
   entry, so a burst of players collapses into a single upstream request.
   `stale-while-revalidate` means a refresh never blocks on the API either.

   `max-age=0` keeps the *browser* from caching: without it browsers pick a
   heuristic lifetime of their own and "Refresh scores" would quietly return
   the same numbers. Every refresh reaches the edge; almost none reach the API. */
const CACHE = {
  standings: "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
  scorers: "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
  matches: "public, max-age=0, s-maxage=60, stale-while-revalidate=120",  // live scores
  current: "public, max-age=0, s-maxage=3600, stale-while-revalidate=7200",
};

// SCHEDULED/TIMED -> upcoming, IN_PLAY/PAUSED -> live, FINISHED -> finished.
// Anything odd (POSTPONED, SUSPENDED, CANCELLED) is treated as not-yet-played.
function mapStatus(s) {
  if (s === "IN_PLAY" || s === "PAUSED") return "live";
  if (s === "FINISHED") return "finished";
  return "upcoming";
}

async function fdGet(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "X-Auth-Token": token },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`football-data ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    err.upstream = true;
    throw err;
  }
  return res.json();
}

// an error should never be cached, and should never carry the upstream body
// back to the browser — that text can name the token or the account behind it
function fail(res, status, message) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error: message });
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return fail(res, 405, "method not allowed");
  }

  // Browsers send this on every request they make; it is absent for curl and
  // for server-side callers, so we only reject when it positively says the
  // request came from another site. Cheap hotlink guard, not an auth check —
  // the caching above is what actually protects the quota.
  if (req.headers["sec-fetch-site"] === "cross-site") {
    return fail(res, 403, "cross-site requests are not allowed");
  }

  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    return fail(res, 500, "FOOTBALL_DATA_TOKEN is not set on the server");
  }

  const { type, matchday } = req.query || {};

  try {
    if (type === "standings") {
      const data = await fdGet("/standings", token);
      const total = (data.standings || []).find((s) => s.type === "TOTAL");
      const table = (total?.table || []).map((r) => ({
        pos: num(r.position),
        team: clubName(r.team?.name),
        p: num(r.playedGames),
        w: num(r.won),
        d: num(r.draw),
        l: num(r.lost),
        gd: num(r.goalDifference),
        pts: num(r.points),
      }));
      res.setHeader("Cache-Control", CACHE.standings);
      res.status(200).json({ table });
      return;
    }

    if (type === "scorers") {
      // One request gives goals AND assists per player; we derive both top-10s.
      const data = await fdGet("/scorers?limit=30", token);
      const people = (data.scorers || []).map((s) => ({
        name: s.player?.name || "",
        team: clubName(s.team?.name),
        goals: num(s.goals),
        assists: num(s.assists),
      }));
      const scorers = people
        .filter((p) => p.name && p.goals > 0)
        .sort((a, b) => b.goals - a.goals)
        .slice(0, 10)
        .map((p) => ({ name: p.name, team: p.team, goals: p.goals }));
      const assists = people
        .filter((p) => p.name && p.assists > 0)
        .sort((a, b) => b.assists - a.assists)
        .slice(0, 10)
        .map((p) => ({ name: p.name, team: p.team, assists: p.assists }));
      res.setHeader("Cache-Control", CACHE.scorers);
      res.status(200).json({ scorers, assists });
      return;
    }

    if (type === "matches") {
      const md = Math.max(1, Math.min(38, parseInt(matchday, 10) || 1));
      const data = await fdGet(`/matches?matchday=${md}`, token);
      const fixtures = (data.matches || []).map((m) => ({
        h: clubName(m.homeTeam?.name),
        a: clubName(m.awayTeam?.name),
        ko: m.utcDate || null,
        hs: m.score?.fullTime?.home ?? null,
        as: m.score?.fullTime?.away ?? null,
        st: mapStatus(m.status),
      }));
      res.setHeader("Cache-Control", CACHE.matches);
      res.status(200).json({ gw: md, fixtures });
      return;
    }

    if (type === "current") {
      const data = await fdGet("", token);
      res.setHeader("Cache-Control", CACHE.current);
      res.status(200).json({ currentMatchday: data.currentSeason?.currentMatchday || 1 });
      return;
    }

    return fail(res, 400, `unknown type: ${String(type).slice(0, 40)}`);
  } catch (e) {
    // full detail to the server log, a plain message to the browser
    console.error("football proxy:", e?.message || e);
    if (e?.upstream && e.status === 429) {
      return fail(res, 429, "football-data rate limit reached — try again shortly");
    }
    return fail(res, e?.status === 404 ? 404 : 502, "couldn't reach the football data service");
  }
}
