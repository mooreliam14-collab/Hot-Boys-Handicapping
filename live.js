/* Hot Boys Handicapping — live grading from ESPN's public feed, run in the viewer's browser.
   Weeks marked complete in data/weeks.json are final and never touched.
   For the open week, each bet with a "spec" is graded from live ESPN stats:
     player bet: {kind:"player", player:"Zay Flowers", stat:"recYds", op:">=" | ">", line:70}
       stat: rec, recYds, car, rushYds, passYds, passTD, fgMade, totalTD
     moneyline:  {kind:"ml", team:"PIT"}
     spread:     {kind:"spread", team:"LV", line:3.5}
     total:      {kind:"total", side:"over" | "under", line:39.5}
     team total: {kind:"teamTotal", team:"DET", side:"over" | "under", line:29.5}
*/
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const ALIAS = { WAS: "WSH", LA: "LAR" };
const UNIT = { rec: "rec", recYds: "yds", car: "car", rushYds: "yds", passYds: "yds", passTD: "pass TD", fgMade: "FG", totalTD: "TD" };
const LIVE_POLL_MS = 15000, IDLE_POLL_MS = 60000;

function espnAbbr(a) { return ALIAS[a] || a; }
function n(v) { const x = parseFloat(v); return isNaN(x) ? 0 : x; }

function fmtClock(s) {
  if (!s) return "";
  if (/half/i.test(s)) return "Half";
  const m = /^(\d+:\d+)\s*-\s*(1st|2nd|3rd|4th|OT)/i.exec(s);
  if (m) return (m[2].toUpperCase() === "OT" ? "OT" : "Q" + m[2][0]) + " · " + m[1];
  const e = /^End of (\d)/i.exec(s);
  if (e) return "End Q" + e[1];
  return s;
}

function parsePlayers(summary) {
  const out = {};
  for (const team of (summary.boxscore && summary.boxscore.players) || []) {
    for (const cat of team.statistics || []) {
      const labels = cat.labels || [];
      for (const a of cat.athletes || []) {
        const name = a.athlete.displayName;
        const s = {}; labels.forEach((l, i) => (s[l] = (a.stats || [])[i]));
        const p = out[name] || (out[name] = { rec: 0, recYds: 0, recTD: 0, car: 0, rushYds: 0, rushTD: 0, passYds: 0, passTD: 0, fgMade: 0, retTD: 0 });
        if (cat.name === "receiving") Object.assign(p, { rec: n(s.REC), recYds: n(s.YDS), recTD: n(s.TD) });
        else if (cat.name === "rushing") Object.assign(p, { car: n(s.CAR), rushYds: n(s.YDS), rushTD: n(s.TD) });
        else if (cat.name === "passing") Object.assign(p, { passYds: n(s.YDS), passTD: n(s.TD) });
        else if (cat.name === "kicking") p.fgMade = n(String(s.FG || "0/0").split("/")[0]);
        else if (["kickReturns", "puntReturns", "interceptions"].includes(cat.name)) p.retTD += n(s.TD);
      }
    }
  }
  for (const p of Object.values(out)) p.totalTD = p.rushTD + p.recTD + p.retTD;
  return out;
}

function findPlayer(players, name) {
  if (players[name]) return players[name];
  const want = name.toLowerCase().replace(/[^a-z ]/g, "");
  const hits = Object.keys(players).filter(k => k.toLowerCase().replace(/[^a-z ]/g, "").includes(want));
  return hits.length === 1 ? players[hits[0]] : null;
}

function detailFor(spec, p) {
  if (!p) return "";
  if (spec.stat === "rec" || spec.stat === "recYds") return `${p.rec} rec, ${p.recYds} yds` + (p.recTD ? `, ${p.recTD} TD` : "");
  if (spec.stat === "car" || spec.stat === "rushYds") return `${p.car} car, ${p.rushYds} yds` + (p.rushTD ? `, ${p.rushTD} TD` : "");
  if (spec.stat === "passYds" || spec.stat === "passTD") return `${p.passYds} pass yds, ${p.passTD} TD`;
  if (spec.stat === "fgMade") return `${p.fgMade} FG made`;
  if (spec.stat === "totalTD") return p.totalTD ? `${p.totalTD} TD` : "No TD";
  return "";
}

