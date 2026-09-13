const fs = require('fs');
const path = require('path');

const GPX_DIR = path.join(__dirname, '..', '..', 'data', 'raw', 'gpx');
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJstDateStr(isoUtc) {
  const d = new Date(new Date(isoUtc).getTime() + JST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

// --- Day metadata (which file(s) belong to which day, JST date ranges) ---

function extractTimes(gpxText) {
  const times = [];
  const re = /<time>([^<]+)<\/time>/g;
  let m;
  while ((m = re.exec(gpxText))) times.push(m[1]);
  return times;
}

function extractName(gpxText) {
  const m = gpxText.match(/<trk>\s*<name>([^<]*)<\/name>/) || gpxText.match(/<name>([^<]*)<\/name>/);
  return m ? m[1] : null;
}

function loadDayMeta() {
  const files = fs.readdirSync(GPX_DIR).filter((f) => f.toLowerCase().endsWith('.gpx'));

  const dayFiles = [];
  let morningRide = null;
  let eveningRide = null;

  for (const file of files) {
    if (file === 'Morning_Ride.gpx') {
      morningRide = file;
      continue;
    }
    if (file === 'Evening_Ride.gpx') {
      eveningRide = file;
      continue;
    }
    const m = file.match(/Day_(\d+)/);
    if (!m) continue;
    dayFiles.push({ file, dayNum: parseInt(m[1], 10) });
  }

  dayFiles.sort((a, b) => a.dayNum - b.dayNum);

  const days = [];

  for (const { file, dayNum } of dayFiles) {
    const text = fs.readFileSync(path.join(GPX_DIR, file), 'utf8');
    const times = extractTimes(text);
    if (times.length === 0) continue;
    const sorted = [...times].sort();
    const startUtc = sorted[0];
    const endUtc = sorted[sorted.length - 1];
    const name = extractName(text) || file;

    days.push({
      id: String(dayNum),
      dayNum,
      label: `Day ${dayNum}`,
      title: name,
      files: [file],
      startUtc,
      endUtc,
      dateRangeJst: [toJstDateStr(startUtc), toJstDateStr(endUtc)],
    });

    if (dayNum === 22 && (morningRide || eveningRide)) {
      const restFiles = [morningRide, eveningRide].filter(Boolean);
      const restTimes = [];
      for (const rf of restFiles) {
        const rtext = fs.readFileSync(path.join(GPX_DIR, rf), 'utf8');
        restTimes.push(...extractTimes(rtext));
      }
      if (restTimes.length > 0) {
        const rsorted = [...restTimes].sort();
        const rStart = rsorted[0];
        const rEnd = rsorted[rsorted.length - 1];
        days.push({
          id: '22a',
          dayNum: 22.5,
          label: 'Day 22a',
          title: 'Rest Day (Sapporo)',
          files: restFiles,
          startUtc: rStart,
          endUtc: rEnd,
          dateRangeJst: [toJstDateStr(rStart), toJstDateStr(rEnd)],
        });
      }
    }
  }

  return days;
}

// --- Full trackpoint parsing ---

function parseTrackPoints(gpxText) {
  const points = [];
  const trkptRe = /<trkpt lat="([\d.\-]+)" lon="([\d.\-]+)">([\s\S]*?)<\/trkpt>/g;
  let m;
  while ((m = trkptRe.exec(gpxText))) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    const body = m[3];
    const eleM = body.match(/<ele>([\d.\-]+)<\/ele>/);
    const timeM = body.match(/<time>([^<]+)<\/time>/);
    const hrM = body.match(/<gpxtpx:hr>(\d+)<\/gpxtpx:hr>/);
    points.push({
      lat,
      lon,
      ele: eleM ? parseFloat(eleM[1]) : null,
      time: timeM ? timeM[1] : null,
      hr: hrM ? parseInt(hrM[1], 10) : null,
    });
  }
  return points;
}

function parseSegmentFromFile(filename) {
  const text = fs.readFileSync(path.join(GPX_DIR, filename), 'utf8');
  return parseTrackPoints(text);
}

// --- Geometry / stats helpers ---

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function computeSegmentStats(points) {
  let distanceM = 0;
  let elevationGainM = 0;
  let movingSeconds = 0;
  let maxSpeedKmh = 0;
  let hrSum = 0;
  let hrCount = 0;
  let maxHr = 0;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (!prev.time || !cur.time) continue;
    const dt = (new Date(cur.time).getTime() - new Date(prev.time).getTime()) / 1000;
    if (dt <= 0) continue;

    const dM = haversineMeters(prev, cur);
    distanceM += dM;

    if (prev.ele != null && cur.ele != null) {
      const deltaEle = cur.ele - prev.ele;
      if (deltaEle > 0) elevationGainM += deltaEle;
    }

    const speedKmh = (dM / dt) * 3.6;
    // treat as moving if faster than a brisk walk; ignore implausible GPS-jump spikes
    if (speedKmh > 2 && speedKmh < 90) {
      movingSeconds += dt;
      if (speedKmh > maxSpeedKmh) maxSpeedKmh = speedKmh;
    }

    if (cur.hr != null) {
      hrSum += cur.hr;
      hrCount += 1;
      if (cur.hr > maxHr) maxHr = cur.hr;
    }
  }

  return {
    distanceKm: distanceM / 1000,
    elevationGainM,
    movingSeconds,
    maxSpeedKmh,
    avgHr: hrCount > 0 ? Math.round(hrSum / hrCount) : null,
    maxHr: hrCount > 0 ? maxHr : null,
  };
}

// Ramer-Douglas-Peucker simplification on [lon, lat] pairs (planar approximation).
function simplifyLine(coords, toleranceDeg) {
  if (coords.length <= 2) return coords;

  function perpendicularDistance(pt, lineStart, lineEnd) {
    const [x, y] = pt;
    const [x1, y1] = lineStart;
    const [x2, y2] = lineEnd;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(x - x1, y - y1);
    const t = ((x - x1) * dx + (y - y1) * dy) / lenSq;
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.hypot(x - projX, y - projY);
  }

  function rdp(points) {
    if (points.length <= 2) return points;
    let maxDist = 0;
    let index = 0;
    const start = points[0];
    const end = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
      const d = perpendicularDistance(points[i], start, end);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > toleranceDeg) {
      const left = rdp(points.slice(0, index + 1));
      const right = rdp(points.slice(index));
      return left.slice(0, -1).concat(right);
    }
    return [start, end];
  }

  return rdp(coords);
}

function simplifyToMax(coords, targetMax) {
  let tolerance = 0.00005; // ~5m
  let simplified = simplifyLine(coords, tolerance);
  let attempts = 0;
  while (simplified.length > targetMax && attempts < 12) {
    tolerance *= 1.7;
    simplified = simplifyLine(coords, tolerance);
    attempts += 1;
  }
  if (simplified.length > targetMax) {
    // fallback: uniform stride decimation
    const stride = Math.ceil(simplified.length / targetMax);
    simplified = simplified.filter((_, i) => i % stride === 0 || i === simplified.length - 1);
  }
  return simplified;
}

module.exports = {
  GPX_DIR,
  loadDayMeta,
  parseTrackPoints,
  parseSegmentFromFile,
  haversineMeters,
  computeSegmentStats,
  simplifyLine,
  simplifyToMax,
  toJstDateStr,
};
