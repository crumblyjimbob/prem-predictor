/*
  Serverless proxy for football-data.org (Vercel Function).

  The browser can't call football-data.org directly — the API token must stay
  server-side and the API sends no CORS headers. This function sits in between:
  the app calls `/api/football?type=...`, we add the token, and we reshape the
  response into the small shapes the app already understands.

  Set the token in Vercel: Settings -> Environment Variables -> FOOTBALL_DATA_TOKEN
  (NOT prefixed with VITE_, so it is never shipped to the browser).
  Get a free token at https://www.football-data.org/client/register
*/

const BASE = "https://api.football-data.org/v4/competitions/PL";

// football-data names clubs "Arsenal FC", "Manchester United FC"; the app (and
// the restored data) use the short form. Drop a trailing " FC" so the two agree.
const clubName = (s) => String(s || "").replace(/\s+FC$/, "").trim();

const num = (v) => (Number.isFinite(+v) ? +v : 0);

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
    throw err;
  }
  return res.json();
}

export default async function handler(req, res) {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    res.status(500).json({ error: "FOOTBALL_DATA_TOKEN is not set on the server" });
    return;
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
      res.status(200).json({ gw: md, fixtures });
      return;
    }

    if (type === "current") {
      const data = await fdGet("", token);
      res.status(200).json({ currentMatchday: data.currentSeason?.currentMatchday || 1 });
      return;
    }

    res.status(400).json({ error: `unknown type: ${type}` });
  } catch (e) {
    res.status(e.status || 502).json({ error: String(e.message || e) });
  }
}
