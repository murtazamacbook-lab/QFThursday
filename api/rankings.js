// Vercel serverless function — proxies FIFA rankings API (server-side, no CORS)
// Cached by Vercel CDN for 1 hour (stale-while-revalidate up to 24h)

const FALLBACK = {
  'France':1,'Argentina':2,'Spain':3,'England':4,'Brazil':5,'Morocco':6,
  'Portugal':7,'Netherlands':8,'Belgium':9,'Mexico':10,'Germany':11,'Italy':12,
  'Croatia':13,'Japan':14,'United States':16,'Senegal':17,'Switzerland':18,'Colombia':19,
  'Uruguay':20,'South Korea':21,'Denmark':22,'Austria':23,'Australia':24,
  'Ecuador':25,'Canada':26,'Wales':27,'Poland':28,'Cameroon':29,'Serbia':30,
  'Ghana':31,'Qatar':32,'Tunisia':33,'Saudi Arabia':34,'Costa Rica':35,
  'Iran':36,'South Africa':37,'Egypt':38,'Algeria':39,'Nigeria':40,'Ivory Coast':41,
};

// FIFA API team name → our internal name
const NAME_MAP = {
  'Korea Republic':   'South Korea',
  "Côte d'Ivoire":    'Ivory Coast',
  "Cote d'Ivoire":    'Ivory Coast',
  'Bosnia and Herzegovina': 'Bosnia & Herz.',
  'IR Iran':          'Iran',
  'United States':    'United States',
  'Türkiye':          'Turkiye',
  'Turkey':           'Turkiye',
  'Curaçao':          'Curacao',
  'Cabo Verde':       'Cape Verde',
  'Congo DR':         'DR Congo',
  'Czechia':          'Czech Republic',
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const r = await fetch(
      'https://api.fifa.com/api/v3/ranking/FIFA?language=en&count=211',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; rankings-proxy/1.0)',
          'Accept': 'application/json',
        },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!r.ok) throw new Error(`FIFA API returned ${r.status}`);
    const data = await r.json();

    // Handle FIFA API v3 response format
    const results = data.Results || [];
    if (results.length < 10) throw new Error('Unexpected response structure');

    const rankings = {};
    results.forEach(item => {
      const rank = item.RankId;
      // Name is an array of translations; prefer en-GB
      const nameArr = item.Team?.Name || [];
      const name = (nameArr.find(n => n.Language === 'en-GB') || nameArr[0])?.Description;
      if (!name || !rank) return;
      const mapped = NAME_MAP[name] || name;
      rankings[mapped] = rank;
    });

    if (Object.keys(rankings).length >= 10) {
      return res.json({ rankings, source: 'live', ts: Date.now() });
    }
    throw new Error('Too few rankings parsed');

  } catch (_e) {
    // Silently fall back to hardcoded June 2026 rankings
    return res.json({ rankings: FALLBACK, source: 'fallback', ts: Date.now() });
  }
}
