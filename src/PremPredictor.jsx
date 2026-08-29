import { useState, useEffect, useRef, useCallback, Fragment } from "react";

/* ============================== storage layer ============================== */

const K = {
  league: "league",
  ledger: "ledger",
  epl: "epl",
  fixtures: (gw) => `fixtures:gw${gw}`,
  preds: (gw, pid) => `preds:gw${gw}:${pid}`,
  predsPrefix: (gw) => `preds:gw${gw}:`,
  gwOpen: (gw) => `open:gw${gw}`,
  adjust: (gw) => `adjust:gw${gw}`,
  backupAt: "backupAt",
  season: "season",
  sAns: (pid) => `season:ans:${pid}`,
  sAnsPrefix: "season:ans:",
};

/* season-long predictions: 11 questions set by the admin before matchweek 1 */
const BUILD = "2026-08-25e";
const QDEFAULT = 11;
const QLIMIT = 30;
const emptySeason = () => ({ questions: [], marks: {}, open: {}, updatedAt: 0 });

// the league deadline, unless the admin has opened or locked this player by hand
function seasonShutFor(season, pid, deadline, gw) {
  const o = season?.open?.[pid];
  if (o === true) return false;
  if (o === false) return true;
  return isShut(deadline) || (gw || 1) > 1;
}

// a tick from the admin is worth a point, banked in the week it was awarded
// "y" right, "n" wrong, nothing at all means not settled yet.
// older files stored {ok:true}, which still reads as right.
const verdictOf = (m) => (m ? (m.v === "n" ? "n" : (m.v === "y" || m.ok) ? "y" : null) : null);

function seasonTally(season) {
  const total = {};
  const wrong = {};
  const byGw = {};
  Object.entries(season?.marks || {}).forEach(([pid, qs]) => {
    Object.values(qs || {}).forEach((m) => {
      const v = verdictOf(m);
      if (!v) return;
      if (v === "n") { wrong[pid] = (wrong[pid] || 0) + 1; return; }
      const g = Math.max(1, Math.min(38, +m.gw || 1));
      total[pid] = (total[pid] || 0) + 1;
      byGw[g] = byGw[g] || {};
      byGw[g][pid] = (byGw[g][pid] || 0) + 1;
    });
  });
  return { total, wrong, byGw };
}

const hasStore = () => typeof window !== "undefined" && !!window.storage;

async function sGet(key) {
  if (!hasStore()) return null;
  try {
    const r = await window.storage.get(key, true);
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
}
async function sSet(key, val) {
  if (!hasStore()) return false;
  try {
    const r = await window.storage.set(key, JSON.stringify(val), true);
    return !!r;
  } catch {
    return false;
  }
}
async function sList(prefix) {
  if (!hasStore()) return [];
  try {
    const r = await window.storage.list(prefix, true);
    return r?.keys || [];
  } catch {
    return [];
  }
}
async function sDel(key) {
  if (!hasStore()) return;
  try {
    await window.storage.delete(key, true);
  } catch {
    /* already gone */
  }
}

/* Storage is rate limited, and a backup or a restore touches dozens of keys in a
   row. A refused call used to come back as a plain null or false and get thrown
   away in silence — which is how a whole league's season answers went missing:
   they are written last, so they were the first thing the limiter swallowed.
   These two wait and try again, and say plainly when they've given up. */
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

async function sGetSure(key, tries = 5) {
  for (let i = 0; i < tries; i++) {
    if (!hasStore()) return { ok: false, value: null };
    try {
      const r = await window.storage.get(key, true);
      return { ok: true, value: r ? JSON.parse(r.value) : null };
    } catch (e) {
      // a key that simply isn't there throws too, and no amount of waiting will
      // conjure it up — only a refusal is worth another go
      const why = String(e?.message || e).toLowerCase();
      const missing = why.includes("not found") || why.includes("no such") || why.includes("404");
      if (missing) return { ok: true, value: null };
      if (i === tries - 1) return { ok: false, value: null };
      await nap(250 * (i + 1) * (i + 1));
    }
  }
  return { ok: false, value: null };
}

async function sSetSure(key, val, tries = 5) {
  for (let i = 0; i < tries; i++) {
    if (await sSet(key, val)) return true;
    if (i < tries - 1) await nap(250 * (i + 1) * (i + 1));
  }
  return false;
}

/* personal storage — only used to clear stale sign-ins from older versions */
const WHOAMI = "whoami";
async function pDel(key) {
  if (!hasStore()) return;
  try {
    await window.storage.delete(key, false);
  } catch {
    /* already gone */
  }
}

/* ================================= helpers ================================= */

const uid = () => Math.random().toString(36).slice(2, 9);

function randomPin(taken = []) {
  let p;
  do {
    p = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  } while (taken.includes(p));
  return p;
}

/* =========================== backup and recovery ========================== */

async function collectLeague() {
  const league = await sGet(K.league);
  const ledger = await sGet(K.ledger);
  const season = await sGet(K.season);
  // the season answers come first now. they used to be read last, so on a big
  // league they were the rows still queueing when the rate limiter said no
  const keys = [
    ...(await sList(K.sAnsPrefix)),
    ...(await sList("preds:")),
    ...(await sList("fixtures:")),
    ...(await sList("open:")),
    ...(await sList("adjust:")),
  ];
  const data = {};
  const lost = [];
  for (const k of keys) {
    const { ok, value } = await sGetSure(k);
    if (!ok) { lost.push(k); continue; }
    if (value) data[k] = value;
  }
  // a file that quietly left someone's answers behind is worse than no file at
  // all — you don't find out until you restore it
  if (lost.length) throw new Error(`couldn't read ${lost.length} of ${keys.length} entries`);
  const answers = Object.keys(data).filter((k) => k.startsWith(K.sAnsPrefix)).length;
  return { app: "prem-predictor", v: 1, exportedAt: Date.now(), league, ledger, season, data, counts: { answers } };
}

async function restoreLeague(obj) {
  if (obj?.app !== "prem-predictor" || !obj?.league?.players) throw new Error("not a league file");
  const failed = [];
  const put = async (k, v) => { if (!(await sSetSure(k, v))) failed.push(k); };

  await put(K.league, obj.league);
  if (obj.ledger) await put(K.ledger, obj.ledger);
  if (obj.season) await put(K.season, obj.season);

  // season answers go in first, ahead of the fixture and prediction bulk. they
  // are small, there are only a handful, and they are the one thing nobody can
  // re-enter once the deadline has gone
  const entries = Object.entries(obj.data || {}).filter(([, v]) => v);
  const first = (k) => (k.startsWith(K.sAnsPrefix) ? 0 : k.startsWith("preds:") ? 1 : 2);
  entries.sort((a, b) => first(a[0]) - first(b[0]));
  for (const [k, v] of entries) await put(k, v);

  // read the answers back before claiming the restore worked
  const wanted = entries.filter(([k]) => k.startsWith(K.sAnsPrefix));
  let answers = 0;
  for (const [k] of wanted) {
    const { ok, value } = await sGetSure(k);
    if (ok && value?.playerId) answers++;
    else if (!failed.includes(k)) failed.push(k);
  }

  // a file taken before a fixture list changed can carry picks for matches that
  // no longer exist — drop them on the way in so the counts read true
  const weeks = {};
  Object.entries(obj.data || {}).forEach(([k, v]) => {
    const m = /^fixtures:gw(\d+)$/.exec(k);
    if (m && v?.fixtures) weeks[m[1]] = new Set(v.fixtures.map((f) => f.id));
  });
  for (const [k, v] of Object.entries(obj.data || {})) {
    const m = /^preds:gw(\d+):/.exec(k);
    if (!m || !v?.picks || !weeks[m[1]]) continue;
    const kept = {};
    Object.entries(v.picks).forEach(([fid, pick]) => { if (weeks[m[1]].has(fid)) kept[fid] = pick; });
    if (Object.keys(kept).length !== Object.keys(v.picks).length) {
      await sSetSure(k, { ...v, picks: kept, updatedAt: Date.now() });
    }
  }
  return { league: obj.league, failed, answers, expected: wanted.length };
}

function downloadJson(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// hand the file to whatever the phone can share with — Mail, WhatsApp, Files
async function shareJson(name, obj) {
  const text = JSON.stringify(obj, null, 2);
  try {
    const file = new File([text], name, { type: "application/json" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name, text: "Prem Predictor league backup" });
      return "shared";
    }
  } catch (e) {
    if (e?.name === "AbortError") return "cancelled";
  }
  downloadJson(name, obj);
  return "downloaded";
}

function readJsonFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { try { res(JSON.parse(r.result)); } catch { rej(new Error("unreadable")); } };
    r.onerror = () => rej(new Error("unreadable"));
    r.readAsText(file);
  });
}

const validPin = (p) => typeof p === "string" && /^\d{4}$/.test(p);

// leagues saved by an earlier version have scrambled PINs and no admin flag
const needsRepair = (l) =>
  !!l && Array.isArray(l.players) && l.players.length > 0 &&
  (!l.players.some((p) => p.admin) || l.players.some((p) => !validPin(p.pin)));

/* ============================ club colour badges ==========================
   Original marks, not official crests: each club's kit colours plus its
   abbreviation, so a fixture list is readable at a glance.
   Squad for 2026/27 — Coventry, Ipswich and Hull up; Wolves, Burnley and
   West Ham down. Anything unrecognised falls back to initials.            */

/* ================================ font sets =============================== */

const FONTS = [
  { id: "stadium", name: "Stadium", note: "Tall condensed caps — matchday board",
    d: "'Bebas Neue', 'Arial Narrow', Impact, sans-serif", b: "'Inter', system-ui, sans-serif", tr: ".06em" },
  { id: "terrace", name: "Terrace", note: "Heavy and loud, fanzine energy",
    d: "'Anton', 'Arial Black', Impact, sans-serif", b: "'Inter', system-ui, sans-serif", tr: ".02em" },
  { id: "fixture", name: "Fixture", note: "Clean grotesque, quietly modern",
    d: "'Space Grotesk', 'Helvetica Neue', system-ui, sans-serif", b: "'Space Grotesk', system-ui, sans-serif", tr: ".01em" },
  { id: "programme", name: "Programme", note: "Editorial serif, old match programme",
    d: "'Playfair Display', Georgia, 'Times New Roman', serif", b: "'Inter', system-ui, sans-serif", tr: "0" },
  { id: "coupon", name: "Coupon", note: "Narrow sans, pools-coupon print",
    d: "'Oswald', 'Arial Narrow', sans-serif", b: "'Inter', system-ui, sans-serif", tr: ".04em" },
];

const fontOf = (id) => FONTS.find((f) => f.id === id) || FONTS[0];

/* ================================= themes =================================
   Same layout, same type, same everything — only the palette moves. Each one
   sets the whole set of variables, so a theme can go dark without leaving
   white-on-white text anywhere: --ink is the page, --white/--dark/--mute are
   the text, --on is whatever sits on top of a solid accent.              */

const THEMES = [
  { id: "default", name: "Classic", note: "The usual purple — no holiday",
    swatch: ["#6D28D9", "#8B5CF6", "#C026D3", "#DB2777"],
    v: {} },

  { id: "halloween", name: "Halloween", note: "Pumpkin and dusk, lights off",
    swatch: ["#F97316", "#A855F7", "#84CC16", "#EF4444"],
    v: {
      "--ink": "#16121C", "--panel": "#1E1826", "--panel2": "#241D2E", "--line": "#3A2F49",
      "--yellow": "#F97316", "--cyan": "#A855F7", "--green": "#84CC16", "--red": "#EF4444", "--mag": "#C084FC",
      "--gold": "#FBBF24", "--white": "#F3EDF9", "--mute": "#A193B4", "--dark": "#FFFFFF",
      "--on": "#16121C", "--tint": "#2C2238", "--dline": "#6B2F3A",
    } },

  { id: "christmas", name: "Christmas", note: "Spruce, berry and candlelight",
    swatch: ["#B01D28", "#0F6B3D", "#C99A2E", "#8C1A24"],
    v: {
      "--ink": "#FFFBF5", "--panel": "#FFFFFF", "--panel2": "#F6EFE4", "--line": "#E2D3BE",
      "--yellow": "#B01D28", "--cyan": "#0F6B3D", "--green": "#15803D", "--red": "#C0392B", "--mag": "#8C1A24",
      "--gold": "#A67617", "--white": "#231A16", "--mute": "#6B5B4C", "--dark": "#14100E",
      "--on": "#FFFBF5", "--tint": "#F3E6D6", "--dline": "#E8C4C0",
    } },

  { id: "stpatrick", name: "St Patrick's", note: "Shamrock green and gold",
    swatch: ["#0E7A45", "#128F52", "#3FA34D", "#C9A227"],
    v: {
      "--ink": "#F7FBF5", "--panel": "#FFFFFF", "--panel2": "#E9F4E7", "--line": "#C7E0C3",
      "--yellow": "#0E7A45", "--cyan": "#128F52", "--green": "#3FA34D", "--red": "#C05621", "--mag": "#166534",
      "--gold": "#B08A1E", "--white": "#12241A", "--mute": "#4F6B57", "--dark": "#0B1A12",
      "--on": "#F7FBF5", "--tint": "#DDEFD9", "--dline": "#E4C7B0",
    } },

  { id: "easter", name: "Easter", note: "Pastels and spring light",
    swatch: ["#7C5BC7", "#3FA9B5", "#5FA95B", "#E4749A"],
    v: {
      "--ink": "#FDFBFF", "--panel": "#FFFFFF", "--panel2": "#F2ECFA", "--line": "#DED2EE",
      "--yellow": "#7C5BC7", "--cyan": "#3FA9B5", "--green": "#5FA95B", "--red": "#E4749A", "--mag": "#B06BC4",
      "--gold": "#C08A2E", "--white": "#26203A", "--mute": "#6C6386", "--dark": "#171331",
      "--on": "#FFFFFF", "--tint": "#EDE4F8", "--dline": "#F0CEDC",
    } },
];

const themeOf = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

/* the badge picks up the holiday too — rings, ground and a pair of ornaments
   tucked either side of the dog's head. Drawn after the dog so they sit in
   front, and inside the clip so anything wide tucks under the rim.        */
const CREST_SKIN = {
  default: { ring: "#FFC857", edge: "#4C1D95", disc: "#6D28D9", grass: "#2E9E5B", grass2: "#41B96D" },
  halloween: { ring: "#F97316", edge: "#150F1E", disc: "#3B2455", grass: "#245C33", grass2: "#317A44" },
  christmas: { ring: "#C99A2E", edge: "#7A1620", disc: "#0F5A34", grass: "#DCE8F2", grass2: "#FFFFFF" },
  stpatrick: { ring: "#C9A227", edge: "#083D24", disc: "#0E7A45", grass: "#2E9E5B", grass2: "#41B96D" },
  easter: { ring: "#E9C46A", edge: "#5B3FA0", disc: "#7C5BC7", grass: "#7FBF6B", grass2: "#9BD187" },
};

const SHIELD = "M12 1.5 21.5 4.4v10.4c0 5.2-4.4 8.4-9.5 9.7-5.1-1.3-9.5-4.5-9.5-9.7V4.4z";

const CLUBS = [
  { k: "ars", s: "ARS", p: "#EF0107", x: "#0A1B3D", t: "#FFFFFF", m: ["arsenal"] },
  { k: "avl", s: "AVL", p: "#670E36", x: "#95BFE5", t: "#FFFFFF", m: ["astonvilla", "villa"] },
  { k: "bou", s: "BOU", p: "#DA291C", x: "#111111", t: "#FFFFFF", m: ["bournemouth"] },
  { k: "bre", s: "BRE", p: "#E30613", x: "#FFFFFF", t: "#FFFFFF", m: ["brentford"] },
  { k: "bha", s: "BHA", p: "#0057B8", x: "#FFFFFF", t: "#FFFFFF", m: ["brighton"] },
  { k: "che", s: "CHE", p: "#034694", x: "#DBA111", t: "#FFFFFF", m: ["chelsea"] },
  { k: "cov", s: "COV", p: "#7ACFF0", x: "#1D2D5C", t: "#12263F", m: ["coventry"] },
  { k: "cry", s: "CRY", p: "#1B458F", x: "#C4122E", t: "#FFFFFF", m: ["crystalpalace", "palace"] },
  { k: "eve", s: "EVE", p: "#003399", x: "#FFFFFF", t: "#FFFFFF", m: ["everton"] },
  { k: "ful", s: "FUL", p: "#FFFFFF", x: "#111111", t: "#111111", m: ["fulham"] },
  { k: "hul", s: "HUL", p: "#F5A12D", x: "#111111", t: "#3A2200", m: ["hull"] },
  { k: "ips", s: "IPS", p: "#3A64A3", x: "#FFFFFF", t: "#FFFFFF", m: ["ipswich"] },
  { k: "lee", s: "LEE", p: "#FFFFFF", x: "#FFCD00", t: "#1D428A", m: ["leeds"] },
  { k: "liv", s: "LIV", p: "#C8102E", x: "#00B2A9", t: "#FFFFFF", m: ["liverpool"] },
  { k: "mci", s: "MCI", p: "#6CABDD", x: "#1C2C5B", t: "#0B1A38", m: ["manchestercity", "mancity", "mcfc"] },
  { k: "mun", s: "MUN", p: "#DA291C", x: "#FBE122", t: "#FFFFFF", m: ["manchesterunited", "manutd", "manunited", "mufc"] },
  { k: "new", s: "NEW", p: "#241F20", x: "#FFFFFF", t: "#FFFFFF", m: ["newcastle"] },
  { k: "nfo", s: "NFO", p: "#DD0000", x: "#FFFFFF", t: "#FFFFFF", m: ["nottingham", "forest"] },
  { k: "sun", s: "SUN", p: "#EB172B", x: "#FFFFFF", t: "#FFFFFF", m: ["sunderland"] },
  { k: "tot", s: "TOT", p: "#FFFFFF", x: "#132257", t: "#132257", m: ["tottenham", "spurs"] },
];

function clubOf(name) {
  const k = String(name || "").toLowerCase().replace(/[^a-z]/g, "");
  const hit = CLUBS.find((c) => c.m.some((m) => k.includes(m)));
  if (hit) return hit;
  const letters = String(name || "?").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();
  return { k: "gen" + k.slice(0, 6), s: letters || "?", p: "#EDE7FA", x: "#8B5CF6", t: "#4C1D95" };
}

function ClubBadge({ name }) {
  const c = clubOf(name);
  const id = "clip-" + c.k;
  return (
    <svg className="club" viewBox="0 0 24 26" role="img" aria-label={name}>
      <defs><clipPath id={id}><path d={SHIELD} /></clipPath></defs>
      <g clipPath={`url(#${id})`}>
        <rect x="0" y="0" width="24" height="26" fill={c.p} />
        <rect x="0" y="19" width="24" height="7" fill={c.x} />
      </g>
      <path d={SHIELD} fill="none" stroke="rgba(0,0,0,.28)" strokeWidth="1" />
      <text x="12" y="14.5" textAnchor="middle" fontSize="7.6" fontWeight="700"
        fill={c.t} fontFamily="ui-monospace, Menlo, monospace" letterSpacing=".2">{c.s}</text>
    </svg>
  );
}

function pointsFor(pick, fx) {
  if (!pick || pick.h == null || pick.a == null) return 0;
  if (fx.hs == null || fx.as == null) return 0;
  if (pick.h === fx.hs && pick.a === fx.as) return 5;
  const p = Math.sign(pick.h - pick.a);
  const a = Math.sign(fx.hs - fx.as);
  return p === a ? 2 : 0;
}

const koTime = (fx) => (fx.ko ? new Date(fx.ko).getTime() : 0);
// one deadline for the whole week: the first kick-off in it
const deadlineOf = (list) => {
  const times = (list || []).map(koTime).filter(Boolean);
  return times.length ? Math.min(...times) : 0;
};
const isShut = (deadline) => deadline > 0 && Date.now() >= deadline;

/* kick-offs are stored in UTC. the admin edits them in Irish time wherever he is,
   while everyone else sees them in their own zone. */
const HOME_TZ = "Europe/Dublin";

