// Vercel serverless function — ESPN match summary proxy
// Returns goals, cards, fouls in the exact shape the app uses
// Cache: 60s during live match, 1h after FT

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';

// Convert "90+3'" or "45'" → "MM:SS" string our scoring engine uses
function minuteToMMSS(clock) {
  if (!clock) return null;
  // ESPN gives e.g. "45'" or "90+2'" or just "45"
  const raw = String(clock).replace("'", '').trim();
  const plusIdx = raw.indexOf('+');
  let mins;
  if (plusIdx >= 0) {
    mins = parseInt(raw) + parseInt(raw.slice(plusIdx + 1)) || parseInt(raw);
  } else {
    mins = parseInt(raw) || 0;
  }
  return `${String(mins).padStart(2, '0')}:00`;
}

function parseDetails(data, homeTeam, awayTeam) {
  const comp = data.header?.competitions?.[0] || data.competitions?.[0];
  if (!comp) return null;

  const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
  const awayComp = comp.competitors?.find(c => c.homeAway === 'away');

  // ── Goals ───────────────────────────────────────────────────────
  const goals = [];
  (data.keyEvents || data.plays || [])
    .filter(e => e.scoringPlay || e.type?.text?.toLowerCase().includes('goal'))
    .forEach(e => {
      const teamId = e.team?.id;
      const isHome = homeComp?.team?.id === teamId;
      const scorer = e.participants?.[0]?.athlete?.shortName
        || e.participants?.[0]?.athlete?.displayName
        || e.athleteText
        || '';
      const time = minuteToMMSS(e.clock?.displayValue || e.period?.clock);
      if (!time) return;
      goals.push({
        scorer,
        time,
        team: isHome ? homeTeam : awayTeam,
        isHome,
      });
    });

  // ── Cards ────────────────────────────────────────────────────────
  let hY = 0, hR = 0, aY = 0, aR = 0;
  (data.keyEvents || data.plays || [])
    .filter(e => {
      const t = (e.type?.text || '').toLowerCase();
      return t.includes('yellow card') || t.includes('red card');
    })
    .forEach(e => {
      const teamId = e.team?.id;
      const isHome = homeComp?.team?.id === teamId;
      const t = (e.type?.text || '').toLowerCase();
      const isRed = t.includes('red');
      if (isHome) { isRed ? hR++ : hY++; } else { isRed ? aR++ : aY++; }
    });

  // ESPN also exposes stats per competitor — use them if available & more accurate
  const toStat = (comp, key) => {
    const s = comp?.statistics?.find(s => s.name === key || s.abbreviation === key);
    return s ? (parseInt(s.displayValue) || 0) : null;
  };
  const hYS = toStat(homeComp, 'yellowCards'); if (hYS !== null) hY = hYS;
  const hRS = toStat(homeComp, 'redCards');    if (hRS !== null) hR = hRS;
  const aYS = toStat(awayComp, 'yellowCards'); if (aYS !== null) aY = aYS;
  const aRS = toStat(awayComp, 'redCards');    if (aRS !== null) aR = aRS;

  // ── Fouls ────────────────────────────────────────────────────────
  let hF = toStat(homeComp, 'foulsCommitted') ?? toStat(homeComp, 'fouls') ?? 0;
  let aF = toStat(awayComp, 'foulsCommitted') ?? toStat(awayComp, 'fouls') ?? 0;

  return {
    goals,
    cards: { hY, hR, aY, aR },
    fouls: { hF, aF },
    source: 'espn',
    ts: Date.now(),
  };
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing event id' });

  // Short cache during live, long cache after FT
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

    const r = await fetch(`${ESPN_BASE}/summary?event=${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; qft-proxy/1.0)', Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`ESPN ${r.status}`);

    const data = await r.json();

    // Resolve team names from header
    const comp = data.header?.competitions?.[0] || data.competitions?.[0];
    const homeTeam = comp?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName || 'Home';
    const awayTeam = comp?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName || 'Away';

    const details = parseDetails(data, homeTeam, awayTeam);
    if (!details) throw new Error('Could not parse details');

    return res.json(details);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
