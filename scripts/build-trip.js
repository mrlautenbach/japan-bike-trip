const fs = require('fs');
const path = require('path');
const {
  loadDayMeta,
  parseSegmentFromFile,
  computeSegmentStats,
  simplifyToMax,
} = require('./lib/gpx');
const { listPhotosWithDays } = require('./lib/photos');
const { listVideosWithDays } = require('./lib/videos');

const ROOT = path.join(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'trip.json');
const PHOTO_ASSIGNMENTS_PATH = path.join(ROOT, 'data', 'photo-assignments.json');
const VIDEO_ASSIGNMENTS_PATH = path.join(ROOT, 'data', 'video-assignments.json');
const CHAPTER_ASSIGNMENTS_PATH = path.join(ROOT, 'data', 'chapter-assignments.json');
const BLOG_POSTS_PATH = path.join(ROOT, 'data', 'blog-posts.json');

const POINTS_PER_SEGMENT = 400;

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function buildDay(dayMeta) {
  const segments = dayMeta.files.map((file) => parseSegmentFromFile(file));
  const allPoints = segments.flat();

  const segmentStats = segments.map(computeSegmentStats);
  const distanceKm = segmentStats.reduce((s, x) => s + x.distanceKm, 0);
  const elevationGainM = segmentStats.reduce((s, x) => s + x.elevationGainM, 0);
  const movingSeconds = segmentStats.reduce((s, x) => s + x.movingSeconds, 0);
  const maxSpeedKmh = Math.max(...segmentStats.map((x) => x.maxSpeedKmh), 0);

  const hrPoints = allPoints.filter((p) => p.hr != null);
  const avgHr = hrPoints.length ? Math.round(hrPoints.reduce((s, p) => s + p.hr, 0) / hrPoints.length) : null;
  const maxHr = hrPoints.length ? Math.max(...hrPoints.map((p) => p.hr)) : null;

  const routeSegments = segments.map((pts) => {
    const coords = pts.map((p) => [p.lon, p.lat]);
    return simplifyToMax(coords, POINTS_PER_SEGMENT);
  });

  // Elevation profile sampled from the first (primary) segment, for chart rendering.
  const elevationProfile = segments[0]
    ? sampleElevationProfile(segments[0], 150)
    : [];

  const firstSeg = segments[0] || [];
  const lastSeg = segments[segments.length - 1] || [];
  const startPoint = firstSeg[0];
  const endPoint = lastSeg[lastSeg.length - 1];

  return {
    id: dayMeta.id,
    dayNum: dayMeta.dayNum,
    label: dayMeta.label,
    title: dayMeta.title,
    dateJst: dayMeta.dateRangeJst[0],
    stats: {
      distanceKm: Math.round(distanceKm * 10) / 10,
      elevationGainM: Math.round(elevationGainM),
      movingTime: formatDuration(movingSeconds),
      movingSeconds: Math.round(movingSeconds),
      avgHr,
      maxHr,
      maxSpeedKmh: Math.round(maxSpeedKmh * 10) / 10,
    },
    startCoords: startPoint ? [startPoint.lon, startPoint.lat] : null,
    endCoords: endPoint ? [endPoint.lon, endPoint.lat] : null,
    routeSegments,
    elevationProfile,
    photos: [],
    videos: [],
    heroPhoto: null,
  };
}

function sampleElevationProfile(points, maxSamples) {
  const withEle = points.filter((p) => p.ele != null);
  if (withEle.length === 0) return [];
  let cumDistM = 0;
  const samples = [];
  let lastSampleDist = -Infinity;
  const stepM = 200; // one sample roughly every 200m of travel
  for (let i = 0; i < withEle.length; i++) {
    if (i > 0) {
      const a = withEle[i - 1];
      const b = withEle[i];
      const R = 6371000;
      const toRad = (d) => (d * Math.PI) / 180;
      const dLat = toRad(b.lat - a.lat);
      const dLon = toRad(b.lon - a.lon);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
      cumDistM += 2 * R * Math.asin(Math.sqrt(h));
    }
    if (cumDistM - lastSampleDist >= stepM) {
      samples.push([Math.round(cumDistM), Math.round(withEle[i].ele)]);
      lastSampleDist = cumDistM;
    }
  }
  if (samples.length <= maxSamples) return samples;
  const stride = Math.ceil(samples.length / maxSamples);
  return samples.filter((_, i) => i % stride === 0);
}

function dayNumInRange(dayNum, from, to) {
  const fromNum = from != null ? from : -Infinity;
  const toNum = to != null ? to : fromNum;
  return dayNum >= fromNum && dayNum <= toNum;
}

