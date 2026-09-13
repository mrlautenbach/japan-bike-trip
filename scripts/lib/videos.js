const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { suggestDayForCapture } = require('./photos');

const ROOT = path.join(__dirname, '..', '..');
const VIDEOS_DIR = path.join(ROOT, 'data', 'raw', 'videos');
const EXIF_CACHE_PATH = path.join(__dirname, '.video-exif-cache.json');

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

// Videos don't support `sips -g creation` (that's photo-only), so we read the
// same content-creation-date metadata via Spotlight's `mdls` instead. Falls
// back to the file's own mtime if a video has no such metadata (e.g. edited/
// re-exported clips that lost their original capture date).
function getVideoCreation(filename) {
  const filePath = path.join(VIDEOS_DIR, filename);
  const stat = fs.statSync(filePath);
  const cacheKey = `${filename}:${stat.size}:${stat.mtimeMs}`;
  if (exifCache[cacheKey] !== undefined) return exifCache[cacheKey];

  let creation = null;
  try {
    const out = execFileSync('mdls', ['-name', 'kMDItemContentCreationDate', '-raw', filePath], {
      encoding: 'utf8',
    });
    const m = out.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const [, y, mo, d, h, mi, s] = m;
      creation = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
    }
  } catch (e) {
    creation = null;
  }

  if (!creation) {
    creation = stat.mtime.toISOString().slice(0, 19);
  }

  exifCache[cacheKey] = creation;
  saveExifCache();
  return creation;
}

function listVideosWithDays(days) {
  if (!fs.existsSync(VIDEOS_DIR)) return [];
  const files = fs.readdirSync(VIDEOS_DIR).filter((f) => /\.(mp4|mov|m4v|webm)$/i.test(f));
  return files.map((filename) => {
    const capturedAt = getVideoCreation(filename);
    const suggestedDay = suggestDayForCapture(capturedAt, days);
    return { filename, capturedAt, suggestedDay };
  });
}

module.exports = { VIDEOS_DIR, getVideoCreation, listVideosWithDays };