// how far a zone's wall clock sits from UTC at a given instant
function zoneOffset(date, tz) {
  const parts = {};
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).forEach((x) => { parts[x.type] = x.value; });
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - date.getTime();
}

function toHomeInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return new Date(d.getTime() + zoneOffset(d, HOME_TZ)).toISOString().slice(0, 16);
}

function fromHomeInput(val) {
  if (!val) return null;
  const wall = new Date(val + "Z");
  if (isNaN(wall)) return null;
  let utc = new Date(wall.getTime() - zoneOffset(wall, HOME_TZ));
  // a kick-off either side of a clock change needs the offset checked again
  const settled = zoneOffset(utc, HOME_TZ);
  if (settled !== zoneOffset(wall, HOME_TZ)) utc = new Date(wall.getTime() - settled);
  return utc.toISOString();
}

// what to call the zone this device is in, e.g. "IST · Europe/Dublin"
// on phones the keyboard covers the bottom of the page: measure it and get out of its way
function useKeyboardInset() {
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const root = document.documentElement;
    if (!vv) return;
    const apply = () => {
      const gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty("--kb", `${Math.round(gap)}px`);
      document.body.classList.toggle("kb-open", gap > 120);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--kb");
      document.body.classList.remove("kb-open");
    };
  }, []);
}

// bring whatever was tapped into the middle of what's left of the screen
const keepInView = (e) => {
  const el = e.target;
  window.setTimeout(() => {
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* older browsers */ }
  }, 320);
};

// hop to the next score box once a digit lands
const advanceScore = (el) => {
  const all = Array.from(el.closest(".wrap")?.querySelectorAll("input.num") || []);
  const next = all[all.indexOf(el) + 1];
  if (next) { next.focus(); try { next.select(); } catch { /* not selectable */ } }
};

function localZoneLabel() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const abbr = new Intl.DateTimeFormat("en-GB", { timeZoneName: "short" })
      .formatToParts(new Date()).find((x) => x.type === "timeZoneName")?.value;
    return [abbr, tz.replace(/_/g, " ")].filter(Boolean).join(" · ");
  } catch {
    return "";
  }
}

// the week's deadline, unless the admin has opened or locked this player by hand
function gwShutFor(open, pid, deadline) {
  const o = open?.[pid];
  if (o === true) return false;
  if (o === false) return true;
  return isShut(deadline);
}
const isFinished = (fx) => fx.status === "finished";
const isLive = (fx) =>
  fx.status === "live" ||
  (!isFinished(fx) && Date.now() >= koTime(fx) && Date.now() < koTime(fx) + 2.5 * 3600e3);

function fmtKo(fx) {
  if (!fx.ko) return "TBC";
  const d = new Date(fx.ko);
  return d
    .toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    .toUpperCase();
}

/* Pull the JSON out of a reply that may also contain prose, fences or a stray
   bracket picked up from a search result. Taking everything from the first
   bracket to the last one broke on any of those, so instead walk the text and
   collect every properly balanced block, then keep the biggest one that parses. */
