const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PHOTOS_DIR = path.join(ROOT, 'data', 'raw', 'photos');
const EXIF_CACHE_PATH = path.join(__dirname, '.exif-cache.json');

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

let exifCache = readJsonSafe(EXIF_CACHE_PATH, {});
function saveExifCache() {
  fs.writeFileSync(EXIF_CACHE_PATH, JSON.stringify(exifCache, null, 2));
}

function getPhotoCreation(filename) {
  const filePath = path.join(PHOTOS_DIR, filename);
  const stat = fs.statSync(filePath);
  const cacheKey = `${filename}:${stat.size}:${stat.mtimeMs}`;
  if (exifCache[cacheKey] !== undefined) return exifCache[cacheKey];

  let creation = null;
  try {
    const out = execFileSync('sips', ['-g', 'creation', filePath], { encoding: 'utf8' });
    const m = out.match(/creation:\s*(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const [, y, mo, d, h, mi, s] = m;
      creation = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
    }
  } catch (e) {
    creation = null;
  }

  exifCache[cacheKey] = creation;
  saveExifCache();
  return creation;
}

// Pixel dimensions, cached alongside the creation dates. The site sets these
// as width/height attributes so the browser reserves the right space before a
// lazy-loaded photo arrives, instead of collapsing to zero height.
function getPhotoSize(filename) {
  const filePath = path.join(PHOTOS_DIR, filename);
  const stat = fs.statSync(filePath);
  const cacheKey = `size:${filename}:${stat.size}:${stat.mtimeMs}`;
  if (exifCache[cacheKey] !== undefined) return exifCache[cacheKey];

  let size = null;
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath], {
      encoding: 'utf8',
    });
    const w = out.match(/pixelWidth:\s*(\d+)/);
    const h = out.match(/pixelHeight:\s*(\d+)/);
    if (w && h) size = { width: Number(w[1]), height: Number(h[1]) };
  } catch (e) {
    size = null;
  }

  exifCache[cacheKey] = size;
  saveExifCache();
  return size;
}

function suggestDayForCapture(creationLocal, days) {
  if (!creationLocal) return null;
  const localDate = creationLocal.slice(0, 10);
  for (const day of days) {
    const [from, to] = day.dateRangeJst;
    if (localDate >= from && localDate <= to) return day.id;
  }
  let best = null;
  let bestDist = Infinity;
  const t = new Date(localDate).getTime();
  for (const day of days) {
    const mid = new Date(day.dateRangeJst[0]).getTime();
    const dist = Math.abs(t - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = day.id;
    }
  }
  return best;
}

function listPhotosWithDays(days) {
  if (!fs.existsSync(PHOTOS_DIR)) return [];
  const files = fs.readdirSync(PHOTOS_DIR).filter((f) => /\.(jpe?g|png|heic|heif)$/i.test(f));
  return files.map((filename) => {
    const capturedAt = getPhotoCreation(filename);
    const suggestedDay = suggestDayForCapture(capturedAt, days);
    const size = getPhotoSize(filename);
    return { filename, capturedAt, suggestedDay, width: size?.width ?? null, height: size?.height ?? null };
  });
}

module.exports = { PHOTOS_DIR, getPhotoCreation, getPhotoSize, suggestDayForCapture, listPhotosWithDays };
