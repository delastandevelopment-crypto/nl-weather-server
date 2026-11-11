// NL Fishing weather server.
// Fetches Environment and Climate Change Canada (ECCC) data, caches it for 15 minutes,
// and returns a WeatherReport for the app.
//
// Routes:
//   GET /weather?lat=..&lon=..   WeatherReport for the app (needs translateToReport finished)
//   GET /raw?lat=..&lon=..       the unchanged ECCC response, for checking fields while building
//
// Run with Node 20 or newer. No packages to install:  node server.mjs

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const ECCC_ITEMS = 'https://api.weather.gc.ca/collections/citypageweather-realtime/items';
const CACHE_MS = 15 * 60 * 1000;
const cache = new Map();

// Small box around the point. ECCC's API filters by bbox: minX, minY, maxX, maxY.
function bboxFor(lat, lon, pad = 0.25) {
  return [lon - pad, lat - pad, lon + pad, lat + pad].map((n) => n.toFixed(4)).join(',');
}

async function fetchEccc(lat, lon) {
  const url = `${ECCC_ITEMS}?f=json&bbox=${bboxFor(lat, lon)}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const res = await fetch(url, {headers: {accept: 'application/json'}});
  if (!res.ok) throw new Error(`ECCC returned HTTP ${res.status}`);
  const data = await res.json();
  cache.set(url, {at: Date.now(), data});
  return data;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Reads the English value of an ECCC field such as {en: 'Light Drizzle', fr: '...'}.
const en = (node) => node?.en ?? null;

// The ECCC forecast has no calendar dates, so each weekday name is matched to the next
// matching day on or after the previous one, starting from today in Newfoundland time (UTC-3:30).
function nextDateForWeekday(fromIso, weekdayIndex) {
  const d = new Date(`${fromIso}T00:00:00Z`);
  while (d.getUTCDay() !== weekdayIndex) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function translateToReport(upstream, _lat, _lon) {
  const feature = upstream.features?.[0];
  if (!feature) throw new Error('ECCC returned no city forecast for this point.');
  const p = feature.properties;

  // Current conditions
  const cc = p.currentConditions;
  const now = {
    temperatureC: cc.temperature.value.en,
    condition: en(cc.condition),
    windKmh: cc.wind.speed.value.en,
    windDirection: en(cc.wind.direction.value),
    gustKmh: cc.wind.gust?.value?.en ?? 0,
    pressureKpa: cc.pressure.value.en,
  };

  // Daily forecast. ECCC lists "day" periods and "night" periods separately, so each day's
  // high comes from its day period and its low from the night period that follows it.
  const fg = p.forecastGroup;
  const startUtc = Date.parse(en(fg.timestamp)) - 3.5 * 60 * 60 * 1000;
  const todayIso = new Date(startUtc).toISOString().slice(0, 10);
  const entries = fg.forecasts;
  const daily = [];

  for (let i = 0; i < entries.length; i++) {
    const f = entries[i];
    const name = en(f.period?.textForecastName) ?? '';
    if (/night|tonight/i.test(name)) continue; // consumed as the low for the day before it

    const weekdayIndex = WEEKDAYS.indexOf(name);
    if (weekdayIndex === -1) continue;

    const date = nextDateForWeekday(daily.length ? daily.at(-1).date : todayIso, weekdayIndex);
    if (daily.length && date <= daily.at(-1).date) continue;

    const night = entries[i + 1];
    const nightIsNext = night && /night/i.test(en(night.period?.textForecastName) ?? '');
    const high = f.temperatures?.temperature?.find((t) => t.class?.en === 'high')?.value?.en;
    const low = (nightIsNext ? night : f)
      .temperatures?.temperature?.find((t) => t.class?.en === 'low')?.value?.en;

    // ECCC gives the chance of precipitation as text, e.g. "...with 60 percent chance of showers."
    const precipText = en(f.cloudPrecip) ?? '';
    const precipMatch = /(\d+) percent/.exec(precipText);

    daily.push({
      date,
      label: date === todayIso ? 'Today' : name.slice(0, 3),
      highC: high ?? low,
      lowC: low ?? high,
      condition: en(f.abbreviatedForecast?.textSummary) ?? precipText,
      precipChance: precipMatch ? Number(precipMatch[1]) : null,
    });
  }

  return {
    location: en(p.name) ?? 'Unknown location',
    now,
    daily,
    // The ECCC city page has no wave, swell or tide data, so marine is null until a marine source is added.
    marine: null,
    source: 'live',
    fetchedAt: Date.now(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (status, body) => {
    res.writeHead(status, {'content-type': 'application/json', 'access-control-allow-origin': '*'});
    res.end(JSON.stringify(body, null, 2));
  };

  if (url.pathname !== '/weather' && url.pathname !== '/raw') {
    return send(404, {error: 'Not found. Use /weather?lat=..&lon=.. or /raw?lat=..&lon=..'});
  }

  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return send(400, {error: 'lat and lon are required numbers'});
  }

  try {
    const upstream = await fetchEccc(lat, lon);
    if (url.pathname === '/raw') return send(200, upstream);
    return send(200, translateToReport(upstream, lat, lon));
  } catch (err) {
    return send(502, {error: err instanceof Error ? err.message : 'Unknown error'});
  }
});

server.listen(PORT, () => {
  console.log(`NL weather server listening on port ${PORT}`);
  console.log(`Try: http://localhost:${PORT}/raw?lat=47.56&lon=-52.71`);
});