function harvestJson(text, open) {
  if (!text) return null;
  const src = String(text).replace(/```[a-z]*/gi, "");
  const close = open === "[" ? "]" : "}";
  const found = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== open) continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close && --depth === 0) {
        try { found.push(JSON.parse(src.slice(i, j + 1))); } catch { /* not this one */ }
        i = j;
        break;
      }
    }
  }
  if (!found.length) return null;
  return found.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
}

const parseJsonBlock = (text) => harvestJson(text, "[");
const parseJsonObject = (text) => harvestJson(text, "{");

async function askClaude(prompt, maxTokens = 1000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  const data = await res.json();
  return (data.content || []).map((i) => (i.type === "text" ? i.text : "")).filter(Boolean).join("\n");
}

/* ================================== styles ================================= */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Anton&family=Oswald:wght@500;700&family=Space+Grotesk:wght@500;700&family=Playfair+Display:wght@700;900&family=Inter:wght@400;600;700&display=swap');
.pp * { box-sizing: border-box; }
.pp {
  --ink:#FFFFFF; --panel:#FFFFFF; --panel2:#F5F1FC; --line:#E3D9F6;
  --yellow:#6D28D9; --cyan:#8B5CF6; --green:#C026D3; --red:#DB2777; --mag:#7C3AED;
  --gold:#5B21B6; --white:#1E1B2E; --mute:#5A5270; --dark:#121019;
  --on:#FFFFFF; --tint:#F5F0FE; --dline:#F4CCE1;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --body: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --display: var(--body);
  --tr: .04em;
  background: var(--ink); color: var(--white); font-family: var(--body);
  min-height:100vh; padding-bottom:32px; -webkit-font-smoothing:antialiased;
}
.pp button { font-family: var(--mono); cursor:pointer; border:none; }
.pp button:focus-visible, .pp input:focus-visible { outline:2px solid var(--cyan); outline-offset:2px; }
.wrap { max-width: 760px; margin:0 auto; padding: 0 12px calc(24px + var(--kb, 0px)); }
/* the save bar rides above the keyboard so it's always reachable */
.savebar { position:sticky; bottom:calc(var(--kb, 0px) + 10px); z-index:15; background:var(--panel);
  border:1px solid var(--line); padding:10px 12px; box-shadow:0 8px 22px rgba(28,10,52,.14); }
/* with the keyboard up, hand the screen back to the fixtures */
body.kb-open .topstack { position:static; }
body.kb-open .tzbar { display:none; }
@media (max-width:560px) {
  .wrap { padding-bottom: calc(140px + var(--kb, 0px)); }
  .num { font-size:16px; }
  .inp { font-size:16px; }
}

/* header — sticky stack: identity, nav, deadline */
.topstack { position:sticky; top:0; z-index:20; background:var(--ink); border-bottom:1px solid var(--line); }
.tt-bar { background:var(--ink); }
.tt-bar-in { max-width:760px; margin:0 auto; padding:16px 12px 14px; display:flex; align-items:center; gap:12px; }
.crest { width:46px; height:46px; flex:0 0 46px; display:block; }
.tt-title { font-family:var(--display); font-weight:700; letter-spacing:var(--tr); font-size:30px; line-height:1.05;
  color:var(--yellow); text-transform:uppercase; }
.tt-meta { margin-left:auto; font-family:var(--mono); font-size:12px; letter-spacing:.1em; color:var(--dark); font-weight:700; text-transform:uppercase; }
.signout { background:transparent; color:var(--dark); font-size:12px; letter-spacing:.08em; text-transform:uppercase;
  border:1px solid var(--line); padding:9px 12px; border-radius:2px; font-weight:700; }
.signout:hover { color:var(--yellow); border-color:var(--yellow); }
@media (max-width:560px) {
  .tt-title { font-size:23px; }
  .crest { width:40px; height:40px; flex:0 0 40px; }
  .tt-meta { display:none; }
  .signout { font-size:11px; padding:8px 10px; }
}
.badge { font-family:var(--mono); font-size:9px; letter-spacing:.14em; font-weight:700; text-transform:uppercase;
  background:var(--yellow); color:var(--on); padding:2px 5px; margin-left:7px; vertical-align:middle; }

/* deadline across time zones */
.tzbar { max-width:760px; margin:0 auto; padding:10px 12px 12px; border-top:1px solid var(--line); background:var(--panel2); }
.tz-head { display:flex; align-items:baseline; gap:10px; margin-bottom:9px; }
.tz-lbl { font-family:var(--display); font-size:13px; letter-spacing:.12em; text-transform:uppercase; color:var(--dark); font-weight:700; }
.tz-left { margin-left:auto; font-family:var(--mono); font-size:22px; font-weight:700; color:var(--yellow); letter-spacing:-.01em; }
.tz-list { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
.tz { display:flex; align-items:center; justify-content:center; gap:8px; padding:7px 4px;
  background:var(--panel); border:1px solid var(--line); border-radius:3px; }
.flag { width:21px; height:14px; flex:0 0 21px; display:block; border-radius:1px; }
.tz-txt { display:flex; flex-direction:column; line-height:1.3; min-width:0; }
.tz b { font-family:var(--mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--dark); font-weight:700; }
.tz time { font-family:var(--mono); font-size:12px; font-weight:700; color:var(--dark); white-space:nowrap; }
.tzbar.soon .tz-left { color:var(--green); }
.tzbar.shut .tz-left { color:var(--red); font-size:16px; }
.tzbar.shut .tz time { color:var(--mute); }
@media (max-width:520px) {
  .tz { flex-direction:column; gap:4px; text-align:center; padding:7px 2px; }
  .tz time { font-size:10.5px; }
  .tz-left { font-size:19px; }
}

/* generic panel */
.panel { background:var(--panel); border:1px solid var(--line); margin:12px 0; }
.panel-hd { font-family:var(--display); text-transform:uppercase; letter-spacing:.16em; font-size:12px; font-weight:700;
  padding:9px 12px; color:var(--on); background:var(--cyan); display:flex; align-items:center; gap:8px; }
.panel-hd.y { background:var(--yellow); }
.panel-hd.g { background:var(--green); }
.panel-hd.m { background:var(--mag); }
.panel-bd { padding:12px; }
.hd-note { margin-left:auto; font-weight:700; font-size:11px; letter-spacing:.1em; }

/* fixtures */
.fx { display:grid; grid-template-columns: 1fr auto 1fr; align-items:center; gap:8px;
  padding:11px 12px; border-bottom:1px solid var(--line); }
.fx:last-child { border-bottom:none; }
.fx-team { font-size:14px; font-weight:600; line-height:1.25; display:flex; align-items:center; gap:8px; min-width:0; }
.fx-team.a { text-align:left; justify-content:flex-start; }
.fx-team.h { text-align:right; justify-content:flex-end; }
.fx-team span { min-width:0; }
.club { width:24px; height:26px; flex:0 0 24px; display:block; }
@media (max-width:420px) {
  .fx-team { font-size:13px; gap:6px; }
  .club { width:21px; height:23px; flex:0 0 21px; }
}
.fx-mid { display:flex; align-items:center; gap:6px; }
.fx-ko { grid-column:1 / -1; font-family:var(--mono); font-size:11px; letter-spacing:.1em; color:var(--dark); font-weight:700; text-align:center; }
.num { width:44px; height:42px; text-align:center; font-family:var(--mono); font-size:19px; font-weight:700;
  background:var(--panel2); color:var(--white); border:1px solid var(--line); border-radius:2px; }
.num::-webkit-outer-spin-button, .num::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
.num { -moz-appearance:textfield; }
.score { font-family:var(--mono); font-size:19px; font-weight:700; min-width:44px; height:42px; display:flex;
  align-items:center; justify-content:center; background:var(--panel2); border:1px solid var(--line); }
.dash { color:var(--mute); font-family:var(--mono); }

/* status chips */
.chip { font-family:var(--mono); font-size:9px; letter-spacing:.14em; padding:2px 5px; font-weight:700; text-transform:uppercase; }
.chip.live { background:var(--green); color:var(--on); }
.chip.ft { background:var(--line); color:var(--mute); }
.chip.lock { background:transparent; color:var(--mute); border:1px solid var(--line); }
.blink { animation: bl 1.4s steps(1,end) infinite; }
@keyframes bl { 0%,60%{opacity:1} 61%,100%{opacity:.25} }
@media (prefers-reduced-motion: reduce) { .blink { animation:none; } }

/* table */
.tbl { width:100%; border-collapse:collapse; font-family:var(--mono); }
.tbl th { font-family:var(--display); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); text-align:left;
  padding:8px 10px; border-bottom:1px solid var(--line); font-weight:700; }
.tbl td { padding:10px; border-bottom:1px solid var(--line); font-size:14px; }
.tbl tr:last-child td { border-bottom:none; }
.tbl .pos { color:var(--gold); width:34px; font-weight:700; }
.tbl .nm { font-family:var(--body); font-weight:600; font-size:14px; }
.tbl .num-c { text-align:right; font-weight:700; color:var(--gold); }
.tbl tr.me td { background:var(--panel2); }
.tbl tr.me .nm::after { content:" ◂ YOU"; font-family:var(--mono); font-size:9px; letter-spacing:.12em; color:var(--cyan); }
.tbl .gwpts { color:var(--green); }

/* buttons */
.btn { background:var(--panel2); color:var(--white); border:1px solid var(--line); padding:11px 14px;
  font-size:12px; letter-spacing:.12em; text-transform:uppercase; font-weight:700; border-radius:2px; }
.btn:hover { border-color:var(--cyan); color:var(--cyan); }
.btn:disabled { opacity:.4; cursor:not-allowed; }
.btn.pri { background:var(--yellow); color:var(--on); border-color:var(--yellow); }
.btn.pri:hover { background:var(--gold); color:var(--on); }
.btn.danger { color:var(--red); border-color:var(--dline); }
.btn.sm { padding:7px 10px; font-size:10px; }
.row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }

/* inputs */
.inp { background:var(--panel2); border:1px solid var(--line); color:var(--white); padding:11px 12px;
  font-size:14px; font-family:var(--body); border-radius:2px; width:100%; }
.lbl { font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); display:block; margin-bottom:6px; }

/* login */
.tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px,1fr)); gap:8px; }
.tile { background:var(--panel2); border:1px solid var(--line); padding:16px 12px; text-align:left; color:var(--white);
  font-family:var(--body); font-weight:600; font-size:15px; border-radius:2px; }
.tile:hover { border-color:var(--yellow); }
.tile.on { border-color:var(--yellow); background:var(--tint); box-shadow:inset 0 0 0 1px var(--yellow); }
.tile small { display:block; font-family:var(--mono); font-size:9px; letter-spacing:.14em; color:var(--mute); margin-top:5px; }
.pad { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; max-width:260px; margin:0 auto; }
.key { background:var(--panel2); border:1px solid var(--line); color:var(--white); font-size:22px; padding:16px 0; border-radius:2px; }
.key:hover { border-color:var(--cyan); }
.dots { display:flex; gap:12px; justify-content:center; margin:18px 0 20px; }
.dot { width:14px; height:14px; border:1px solid var(--line); background:transparent; }
.dot.on { background:var(--yellow); border-color:var(--yellow); }

/* nav — colour-tabbed bar under the title */
.fastext { border-top:1px solid var(--line); }
.fastext-in { max-width:760px; margin:0 auto; display:flex; }
.ft-btn { font-family:var(--display); flex:1; background:transparent; color:var(--dark); padding:12px 4px 11px; font-size:13px; letter-spacing:.1em;
  font-weight:700; text-transform:uppercase; border-bottom:4px solid transparent; }
.ft-btn[data-c="red"] { border-bottom-color:var(--red); }
.ft-btn[data-c="green"] { border-bottom-color:var(--green); }
.ft-btn[data-c="yellow"] { border-bottom-color:var(--yellow); }
.ft-btn[data-c="cyan"] { border-bottom-color:var(--cyan); }
.ft-btn[data-c="magenta"] { border-bottom-color:var(--mag); }
.ft-btn.on[data-c="red"] { color:var(--red); background:var(--tint); }
.ft-btn.on[data-c="green"] { color:var(--green); background:var(--tint); }
.ft-btn.on[data-c="yellow"] { color:var(--yellow); background:var(--tint); }
.ft-btn.on[data-c="cyan"] { color:var(--cyan); background:var(--tint); }
.ft-btn.on[data-c="magenta"] { color:var(--mag); background:var(--tint); }
@media (max-width:430px) { .ft-btn { font-size:11px; letter-spacing:.04em; padding:12px 2px 11px; } }

/* misc */
.mono { font-family:var(--mono); }
.mute { color:var(--mute); }
.small { font-size:12px; }
.empty { text-align:center; padding:28px 16px; color:var(--mute); font-size:13px; line-height:1.6; }
.toast { position:fixed; left:50%; transform:translateX(-50%); bottom:24px; background:var(--panel2);
  border:1px solid var(--cyan); color:var(--white); padding:10px 16px; font-family:var(--mono); font-size:11px;
  letter-spacing:.1em; text-transform:uppercase; z-index:40; max-width:92%; text-align:center; }
.toast.err { border-color:var(--red); color:var(--red); }
.picks { padding:8px 12px 12px; display:flex; flex-wrap:wrap; gap:6px; border-bottom:1px solid var(--line); }
.veil { padding:12px; border-bottom:1px solid var(--line); background:var(--panel2); display:flex; flex-direction:column; gap:4px; }
.veil b { font-family:var(--display); font-size:15px; letter-spacing:.04em; color:var(--dark); }
.veil span { font-size:12.5px; line-height:1.55; color:var(--mute); }
.pick.none { color:var(--mute); border-style:dashed; }
.pick.none b { color:var(--mute); }
.pick { font-family:var(--mono); font-size:11px; padding:3px 7px; background:var(--panel2); border:1px solid var(--line); }
.pick b { color:var(--white); font-weight:700; }
.pick.p5 { border-color:var(--green); color:var(--green); }
.pick.p2 { border-color:var(--cyan); color:var(--cyan); }
.pick.p0 { color:var(--mute); }
.divider { height:1px; background:var(--line); margin:14px 0; }
.filebtn { display:inline-block; background:var(--panel2); color:var(--white); border:1px solid var(--line);
  padding:11px 14px; font-family:var(--mono); font-size:12px; letter-spacing:.12em; text-transform:uppercase;
  font-weight:700; border-radius:2px; cursor:pointer; }
.filebtn:hover { border-color:var(--cyan); color:var(--cyan); }
.filebtn.sm { padding:7px 10px; font-size:10px; }
.filebtn input { display:none; }
.diag { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; padding:12px; background:var(--panel2);
  border:1px solid var(--line); border-radius:3px; }
.diag span { font-family:var(--mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--mute); align-self:center; }
.diag b { font-family:var(--mono); font-size:13px; color:var(--dark); font-weight:700; }
.fontlist { display:flex; flex-direction:column; }
.fontopt { display:block; width:100%; text-align:left; background:transparent; padding:12px;
  border-bottom:1px solid var(--line); }
.fontopt:last-child { border-bottom:none; }
.fontopt:hover { background:var(--panel2); }
.fontopt.on { background:var(--tint); box-shadow:inset 3px 0 0 var(--yellow); }
.fontopt-sample { display:block; font-size:26px; line-height:1.15; color:var(--white); font-weight:700; text-transform:uppercase; }
.fontopt.on .fontopt-sample { color:var(--yellow); }
.fontopt-meta { display:block; font-family:var(--mono); font-size:10px; letter-spacing:.1em;
  text-transform:uppercase; color:var(--mute); margin-top:5px; }
.skinrow { display:flex; align-items:center; gap:10px; }
.skinchips { display:flex; flex:0 0 auto; box-shadow:inset 0 0 0 1px var(--line); }
.skinchips s { display:block; width:20px; height:20px; }
.skinname { font-family:var(--display); font-size:19px; line-height:1.15; color:var(--white);
  font-weight:700; text-transform:uppercase; letter-spacing:var(--tr); }
.skinopt.on .skinname { color:var(--yellow); }
.deadline { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; padding:10px 12px;
  background:var(--panel2); border-bottom:1px solid var(--line); }
.deadline .dl-lbl { font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); }
.deadline .dl-when { font-family:var(--mono); font-size:12px; font-weight:700; color:var(--white); letter-spacing:.06em; }
.deadline .dl-left { margin-left:auto; font-family:var(--mono); font-size:14px; font-weight:700; color:var(--yellow); letter-spacing:.06em; }
.deadline.shut .dl-left { color:var(--red); }
.deadline.soon .dl-left { color:var(--green); }
.pin-code { font-family:var(--mono); font-size:16px; font-weight:700; letter-spacing:.28em; color:var(--gold);
  background:var(--panel2); border:1px solid var(--line); padding:4px 8px; display:inline-block; }

/* season-long predictions */
.qrow { display:flex; align-items:flex-start; gap:10px; padding:10px 0; border-bottom:1px solid var(--line); }
.qrow:last-child { border-bottom:none; }
.qn { font-family:var(--mono); font-size:11px; font-weight:700; color:var(--yellow);
  width:18px; flex:0 0 18px; padding-top:12px; }
.qrow .qtx { font-family:var(--body); font-size:13.5px; color:var(--white); flex:1 1 190px; padding-top:11px; line-height:1.4; }
.qrow .inp { flex:1 1 150px; min-width:0; }
.tbl td.ans { font-family:var(--body); font-size:13px; color:var(--white); word-break:break-word; }
.tbl td .yes { color:var(--green); font-weight:700; }
.marks { display:inline-flex; gap:6px; justify-content:flex-end; }
.marks button { width:30px; height:30px; border:1px solid var(--line); background:var(--panel2);
  font-size:14px; font-weight:700; line-height:1; color:var(--mute); cursor:pointer; }
.marks .tick.on { background:var(--green); border-color:var(--green); color:var(--on); }
.marks .cross.on { background:var(--red); border-color:var(--red); color:var(--on); }
.marks button:hover { border-color:var(--dark); }
.tbl td .no { color:var(--red); font-weight:700; }
.tbl td.num-c.bad { color:var(--red); }
.tick { display:inline-flex; align-items:center; justify-content:center; position:relative;
  width:30px; height:30px; border:1px solid var(--line); background:var(--panel2); cursor:pointer; }
.tick input { position:absolute; inset:0; opacity:0; cursor:pointer; margin:0; }
.tick span { font-size:15px; font-weight:700; color:var(--green); line-height:1; }
.tick:hover { border-color:var(--green); }
@media (max-width:520px) { .qrow { flex-wrap:wrap; } .qrow .qtx { padding-top:2px; flex-basis:100%; } .qn { padding-top:2px; } }

/* week-by-week grid — scrolls sideways as the season stretches out */
.gridscroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
/* This is deliberately not a <table>. A heading and the figures beneath it are
   the same grid track, so they cannot come apart — there is no colgroup to be
   overridden, no fixed layout to be reinterpreted, and no separate header row
   that a browser can measure on its own. Every cell is a child of one grid. */
.gwgrid { display:grid; width:max-content; min-width:100%; }
.gwgrid > div { display:flex; align-items:center; min-height:38px; padding:0 8px;
  white-space:nowrap; overflow:hidden; background:var(--panel);
  border-bottom:1px solid var(--line); }
.gwgrid .gh { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em;
  text-transform:uppercase; color:var(--mute); background:var(--panel2); }
.gwgrid .gnum { justify-content:flex-end; font-family:var(--mono); font-size:12.5px;
  font-variant-numeric:tabular-nums; padding:0 8px 0 4px; }
.gwgrid .gpos { position:sticky; left:0; z-index:2; justify-content:center; padding:0 2px; }
.gwgrid .gnm { position:sticky; left:34px; z-index:2; box-shadow:1px 0 0 var(--line); font-size:13.5px; }
.gwgrid .gnm span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gwgrid .gtot { position:sticky; right:0; z-index:2; box-shadow:-1px 0 0 var(--line);
  justify-content:flex-end; padding-right:12px; color:var(--yellow); font-weight:700; }
.gwgrid .gh.gtot { color:var(--mute); font-weight:400; }
.gwgrid .me { background:var(--tint); }
.gwgrid .live { color:var(--green); }
.gwgrid .foot { border-bottom:none; }

/* sub-tabs inside a screen */
.seg { display:flex; border:1px solid var(--line); border-radius:2px; overflow:hidden; margin:12px 0 0; background:var(--panel); }
.seg.inner { margin:10px 12px 0; }
.seg button { flex:1 1 0; min-width:0; background:transparent; color:var(--dark); font-size:11px; letter-spacing:.11em;
  text-transform:uppercase; font-weight:700; padding:11px 6px; border-right:1px solid var(--line);
  line-height:1.25; }
.seg button:last-child { border-right:none; }
.seg button:hover { color:var(--yellow); }
.seg button.on { background:var(--yellow); color:var(--on); }
@media (max-width:420px) { .seg button { font-size:10px; letter-spacing:.06em; padding:10px 3px; } }

/* position line chart */
.chartwrap { padding:12px 8px 4px; }
.chart { width:100%; height:auto; display:block; overflow:visible; }
.chart .grid { stroke:var(--line); stroke-width:1; }
.chart .axl { font-family:var(--mono); font-size:10px; fill:var(--mute); font-weight:700; letter-spacing:.06em; }
.chart .tag { font-family:var(--mono); font-weight:700; letter-spacing:.02em; pointer-events:none; }
.legend { display:flex; flex-wrap:wrap; gap:6px 12px; padding:4px 12px 14px; }
.leg { display:flex; align-items:center; gap:6px; font-family:var(--mono); font-size:10.5px;
  letter-spacing:.06em; color:var(--dark); text-transform:uppercase; font-weight:700; }
.leg i { width:14px; height:3px; display:block; border-radius:2px; flex:0 0 14px; }
.leg b { color:var(--white); }
.leg.self { color:var(--yellow); }
.leg.self b { color:var(--yellow); }

/* real Premier League tables */
.tbl .tm { display:flex; align-items:center; gap:8px; font-family:var(--body); font-weight:600; font-size:13.5px; min-width:0; }
.tbl .tm span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tbl td.n { text-align:right; font-family:var(--mono); font-size:13px; color:var(--dark); }
.tbl th.n { text-align:right; }
.tbl td.n.pts { color:var(--yellow); font-weight:700; }
.tbl tr.ucl td.pos { box-shadow:inset 3px 0 0 var(--cyan); }
.tbl tr.rel td.pos { box-shadow:inset 3px 0 0 var(--red); }
.tbl .club { width:20px; height:22px; flex:0 0 20px; }
.keyline { display:flex; gap:14px; flex-wrap:wrap; padding:10px 12px; border-top:1px solid var(--line);
  font-family:var(--mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--mute); }
.keyline s { text-decoration:none; display:inline-block; width:10px; height:10px; margin-right:5px; vertical-align:-1px; }
@media (max-width:560px) {
  .hide-sm { display:none; }
  .tbl td, .tbl th { padding:8px 6px; }
  .tbl .tm { font-size:12.5px; gap:6px; }
}
`;

/* ================================ tiny bits =============================== */

function Toast({ msg, kind }) {
  if (!msg) return null;
  return <div className={"toast" + (kind === "err" ? " err" : "")}>{msg}</div>;
}

function Panel({ title, tone = "", note, children }) {
  return (
    <div className="panel">
      <div className={"panel-hd " + tone}>
        {title}
        {note ? <span className="hd-note">{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

/* ================================== screens =============================== */

function Setup({ onDone, toast }) {
  const [adminName, setAdminName] = useState("David Earls");
  const [names, setNames] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);

  const go = async () => {
    const admin = adminName.trim();
    if (!admin) return toast("The admin needs a name", "err");
    const list = names.split("\n").map((n) => n.trim()).filter(Boolean).filter((n) => n.toLowerCase() !== admin.toLowerCase());
    if (!list.length) return toast("Add at least one other player", "err");
    setBusy(true);
    const taken = [];
    const mk = (n, isAdmin) => {
      const p = randomPin(taken);
      taken.push(p);
      return { id: uid(), name: n, pin: p, admin: isAdmin };
    };
    const league = {
      season: "2026/27",
      currentGw: 1,
      players: [mk(admin, true), ...list.map((n) => mk(n, false))],
      createdAt: Date.now(),
    };
    const ok = await sSet(K.league, league);
    setBusy(false);
    if (!ok) return toast("Couldn't save the league — try again", "err");
    setMade(league);
  };

  if (made) {
    return (
      <div className="wrap">
        <Panel title="Send these out" tone="y" note={`${made.players.length} players`}>
          <div className="panel-bd">
            <p className="small mute" style={{ margin: "0 0 4px", lineHeight: 1.6 }}>
              Each player needs their own PIN to sign in. Screenshot this or copy it now — the admin can see the list
              again later, nobody else can.
            </p>
          </div>
          <table className="tbl">
            <tbody>
              {made.players.map((p) => (
                <tr key={p.id}>
                  <td className="nm">{p.name}{p.admin ? <span className="badge">Admin</span> : null}</td>
                  <td style={{ textAlign: "right" }}><span className="pin-code">{p.pin}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="panel-bd">
            <button className="btn pri" onClick={() => onDone(made)}>Open the league</button>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="wrap">
      <Panel title="Start your league" tone="y">
        <div className="panel-bd">
          <p className="small mute" style={{ margin: "0 0 16px", lineHeight: 1.6 }}>
            The admin plays like everyone else, and also gets to fix scores and manage players. Everybody, admin
            included, gets a random 4-digit PIN — you'll see the full list on the next screen.
          </p>
          <label className="lbl">Admin</label>
          <input className="inp" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
          <div style={{ height: 12 }} />
          <label className="lbl">Everyone else — one name per line</label>
          <textarea className="inp" rows={6} value={names} onChange={(e) => setNames(e.target.value)}
            placeholder={"Aoife\nDeclan\nNiamh\nSeán"} />
          <div style={{ height: 16 }} />
          <button className="btn pri" onClick={go} disabled={busy}>{busy ? "Saving…" : "Create league"}</button>
          <div className="divider" />
          <p className="small mute" style={{ margin: "0 0 10px", lineHeight: 1.6 }}>
            Rebuilding after losing an app? Restore your downloaded league file instead and everything comes back.
          </p>
          <label className="filebtn sm">
            Restore from file
            <input type="file" accept="application/json,.json" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const restored = await restoreLeague(await readJsonFile(file));
                setMade(restored);
              } catch {
                toast("That file didn't restore", "err");
              }
            }} />
          </label>
        </div>
      </Panel>
    </div>
  );
}

/* ---- crest ornaments, drawn at the origin and dropped either side ---- */

const Pumpkin = () => (
  <g>
    <rect x="-.9" y="-7.4" width="1.8" height="2.6" rx=".6" fill="#4B7A2B" />
    <path d="M0-5.2c1.6-1.9 4-2.4 5.2-1.4" stroke="#5C9134" strokeWidth="1.1" fill="none" strokeLinecap="round" />
    <ellipse cx="0" cy="0" rx="6.2" ry="5.1" fill="#F97316" />
    <ellipse cx="-3.1" cy="0" rx="2.5" ry="5" fill="#E4670B" />
    <ellipse cx="3.1" cy="0" rx="2.5" ry="5" fill="#E4670B" />
    <path d="M-3.4-1.9l2.2 1.9-2.7.5zM3.4-1.9l-2.2 1.9 2.7.5z" fill="#2B1A05" />
    <path d="M-3 1.8h1.2l.6.9.7-.9h1l.7.9.7-.9h1.2l-.9 2.1h-4z" fill="#2B1A05" />
  </g>
);

const Spider = () => (
  <g>
    <path d="M0-13v6.6" stroke="#EFE6D2" strokeWidth=".7" fill="none" />
    <g stroke="#171021" strokeWidth="1.1" fill="none" strokeLinecap="round">
      <path d="M-2.6-.6-5.8-3-7 -.8M-2.8 1-6.2.6-7.4 2.9M-2.6 2.6-5.6 4.3-6.1 6.6" />
      <path d="M2.6-.6 5.8-3 7-.8M2.8 1 6.2.6 7.4 2.9M2.6 2.6 5.6 4.3 6.1 6.6" />
    </g>
    <ellipse cx="0" cy="1.8" rx="3.6" ry="4" fill="#171021" />
    <circle cx="0" cy="-3.4" r="2.6" fill="#241733" />
    <circle cx="-1.1" cy="-3.9" r=".85" fill="#F97316" />
    <circle cx="1.1" cy="-3.9" r=".85" fill="#F97316" />
  </g>
);

const Tree = () => (
  <g>
    <rect x="-1.1" y="4.2" width="2.2" height="2.8" fill="#6B4423" />
    <path d="M0-6.4 4.2-2h-8.4z" fill="#166534" />
    <path d="M0-3.2 5.2 1.2h-10.4z" fill="#15803D" />
    <path d="M0 0 6.2 4.6h-12.4z" fill="#166534" />
    <path d="M0-8.2.75-6.7l1.65.25-1.2 1.15.3 1.65L0-4.4l-1.5.75.3-1.65-1.2-1.15 1.65-.25z" fill="#FBBF24" />
    <circle cx="-2.4" cy="-.4" r=".8" fill="#E4574C" />
    <circle cx="2.6" cy="2.6" r=".8" fill="#EFE6D2" />
    <circle cx="1.9" cy="-1.8" r=".8" fill="#8FD3F4" />
  </g>
);

const Shamrock = () => (
  <g>
    <path d="M0 1.4c.4 2.6-.4 4.4-2.4 5.8" stroke="#3E9B4F" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    <g fill="#7BD389" stroke="#3E9B4F" strokeWidth=".7">
      <circle cx="0" cy="-3.6" r="3.1" />
      <circle cx="-3.5" cy="1.1" r="3.1" />
      <circle cx="3.5" cy="1.1" r="3.1" />
    </g>
  </g>
);

const Pint = () => (
  <g>
    <path d="M-3.4-6.2h6.8L2.6 5.4a1.4 1.4 0 0 1-1.4 1.3h-2.4a1.4 1.4 0 0 1-1.4-1.3z" fill="#251710" />
    <path d="M-3.4-6.2h6.8l-.28 3.9h-6.24z" fill="#F6EFDD" />
    <path d="M-3.5-6.5c.9-.9 2-.5 2.6-.1.7-.9 2.1-.9 2.9-.1.6-.5 1.6-.4 1.5.2z" fill="#FFFBF0" />
    <path d="M-1.9-1.4-2.5 4.6" stroke="#FFFFFF" strokeWidth=".8" opacity=".2" strokeLinecap="round" />
    <path d="M-3.4-6.2h6.8L2.6 5.4a1.4 1.4 0 0 1-1.4 1.3h-2.4a1.4 1.4 0 0 1-1.4-1.3z"
      fill="none" stroke="#F6EFDD" strokeWidth=".7" opacity=".55" />
  </g>
);

const Bunny = () => (
  <g>
    <ellipse cx="-2.1" cy="-4.4" rx="1.6" ry="4.1" fill="#FFFFFF" transform="rotate(-11 -2.1 -4.4)" />
    <ellipse cx="2.1" cy="-4.4" rx="1.6" ry="4.1" fill="#FFFFFF" transform="rotate(11 2.1 -4.4)" />
    <ellipse cx="-2.1" cy="-4.4" rx=".7" ry="2.6" fill="#F6BBD0" transform="rotate(-11 -2.1 -4.4)" />
    <ellipse cx="2.1" cy="-4.4" rx=".7" ry="2.6" fill="#F6BBD0" transform="rotate(11 2.1 -4.4)" />
    <circle cx="0" cy="1.6" r="4.3" fill="#FFFFFF" />
    <circle cx="-1.6" cy=".8" r=".75" fill="#2B2233" />
    <circle cx="1.6" cy=".8" r=".75" fill="#2B2233" />
    <path d="M0 2.2 -.9 3.1h1.8z" fill="#F6BBD0" />
    <path d="M-3.4 2.4h-2.2M-3.3 3.4h-2M3.4 2.4h2.2M3.3 3.4h2"
      stroke="#D9CFE4" strokeWidth=".6" strokeLinecap="round" />
  </g>
);

const Egg = () => (
  <g>
    <clipPath id="crest-egg"><path d="M0-6.6c3.1 0 5.3 3.9 5.3 7S2.9 6.6 0 6.6-5.3 3.5-5.3.4-3.1-6.6 0-6.6z" /></clipPath>
    <path d="M0-6.6c3.1 0 5.3 3.9 5.3 7S2.9 6.6 0 6.6-5.3 3.5-5.3.4-3.1-6.6 0-6.6z" fill="#F7C9DC" />
    <g clipPath="url(#crest-egg)">
      <path d="M-7-2.4h14v1.9h-14z" fill="#5BC0BE" />
      <path d="M-7 2.2h14v1.9h-14z" fill="#F9D97A" />
      <path d="M-7-6.6l2.2 2.2-2.2 2.2zM-2.6-6.6l2.2 2.2-2.2 2.2zM1.8-6.6l2.2 2.2-2.2 2.2zM6.2-6.6l2.2 2.2-2.2 2.2z" fill="#9C7BD6" />
    </g>
    <path d="M0-6.6c3.1 0 5.3 3.9 5.3 7S2.9 6.6 0 6.6-5.3 3.5-5.3.4-3.1-6.6 0-6.6z"
      fill="none" stroke="#D98BB0" strokeWidth=".7" />
  </g>
);

const TRIMS = {
  halloween: [Pumpkin, Spider],
  christmas: [Tree, Tree],
  stpatrick: [Shamrock, Pint],
  easter: [Bunny, Egg],
};

function Crest({ theme }) {
  const c = CREST_SKIN[theme] || CREST_SKIN.default;
  const [Left, Right] = TRIMS[theme] || [];
  return (
    <svg className="crest" viewBox="0 0 56 56" aria-hidden="true">
      <defs>
        <clipPath id="crest-inner"><circle cx="28" cy="28" r="23.5" /></clipPath>
      </defs>
      {/* badge rings */}
      <circle cx="28" cy="28" r="27" fill={c.ring} />
      <circle cx="28" cy="28" r="25" fill={c.edge} />
      <circle cx="28" cy="28" r="23.5" fill={c.disc} />
      <g clipPath="url(#crest-inner)">
        {/* pitch */}
        <path d="M0 38h56v18H0z" fill={c.grass} />
        <path d="M0 38h56v2.4H0z" fill={c.grass2} />
        {/* dog */}
        <g>
          <ellipse cx="18.4" cy="21.5" rx="4.2" ry="7.6" fill="#8B5A2B" transform="rotate(-20 18.4 21.5)" />
          <ellipse cx="37.6" cy="21.5" rx="4.2" ry="7.6" fill="#8B5A2B" transform="rotate(20 37.6 21.5)" />
          <ellipse cx="28" cy="23.5" rx="10.2" ry="10.6" fill="#F3DDB4" />
          <ellipse cx="28" cy="28" rx="5.8" ry="4.4" fill="#FFF4E2" />
          <ellipse cx="28" cy="25.6" rx="2.1" ry="1.6" fill="#2B2233" />
          <path d="M28 27.2v1.6M28 28.8c-1.2 1.2-2.7 1-3.4 0M28 28.8c1.2 1.2 2.7 1 3.4 0"
            stroke="#2B2233" strokeWidth="1.1" fill="none" strokeLinecap="round" />
          <path d="M26.4 31.4c1 1.4 3.1 1.4 4.1 0z" fill="#FF7BA8" />
          <circle cx="23.6" cy="21.6" r="1.5" fill="#2B2233" />
          <circle cx="32.4" cy="21.6" r="1.5" fill="#2B2233" />
          <circle cx="24.1" cy="21.1" r=".5" fill="#FFFFFF" />
          <circle cx="32.9" cy="21.1" r=".5" fill="#FFFFFF" />
        </g>
        {/* holiday trim, either side of the head */}
        {Left ? <g transform="translate(12.5 17) scale(.72)"><Left /></g> : null}
        {Right ? (
          <g transform={`translate(43.5 17) scale(${theme === "christmas" ? "-.72,.72" : ".72"})`}><Right /></g>
        ) : null}
        {/* football */}
        <g transform="translate(15.5 42)">
          <circle r="7" fill="#FFFFFF" stroke="#2B2233" strokeWidth="1.1" />
          <path d="M0-4l3.3 2.4-1.3 3.9h-4l-1.3-3.9z" fill="#2B2233" />
          <path d="M0-4v-3M3.3-1.6l2.9-.9M2-2.3l2.5 2.6M-2-2.3l-2.5 2.6M-3.3-1.6l-2.9-.9"
            stroke="#2B2233" strokeWidth="1" strokeLinecap="round" />
        </g>
        {/* trophy */}
        <g transform="translate(40.5 41)" fill={c.ring}>
          <path d="M-4-5h8v4.2A4 4 0 0 1-4-.8z" />
          <path d="M-4-4.2c-2.2 0-3.4 1-3.4 2.5S-6.2.9-4 .7v-1.6c-1.3.1-1.9-.4-1.9-1.2s.6-1.1 1.9-1.1z" />
          <path d="M4-4.2c2.2 0 3.4 1 3.4 2.5S6.2.9 4 .7v-1.6c1.3.1 1.9-.4 1.9-1.2s-.6-1.1-1.9-1.1z" />
          <rect x="-.9" y="3" width="1.8" height="2.6" />
          <rect x="-3.4" y="5.4" width="6.8" height="1.9" rx=".6" />
          <path d="M0-3.4l.85 1.75 1.9.25-1.4 1.35.35 1.9L0 1l-1.7.85.35-1.9-1.4-1.35 1.9-.25z" fill="#FFF3C4" opacity=".9" />
        </g>
      </g>
      <circle cx="28" cy="28" r="23.5" fill="none" stroke={c.edge} strokeWidth="1.2" />
    </svg>
  );
}

function Flag({ code }) {
  if (code === "ie") {
    return (
      <svg className="flag" viewBox="0 0 21 14" aria-hidden="true">
        <rect width="7" height="14" fill="#169B62" /><rect x="7" width="7" height="14" fill="#FFFFFF" />
        <rect x="14" width="7" height="14" fill="#FF883E" />
        <rect x=".4" y=".4" width="20.2" height="13.2" fill="none" stroke="rgba(0,0,0,.22)" strokeWidth=".8" />
      </svg>
    );
  }
  if (code === "us") {
    return (
      <svg className="flag" viewBox="0 0 21 14" aria-hidden="true">
        <rect width="21" height="14" fill="#FFFFFF" />
        {[0, 2, 4, 6, 8, 10, 12].map((y) => <rect key={y} y={y} width="21" height="1.08" fill="#B22234" />)}
        <rect width="9" height="7.5" fill="#3C3B6E" />
        {[1.6, 4, 6.4].map((y) => [1.6, 3.8, 6, 7.6].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r=".55" fill="#FFFFFF" />))}
        <rect x=".4" y=".4" width="20.2" height="13.2" fill="none" stroke="rgba(0,0,0,.22)" strokeWidth=".8" />
      </svg>
    );
  }
  return (
    <svg className="flag" viewBox="0 0 21 14" aria-hidden="true">
      <rect width="21" height="14" fill="#00247D" />
      <rect width="9" height="7" fill="#00247D" />
      <path d="M0 0l9 7M9 0L0 7" stroke="#FFFFFF" strokeWidth="1.4" />
      <path d="M4.5 0v7M0 3.5h9" stroke="#FFFFFF" strokeWidth="2.2" />
      <path d="M4.5 0v7M0 3.5h9" stroke="#CF142B" strokeWidth="1.1" />
      <path d="M4.6 8.4l.55 1.6h1.7l-1.4 1 .55 1.6-1.4-1-1.4 1 .55-1.6-1.4-1h1.7z" fill="#FFFFFF" />
      <circle cx="14.5" cy="3.4" r=".8" fill="#FFFFFF" /><circle cx="17.6" cy="6.2" r=".8" fill="#FFFFFF" />
      <circle cx="14.5" cy="9.6" r=".8" fill="#FFFFFF" /><circle cx="12.2" cy="6.6" r=".7" fill="#FFFFFF" />
      <circle cx="16.2" cy="10.9" r=".55" fill="#FFFFFF" />
      <rect x=".4" y=".4" width="20.2" height="13.2" fill="none" stroke="rgba(0,0,0,.22)" strokeWidth=".8" />
    </svg>
  );
}

const ZONES = [
  { label: "Galway", tz: "Europe/Dublin", flag: "ie" },
  { label: "Philadelphia", tz: "America/New_York", flag: "us" },
  { label: "Sydney", tz: "Australia/Sydney", flag: "au" },
];

function countdownText(ms) {
  const d = Math.floor(ms / 86400e3);
  const h = Math.floor(ms / 3600e3) % 24;
  const m = Math.floor(ms / 60e3) % 60;
  const s = Math.floor(ms / 1000) % 60;
  if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, "0")}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function TzBar({ at }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!at) return null;
  const ms = at - now;
  const shut = ms <= 0;
  return (
    <div className={"tzbar" + (shut ? " shut" : ms < 3600e3 ? " soon" : "")}>
      <div className="tz-head">
        <span className="tz-lbl">{shut ? "Predictions closed" : "Predictions close in"}</span>
        <span className="tz-left">{shut ? "Locked" : countdownText(ms)}</span>
      </div>
      <div className="tz-list">
        {ZONES.map((z) => (
          <div className="tz" key={z.tz}>
            <Flag code={z.flag} />
            <div className="tz-txt">
              <b>{z.label}</b>
              <time>
                {new Date(at).toLocaleString("en-GB", {
                  timeZone: z.tz, weekday: "short", day: "numeric", month: "short",
                  hour: "2-digit", minute: "2-digit", hour12: false,
                })}
              </time>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Repair({ league, onDone, toast }) {
  const [done, setDone] = useState(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      const taken = [];
      const roster = [...league.players];
      // David Earls runs the league — add him if this roster predates that
      let adminIdx = roster.findIndex((p) => p.name.trim().toLowerCase() === "david earls");
      if (adminIdx === -1) adminIdx = roster.findIndex((p) => /david|earls/i.test(p.name));
      if (adminIdx === -1) {
        roster.unshift({ id: uid(), name: "David Earls", pin: null, admin: true });
        adminIdx = 0;
      }
      const players = roster.map((p, i) => {
        const pin = randomPin(taken);
        taken.push(pin);
        return { ...p, pin, admin: i === adminIdx };
      });
      const next = { ...league, players };
      if (!(await sSet(K.league, next))) return toast("Couldn't update the league — reopen to retry", "err");
      setDone(next);
    })();
  }, [league, toast]);

  if (!done) {
    return (
      <div className="wrap">
        <Panel title="Updating the league" tone="y">
          <div className="empty">Issuing new PINs…</div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="wrap">
      <Panel title="New PINs" tone="y" note={`${done.players.length} players`}>
        <div className="panel-bd">
          <p className="small mute" style={{ margin: 0, lineHeight: 1.6 }}>
            The old PINs stopped working when sign-in changed, so everyone has a new one. Send these out — predictions
            and points from before are all still here.
          </p>
        </div>
        <table className="tbl">
          <tbody>
            {done.players.map((p) => (
              <tr key={p.id}>
                <td className="nm">{p.name}{p.admin ? <span className="badge">Admin</span> : null}</td>
                <td style={{ textAlign: "right" }}><span className="pin-code">{p.pin}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="panel-bd">
          <button className="btn pri" onClick={() => onDone(done)}>Sign in</button>
        </div>
      </Panel>
    </div>
  );
}

function Login({ league, onIn, toast }) {
  const [who, setWho] = useState(null);
  const [pin, setPin] = useState("");
  const [mode, setMode] = useState(null);
  const [found, setFound] = useState(null);
  const reset = () => { setWho(null); setPin(""); };

  const recover = async (file) => {
    if (!file) return;
    try {
      const obj = await readJsonFile(file);
      if (obj?.app !== "prem-predictor" || !obj?.league?.players) return toast("That isn't a league file", "err");
      if (obj.league.createdAt !== league.createdAt) return toast("That file is from a different league", "err");
      const admin = obj.league.players.find((p) => p.admin);
      if (!admin) return toast("No admin in that file", "err");
      const live = league.players.find((p) => p.id === admin.id);
      if (!live) return toast("That admin is no longer in the league", "err");
      setFound({ id: live.id, name: live.name, pin: live.pin });
    } catch {
      toast("Couldn't read that file", "err");
    }
  };

  const submit = useCallback(async (value) => {
    const typed = String(value ?? "").trim();
    const stored = String(who?.pin ?? "").trim();
    if (typed === stored && stored !== "") {
      return onIn({ admin: !!who.admin, id: who.id, name: who.name });
    }
    setPin("");
    toast("Wrong PIN");
  }, [who, onIn, toast]);

  useEffect(() => {
    if (pin.length === 4) { const v = pin; setTimeout(() => submit(v), 120); }
  }, [pin, submit]);

  if (mode === "recover") {
    return (
      <div className="wrap">
        <Panel title="Admin recovery" tone="y">
          <div className="panel-bd">
            {found ? (
              <>
                <p className="small mute" style={{ margin: "0 0 12px", lineHeight: 1.6 }}>
                  Checked out. This is the current admin PIN — the file only proves who you are, it doesn't change anything.
                </p>
                <div className="row" style={{ alignItems: "center", marginBottom: 14 }}>
                  <span className="nm" style={{ fontWeight: 700 }}>{found.name}</span>
                  <span className="pin-code">{found.pin}</span>
                </div>
                <button className="btn pri" onClick={() => onIn({ admin: true, id: found.id, name: found.name })}>
                  Sign in as {found.name}
                </button>
              </>
            ) : (
              <>
                <p className="small mute" style={{ margin: "0 0 12px", lineHeight: 1.6 }}>
                  Lost the admin PIN? Choose the league file you downloaded from the Admin tab and it'll show you the
                  current one. This only works for the admin — everyone else asks the admin for theirs.
                </p>
                <label className="filebtn">
                  Choose league file
                  <input type="file" accept="application/json,.json" onChange={(e) => recover(e.target.files?.[0])} />
                </label>
              </>
            )}
            <div className="divider" />
            <button className="btn sm" onClick={() => { setMode(null); setFound(null); }}>Back to sign in</button>
          </div>
        </Panel>
      </div>
    );
  }

  if (!who) {
    return (
      <div className="wrap">
        <Panel title="Who's playing?" tone="y" note={league.season}>
          <div className="panel-bd">
            <div className="tiles">
              {league.players.map((p) => (
                <button key={p.id} className="tile" onClick={() => setWho(p)}>
                  {p.name}
                  <small>{p.admin ? "Admin · Enter PIN" : "Enter PIN"}</small>
                </button>
              ))}
            </div>
            <p className="small mute" style={{ margin: "14px 0 0", lineHeight: 1.6 }}>
              Your PIN is needed every time you sign in, on any device. Lost it? The admin can issue you a new one.
            </p>
            <div className="divider" />
            <button className="btn sm" onClick={() => setMode("recover")}>Admin recovery — use league file</button>
          </div>
        </Panel>
      </div>
    );
  }

  const label = `Hi ${who.name} — your PIN`;

  return (
    <div className="wrap">
      <Panel title={who.name} tone="y">
        <div className="panel-bd">
          <p className="lbl" style={{ textAlign: "center" }}>{label}</p>
          <div className="dots">
            {[0, 1, 2, 3].map((i) => <div key={i} className={"dot" + (pin.length > i ? " on" : "")} />)}
          </div>
          <div className="pad">
            {["1","2","3","4","5","6","7","8","9"].map((n) => (
              <button key={n} className="key" onClick={() => setPin((p) => (p + n).slice(0, 4))}>{n}</button>
            ))}
            <button className="key" style={{ fontSize: 11, letterSpacing: ".1em" }} onClick={reset}>BACK</button>
            <button className="key" onClick={() => setPin((p) => (p + "0").slice(0, 4))}>0</button>
            <button className="key" style={{ fontSize: 18 }} onClick={() => setPin((p) => p.slice(0, -1))}>⌫</button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------- predictions ------------------------------ */

function Predict({ league, gw, fixtures, myPicks, onSave, toast, me, gwOpen }) {
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const seeded = useRef("");

  // scores refreshing in the background used to reset this form mid-entry —
  // anything typed and not yet saved now survives the refresh
  useEffect(() => {
    const list = fixtures?.fixtures || [];
    const key = `${gw}:${list.map((f) => f.id).join("|")}`;
    setDraft((prev) => {
      const filled = (v) => v !== undefined && v !== null && v !== "";
      const d = {};
      list.forEach((f) => {
        const mine = seeded.current === key ? prev[f.id] : null;
        const saved = myPicks?.[f.id];
        d[f.id] = mine && (filled(mine.h) || filled(mine.a))
          ? mine
          : { h: saved ? String(saved.h) : "", a: saved ? String(saved.a) : "" };
      });
      return d;
    });
    seeded.current = key;
  }, [fixtures, myPicks, gw]);

  const set = (id, side, v, el) => {
    const clean = v.replace(/\D/g, "").slice(0, 2);
    setDraft((d) => ({ ...d, [id]: { ...d[id], [side]: clean } }));
    if (el && clean.length === 1) advanceScore(el);
  };

  const save = async () => {
    const deadline = deadlineOf(fixtures?.fixtures);
    if (isShut(deadline)) return toast("Predictions closed at kick-off", "err");
    const picks = { ...(myPicks || {}) };
    let n = 0;
    (fixtures?.fixtures || []).forEach((f) => {
      const d = draft[f.id];
      if (d && d.h !== "" && d.a !== "") { picks[f.id] = { h: +d.h, a: +d.a }; n++; }
    });
    if (!n) return toast("Put a score on at least one game", "err");
    setBusy(true);
    const ok = await onSave(picks);
    setBusy(false);
    toast(ok ? `${n} prediction${n > 1 ? "s" : ""} saved` : "Couldn't save — try again", ok ? "" : "err");
  };

  if (!fixtures?.fixtures?.length) {
    return (
      <div className="wrap">
        <Panel title={`Matchweek ${gw}`} tone="y">
          <div className="empty">No fixtures yet for this matchweek.<br />They load automatically — give it a moment, or sync from the Admin tab.</div>
        </Panel>
      </div>
    );
  }

  const deadline = deadlineOf(fixtures.fixtures);
  const shut = gwShutFor(gwOpen, me.id, deadline);
  const reopened = isShut(deadline) && !shut;
  const missing = fixtures.fixtures.filter((f) => {
    const d = draft[f.id];
    return !d || d.h === "" || d.a === "";
  }).length;

  return (
    <div className="wrap">
      <Panel title={`Matchweek ${gw} — your picks`} tone="y"
        note={shut ? "Closed" : reopened ? "Opened for you" : `${missing} to fill`}>
        {fixtures.fixtures.map((f) => {
          const mine = myPicks?.[f.id];
          return (
            <div className="fx" key={f.id}>
              <div className="fx-team h"><span>{f.h}</span><ClubBadge name={f.h} /></div>
              <div className="fx-mid">
                {shut ? (
                  <>
                    <div className="score">{mine ? mine.h : "–"}</div>
                    <span className="dash">:</span>
                    <div className="score">{mine ? mine.a : "–"}</div>
                  </>
                ) : (
                  <>
                    <input className="num" inputMode="numeric" enterKeyHint="next" value={draft[f.id]?.h ?? ""}
                      onFocus={keepInView} onChange={(e) => set(f.id, "h", e.target.value, e.target)}
                      aria-label={`${f.h} goals`} />
                    <span className="dash">:</span>
                    <input className="num" inputMode="numeric" enterKeyHint="next" value={draft[f.id]?.a ?? ""}
                      onFocus={keepInView} onChange={(e) => set(f.id, "a", e.target.value, e.target)}
                      aria-label={`${f.a} goals`} />
                  </>
                )}
              </div>
              <div className="fx-team a"><ClubBadge name={f.a} /><span>{f.a}</span></div>
              <div className="fx-ko">{fmtKo(f)}</div>
            </div>
          );
        })}
      </Panel>
      {!shut && (
        <div className="row savebar" style={{ margin: "0 0 20px" }}>
          <button className="btn pri" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save predictions"}</button>
          <span className="mono small mute">
            {reopened
              ? "The admin has opened this week back up for you"
              : "5 pts exact score · 2 pts right result · edit until the deadline"}
          </span>
        </div>
      )}
      {shut && (
        <p className="mono small mute" style={{ textAlign: "center" }}>
          {myPicks ? `Your picks are in, ${me.name}.` : `You missed this one, ${me.name}.`}
        </p>
      )}
      <p className="mono small mute" style={{ textAlign: "center", margin: "10px 0 20px" }}>
        Kick-offs in your own time · {localZoneLabel()}
      </p>
    </div>
  );
}

/* --------------------------------- scores --------------------------------- */

function Scores({ league, gw, fixtures, allPreds, onRefresh, refreshing }) {
  if (!fixtures?.fixtures?.length) {
    return (
      <div className="wrap">
        <Panel title={`Matchweek ${gw}`} tone="g">
          <div className="empty">No fixtures loaded for this matchweek yet.</div>
        </Panel>
      </div>
    );
  }
  const deadline = deadlineOf(fixtures.fixtures);
  const revealed = isShut(deadline);
  const inCount = league.players.filter((p) => allPreds[p.id] && Object.keys(allPreds[p.id]).length).length;

  return (
    <div className="wrap">
      <Panel
        title={`Matchweek ${gw} — scores`}
        tone="g"
        note={fixtures.updatedAt ? `Updated ${new Date(fixtures.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}
      >
        {!revealed && (
          <div className="veil">
            <b>Everyone's picks are sealed until the deadline.</b>
            <span>{inCount} of {league.players.length} {inCount === 1 ? "player has" : "players have"} put predictions in. They all appear here the moment the first game kicks off.</span>
          </div>
        )}
        {fixtures.fixtures.map((f) => {
          const rows = revealed
            ? league.players
                .map((p) => ({ pid: p.id, name: p.name, pick: allPreds[p.id]?.[f.id] }))
                .sort((a, b) => pointsFor(b.pick, f) - pointsFor(a.pick, f) || a.name.localeCompare(b.name))
            : [];
          return (
            <div key={f.id}>
              <div className="fx">
                <div className="fx-team h"><span>{f.h}</span><ClubBadge name={f.h} /></div>
                <div className="fx-mid">
                  <div className="score">{f.hs ?? "–"}</div>
                  <span className="dash">:</span>
                  <div className="score">{f.as ?? "–"}</div>
                </div>
                <div className="fx-team a"><ClubBadge name={f.a} /><span>{f.a}</span></div>
                <div className="fx-ko">
                  {isLive(f) ? <span className="chip live blink">Live</span>
                    : isFinished(f) ? <span className="chip ft">Full time</span>
                    : fmtKo(f)}
                </div>
              </div>
              {rows.length > 0 && (
                <div className="picks">
                  {rows.map((r) => {
                    if (!r.pick) return <span key={r.pid} className="pick none">{r.name} <b>—</b></span>;
                    const pts = pointsFor(r.pick, f);
                    return (
                      <span key={r.pid} className={"pick p" + pts}>
                        {r.name} <b>{r.pick.h}-{r.pick.a}</b>{f.hs != null ? ` +${pts}` : ""}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </Panel>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn sm" onClick={onRefresh} disabled={refreshing}>{refreshing ? "Checking…" : "Refresh scores"}</button>
        <span className="mono small mute">Live games refresh on their own every 3 min</span>
      </div>
      <p className="mono small mute" style={{ textAlign: "center", margin: "0 0 20px" }}>
        Kick-offs in your own time · {localZoneLabel()}
      </p>
    </div>
  );
}

/* ---------------------------------- table --------------------------------- */

const LINE_COLS = [
  "#6D28D9", "#DB2777", "#0891B2", "#C026D3", "#EA580C",
  "#059669", "#4338CA", "#B45309", "#BE123C", "#0F766E",
];

// running position after every matchweek that has been scored
function positionSeries(league, ledger, bonusByGw = {}, onlyDone = false, currentGw = 0) {
  const byGw = ledger?.byGw || {};
  const done = ledger?.done || {};
  // a week counts once it's flagged complete, or once the league has moved past it —
  // ledgers written before completion was tracked have no flags at all
  const finished = (n) => done[n] === true || (currentGw > 0 && n < currentGw);
  const players = league?.players || [];
  const scored = [...new Set([...Object.keys(byGw), ...Object.keys(bonusByGw)])]
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 1 && (currentGw <= 0 || n <= currentGw))
    // a week only earns a point on the chart once every game in it has finished
    .filter((n) => !onlyDone || finished(n))
    .sort((a, b) => a - b);
  if (!scored.length) return { gws: [], steps: [] };

  // run straight through from the first scored week to the latest, so a week
  // nobody logged doesn't leave a hole — positions simply carry forward
  const first = scored[0];
  const last = scored[scored.length - 1];
  const gws = [];
  for (let g = first; g <= last; g++) gws.push(g);

  const running = {};
  players.forEach((p) => { running[p.id] = 0; });
  const steps = gws.map((g) => {
    const week = byGw[g] || {};
    const extra = bonusByGw[g] || {};
    players.forEach((p) => { running[p.id] += (week[p.id] || 0) + (extra[p.id] || 0); });
    const totals = { ...running };
    const pos = {};
    players.forEach((p) => {
      pos[p.id] = 1 + players.filter((q) => (totals[q.id] || 0) > (totals[p.id] || 0)).length;
    });
    return { gw: g, pos, totals };
  });
  return { gws, steps };
}

// short tags for the chart — two initials, stretched if two players clash
function chartTags(players) {
  const base = players.map((p) => {
    const clean = String(p.name || "").trim();
    const words = clean.split(/\s+/).filter(Boolean);
    const two = words.length > 1 ? words[0][0] + words[1][0] : clean.slice(0, 2);
    return (two || "?").toUpperCase();
  });
  const seen = {};
  base.forEach((b) => { seen[b] = (seen[b] || 0) + 1; });
  const used = {};
  return players.map((p, i) => {
    let tag = base[i];
    if (seen[tag] > 1) tag = String(p.name || "").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || tag;
    while (used[tag]) tag = tag.slice(0, 2) + ((+tag.slice(2) || 1) + 1);
    used[tag] = true;
    return tag;
  });
}

function PositionChart({ league, ledger, me, gw, settled, bonusByGw, emptyNote, onlyDone, mode = "points" }) {
  const players = league?.players || [];
  const { gws, steps } = positionSeries(league, ledger, bonusByGw, onlyDone, gw);
  const n = players.length;
  const byPoints = mode === "points";

  if (!gws.length || n < 2) {
    return (
      <div className="empty">
        {emptyNote || (
          <>
            The position chart draws itself once a matchweek has been scored.<br />
            Every player's line shows where they sat in the league overall after each week.
          </>
        )}
      </div>
    );
  }

  const tags = chartTags(players);
  const W = 700;
  const H = Math.max(240, 74 + n * 26);
  const L = 42, R = 18, T = 20, B = 32;
  const iw = W - L - R, ih = H - T - B;
  const xAt = (i) => (gws.length === 1 ? L + iw / 2 : L + (i * iw) / (gws.length - 1));

  // running totals: highest tally at the top, with a round number for the ceiling
  const peak = Math.max(1, ...steps.flatMap((st) => players.map((p) => st.totals[p.id] || 0)));
  const capStep = peak <= 20 ? 5 : peak <= 60 ? 10 : peak <= 150 ? 25 : 50;
  const cap = Math.ceil(peak / capStep) * capStep;
  const ticks = byPoints
    ? Array.from({ length: cap / capStep + 1 }, (_, i) => i * capStep)
    : Array.from({ length: n }, (_, i) => i + 1);
  const yPts = (v) => T + ih - (v / cap) * ih;
  const yRank = (rank) => (n === 1 ? T + ih / 2 : T + ((rank - 1) * ih) / (n - 1));
  const yAt = (v) => (byPoints ? yPts(v) : yRank(v));
  const valueOf = (st, id) => (byPoints ? st.totals[id] || 0 : st.pos[id] || n);
  const step = gws.length > 1 ? iw / (gws.length - 1) : iw;
  // initials fit inside every point while the weeks are spread out; once the
  // season crowds up, only the latest week is tagged
  const tagAll = step >= 27;
  const every = Math.ceil(gws.length / 9);
  const openIdx = !settled && gws[gws.length - 1] === gw ? gws.length - 1 : -1;
  const lastIdx = gws.length - 1;

  // players level on points share a position — nudge them apart so both show
  const nudge = steps.map((s) => {
    const groups = {};
    players.forEach((p) => {
      const r = byPoints ? s.totals[p.id] || 0 : s.pos[p.id] || n;
      (groups[r] = groups[r] || []).push(p.id);
    });
    const out = {};
    Object.values(groups).forEach((ids) => {
      ids.forEach((id, k) => { out[id] = (k - (ids.length - 1) / 2) * (tagAll ? 19 : 8); });
    });
    return out;
  });

  // draw everyone else first so your own line sits on top
  const order = [...players].sort((a, b) => (a.id === me?.id ? 1 : 0) - (b.id === me?.id ? 1 : 0));

  return (
    <>
      <div className="chartwrap">
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img"
          aria-label="League position after each matchweek">
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={L} x2={W - R} y1={yAt(t)} y2={yAt(t)} />
              <text className="axl" x={L - 9} y={yAt(t) + 3.5} textAnchor="end">{t}</text>
            </g>
          ))}
          {gws.map((g, i) =>
            i % every === 0 || i === lastIdx ? (
              <text key={g} className="axl" x={xAt(i)} y={H - 11} textAnchor="middle">{g}</text>
            ) : null
          )}
          <text className="axl" x={L - 9} y={H - 11} textAnchor="end">MW</text>
          <text className="axl" x={L - 9} y={T - 8} textAnchor="end">{byPoints ? "PTS" : "POS"}</text>
          {order.map((p) => {
            const idx = players.findIndex((q) => q.id === p.id);
            const col = LINE_COLS[idx % LINE_COLS.length];
            const tag = tags[idx];
            const mine = p.id === me?.id;
            const xy = steps.map((s, i) => [xAt(i) + (nudge[i][p.id] || 0), yAt(valueOf(s, p.id))]);
            const solid = openIdx > 0 ? xy.slice(0, openIdx) : xy;
            return (
              <g key={p.id}>
                <polyline points={solid.map((c) => c.join(",")).join(" ")} fill="none" stroke={col}
                  strokeWidth={mine ? 3.4 : 2} strokeLinejoin="round" strokeLinecap="round"
                  opacity={mine ? 1 : 0.82} />
                {openIdx > 0 && (
                  <polyline points={xy.slice(openIdx - 1).map((c) => c.join(",")).join(" ")} fill="none"
                    stroke={col} strokeWidth={mine ? 3.4 : 2} strokeDasharray="5 4"
                    strokeLinecap="round" opacity={mine ? 1 : 0.82} />
                )}
                {xy.map(([cx, cy], i) => {
                  const tagged = tagAll || i === lastIdx;
                  const open = i === openIdx;
                  const r = tagged ? (mine ? 10.5 : 9.5) : mine ? 4 : 3;
                  return (
                    <g key={i}>
                      <circle cx={cx} cy={cy} r={r}
                        fill={open ? "#FFFFFF" : col}
                        stroke={open ? col : "#FFFFFF"} strokeWidth={open ? 2 : 1.2} />
                      {tagged && (
                        <text x={cx} y={cy + 3.2} textAnchor="middle" className="tag"
                          fill={open ? col : "#FFFFFF"}
                          fontSize={tag.length > 2 ? 7.6 : 8.8}>{tag}</text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="legend">
        {players.map((p, i) => (
          <span key={p.id} className={"leg" + (p.id === me?.id ? " self" : "")}>
            <i style={{ background: LINE_COLS[i % LINE_COLS.length] }} />
            <b>{tags[i]}</b> {p.name}{p.id === me?.id ? " (you)" : ""}
          </span>
        ))}
      </div>
    </>
  );
}

function EplTables({ epl, onRefresh, busy, season, view = "table" }) {
  const table = epl?.table || [];
  const scorers = epl?.scorers || [];
  const assists = epl?.assists || [];
  const stamp = epl?.updatedAt
    ? new Date(epl.updatedAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
    : "";

  const list = view === "scorers" ? scorers : view === "assists" ? assists : [];
  const bare = view === "table" ? !table.length : !list.length;
  const heading = view === "table" ? "Premier League" : view === "scorers" ? "Top scorers" : "Top assists";

  if (bare) {
    return (
      <>
        <Panel title={heading} tone="m">
          <div className="empty">
            {busy
              ? "Looking up the league…"
              : epl?.error
                ? <>The last lookup didn't come back usable.<br />
                    <span className="mono small mute">{epl.error}</span><br />
                    Try again — it's usually a one-off.</>
                : "Nothing here yet. Either the season hasn't kicked off or the last lookup came back empty."}
          </div>
        </Panel>
        <div className="row" style={{ marginBottom: 20 }}>
          <button className="btn sm" onClick={onRefresh} disabled={busy}>
            {busy ? "Checking…" : "Fetch the league"}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {view === "table" && table.length > 0 && (
        <Panel title={`Premier League ${season || ""}`} tone="m" note={stamp ? `Updated ${stamp}` : ""}>
          <table className="tbl">
            <thead>
              <tr>
                <th></th>
                <th>Club</th>
                <th className="n">P</th>
                <th className="n hide-sm">W</th>
                <th className="n hide-sm">D</th>
                <th className="n hide-sm">L</th>
                <th className="n">GD</th>
                <th className="n">Pts</th>
              </tr>
            </thead>
            <tbody>
              {table.map((t, i) => {
                const pos = t.pos || i + 1;
                const zone = pos <= 4 ? "ucl" : pos >= table.length - 2 ? "rel" : "";
                return (
                  <tr key={t.team + pos} className={zone}>
                    <td className="pos">{pos}</td>
                    <td>
                      <div className="tm"><ClubBadge name={t.team} /><span>{t.team}</span></div>
                    </td>
                    <td className="n">{t.p}</td>
                    <td className="n hide-sm">{t.w}</td>
                    <td className="n hide-sm">{t.d}</td>
                    <td className="n hide-sm">{t.l}</td>
                    <td className="n">{t.gd > 0 ? `+${t.gd}` : t.gd}</td>
                    <td className="n pts">{t.pts}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="keyline">
            <span><s style={{ background: "var(--cyan)" }} />Champions League</span>
            <span><s style={{ background: "var(--red)" }} />Relegation</span>
          </div>
        </Panel>
      )}

      {view !== "table" && list.length > 0 && (
        <Panel title={heading} tone={view === "scorers" ? "g" : "y"}
          note={stamp ? `Updated ${stamp}` : `Top ${list.length}`}>
          <table className="tbl">
            <tbody>
              {list.map((s, i) => (
                <tr key={s.name + i}>
                  <td className="pos">{i + 1}</td>
                  <td className="nm">{s.name}</td>
                  <td>
                    <div className="tm"><ClubBadge name={s.team} /><span className="mono small mute">{s.team}</span></div>
                  </td>
                  <td className="num-c">{view === "scorers" ? s.goals : s.assists}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <div className="row" style={{ marginBottom: 20 }}>
        <button className="btn sm" onClick={onRefresh} disabled={busy}>
          {busy ? "Checking…" : "Refresh league data"}
        </button>
        <span className="mono small mute">Refreshes on its own every 30 min</span>
      </div>
    </>
  );
}

/* ===================== season-long predictions ===================== */

function SeasonTable({ league, season, answers, me, gw }) {
  const questions = season?.questions || [];
  const tally = seasonTally(season);
  const rows = (league?.players || [])
    .map((p) => {
      const right = tally.total[p.id] || 0;
      const wrong = tally.wrong[p.id] || 0;
      return {
        id: p.id,
        name: p.name,
        right,
        wrong,
        left: Math.max(0, questions.length - right - wrong),
        filled: questions.filter((q) => String(answers?.[p.id]?.[q.id] || "").trim()).length,
      };
    })
    .sort((a, b) => b.right - a.right || a.wrong - b.wrong || a.name.localeCompare(b.name));

  const awarded = rows.reduce((n, r) => n + r.right, 0);

  return (
    <>
      <Panel title="Season predictions table" tone="m"
        note={`${questions.length} question${questions.length === 1 ? "" : "s"}`}>
        <table className="tbl">
          <thead>
            <tr>
              <th></th>
              <th>Player</th>
              <th style={{ textAlign: "right" }}>Right</th>
              <th style={{ textAlign: "right" }}>Wrong</th>
              <th style={{ textAlign: "right" }}>Left</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pos = 1 + rows.filter((q) => q.right > r.right).length;
              return (
                <tr key={r.id} className={r.id === me?.id ? "me" : ""}>
                  <td className="pos">{pos}</td>
                  <td className="nm">{r.name}</td>
                  <td className="num-c">{r.right}</td>
                  <td className="num-c bad">{r.wrong}</td>
                  <td className="num-c mute">{r.left}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
      <p className="mono small mute" style={{ textAlign: "center", marginBottom: 20 }}>
        {awarded} point{awarded === 1 ? "" : "s"} settled · separate from the matchweek league
      </p>
    </>
  );
}

function Season({ league, me, season, answers, deadline, gw, bonus, onSaveAnswers, onSaveQuestions,
  onToggleMark, onSetOpen }) {
  const [view, setView] = useState("calls");
  const questions = season?.questions || [];
  const marks = season?.marks || {};
  const players = league?.players || [];
  // the season deadline has passed for the league as a whole…
  const generalShut = isShut(deadline) || gw > 1;
  // …but the admin can open or close any one player on top of that
  const myShut = seasonShutFor(season, me.id, deadline, gw);
  const reopened = generalShut && !myShut;
  const showResults = generalShut && (myShut || me.admin);

  const [draft, setDraft] = useState(() => ({ ...(answers?.[me.id] || {}) }));
  const blankRows = () => Array.from({ length: QDEFAULT }, () => ({ id: null, text: "" }));
  const rowsFrom = (qs) => (qs?.length ? qs.map((q) => ({ id: q.id, text: q.text })) : blankRows());
  const [qDraft, setQDraft] = useState(() => rowsFrom(questions));
  const [savingA, setSavingA] = useState(false);
  const [savingQ, setSavingQ] = useState(false);

  // these two forms are now re-read from storage every so often, so that other
  // people's entries appear without a reload. neither may throw away typing that
  // hasn't been saved yet: only re-seed when what's stored has actually changed,
  // and even then keep anything already filled in on screen.
  const seedA = useRef("");
  useEffect(() => {
    const mine = answers?.[me.id] || {};
    const key = JSON.stringify(mine);
    if (seedA.current === key) return;
    setDraft((prev) => {
      const out = { ...mine };
      Object.entries(prev || {}).forEach(([k, v]) => { if (String(v || "").trim()) out[k] = v; });
      return out;
    });
    seedA.current = key;
  }, [answers, me.id]);

  const seedQ = useRef("");
  useEffect(() => {
    const qs = season?.questions || [];
    const key = JSON.stringify(qs);
    if (seedQ.current === key) return;
    seedQ.current = key;
    setQDraft(qs.length
      ? qs.map((q) => ({ id: q.id, text: q.text }))
      : Array.from({ length: QDEFAULT }, () => ({ id: null, text: "" })));
  }, [season]);

  const answered = questions.filter((q) => String(draft[q.id] || "").trim()).length;

  const saveMine = async () => {
    setSavingA(true);
    await onSaveAnswers(draft);
    setSavingA(false);
  };

  const saveQs = async () => {
    setSavingQ(true);
    await onSaveQuestions(qDraft);
    setSavingQ(false);
  };

  const when = deadline
    ? new Date(deadline).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : null;

  const anySettled = Object.values(bonus?.total || {}).some((v) => v > 0);

  return (
    <div className="wrap">
      <div className="seg">
        <button className={view === "calls" ? "on" : ""} onClick={() => setView("calls")}>Predictions</button>
        <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>Table</button>
        <button className={view === "chart" ? "on" : ""} onClick={() => setView("chart")}>Positions</button>
      </div>

      {view === "table" && (
        <SeasonTable league={league} season={season} answers={answers} me={me} gw={gw} />
      )}

      {view === "chart" && (
        <>
          <Panel title="Season predictions position" tone="m" note="1 = top">
            <PositionChart league={league} ledger={{ byGw: bonus?.byGw || {} }} me={me} gw={gw} settled
              mode="points"
              emptyNote={<>Nothing settled yet.<br />
                This charts the season-predictions league only — lines appear as the admin marks calls right.</>} />
          </Panel>
          <p className="mono small mute" style={{ textAlign: "center", marginBottom: 20 }}>
            {anySettled
              ? "Position in the season-predictions league after each matchweek"
              : "Separate from the matchweek league"}
          </p>
        </>
      )}

      {view === "calls" && (questions.length === 0 ? (
        <Panel title="Season predictions" tone="m">
          <div className="empty">
            {me.admin
              ? "Set your questions below. Everyone answers them once, before the first deadline of the season."
              : "The admin hasn't set this season's questions yet."}
          </div>
        </Panel>
      ) : (
        <>
          {/* ---------- answering, open until the deadline ---------- */}
          {!myShut && (
            <>
              <Panel title="Season predictions" tone="m"
                note={reopened ? "Opened for you" : when ? `Closes ${when}` : "Closes at the first kick-off"}>
                <div className="panel-bd">
                  <p className="mono small mute" style={{ marginBottom: 12 }}>
                    {reopened
                      ? "The deadline has gone but the admin has opened these back up for you. Save as often as you like — they'll close again when the admin says so."
                      : `${questions.length} calls for the whole season. One point for each one the admin marks right. Saving submits them, and you can come back and change them as often as you like until the deadline.`}
                  </p>
                  {questions.map((q, i) => (
                    <div key={q.id} className="qrow">
                      <span className="qn">{i + 1}</span>
                      <label className="qtx">{q.text}</label>
                      <input className="inp" value={draft[q.id] || ""} maxLength={60}
                        onFocus={keepInView} placeholder="Your answer"
                        onChange={(e) => setDraft({ ...draft, [q.id]: e.target.value })} />
                    </div>
                  ))}
                </div>
              </Panel>
              <div className="row" style={{ marginBottom: 20 }}>
                <button className="btn pri" onClick={saveMine} disabled={savingA}>
                  {savingA ? "Saving…" : "Save my answers"}
                </button>
                <span className="mono small mute">{answered} of {questions.length} filled · editable until the deadline</span>
              </div>
            </>
          )}

          {/* ---------- everyone's answers, once they're in ---------- */}
          {showResults && (
            <>

              {questions.map((q, i) => (
                <Panel key={q.id} title={`${i + 1}. ${q.text}`} tone="">
                  <table className="tbl">
                    <tbody>
                      {players.map((p) => {
                        const v = verdictOf(marks[p.id]?.[q.id]);
                        const ans = answers?.[p.id]?.[q.id];
                        return (
                          <tr key={p.id} className={p.id === me.id ? "me" : ""}>
                            <td className="nm">{p.name}</td>
                            <td className="ans">{ans ? ans : <span className="mute">—</span>}</td>
                            <td className="num-c">
                              {me.admin ? (
                                <div className="marks">
                                  <button className={"tick" + (v === "y" ? " on" : "")}
                                    onClick={() => onToggleMark(p.id, q.id, "y")}
                                    aria-label={`${p.name} right`}>✓</button>
                                  <button className={"cross" + (v === "n" ? " on" : "")}
                                    onClick={() => onToggleMark(p.id, q.id, "n")}
                                    aria-label={`${p.name} wrong`}>✗</button>
                                </div>
                              ) : (
                                <span className={v === "y" ? "yes" : v === "n" ? "no" : "mute"}>
                                  {v === "y" ? "✓" : v === "n" ? "✗" : "·"}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Panel>
              ))}

              {me.admin && (
                <p className="mono small mute" style={{ textAlign: "center", marginBottom: 20 }}>
                  A tick banks a point in matchweek {gw} — settle each one as it's decided
                </p>
              )}
            </>
          )}
        </>
      ))}

      {/* ---------- admin: who can still edit ---------- */}
      {view === "calls" && me.admin && questions.length > 0 && (
        <Panel title="Who can edit" tone="g"
          note={generalShut ? "Deadline gone" : "Deadline still open"}>
          <table className="tbl">
            <tbody>
              {players.map((p) => {
                const o = season?.open?.[p.id];
                const openNow = !seasonShutFor(season, p.id, deadline, gw);
                const filled = Object.keys(answers?.[p.id] || {}).length;
                return (
                  <tr key={p.id}>
                    <td className="nm">
                      {p.name}
                      <span className="mono small mute"> · {filled}/{questions.length}</span>
                    </td>
                    <td className="num-c">
                      <span className={"chip " + (openNow ? "live" : "ft")}>{openNow ? "Open" : "Locked"}</span>
                      {o !== undefined ? <span className="chip lock" style={{ marginLeft: 4 }}>Set</span> : null}
                    </td>
                    <td className="num-c">
                      <button className="btn sm" onClick={() => onSetOpen(p.id, !openNow)}>
                        {openNow ? "Lock" : "Open"}
                      </button>
                      {o !== undefined && (
                        <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => onSetOpen(p.id, null)}>
                          Auto
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="keyline">
            <span>Auto follows the matchweek 1 deadline</span>
            <span>Open lets that player edit whenever</span>
          </div>
        </Panel>
      )}

      {/* ---------- admin: setting the questions ---------- */}
      {view === "calls" && me.admin && (
        <Panel title="Set the questions" tone="y"
          note={`${qDraft.filter((r) => r.text.trim()).length} question${qDraft.filter((r) => r.text.trim()).length === 1 ? "" : "s"}`}>
          <div className="panel-bd">
            <p className="mono small mute" style={{ marginBottom: 12 }}>
              One point each. Anything with a clear answer works — title winner, top scorer, who goes down,
              whether a manager lasts the year. Eleven is the default, but add or drop as many as you like.
            </p>
            {qDraft.map((r, i) => (
              <div key={r.id || `new${i}`} className="qrow">
                <span className="qn">{i + 1}</span>
                <input className="inp" value={r.text} maxLength={90}
                  placeholder={`Question ${i + 1}`}
                  onChange={(e) => {
                    const next = [...qDraft];
                    next[i] = { ...next[i], text: e.target.value };
                    setQDraft(next);
                  }} />
                <button className="btn sm danger" aria-label={`Remove question ${i + 1}`}
                  onClick={() => setQDraft(qDraft.filter((_, k) => k !== i))}>Remove</button>
              </div>
            ))}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn sm" disabled={qDraft.length >= QLIMIT}
                onClick={() => setQDraft([...qDraft, { id: null, text: "" }])}>Add a question</button>
              <button className="btn pri" onClick={saveQs} disabled={savingQ}>
                {savingQ ? "Saving…" : "Save questions"}
              </button>
            </div>
            <p className="mono small mute" style={{ margin: "12px 0 0" }}>
              {generalShut
                ? "Reword freely — nobody's answer changes. Removing a question drops its ticks and its points."
                : "Nothing is saved until you press Save questions."}
            </p>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Table({ league, gw, standings, me, ledger, bonusByGw, epl, onRefreshEpl, eplBusy, settled }) {
  const [view, setView] = useState("mini");
  const [chartMode, setChartMode] = useState("points");
  // one column per matchweek that has actually been reached: everything behind us,
  // plus the one being played now. a stray ledger entry for a week still to come
  // (a sandbox run, a matchweek set forward and back) doesn't earn a column.
  const started = (n) => {
    if (n === gw) return true;              // the week being played now
    const ko = ledger?.ko?.[n];
    if (ko) return isShut(ko);              // its deadline is on record — trust it
    return n < gw;                          // older ledgers kept no deadline
  };
  const weeks = [...new Set([
    ...Object.keys(ledger?.byGw || {}).map(Number),
    ...Object.keys(bonusByGw || {}).map(Number),
    gw,
  ])]
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= gw && started(n))
    .sort((a, b) => a - b);
  const rows = [...standings].sort((a, b) => b.total - a.total || b.gw - a.gw || a.name.localeCompare(b.name));

  // one figure per cell, and the row of them adds up to the Total beside it:
  // the week's match points plus any season-long calls ticked off that week
  const live = Object.fromEntries(standings.map((r) => [r.id, r.gw]));
  const weekPoints = (pid, g) => {
    const base = g === gw ? (live[pid] ?? 0) : ledger?.byGw?.[g]?.[pid];
    const extra = bonusByGw?.[g]?.[pid] || 0;
    if (base == null) return extra || null;
    return base + extra;
  };

  return (
    <div className="wrap">
      <div className="seg">
        <button className={view === "mini" ? "on" : ""} onClick={() => setView("mini")}>Standings</button>
        <button className={view === "chart" ? "on" : ""} onClick={() => setView("chart")}>Positions</button>
        <button className={view === "epl" ? "on" : ""} onClick={() => setView("epl")}>EPL</button>
        <button className={view === "scorers" ? "on" : ""} onClick={() => setView("scorers")}>Scorers</button>
        <button className={view === "assists" ? "on" : ""} onClick={() => setView("assists")}>Assists</button>
      </div>

      {view === "mini" && (
        <>
          <Panel title={`${league.season} table`} tone="" note={`After MW ${gw}`}>
            <div className="gridscroll">
              <div className="gwgrid"
                style={{ gridTemplateColumns: `34px 122px repeat(${weeks.length}, 38px) minmax(64px, 1fr)` }}>
                <div className="gh gpos">#</div>
                <div className="gh gnm"><span>Player</span></div>
                {weeks.map((g) => <div key={`h${g}`} className="gh gnum">{g}</div>)}
                <div className="gh gnum gtot">Total</div>
                {rows.map((r, i) => {
                  const last = i === rows.length - 1 ? " foot" : "";
                  const mine = r.id === me.id ? " me" : "";
                  return (
                    <Fragment key={r.id}>
                      <div className={`gpos${mine}${last}`}>{i + 1}</div>
                      <div className={`gnm${mine}${last}`}><span>{r.name}</span></div>
                      {weeks.map((g) => {
                        const v = weekPoints(r.id, g);
                        return (
                          <div key={g} className={`gnum${mine}${last}${g === gw ? " live" : ""}`}>
                            {v == null ? <span className="mute">·</span> : v}
                          </div>
                        );
                      })}
                      <div className={`gnum gtot${mine}${last}`}>{r.total}</div>
                    </Fragment>
                  );
                })}
              </div>
            </div>
            <div className="keyline">
              <span>Scroll the matchweeks sideways</span>
              <span>MW {gw} includes games in play</span>
            </div>
          </Panel>
          <p className="mono small mute" style={{ textAlign: "center", marginBottom: 20 }}>
            5 pts exact score · 2 pts right result
          </p>
        </>
      )}

      {view === "chart" && (
        <>
          <Panel title="League progress" tone="y"
            note={chartMode === "points" ? "Running total" : "1 = top"}>
            <div className="seg inner">
              <button className={chartMode === "points" ? "on" : ""} onClick={() => setChartMode("points")}>Points</button>
              <button className={chartMode === "pos" ? "on" : ""} onClick={() => setChartMode("pos")}>Position</button>
            </div>
            <PositionChart league={league} ledger={ledger} bonusByGw={bonusByGw} me={me} gw={gw} settled onlyDone
              mode={chartMode}
              emptyNote={<>The chart fills in once a matchweek has finished.<br />
                Each point is a player's total after that week.</>} />
          </Panel>
          <p className="mono small mute" style={{ textAlign: "center", marginBottom: 20 }}>
            {chartMode === "points"
              ? "Total points after each completed matchweek"
              : "League position after each completed matchweek"}
          </p>
        </>
      )}

      {view === "epl" && (
        <EplTables epl={epl} onRefresh={onRefreshEpl} busy={eplBusy} season={league.season} view="table" />
      )}

      {view === "scorers" && (
        <EplTables epl={epl} onRefresh={onRefreshEpl} busy={eplBusy} season={league.season} view="scorers" />
      )}

      {view === "assists" && (
        <EplTables epl={epl} onRefresh={onRefreshEpl} busy={eplBusy} season={league.season} view="assists" />
      )}
    </div>
  );
}

/* ---------------------------------- admin --------------------------------- */

function Admin({ league, setLeague, gw, fixtures, setFixtures, toast, pullFixtures, refreshScores,
  autoSync, busy, allPreds, gwOpen, onSetGwOpen, gwPts, adjust, onSetAdjust, ledger }) {
  const [newName, setNewName] = useState("");
  const [newPinInput, setNewPinInput] = useState("");
  const [pinDraft, setPinDraft] = useState({});
  const [backedUpAt, setBackedUpAt] = useState(0);
  const [adjDraft, setAdjDraft] = useState({});
  const [adjWeek, setAdjWeek] = useState(gw);
  const [weekAdj, setWeekAdj] = useState({});

  useEffect(() => { setAdjWeek(gw); }, [gw]);
  useEffect(() => {
    let live = true;
    (async () => {
      const map = adjWeek === gw ? (adjust || {}) : ((await sGet(K.adjust(adjWeek))) || {});
      if (live) setWeekAdj(map);
    })();
    return () => { live = false; };
  }, [adjWeek, gw, adjust]);

  useEffect(() => { (async () => setBackedUpAt((await sGet(K.backupAt)) || 0))(); }, []);
  const [gwInput, setGwInput] = useState(String(gw));
  const [pullGw, setPullGw] = useState(String(gw));
  const [syncing, setSyncing] = useState(false);

  const runSync = async () => {
    setSyncing(true);
    await autoSync();
    setSyncing(false);
    toast("Synced");
  };

  const addPlayer = async () => {
    const n = newName.trim();
    if (!n) return;
    if (league.players.length >= 20) return toast("That's the player limit", "err");
    const taken = league.players.map((p) => p.pin);
    const wanted = newPinInput.trim();
    let pin;
    if (wanted) {
      if (!validPin(wanted)) return toast("A PIN is four digits", "err");
      if (taken.includes(wanted)) return toast("Someone already has that PIN", "err");
      pin = wanted;
    } else {
      pin = randomPin(taken);
    }
    const next = { ...league, players: [...league.players, { id: uid(), name: n, pin, admin: false }] };
    if (await sSet(K.league, next)) {
      setLeague(next);
      setNewName("");
      setNewPinInput("");
      toast(`${n} added — PIN ${pin}`);
    } else toast("Couldn't add that player", "err");
  };

  const newPin = async (id) => {
    const pin = randomPin(league.players.map((p) => p.pin));
    const next = { ...league, players: league.players.map((p) => (p.id === id ? { ...p, pin } : p)) };
    if (await sSet(K.league, next)) { setLeague(next); toast(`New PIN ${pin}`); }
  };

  // hand-pick a PIN instead of taking whatever the app generated
  const setPin = async (id) => {
    const wanted = String(pinDraft[id] || "").trim();
    if (!validPin(wanted)) return toast("A PIN is four digits", "err");
    if (league.players.some((p) => p.id !== id && p.pin === wanted)) {
      return toast("Someone already has that PIN", "err");
    }
    const next = { ...league, players: league.players.map((p) => (p.id === id ? { ...p, pin: wanted } : p)) };
    if (await sSet(K.league, next)) {
      setLeague(next);
      setPinDraft((d) => ({ ...d, [id]: "" }));
      const who = league.players.find((p) => p.id === id)?.name || "That player";
      toast(`${who}'s PIN is now ${wanted}`);
    } else toast("Couldn't set that PIN", "err");
  };

  const adminCount = league.players.filter((p) => p.admin).length;

  const toggleAdmin = async (id) => {
    const target = league.players.find((p) => p.id === id);
    if (target.admin && adminCount < 2) return toast("The league needs at least one admin", "err");
    const next = { ...league, players: league.players.map((p) => (p.id === id ? { ...p, admin: !p.admin } : p)) };
    if (await sSet(K.league, next)) {
      setLeague(next);
      toast(target.admin ? `${target.name} is a player now` : `${target.name} is an admin`);
    }
  };

  const removePlayer = async (id) => {
    const target = league.players.find((p) => p.id === id);
    if (target.admin && adminCount < 2) return toast("The league needs at least one admin", "err");
    const next = { ...league, players: league.players.filter((p) => p.id !== id) };
    if (await sSet(K.league, next)) { setLeague(next); toast("Player removed"); }
  };

  const [saving, setSaving] = useState(false);

  const staleBackup = Date.now() - (backedUpAt || 0) > 7 * 24 * 3600e3;

  const backupName = () => `prem-predictor-${new Date().toISOString().slice(0, 10)}.json`;

  const markBackedUp = async () => {
    const at = Date.now();
    await sSet(K.backupAt, at);
    setBackedUpAt(at);
  };

  const saveBackup = async () => {
    setSaving(true);
    try {
      const dump = await collectLeague();
      downloadJson(backupName(), dump);
      await markBackedUp();
      toast(`League file saved — ${dump.counts?.answers || 0} sets of season answers in it`);
    } catch (e) {
      toast(`Couldn't build the file — ${String(e?.message || e).slice(0, 40)}`, "err");
    } finally {
      setSaving(false);
    }
  };

  const sendBackup = async () => {
    setSaving(true);
    try {
      const dump = await collectLeague();
      const how = await shareJson(backupName(), dump);
      if (how === "cancelled") return;
      await markBackedUp();
      toast(how === "shared"
        ? `Sent — ${dump.counts?.answers || 0} sets of season answers in it`
        : "Downloaded — this device can't share files");
    } catch (e) {
      toast(`Couldn't build the file — ${String(e?.message || e).slice(0, 40)}`, "err");
    } finally {
      setSaving(false);
    }
  };

  const loadBackup = async (file) => {
    if (!file) return;
    try {
      const obj = await readJsonFile(file);
      const res = await restoreLeague(obj);
      if (res.failed.length) {
        toast(`${res.failed.length} entries wouldn't save — wait a moment and restore again`, "err");
        return;
      }
      toast(`Restored — ${res.answers}/${res.expected} sets of season answers. Reloading`);
      // reload from scratch: leaving stale points in memory would let the next
      // ledger write overwrite the restored weeks with only the current one
      setTimeout(() => { try { window.location.reload(); } catch { /* ignore */ } }, 600);
    } catch {
      toast("That file didn't restore", "err");
    }
  };

  const setFont = async (id) => {
    const next = { ...league, font: id };
    if (await sSet(K.league, next)) { setLeague(next); toast(`${fontOf(id).name} it is`); }
  };

  const setTheme = async (id) => {
    const next = { ...league, theme: id };
    if (await sSet(K.league, next)) {
      setLeague(next);
      toast(id === "default" ? "Back to the usual colours" : `${themeOf(id).name} colours on`);
    }
  };

  const setGw = async () => {
    const n = Math.max(1, Math.min(38, +gwInput || 1));
    const next = { ...league, currentGw: n };
    if (await sSet(K.league, next)) { setLeague(next); toast(`Now on matchweek ${n}`); }
  };

  const editFx = async (id, field, value) => {
    const list = fixtures.fixtures.map((f) => (f.id === id ? { ...f, [field]: value } : f));
    const next = { ...fixtures, fixtures: list, updatedAt: Date.now() };
    setFixtures(next);
    await sSet(K.fixtures(gw), next);
  };

  const setScore = (id, side, raw) => {
    const v = raw === "" ? null : Math.max(0, Math.min(20, +raw));
    editFx(id, side, v);
  };

  return (
    <div className="wrap">
      <Panel title="Fixtures" tone="m" note={league.syncedAt ? `Synced ${new Date(league.syncedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "Not synced yet"}>
        <div className="panel-bd">
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="btn pri" onClick={runSync} disabled={syncing || busy}>
              {syncing ? "Syncing…" : "Sync now"}
            </button>
            <button className="btn" disabled={busy || syncing} onClick={() => refreshScores(false)}>Refresh scores</button>
          </div>
          <p className="small mute" style={{ marginBottom: 10, lineHeight: 1.6 }}>
            This happens on its own — the app works out the current matchweek and loads its fixtures whenever someone
            opens it and the data is more than six hours old. You only need this button if something looks wrong.
          </p>
          <div className="row">
            <div style={{ flex: "0 0 90px" }}>
              <label className="lbl">Load one week</label>
              <input className="inp mono" inputMode="numeric" value={pullGw} onChange={(e) => setPullGw(e.target.value.replace(/\D/g, ""))} />
            </div>
            <button className="btn sm" style={{ marginTop: 20 }} disabled={busy} onClick={() => pullFixtures(+pullGw || gw)}>
              {busy ? "Looking up…" : "Pull fixtures"}
            </button>
          </div>
          <p className="small mute" style={{ marginBottom: 0, lineHeight: 1.6 }}>
            Everything below is editable, and what you set here is what counts for scoring.
          </p>
        </div>
        {fixtures?.fixtures?.length ? (
          <table className="tbl">
            <thead><tr><th>Match</th><th>Kick-off <span className="mute">Irish time</span></th><th style={{ textAlign: "right" }}>Score</th><th></th></tr></thead>
            <tbody>
              {fixtures.fixtures.map((f) => (
                <tr key={f.id}>
                  <td style={{ fontSize: 12 }}>{f.h}<br /><span className="mute">{f.a}</span></td>
                  <td>
                    <input className="inp mono" style={{ fontSize: 11, padding: "6px 8px" }} type="datetime-local"
                      value={toHomeInput(f.ko)}
                      onChange={(e) => editFx(f.id, "ko", fromHomeInput(e.target.value))} />
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      <input className="num" style={{ width: 38, height: 34, fontSize: 16 }} inputMode="numeric"
                        onFocus={keepInView}
                        value={f.hs ?? ""} onChange={(e) => setScore(f.id, "hs", e.target.value.replace(/\D/g, ""))} />
                      <input className="num" style={{ width: 38, height: 34, fontSize: 16 }} inputMode="numeric"
                        onFocus={keepInView}
                        value={f.as ?? ""} onChange={(e) => setScore(f.id, "as", e.target.value.replace(/\D/g, ""))} />
                    </div>
                  </td>
                  <td>
                    <button className="btn sm" onClick={() => editFx(f.id, "status", isFinished(f) ? "live" : "finished")}>
                      {isFinished(f) ? "FT" : "End"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty">No fixtures stored for matchweek {gw}.</div>}
      </Panel>

      <Panel title="Matchweek" tone="m">
        <div className="panel-bd row">
          <div style={{ flex: "0 0 90px" }}>
            <label className="lbl">Current</label>
            <input className="inp mono" inputMode="numeric" value={gwInput} onChange={(e) => setGwInput(e.target.value.replace(/\D/g, ""))} />
          </div>
          <button className="btn" style={{ marginTop: 20 }} onClick={setGw}>Set matchweek</button>
        </div>
      </Panel>

      <Panel title="Backup" tone="m"
        note={backedUpAt
          ? `Last ${new Date(backedUpAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
          : "Never"}>
        <div className="panel-bd">
          {staleBackup && (
            <p className="small" style={{ margin: "0 0 12px", lineHeight: 1.6, color: "var(--red)", fontWeight: 600 }}>
              {backedUpAt
                ? "It's over a week since the last backup — worth taking one now."
                : "No backup taken yet. Take one now, before anyone's picks are in."}
            </p>
          )}
          <p className="small mute" style={{ margin: "0 0 12px", lineHeight: 1.6 }}>
            Saves the whole league to a file — players, PINs, every prediction and the points. Keep it somewhere safe.
            It's what gets you back in if you lose your PIN, and what rebuilds the league if this app ever goes away.
          </p>
          <div className="row">
            <button className="btn pri" onClick={sendBackup} disabled={saving}>
              {saving ? "Preparing…" : "Send league file"}
            </button>
            <button className="btn" onClick={saveBackup} disabled={saving}>
              Download only
            </button>
            <label className="filebtn sm">
              Restore from file
              <input type="file" accept="application/json,.json" onChange={(e) => loadBackup(e.target.files?.[0])} />
            </label>
          </div>
          <p className="small mute" style={{ margin: "12px 0 0", lineHeight: 1.6 }}>
            Send opens your phone's share sheet, so you can fire the file straight into an email to yourself
            or into the group chat. On a desktop browser it just downloads. Restoring overwrites everything
            currently in the league with what's in the file.
          </p>
        </div>
      </Panel>

      <Panel title="Colours" tone="" note={themeOf(league.theme).name}>
        <div className="panel-bd" style={{ paddingBottom: 4 }}>
          <p className="small mute" style={{ margin: 0, lineHeight: 1.6 }}>
            Same layout and type — only the palette changes, and the whole league sees it.
            Switch back to Classic whenever the holiday's over.
          </p>
        </div>
        <div className="fontlist">
          {THEMES.map((t) => (
            <button key={t.id} className={"fontopt skinopt" + (themeOf(league.theme).id === t.id ? " on" : "")}
              onClick={() => setTheme(t.id)}>
              <span className="skinrow">
                <span className="skinchips">
                  {t.swatch.map((c, i) => <s key={i} style={{ background: c }} />)}
                </span>
                <span className="skinname">{t.name}</span>
              </span>
              <span className="fontopt-meta">{t.note}</span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Typeface" tone="m" note={fontOf(league.font).name}>
        <div className="panel-bd" style={{ paddingBottom: 4 }}>
          <p className="small mute" style={{ margin: 0, lineHeight: 1.6 }}>
            Pick one and the whole league sees it. Each is previewed in its own face.
          </p>
        </div>
        <div className="fontlist">
          {FONTS.map((f) => (
            <button key={f.id} className={"fontopt" + (fontOf(league.font).id === f.id ? " on" : "")}
              onClick={() => setFont(f.id)}>
              <span className="fontopt-sample" style={{ fontFamily: f.d, letterSpacing: f.tr }}>Pres Prem Predictor</span>
              <span className="fontopt-meta">{f.name} — {f.note}</span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Points fixes" tone="y" note={`MW ${adjWeek}`}>
        <div className="panel-bd" style={{ paddingBottom: 0 }}>
          <p className="small mute" style={{ margin: "0 0 10px", lineHeight: 1.6 }}>
            Points are worked out from the fixtures, so this is only for putting something right — a save
            that didn't land, a pick sent to you another way. Pick any matchweek; the adjustment lands on
            that week's total and flows through to the table and the chart.
          </p>
          <div className="row" style={{ marginBottom: 4 }}>
            <button className="btn sm" disabled={adjWeek <= 1}
              onClick={() => setAdjWeek(adjWeek - 1)}>◀</button>
            <span className="mono" style={{ minWidth: 78, textAlign: "center" }}>MW {adjWeek}</span>
            <button className="btn sm" disabled={adjWeek >= 38}
              onClick={() => setAdjWeek(adjWeek + 1)}>▶</button>
            {adjWeek !== gw && (
              <button className="btn sm" onClick={() => setAdjWeek(gw)}>Back to MW {gw}</button>
            )}
          </div>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Player</th>
              <th style={{ textAlign: "right" }}>Points</th>
              <th style={{ textAlign: "right" }}>Adjust</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {league.players.map((p) => {
              const adj = +(weekAdj[p.id] || 0);
              const banked = adjWeek === gw ? (gwPts?.[p.id] || 0) : (ledger?.byGw?.[adjWeek]?.[p.id] ?? null);
              const key = `${adjWeek}:${p.id}`;
              const val = adjDraft[key] !== undefined ? adjDraft[key] : (adj || "");
              return (
                <tr key={p.id}>
                  <td className="nm">{p.name}</td>
                  <td className="num-c">{banked == null ? <span className="mute">·</span> : banked - adj}</td>
                  <td className="num-c">
                    <input className="inp mono" style={{ width: 62, padding: "7px 8px", textAlign: "right" }}
                      inputMode="numeric" maxLength={4} placeholder="0"
                      aria-label={`Adjust ${p.name} for matchweek ${adjWeek}`} value={val}
                      onFocus={keepInView}
                      onChange={(e) => setAdjDraft({ ...adjDraft, [key]: e.target.value.replace(/[^-\d]/g, "").slice(0, 4) })}
                      onKeyDown={(e) => e.key === "Enter" && onSetAdjust(p.id, adjDraft[key] || 0, adjWeek)} />
                  </td>
                  <td className="num-c">
                    <button className="btn sm" onClick={() => onSetAdjust(p.id, adjDraft[key] ?? adj, adjWeek)}>Apply</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="keyline">
          <span>Negative takes points away</span>
          <span>Zero clears it</span>
        </div>
      </Panel>

      <p className="mono small mute" style={{ textAlign: "center", margin: "0 0 18px" }}>
        Build {BUILD}
      </p>

      <Panel title={`Who can edit MW ${gw}`} tone="g"
        note={isShut(deadlineOf(fixtures?.fixtures)) ? "Deadline gone" : "Deadline still open"}>
        <div className="panel-bd" style={{ paddingBottom: 0 }}>
          <p className="small mute" style={{ margin: 0, lineHeight: 1.6 }}>
            Everyone can edit their picks freely until the deadline. After it, open a player back up here if
            they've a good reason — it only affects this matchweek.
          </p>
        </div>
        <table className="tbl">
          <tbody>
            {league.players.map((p) => {
              const o = gwOpen?.[p.id];
              const openNow = !gwShutFor(gwOpen, p.id, deadlineOf(fixtures?.fixtures));
              const filled = Object.keys(allPreds?.[p.id] || {}).length;
              const total = fixtures?.fixtures?.length || 0;
              return (
                <tr key={p.id}>
                  <td className="nm">
                    {p.name}
                    <span className="mono small mute"> · {filled}/{total}</span>
                  </td>
                  <td className="num-c">
                    <span className={"chip " + (openNow ? "live" : "ft")}>{openNow ? "Open" : "Locked"}</span>
                    {o !== undefined ? <span className="chip lock" style={{ marginLeft: 4 }}>Set</span> : null}
                  </td>
                  <td className="num-c">
                    <button className="btn sm" onClick={() => onSetGwOpen(p.id, !openNow)}>
                      {openNow ? "Lock" : "Open"}
                    </button>
                    {o !== undefined && (
                      <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => onSetGwOpen(p.id, null)}>
                        Auto
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="keyline">
          <span>Auto follows this week's kick-off deadline</span>
          <span>Switches reset each matchweek</span>
        </div>
      </Panel>

      <Panel title="Players" tone="m" note={`${league.players.length} in`}>
        <div className="panel-bd" style={{ paddingBottom: 0 }}>
          <p className="small mute" style={{ margin: 0, lineHeight: 1.6 }}>
            Send each player their PIN. Type four digits to set one yourself, or let the app pick. Either
            way the old PIN stops working straight away.
          </p>
        </div>
        <table className="tbl">
          <tbody>
            {league.players.map((p) => (
              <tr key={p.id}>
                <td className="nm">{p.name}{p.admin ? <span className="badge">Admin</span> : null}<br /><span className="pin-code" style={{ marginTop: 5 }}>{p.pin}</span></td>
                <td style={{ textAlign: "right" }}>
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <input className="inp mono" style={{ width: 76, padding: "7px 8px", letterSpacing: ".2em" }}
                      inputMode="numeric" maxLength={4} placeholder="Set"
                      aria-label={`Set ${p.name}'s PIN`}
                      value={pinDraft[p.id] || ""}
                      onChange={(e) => setPinDraft({ ...pinDraft, [p.id]: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                      onKeyDown={(e) => e.key === "Enter" && setPin(p.id)} />
                    <button className="btn sm" onClick={() => setPin(p.id)}
                      disabled={(pinDraft[p.id] || "").length !== 4}>Set PIN</button>
                    <button className="btn sm" onClick={() => newPin(p.id)}>Random</button>
                    <button className="btn sm" onClick={() => toggleAdmin(p.id)}>{p.admin ? "Make player" : "Make admin"}</button>
                    <button className="btn sm danger" onClick={() => removePlayer(p.id)}>Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="panel-bd row">
          <input className="inp" style={{ flex: 1, minWidth: 130 }} value={newName} placeholder="New player's name"
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPlayer()} />
          <input className="inp mono" style={{ width: 92, letterSpacing: ".2em" }} inputMode="numeric" maxLength={4}
            placeholder="PIN" aria-label="PIN for the new player" value={newPinInput}
            onChange={(e) => setNewPinInput(e.target.value.replace(/\D/g, "").slice(0, 4))}
            onKeyDown={(e) => e.key === "Enter" && addPlayer()} />
          <button className="btn" onClick={addPlayer}>Add player</button>
        </div>
      </Panel>
    </div>
  );
}

/* =================================== app ================================== */

export default function PremPredictor() {
  const [league, setLeague] = useState(null);
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState("predict");
  const [fixtures, setFixtures] = useState(null);
  const [allPreds, setAllPreds] = useState({});
  const [gwOpen, setGwOpen] = useState({});
  const [adjust, setAdjust] = useState({});
  const [ledger, setLedger] = useState({ byGw: {} });
  const [epl, setEpl] = useState(null);
  const [eplBusy, setEplBusy] = useState(false);
  const [season, setSeason] = useState(emptySeason());
  const [sAnswers, setSAnswers] = useState({});
  const [seasonDeadline, setSeasonDeadline] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  const autoRef = useRef({ pulled: false, scored: 0, epl: 0 });
  useKeyboardInset();

  const toast = useCallback((msg, kind) => {
    setToastMsg({ msg, kind });
    setTimeout(() => setToastMsg(null), 2600);
  }, []);

  const gw = league?.currentGw || 1;

  /* ---- initial load ---- */
  useEffect(() => {
    (async () => {
      const l = await sGet(K.league);
      setLeague(l);
      const led = await sGet(K.ledger);
      if (led) setLedger(led);
      const e = await sGet(K.epl);
      if (e) setEpl(e);
      const sn = await sGet(K.season);
      if (sn) setSeason(sn);
      const fx1 = await sGet(K.fixtures(1));
      setSeasonDeadline(deadlineOf(fx1?.fixtures));
      // sign-in is never remembered — clear anything an earlier version stored
      await pDel(WHOAMI);
      setLoading(false);
    })();
  }, []);

  const signIn = useCallback(async (u) => {
    setMe(u);
  }, []);

  const signOut = useCallback(async () => {
    setMe(null);
    setTab("predict");
  }, []);

  const loadWeek = useCallback(async (n) => {
    const fx = await sGet(K.fixtures(n));
    setFixtures(fx);
    setGwOpen((await sGet(K.gwOpen(n))) || {});
    setAdjust((await sGet(K.adjust(n))) || {});
    const keys = await sList(K.predsPrefix(n));
    const out = {};
    for (const k of keys) {
      const rec = await sGet(k);
      if (rec?.playerId) out[rec.playerId] = rec.picks || {};
    }
    setAllPreds(out);
    return fx;
  }, []);

  useEffect(() => { if (league && me) loadWeek(gw); }, [league, me, gw, loadWeek]);

  // just the predictions, without disturbing the fixtures — cheap enough to poll
  const loadPicks = useCallback(async (n) => {
    const keys = await sList(K.predsPrefix(n));
    const out = {};
    let missed = false;
    for (const k of keys) {
      const { ok, value } = await sGetSure(k);
      if (!ok) { missed = true; continue; }
      if (value?.playerId) out[value.playerId] = value.picks || {};
    }
    // same rule as the season answers: a half-finished poll keeps what it had
    setAllPreds((prev) => (missed ? { ...prev, ...out } : out));
    setGwOpen((await sGet(K.gwOpen(n))) || {});
  }, []);

  /* ---- season-long predictions ---- */
  const loadSeason = useCallback(async () => {
    const sn = await sGet(K.season);
    setSeason(sn || emptySeason());
    const keys = await sList(K.sAnsPrefix);
    const out = {};
    let missed = false;
    for (const k of keys) {
      const { ok, value } = await sGetSure(k);
      if (!ok) { missed = true; continue; }
      if (value?.playerId) out[value.playerId] = value.answers || {};
    }
    // a poll that got knocked back halfway through must not wipe the people it
    // never reached off the screen — keep what we already had for them
    setSAnswers((prev) => (missed ? { ...prev, ...out } : out));
  }, []);

  useEffect(() => { if (league && me) loadSeason(); }, [league, me, loadSeason]);
  useEffect(() => { if (tab === "season") loadSeason(); }, [tab, loadSeason]);

  /* everyone writes into the same shared storage, but nothing tells a phone that
     someone else has just put their picks in. so we go and look: on a timer while
     the app is in front of you, and the moment it comes back into view. */
  useEffect(() => {
    if (!league || !me) return;
    const awake = () => typeof document === "undefined" || !document.hidden;
    const pullPicks = () => { if (awake()) loadPicks(gw); };
    const pullSeason = () => { if (awake() && (tab === "season" || tab === "table")) loadSeason(); };
    const wake = () => { pullPicks(); pullSeason(); };

    pullPicks();
    if (tab === "season" || tab === "table") pullSeason();

    // fast where other people's entries are actually on screen, slow elsewhere
    const near = tab === "scores" || tab === "table" || tab === "admin";
    const a = setInterval(pullPicks, near ? 15e3 : 60e3);
    const b = setInterval(pullSeason, 45e3);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(a);
      clearInterval(b);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [league, me, gw, tab, loadPicks, loadSeason]);
  // matchweek 1's first kick-off is the cut-off for the season calls
  useEffect(() => {
    if (gw === 1 && fixtures?.fixtures) setSeasonDeadline(deadlineOf(fixtures.fixtures));
  }, [fixtures, gw]);

  const saveSeasonAnswers = useCallback(async (obj) => {
    if (seasonShutFor(season, me.id, seasonDeadline, league?.currentGw || 1)) {
      toast("Season predictions are closed", "err");
      return false;
    }
    const clean = {};
    Object.entries(obj || {}).forEach(([k, v]) => {
      const t = String(v || "").trim().slice(0, 60);
      if (t) clean[k] = t;
    });
    const rec = { playerId: me.id, answers: clean, updatedAt: Date.now() };
    if (!(await sSet(K.sAns(me.id), rec))) { toast("Couldn't save those", "err"); return false; }
    setSAnswers((prev) => ({ ...prev, [me.id]: clean }));
    toast("Season answers saved — you can still edit them");
    return true;
  }, [me, league, season, seasonDeadline, toast]);

  const saveSeasonQuestions = useCallback(async (rows) => {
    const qs = (rows || [])
      .map((r) => ({ id: r?.id || `q${uid()}`, text: String(r?.text || "").trim().slice(0, 90) }))
      .filter((q) => q.text)
      .slice(0, QLIMIT);
    // a question that's gone takes its ticks with it, so the tallies stay honest
    const live = new Set(qs.map((q) => q.id));
    const marks = {};
    Object.entries(season?.marks || {}).forEach(([pid, qmap]) => {
      const kept = {};
      Object.entries(qmap || {}).forEach(([qid, m]) => { if (live.has(qid)) kept[qid] = m; });
      if (Object.keys(kept).length) marks[pid] = kept;
    });
    const next = { ...(season || emptySeason()), questions: qs, marks, updatedAt: Date.now() };
    if (!(await sSet(K.season, next))) { toast("Couldn't save the questions", "err"); return false; }
    setSeason(next);
    toast(`${qs.length} question${qs.length === 1 ? "" : "s"} saved`);
    return true;
  }, [season, toast]);

  const toggleSeasonMark = useCallback(async (pid, qid, verdict) => {
    const marks = { ...(season?.marks || {}) };
    const forP = { ...(marks[pid] || {}) };
    // pressing the mark it already has clears it back to undecided
    if (verdictOf(forP[qid]) === verdict) delete forP[qid];
    else forP[qid] = { v: verdict, gw: league?.currentGw || 1 };
    marks[pid] = forP;
    const next = { ...(season || emptySeason()), marks, updatedAt: Date.now() };
    if (!(await sSet(K.season, next))) { toast("Couldn't save that mark", "err"); return; }
    setSeason(next);
  }, [season, league, toast]);

  const setSeasonOpen = useCallback(async (pid, val) => {
    const open = { ...(season?.open || {}) };
    if (val === null) delete open[pid];
    else open[pid] = !!val;
    const next = { ...(season || emptySeason()), open, updatedAt: Date.now() };
    if (!(await sSet(K.season, next))) { toast("Couldn't change that", "err"); return; }
    setSeason(next);
    const who = league?.players?.find((x) => x.id === pid)?.name || "That player";
    toast(val === null ? `${who} back on the normal deadline` : val ? `${who} can edit again` : `${who} is locked`);
  }, [season, league, toast]);

  const bonus = seasonTally(season);

  /* ---- standings ---- */
  const liveGwPoints = useCallback(() => {
    const out = {};
    (league?.players || []).forEach((p) => { out[p.id] = 0; });
    (fixtures?.fixtures || []).forEach((f) => {
      Object.entries(allPreds).forEach(([pid, picks]) => {
        if (out[pid] == null) return;
        out[pid] += pointsFor(picks?.[f.id], f);
      });
    });
    // whatever the admin has put right by hand
    Object.entries(adjust || {}).forEach(([pid, n]) => {
      if (out[pid] != null) out[pid] += +n || 0;
    });
    return out;
  }, [league, fixtures, allPreds, adjust]);

  const gwPts = liveGwPoints();
  const standings = (league?.players || []).map((p) => {
    const thisWeek = gwPts[p.id] || 0;
    let total = 0;
    // only weeks we've actually reached count — same rule as the table columns
    Object.entries(ledger.byGw || {}).forEach(([g, m]) => {
      if (+g !== gw && +g >= 1 && +g <= gw) total += m[p.id] || 0;
    });
    // the season-long calls the admin has ticked, banked in the week they landed
    let extra = 0;
    Object.entries(bonus.byGw || {}).forEach(([g, m]) => {
      if (+g >= 1 && +g <= gw) extra += m[p.id] || 0;
    });
    return { id: p.id, name: p.name, gw: thisWeek, total: total + thisWeek + extra };
  });

  /* ---- keep the ledger in step ---- */
  useEffect(() => {
    if (!league || !fixtures) return;
    const current = ledger.byGw?.[gw] || {};
    const fresh = gwPts;
    const wasDone = !!ledger.done?.[gw];
    const nowDone = fixtures.fixtures.length > 0 && fixtures.fixtures.every(isFinished);
    const same = Object.keys(fresh).every((k) => current[k] === fresh[k]) &&
      Object.keys(current).length === Object.keys(fresh).length && wasDone === nowDone;
    if (same) return;
    const complete = fixtures.fixtures.length > 0 && fixtures.fixtures.every(isFinished);
    (async () => {
      // merge onto what's actually stored, so weeks this device never loaded survive
      const stored = (await sGet(K.ledger)) || {};
      const next = {
        byGw: { ...(stored.byGw || {}), ...(ledger.byGw || {}), [gw]: fresh },
        done: { ...(stored.done || {}), ...(ledger.done || {}), [gw]: complete },
        // remember when each week's deadline was, so the table can tell a week
        // that has actually started from one the matchweek counter ran ahead to
        ko: { ...(stored.ko || {}), ...(ledger.ko || {}), [gw]: deadlineOf(fixtures.fixtures) },
        updatedAt: Date.now(),
      };
      setLedger(next);
      await sSet(K.ledger, next);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtures, allPreds, league, gw, adjust]);

  /* ---- pulling fixtures & scores ---- */
  // a fixture dropped from the week would leave everyone's pick for it stranded
  const prunePicks = useCallback(async (n, list) => {
    const live = new Set((list || []).map((f) => f.id));
    const keys = await sList(K.predsPrefix(n));
    for (const key of keys) {
      const rec = await sGet(key);
      if (!rec?.picks) continue;
      const kept = {};
      Object.entries(rec.picks).forEach(([fid, v]) => { if (live.has(fid)) kept[fid] = v; });
      if (Object.keys(kept).length !== Object.keys(rec.picks).length) {
        await sSet(key, { ...rec, picks: kept, updatedAt: Date.now() });
      }
    }
  }, []);

  const pullFixtures = useCallback(async (n, silent) => {
    if (!silent) setBusy(true);
    try {
      const txt = await askClaude(
        `Search the web for the English Premier League ${league?.season || "2026/27"} season fixture list for Matchweek ${n}. ` +
        `Reply with ONLY a JSON array and nothing else — no prose, no markdown fences. ` +
        `Format: [{"h":"Home team","a":"Away team","ko":"2026-08-15T19:00:00Z"}]. ` +
        `Use full club names, UTC kick-off times, and include every match in that matchweek.`
      );
      const arr = parseJsonBlock(txt);
      if (!arr?.length) { if (!silent) toast("Couldn't read a fixture list — try again", "err"); return null; }
      const existing = (await sGet(K.fixtures(n)))?.fixtures || [];
      const list = arr.slice(0, 20).map((f) => {
        const prev = existing.find((e) => e.h === f.h && e.a === f.a);
        return {
          id: prev?.id || uid(),
          h: String(f.h).slice(0, 30),
          a: String(f.a).slice(0, 30),
          ko: f.ko || prev?.ko || null,
          hs: prev?.hs ?? null,
          as: prev?.as ?? null,
          status: prev?.status || "upcoming",
        };
      });
      const rec = { gw: n, fixtures: list, updatedAt: Date.now() };
      await sSet(K.fixtures(n), rec);
      await prunePicks(n, list);
      if (n === gw) { setFixtures(rec); await loadWeek(n); }
      if (!silent) toast(`${list.length} fixtures loaded for MW ${n}`);
      return rec;
    } catch {
      if (!silent) toast("Fixture lookup failed", "err");
      return null;
    } finally {
      if (!silent) setBusy(false);
    }
  }, [league, gw, toast, prunePicks, loadWeek]);

  const refreshScores = useCallback(async (silent) => {
    const fx = fixtures;
    if (!fx?.fixtures?.length) { if (!silent) toast("No fixtures to check", "err"); return; }
    if (!silent) setBusy(true);
    try {
      const listStr = fx.fixtures.map((f, i) => `${i}: ${f.h} v ${f.a}`).join("; ");
      const txt = await askClaude(
        `Search the web for the current scores in these English Premier League matches (${league?.season || "2026/27"} season, matchweek ${fx.gw}): ${listStr}. ` +
        `Reply with ONLY a JSON array and nothing else — no prose, no fences. ` +
        `Format: [{"i":0,"hs":2,"as":1,"st":"finished"}]. ` +
        `"st" is one of upcoming, live, finished. Use null for hs and as if the match has not kicked off. Include every index.`
      );
      const arr = parseJsonBlock(txt);
      if (!arr?.length) { if (!silent) toast("No score update found", "err"); return; }
      const list = fx.fixtures.map((f, i) => {
        const u = arr.find((x) => +x.i === i);
        if (!u) return f;
        return {
          ...f,
          hs: u.hs == null ? f.hs : Math.max(0, Math.min(20, +u.hs)),
          as: u.as == null ? f.as : Math.max(0, Math.min(20, +u.as)),
          status: ["upcoming", "live", "finished"].includes(u.st) ? u.st : f.status,
        };
      });
      const rec = { ...fx, fixtures: list, updatedAt: Date.now() };
      await sSet(K.fixtures(fx.gw), rec);
      setFixtures(rec);
      if (!silent) toast("Scores updated");
    } catch {
      if (!silent) toast("Score check failed", "err");
    } finally {
      if (!silent) setBusy(false);
    }
  }, [fixtures, league, toast]);

  /* ---- the real Premier League: standings, scorers, assists ---- */
  const eplRunning = useRef(false);
  const runEplPull = useCallback(async (silent) => {
    const season = league?.season || "2026/27";
    const num = (v) => (Number.isFinite(+v) ? Math.max(-200, Math.min(200, Math.round(+v))) : 0);
    const str = (v) => String(v ?? "").slice(0, 34);
    const notes = [];
    let table = [], scorers = [], assists = [];

    // rows come back as bare arrays: a full twenty-club table written as objects
    // overran the reply limit and arrived truncated, which parsed as nothing
    // the scorers lookup comes back as an object and the table as an array, and
    // the parser will happily find an array nested inside an object — so say which
    const askRows = async (prompt, tokens, want = "[") => {
      let last = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const txt = await askClaude(attempt === 0 ? prompt : prompt + " Reply with the JSON only. No commentary, no explanation.", tokens);
          last = txt || "";
          const parsed = want === "{"
            ? parseJsonObject(txt) || parseJsonBlock(txt)
            : parseJsonBlock(txt) || parseJsonObject(txt);
          if (parsed) return parsed;
        } catch (e) {
          last = String(e?.message || e);
        }
      }
      notes.push(last ? `unreadable reply (${last.slice(0, 60)}…)` : "no reply");
      return null;
    };

    const today = new Date().toISOString().slice(0, 10);
    const tbl = await askRows(
      `Today is ${today}. Search the web for the current English Premier League ${season} league table. ` +
      `Reply with ONLY a JSON array, no prose, no fences: ` +
      `[["Club",played,won,drawn,lost,goalDifference,points]] — one row per club, league order, all twenty. ` +
      `No header row. If not a single match has been played yet, reply []`,
      4000, "["
    );
    const tblRows = Array.isArray(tbl) ? tbl : Array.isArray(tbl?.table) ? tbl.table : null;
    if (tblRows) {
      const HEADERS = ["club", "team", "pos", "position", "p", "pl", "played", "pts", "points", "gd", "w", "d", "l"];
      table = tblRows
        .map((r) => (Array.isArray(r)
          ? { team: str(r[0]), p: r[1], w: r[2], d: r[3], l: r[4], gd: r[5], pts: r[6] }
          : { team: str(r.team || r.club), p: r.p ?? r.played, w: r.w ?? r.won, d: r.d ?? r.drawn, l: r.l ?? r.lost, gd: r.gd, pts: r.pts ?? r.points }))
        // a column-heading row arrives looking like a club with letters where the
        // numbers should be — drop it before trimming, or the real last club is lost
        .filter((t) => t.team
          && !HEADERS.includes(t.team.trim().toLowerCase())
          && Number.isFinite(+t.p) && Number.isFinite(+t.pts) && String(t.p).trim() !== "")
        .slice(0, 20)
        .map((t, i) => ({
          pos: i + 1, team: t.team,
          p: num(t.p), w: num(t.w), d: num(t.d), l: num(t.l), gd: num(t.gd), pts: num(t.pts),
        }));
    }

    // Goals and assists used to go out as one request for one object keyed
    // "scorers" and "assists". Any other wording back — top_scorers, topScorers,
    // goalscorers, or the two lists simply handed over as arrays — read as
    // nothing at all, and the tab sat empty while the table beside it filled in.
    // So: one plain array each, the same shape the table asks for and gets, and
    // a reader that takes the list however it is labelled.
    const listIn = (v, ...names) => {
      if (Array.isArray(v)) return v;
      if (!v || typeof v !== "object") return [];
      const keys = Object.keys(v);
      for (const want of names) {
        const hit = keys.find((k) => k.toLowerCase().replace(/[^a-z]/g, "") === want);
        if (hit && Array.isArray(v[hit])) return v[hit];
      }
      // one array in there and nothing else it could be — take it
      const arrays = keys.filter((k) => Array.isArray(v[k]));
      return arrays.length === 1 ? v[arrays[0]] : [];
    };
    const rows = (list) => (Array.isArray(list) ? list : [])
      .map((r) => (Array.isArray(r)
        ? { name: str(r[0]), team: str(r[1]), raw: r.slice(2).find((v) => Number.isFinite(+v) && String(v).trim() !== "") }
        : {
          name: str(r?.name || r?.player || r?.playerName),
          team: str(r?.team || r?.club || r?.squad),
          raw: r?.goals ?? r?.assists ?? r?.n ?? r?.total ?? r?.count,
        }))
      .filter((x) => x.name
        && !["player", "name", "rank", "pos"].includes(x.name.trim().toLowerCase())
        && Number.isFinite(+x.raw) && String(x.raw).trim() !== "")
      .slice(0, 10)
      .map((x) => ({ name: x.name, team: x.team, n: num(x.raw) }));

    const askPlayers = async (what, label, ...aliases) => {
      const got = await askRows(
        `Today is ${today}. Search the web for the current English Premier League ${season} top ${what}. ` +
        `Reply with ONLY a JSON array, no prose, no fences, no wrapper object: ` +
        `[["Player name","Club",${label}]] — the top ten, best first, no header row. ` +
        `If not a single match has been played yet, reply []`,
        2200, "["
      );
      return rows(listIn(got, ...aliases));
    };

    scorers = (await askPlayers("goalscorers", "goals", "scorers", "goalscorers", "topscorers", "players"))
      .map((x) => ({ name: x.name, team: x.team, goals: x.n }));
    assists = (await askPlayers("assist providers", "assists", "assists", "assistproviders", "topassists", "players"))
      .map((x) => ({ name: x.name, team: x.team, assists: x.n }));

    if (!table.length && !scorers.length && !assists.length) {
      const why = notes[0] || "nothing came back";
      const rec = { table: [], scorers: [], assists: [], error: why, updatedAt: Date.now() };
      await sSet(K.epl, rec);
      setEpl(rec);
      if (!silent) toast("League lookup came back empty", "err");
      return;
    }
    const rec = { table, scorers, assists, error: notes[0] || "", updatedAt: Date.now() };
    await sSet(K.epl, rec);
    setEpl(rec);
    if (!silent) toast(table.length ? "League data updated" : "Player lists updated");
  }, [league, toast]);

  // a throw anywhere in the lookup used to leave the busy flag stuck on, which
  // disabled the Refresh button for the rest of the session and quietly blocked
  // every later attempt — clear it whatever happens
  const pullEpl = useCallback(async (silent) => {
    if (eplRunning.current) return;
    eplRunning.current = true;
    setEplBusy(true);
    try {
      await runEplPull(silent);
    } catch {
      if (!silent) toast("League lookup failed", "err");
    } finally {
      eplRunning.current = false;
      setEplBusy(false);
    }
  }, [runEplPull, toast]);

  // freshen it when someone opens the table, at most every half hour
  useEffect(() => {
    if (!league || !me || tab !== "table") return;
    // good data keeps for half an hour; a lookup that came back empty is worth
    // another go much sooner, or the tab stays blank all evening
    const nothing = !epl?.table?.length && !epl?.scorers?.length && !epl?.assists?.length;
    // a table with no scorers alongside it means the player half of the lookup
    // came back short — worth another go before the usual half hour is up
    const halfThere = !!epl?.table?.length && !epl?.scorers?.length;
    const keepFor = nothing ? 3 * 60e3 : halfThere ? 10 * 60e3 : 30 * 60e3;
    if (Date.now() - (epl?.updatedAt || 0) < keepFor) return;
    if (Date.now() - autoRef.current.epl < 60e3) return;
    autoRef.current.epl = Date.now();
    pullEpl(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, league, me, epl]);

  /* ---- automatic housekeeping ---- */
  // works out which matchweek is on, loads its fixtures and any scores
  const autoSync = useCallback(async () => {
    if (!league) return;
    try {
      const txt = await askClaude(
        `Search the web for the English Premier League ${league.season} season. Work out which matchweek is in progress right now, or if none is in progress, which matchweek is next. ` +
        `Reply with ONLY a JSON object and nothing else — no prose, no fences. ` +
        `Format: {"gw":3,"fixtures":[{"h":"Home team","a":"Away team","ko":"2026-08-15T14:00:00Z","hs":null,"as":null,"st":"upcoming"}]}. ` +
        `Include every match in that matchweek, full club names, UTC kick-off times, hs and as as the current score or null if it has not kicked off, st as upcoming, live or finished.`
      );
      const obj = parseJsonObject(txt);
      const n = Math.max(1, Math.min(38, +obj?.gw || 0));
      if (!n || !Array.isArray(obj.fixtures) || !obj.fixtures.length) return;
      const existing = (await sGet(K.fixtures(n)))?.fixtures || [];
      const list = obj.fixtures.slice(0, 20).map((f) => {
        const prev = existing.find((e) => e.h === f.h && e.a === f.a);
        return {
          id: prev?.id || uid(),
          h: String(f.h).slice(0, 30),
          a: String(f.a).slice(0, 30),
          ko: f.ko || prev?.ko || null,
          hs: f.hs == null ? prev?.hs ?? null : Math.max(0, Math.min(20, +f.hs)),
          as: f.as == null ? prev?.as ?? null : Math.max(0, Math.min(20, +f.as)),
          status: ["upcoming", "live", "finished"].includes(f.st) ? f.st : prev?.status || "upcoming",
        };
      });
      const rec = { gw: n, fixtures: list, updatedAt: Date.now() };
      await sSet(K.fixtures(n), rec);
      // the lookup can run ahead of us — move on at most one week at a time, and
      // only once the week we're on has actually finished
      const here = await sGet(K.fixtures(league.currentGw));
      const hereDone = !!here?.fixtures?.length && here.fixtures.every(isFinished);
      const step = n > league.currentGw && hereDone ? league.currentGw + 1 : league.currentGw;
      const target = Math.max(league.currentGw, Math.min(n, step));
      const nextLeague = { ...league, currentGw: target, syncedAt: Date.now() };
      await sSet(K.league, nextLeague);
      setLeague(nextLeague);
      if (n === target) setFixtures(rec);
    } catch {
      /* leave whatever is already stored in place */
    }
  }, [league]);

  useEffect(() => {
    if (!league || !me || loading || autoRef.current.pulled) return;
    const stale = Date.now() - (league.syncedAt || 0) > 6 * 3600e3;
    if (fixtures === null || stale) {
      autoRef.current.pulled = true;
      autoSync();
    }
  }, [league, me, loading, fixtures, autoSync]);

  useEffect(() => {
    if (!fixtures?.fixtures?.length) return;
    // catch up on any match that has kicked off and still has no final score —
    // games played while nobody had the app open would otherwise never fill in
    const owing = fixtures.fixtures.some((f) => !isFinished(f) && Date.now() >= koTime(f));
    if (!owing) return;
    if (Date.now() - autoRef.current.scored > 120e3) {
      autoRef.current.scored = Date.now();
      refreshScores(true);
    }
    // while anything is actually in play, keep checking every three minutes
    if (!fixtures.fixtures.some(isLive)) return;
    const t = setInterval(() => { autoRef.current.scored = Date.now(); refreshScores(true); }, 180e3);
    return () => clearInterval(t);
  }, [fixtures, refreshScores]);

  // the day after the last match, load next week's fixtures so people can get their picks in
  useEffect(() => {
    if (!league || !me || !fixtures?.fixtures?.length || gw >= 38) return;
    if (autoRef.current.rolling) return;
    const all = fixtures.fixtures;
    if (!all.every(isFinished)) return;
    const lastEnd = Math.max(...all.map(koTime)) + 2 * 3600e3;
    const openAt = new Date(lastEnd);
    openAt.setDate(openAt.getDate() + 1);
    openAt.setHours(6, 0, 0, 0);
    if (Date.now() < openAt.getTime()) return;
    autoRef.current.rolling = true;
    (async () => {
      await pullFixtures(gw + 1, true);
      const next = { ...league, currentGw: gw + 1, syncedAt: Date.now() };
      if (await sSet(K.league, next)) setLeague(next);
      autoRef.current.rolling = false;
    })();
  }, [league, me, fixtures, gw, pullFixtures]);
  /* ---- saving predictions ---- */
  const savePicks = useCallback(async (picks) => {
    if (gwShutFor(gwOpen, me.id, deadlineOf(fixtures?.fixtures))) return false;
    const rec = { playerId: me.id, gw, picks, updatedAt: Date.now() };
    if (!(await sSet(K.preds(gw, me.id), rec))) return false;
    // read it straight back: a write that silently didn't land must not look saved
    const back = await sGet(K.preds(gw, me.id));
    const wrote = back?.picks || {};
    const good = Object.keys(picks).every((k) => wrote[k]?.h === picks[k].h && wrote[k]?.a === picks[k].a);
    if (!good) return false;
    setAllPreds((p) => ({ ...p, [me.id]: picks }));
    return true;
  }, [me, gw, gwOpen, fixtures]);

  const setAdjustFor = useCallback(async (pid, val, week) => {
    const g = Math.max(1, Math.min(38, +week || gw));
    const n = Math.max(-200, Math.min(200, Math.round(+val || 0)));
    const map = g === gw ? (adjust || {}) : ((await sGet(K.adjust(g))) || {});
    const before = +(map[pid] || 0);
    const next = { ...map };
    if (n === 0) delete next[pid];
    else next[pid] = n;
    if (!(await sSet(K.adjust(g), next))) { toast("Couldn't save that", "err"); return; }
    if (g === gw) {
      setAdjust(next);
    } else {
      // a past week isn't recalculated by the app, so move its stored points by the difference
      const stored = (await sGet(K.ledger)) || {};
      const week0 = { ...(stored.byGw?.[g] || {}) };
      week0[pid] = Math.max(-999, (week0[pid] || 0) - before + n);
      const merged = { ...stored, byGw: { ...(stored.byGw || {}), [g]: week0 }, updatedAt: Date.now() };
      if (await sSet(K.ledger, merged)) setLedger(merged);
    }
    const who = league?.players?.find((x) => x.id === pid)?.name || "That player";
    toast(n === 0 ? `${who}'s MW ${g} adjustment cleared` : `${who} ${n > 0 ? "+" : ""}${n} for MW ${g}`);
  }, [adjust, gw, league, toast]);

  const setGwOpenFor = useCallback(async (pid, val) => {
    const next = { ...(gwOpen || {}) };
    if (val === null) delete next[pid];
    else next[pid] = !!val;
    if (!(await sSet(K.gwOpen(gw), next))) { toast("Couldn't change that", "err"); return; }
    setGwOpen(next);
    const who = league?.players?.find((x) => x.id === pid)?.name || "That player";
    toast(val === null ? `${who} back on the normal deadline` : val ? `${who} can edit MW ${gw}` : `${who} is locked`);
  }, [gwOpen, gw, league, toast]);

  /* ---- render ---- */
  const face = fontOf(league?.font);
  const skin = themeOf(league?.theme);
  const deadline = deadlineOf(fixtures?.fixtures);
  const tabs = me
    ? [
        { id: "predict", label: "Predict", c: "red" },
        { id: "scores", label: "Scores", c: "green" },
        { id: "table", label: "Table", c: "yellow" },
        { id: "season", label: "Season", c: "magenta" },
        ...(me.admin ? [{ id: "admin", label: "Admin", c: "cyan" }] : []),
      ]
    : [];

  const shell = (children) => (
    <div className="pp" style={{ "--display": face.d, "--body": face.b, "--tr": face.tr, ...skin.v }}>
      <style>{CSS}</style>
      <div className="topstack">
        <div className="tt-bar">
          <div className="tt-bar-in">
            <Crest theme={league?.theme} />
            <span className="tt-title">Pres Prem Predictor</span>
            <span className="tt-meta">{league ? `Matchweek ${gw}` : "Setup"}</span>
            {me ? <button className="signout" onClick={signOut}>{me.name} · Sign out</button> : null}
          </div>
        </div>
        {tabs.length > 0 && (
          <nav className="fastext">
            <div className="fastext-in">
              {tabs.map((t) => (
                <button key={t.id} data-c={t.c} className={"ft-btn" + (tab === t.id ? " on" : "")}
                  onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
          </nav>
        )}
        {me && deadline ? <TzBar at={deadline} /> : null}
      </div>
      {children}
      <Toast msg={toastMsg?.msg} kind={toastMsg?.kind} />
    </div>
  );

  if (!hasStore()) return shell(<div className="wrap"><div className="empty">This app needs its saved data to run, and storage isn't available here. Open it from the chat it was created in.</div></div>);
  if (loading) return shell(<div className="wrap"><div className="empty">Loading the league…</div></div>);
  if (!league) return shell(<Setup onDone={setLeague} toast={toast} />);
  if (needsRepair(league)) {
    return shell(
      <Repair league={league} toast={toast}
        onDone={async (l) => { await pDel(WHOAMI); setMe(null); setLeague(l); }} />
    );
  }
  if (!me) return shell(<Login league={league} onIn={signIn} toast={toast} />);

  return shell(
    <>
      {tab === "predict" && <Predict league={league} gw={gw} fixtures={fixtures} myPicks={allPreds[me.id]} onSave={savePicks} toast={toast} me={me} gwOpen={gwOpen} />}
      {tab === "scores" && <Scores league={league} gw={gw} fixtures={fixtures} allPreds={allPreds}
        onRefresh={() => { loadPicks(gw); refreshScores(false); }} refreshing={busy} />}
      {tab === "season" && (
        <Season league={league} me={me} season={season} answers={sAnswers} deadline={seasonDeadline}
          gw={gw} bonus={bonus} onSaveAnswers={saveSeasonAnswers} onSaveQuestions={saveSeasonQuestions}
          onToggleMark={toggleSeasonMark} onSetOpen={setSeasonOpen} />
      )}
      {tab === "table" && (
        <Table league={league} gw={gw} standings={standings} me={me} ledger={ledger} bonusByGw={bonus.byGw}
          epl={epl} onRefreshEpl={() => pullEpl(false)} eplBusy={eplBusy}
          settled={!!fixtures?.fixtures?.length && fixtures.fixtures.every(isFinished)} />
      )}
      {tab === "admin" && me.admin && (
        <Admin league={league} setLeague={setLeague} gw={gw} fixtures={fixtures} setFixtures={setFixtures}
          toast={toast} pullFixtures={pullFixtures} refreshScores={refreshScores} autoSync={autoSync} busy={busy}
          allPreds={allPreds} gwOpen={gwOpen} onSetGwOpen={setGwOpenFor}
          gwPts={gwPts} adjust={adjust} onSetAdjust={setAdjustFor} ledger={ledger} />
      )}
    </>
  );
}