function gradeBet(bet, g, players) {
  const s = bet.spec; if (!s) return;
  const live = g.status === "live", fin = g.status === "final";
  if (!live && !fin) return;
  const tag = live ? " (in progress)" : "";
  if (s.kind === "player") {
    const p = findPlayer(players, s.player);
    if (!p) {
      if (fin) { bet.status = "review"; bet.detail = "No stats recorded. Checking if he was active."; }
      return;
    }
    const cur = p[s.stat] || 0;
    const ok = s.op === ">" ? cur > s.line : cur >= s.line;
    bet.progress = { current: cur, line: s.line, unit: UNIT[s.stat] || "", cleared: ok };
    bet.detail = detailFor(s, p) + tag;
    if (fin) bet.status = ok ? "hit" : "miss";
    return;
  }
  const mine = espnAbbr(s.team || "") === espnAbbr(g.home) ? g.homeScore : g.awayScore;
  const theirs = espnAbbr(s.team || "") === espnAbbr(g.home) ? g.awayScore : g.homeScore;
  if (s.kind === "ml") {
    bet.detail = (mine > theirs ? "Leading " : mine < theirs ? "Trailing " : "Tied ") + `${mine}–${theirs}` + tag;
    if (fin) { bet.status = mine > theirs ? "hit" : "miss"; bet.detail = (mine > theirs ? "Won " : "Lost ") + `${mine}–${theirs}`; }
  } else if (s.kind === "spread") {
    const m = mine + s.line - theirs;
    bet.detail = `${mine}–${theirs}, ${m > 0 ? "covering" : m < 0 ? "not covering" : "on the number"}` + tag;
    if (fin) bet.status = m > 0 ? "hit" : m < 0 ? "miss" : "push";
  } else if (s.kind === "teamTotal") {
    bet.detail = `${s.team} ${mine} pts` + tag;
    if (fin) bet.status = mine === s.line ? "push" : (s.side === "over" ? mine > s.line : mine < s.line) ? "hit" : "miss";
  } else if (s.kind === "total") {
    const t = g.homeScore + g.awayScore;
    bet.detail = `${t} total pts` + tag;
    if (fin) bet.status = t === s.line ? "push" : (s.side === "over" ? t > s.line : t < s.line) ? "hit" : "miss";
  }
}

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

/* Applies live ESPN data to the open week in place. Returns {anyLive, error}. */
async function applyLive(week, season) {
  const res = { anyLive: false, error: null };
  try {
    const sb = await getJSON(`${ESPN}/scoreboard?seasontype=2&week=${week.week}&dates=${season}`);
    const byPair = {};
    for (const ev of sb.events || []) {
      const c = ev.competitions[0];
      const side = {}; c.competitors.forEach(t => (side[t.homeAway] = t));
      byPair[side.away.team.abbreviation + "-" + side.home.team.abbreviation] = { ev, c, side };
    }
    const tasks = [];
    for (const g of week.games || []) {
      const bets = (week.bets || []).filter(b => b.game === g.id && b.spec && (b.status || "pending") === "pending");
      if (!bets.length) continue;
      const hit = byPair[espnAbbr(g.away) + "-" + espnAbbr(g.home)];
      if (!hit) continue;
      const st = hit.c.status.type.state;
      if (st === "pre") continue;
      g.status = st === "in" ? "live" : "final";
      g.awayScore = n(hit.side.away.score); g.homeScore = n(hit.side.home.score);
      g.ot = (hit.c.status.period || 0) > 4;
      g.clock = g.status === "live" ? fmtClock(hit.c.status.type.shortDetail) : undefined;
      g.situation = g.status === "live" && hit.c.situation ? hit.c.situation.downDistanceText || undefined : undefined;
      if (g.status === "live") res.anyLive = true;
      tasks.push((async () => {
        let players = {};
        try {
          const sm = await getJSON(`${ESPN}/summary?event=${hit.ev.id}`);
          players = parsePlayers(sm);
          if (g.status === "live" && !g.situation) {
            const plays = (((sm.drives || {}).current || {}).plays) || [];
            const last = plays[plays.length - 1];
            g.situation = (last && last.end && last.end.downDistanceText) || undefined;
          }
        } catch (e) { if (bets.some(b => b.spec.kind === "player")) return; }
        bets.forEach(b => gradeBet(b, g, players));
      })());
    }
    await Promise.all(tasks);
    const betGames = new Set((week.bets || []).map(b => b.game));
    const allFinal = (week.games || []).filter(g => betGames.has(g.id)).every(g => g.status === "final");
    const nonePending = (week.bets || []).every(b => !["pending", "review"].includes(b.status || "pending"));
    if (allFinal && nonePending) week.complete = true;
    week.updatedAt = new Date().toISOString();
  } catch (e) { res.error = e; }
  return res;
}