function main() {
  const dayMetas = loadDayMeta();
  const dayNumById = Object.fromEntries(dayMetas.map((d) => [d.id, d.dayNum]));

  console.log(`Parsing ${dayMetas.length} day(s) of GPX data...`);
  const days = dayMetas.map((meta, i) => {
    process.stdout.write(`  [${i + 1}/${dayMetas.length}] ${meta.label} (${meta.title})...\n`);
    return buildDay(meta);
  });

  // --- Chapters: blog posts mapped to day ranges. Built before the photo/video
  // merge below so that "whole screen" posts (prologue/epilogue) can also be
  // photo/video targets, alongside numbered days.
  const blogPosts = readJsonSafe(BLOG_POSTS_PATH, []);
  const chapterAssignments = readJsonSafe(CHAPTER_ASSIGNMENTS_PATH, {});

  const chapters = blogPosts.map((post) => {
    const assignment = chapterAssignments[post.slug] || {};
    const notDaySpecific = assignment.notDaySpecific ?? ['meta', 'prologue', 'epilogue'].includes(post.category);
    let dayIds = [];
    if (!notDaySpecific && assignment.from) {
      const fromNum = dayNumById[assignment.from];
      const toNum = assignment.to ? dayNumById[assignment.to] : fromNum;
      dayIds = dayMetas.filter((d) => dayNumInRange(d.dayNum, fromNum, toNum)).map((d) => d.id);
    }
    return {
      slug: post.slug,
      title: post.title,
      desc: post.desc,
      fullText: post.fullText || null,
      heroImage: post.heroImage || null,
      url: post.url,
      category: post.category,
      notDaySpecific,
      fromDay: notDaySpecific ? null : assignment.from || null,
      toDay: notDaySpecific ? null : assignment.to || assignment.from || null,
      dayIds,
      photos: [],
      videos: [],
      heroPhoto: null,
    };
  });

  // --- Photos: auto-assign by EXIF date, but respect explicit overrides —
  // including an explicit "remove from site" (saved as null), which must NOT
  // fall back to the EXIF guess. Only photos never touched in the assign tool
  // fall back to the suggested day. An override can be a plain day-id string
  // (the original format) or, for a photo marked as the day's full-width
  // feature photo, `{ day, fullWidth: true }`. The "day" can also be a blog
  // post slug, targeting a prologue/epilogue "whole screen" post instead of
  // a numbered day.
  const photoOverrides = readJsonSafe(PHOTO_ASSIGNMENTS_PATH, {});
  const photoMeta = listPhotosWithDays(dayMetas);
  const daysById = Object.fromEntries(days.map((d) => [d.id, d]));
  const chaptersBySlug = Object.fromEntries(chapters.map((c) => [c.slug, c]));
  const photoTargetsById = { ...daysById, ...chaptersBySlug };

  for (const photo of photoMeta) {
    const hasOverride = Object.prototype.hasOwnProperty.call(photoOverrides, photo.filename);
    let assignedDay = null;
    let fullWidth = false;
    if (hasOverride) {
      const value = photoOverrides[photo.filename];
      if (value && typeof value === 'object') {
        assignedDay = value.day ?? null;
        fullWidth = Boolean(value.fullWidth);
      } else {
        assignedDay = value; // plain day-id/slug string, or null for "removed"
      }
    } else {
      assignedDay = photo.suggestedDay;
    }
    const target = assignedDay && photoTargetsById[assignedDay];
    if (target) {
      const entry = {
        filename: photo.filename,
        capturedAt: photo.capturedAt,
        width: photo.width,
        height: photo.height,
      };
      // Only one full-width feature photo per target — any extras fall back
      // to the regular grid instead of being dropped.
      if (fullWidth && !target.heroPhoto) {
        target.heroPhoto = entry;
      } else {
        target.photos.push(entry);
      }
    }
  }
  for (const target of [...days, ...chapters]) {
    target.photos.sort((a, b) => (a.capturedAt || '').localeCompare(b.capturedAt || ''));
  }

  // --- Videos: same auto-assign + explicit-override behavior as photos
  // (an explicit "remove from site" — saved as null — never falls back to
  // the EXIF/mdls-based guess), plus a per-video "sound" flag that defaults
  // to false (muted) unless explicitly turned on in the assign tool.
  const videoOverrides = readJsonSafe(VIDEO_ASSIGNMENTS_PATH, {});
  const videoMeta = listVideosWithDays(dayMetas);

  for (const video of videoMeta) {
    const hasOverride = Object.prototype.hasOwnProperty.call(videoOverrides, video.filename);
    const override = hasOverride ? videoOverrides[video.filename] : null;
    const assignedDay = hasOverride ? override && override.day : video.suggestedDay;
    const target = assignedDay && photoTargetsById[assignedDay];
    if (target) {
      target.videos.push({
        filename: video.filename,
        capturedAt: video.capturedAt,
        sound: Boolean(override && override.sound),
      });
    }
  }
  for (const target of [...days, ...chapters]) {
    target.videos.sort((a, b) => (a.capturedAt || '').localeCompare(b.capturedAt || ''));
  }

  // --- Trip-level totals ---
  const totalDistanceKm = days.reduce((s, d) => s + d.stats.distanceKm, 0);
  const totalElevationM = days.reduce((s, d) => s + d.stats.elevationGainM, 0);
  const totalMovingSeconds = days.reduce((s, d) => s + d.stats.movingSeconds, 0);

  const trip = {
    meta: {
      title: 'End-to-End: Japan by Bike',
      startLocation: 'Nagasaki',
      endLocation: 'Cape Soya, Wakkanai',
      startDate: dayMetas[0].dateRangeJst[0],
      endDate: dayMetas[dayMetas.length - 1].dateRangeJst[0],
      totalDays: days.length,
      totalDistanceKm: Math.round(totalDistanceKm),
      totalElevationM: Math.round(totalElevationM),
      totalMovingTime: formatDuration(totalMovingSeconds),
      generatedAt: new Date().toISOString(),
    },
    days,
    chapters,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(trip));
  const sizeKb = Math.round(fs.statSync(OUT_PATH).size / 1024);
  console.log(`\nWrote ${OUT_PATH} (${sizeKb} KB)`);
  console.log(
    `Totals: ${trip.meta.totalDistanceKm} km, ${trip.meta.totalElevationM} m elevation, ${trip.meta.totalMovingTime} moving time over ${trip.meta.totalDays} days`
  );
}

main();
