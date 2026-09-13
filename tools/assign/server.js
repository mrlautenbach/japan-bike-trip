const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadDays } = require('./days');
const { getPhotoCreation, suggestDayForCapture } = require('../../scripts/lib/photos');
const { getVideoCreation } = require('../../scripts/lib/videos');

const ROOT = path.join(__dirname, '..', '..');
const PHOTOS_DIR = path.join(ROOT, 'data', 'raw', 'photos');
const VIDEOS_DIR = path.join(ROOT, 'data', 'raw', 'videos');
const BLOG_POSTS_PATH = path.join(ROOT, 'data', 'blog-posts.json');
const PHOTO_ASSIGNMENTS_PATH = path.join(ROOT, 'data', 'photo-assignments.json');
const VIDEO_ASSIGNMENTS_PATH = path.join(ROOT, 'data', 'video-assignments.json');
const CHAPTER_ASSIGNMENTS_PATH = path.join(ROOT, 'data', 'chapter-assignments.json');
const HEIC_CACHE_DIR = path.join(__dirname, '.heic-cache');
const PORT = 5051;

if (!fs.existsSync(HEIC_CACHE_DIR)) fs.mkdirSync(HEIC_CACHE_DIR, { recursive: true });
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

// The prologue/epilogue blog posts render as full-screen sections rather than
// being tied to a numbered day — expose them as extra photo/video assignment
// targets (alongside days), keyed by their slug instead of a day id.
function loadChapterTargets() {
  const posts = readJsonSafe(BLOG_POSTS_PATH, []);
  return posts
    .filter((p) => p.category === 'prologue' || p.category === 'epilogue')
    .map((p) => ({
      id: p.slug,
      label: p.category === 'prologue' ? 'Prologue' : 'Epilogue',
      title: p.title,
    }));
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function isHeic(filename) {
  return /\.(heic|heif)$/i.test(filename);
}

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function serveImage(filename, res) {
  const filePath = path.join(PHOTOS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  if (isHeic(filename)) {
    const cachedJpeg = path.join(HEIC_CACHE_DIR, filename.replace(/\.(heic|heif)$/i, '.jpg'));
    if (!fs.existsSync(cachedJpeg)) {
      try {
        execFileSync('sips', ['-s', 'format', 'jpeg', filePath, '--out', cachedJpeg]);
      } catch (e) {
        res.writeHead(500);
        res.end('HEIC conversion failed');
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    fs.createReadStream(cachedJpeg).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': contentTypeFor(filename) });
  fs.createReadStream(filePath).pipe(res);
}

function videoContentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  return 'video/mp4';
}

function serveVideo(filename, req, res) {
  const filePath = path.join(VIDEOS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const stat = fs.statSync(filePath);
  const contentType = videoContentTypeFor(filename);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(startStr, 10);
  const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType,
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (url.pathname === '/api/days') {
      const days = loadDays();
      const chapterTargets = loadChapterTargets();
      sendJson(res, [...days, ...chapterTargets]);
      return;
    }

    if (url.pathname === '/api/posts') {
      const posts = readJsonSafe(BLOG_POSTS_PATH, []);
      sendJson(res, posts);
      return;
    }

    if (url.pathname === '/api/photos') {
      const days = loadDays();
      const files = fs
        .readdirSync(PHOTOS_DIR)
        .filter((f) => /\.(jpe?g|png|heic|heif)$/i.test(f));
      const saved = readJsonSafe(PHOTO_ASSIGNMENTS_PATH, {});
      const photos = files.map((filename) => {
        const capturedAt = getPhotoCreation(filename);
        const suggestedDay = suggestDayForCapture(capturedAt, days);
        const hasOverride = Object.prototype.hasOwnProperty.call(saved, filename);
        const rawValue = hasOverride ? saved[filename] : undefined;
        let assignedDay, fullWidth;
        if (!hasOverride) {
          assignedDay = suggestedDay ?? null;
          fullWidth = false;
        } else if (rawValue && typeof rawValue === 'object') {
          assignedDay = rawValue.day ?? null;
          fullWidth = Boolean(rawValue.fullWidth);
        } else {
          assignedDay = rawValue; // plain day-id string, or null for "removed"
          fullWidth = false;
        }
        return {
          filename,
          url: `/photos/${encodeURIComponent(filename)}`,
          capturedAt,
          suggestedDay,
          assignedDay,
          fullWidth,
        };
      });
      photos.sort((a, b) => (a.capturedAt || '').localeCompare(b.capturedAt || ''));
      sendJson(res, photos);
      return;
    }

    if (url.pathname.startsWith('/photos/') && req.method === 'GET') {
      const filename = decodeURIComponent(url.pathname.replace('/photos/', ''));
      serveImage(filename, res);
      return;
    }

    if (url.pathname === '/api/videos') {
      const days = loadDays();
      const files = fs.existsSync(VIDEOS_DIR)
        ? fs.readdirSync(VIDEOS_DIR).filter((f) => /\.(mp4|mov|m4v|webm)$/i.test(f))
        : [];
      const saved = readJsonSafe(VIDEO_ASSIGNMENTS_PATH, {});
      const videos = files.map((filename) => {
        const capturedAt = getVideoCreation(filename);
        const suggestedDay = suggestDayForCapture(capturedAt, days);
        const savedEntry = saved[filename];
        return {
          filename,
          url: `/videos/${encodeURIComponent(filename)}`,
          capturedAt,
          suggestedDay,
          assignedDay: (savedEntry && savedEntry.day) ?? suggestedDay ?? null,
          sound: Boolean(savedEntry && savedEntry.sound),
        };
      });
      videos.sort((a, b) => (a.capturedAt || '').localeCompare(b.capturedAt || ''));
      sendJson(res, videos);
      return;
    }

    if (url.pathname.startsWith('/videos/') && req.method === 'GET') {
      const filename = decodeURIComponent(url.pathname.replace('/videos/', ''));
      serveVideo(filename, req, res);
      return;
    }

    if (url.pathname === '/api/assignments/videos' && req.method === 'GET') {
      sendJson(res, readJsonSafe(VIDEO_ASSIGNMENTS_PATH, {}));
      return;
    }

    if (url.pathname === '/api/assignments/videos' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const current = readJsonSafe(VIDEO_ASSIGNMENTS_PATH, {});
      const merged = { ...current, ...body };
      writeJson(VIDEO_ASSIGNMENTS_PATH, merged);
      sendJson(res, { ok: true, saved: merged });
      return;
    }

    if (url.pathname === '/api/assignments/photos' && req.method === 'GET') {
      sendJson(res, readJsonSafe(PHOTO_ASSIGNMENTS_PATH, {}));
      return;
    }

    if (url.pathname === '/api/assignments/photos' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const current = readJsonSafe(PHOTO_ASSIGNMENTS_PATH, {});
      const merged = { ...current, ...body };
      writeJson(PHOTO_ASSIGNMENTS_PATH, merged);
      sendJson(res, { ok: true, saved: merged });
      return;
    }

    if (url.pathname === '/api/assignments/chapters' && req.method === 'GET') {
      sendJson(res, readJsonSafe(CHAPTER_ASSIGNMENTS_PATH, {}));
      return;
    }

    if (url.pathname === '/api/assignments/chapters' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const current = readJsonSafe(CHAPTER_ASSIGNMENTS_PATH, {});
      const merged = { ...current, ...body };
      writeJson(CHAPTER_ASSIGNMENTS_PATH, merged);
      sendJson(res, { ok: true, saved: merged });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Photo/chapter assignment tool running at http://localhost:${PORT}`);
});
