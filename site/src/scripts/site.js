import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// maplibre-gl resolves its worker script at runtime relative to its own
// import.meta.url, which only lands correctly when the library is served
// unbundled. Astro's production build inlines it into a hashed chunk under
// _astro/, so that guess 404s and the map silently never renders (the base
// "background" paint color still shows, making it look like a plain grey
// box rather than an error). Pointing it at a copy we control in public/
// sidesteps the guess entirely.
setWorkerUrl('/maplibre-gl-worker.mjs');
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const trip = JSON.parse(document.getElementById('trip-data').textContent);
const isMobile = window.matchMedia('(max-width: 860px)').matches;

// Scale a MapLibre line-width value by `factor`, whether it's a plain number
// or a zoom-dependent expression. Expressions can't just be wrapped in
// ['*', expr, factor] because a nested "zoom" reference (other than as the
// direct input to a top-level step/interpolate) is invalid — instead we scale
// the expression's own output stops, preserving its zoom shape.
function scaleWidthExpression(expr, factor) {
  if (typeof expr === 'number') return expr * factor;
  if (Array.isArray(expr)) {
    if (expr[0] === 'interpolate') {
      const [op, interpolation, input, ...stops] = expr;
      const scaledStops = [];
      for (let i = 0; i < stops.length; i += 2) {
        scaledStops.push(stops[i], scaleWidthExpression(stops[i + 1], factor));
      }
      return [op, interpolation, input, ...scaledStops];
    }
    if (expr[0] === 'step') {
      const [op, input, base, ...stops] = expr;
      const scaledStops = [];
      for (let i = 0; i < stops.length; i += 2) {
        scaledStops.push(stops[i], scaleWidthExpression(stops[i + 1], factor));
      }
      return [op, input, scaleWidthExpression(base, factor), ...scaledStops];
    }
  }
  // Unrecognized expression shape: leave it unscaled rather than risk
  // producing an invalid MapLibre expression.
  return expr;
}

function segmentsToFeatures(day) {
  return day.routeSegments
    .filter((seg) => seg.length > 1)
    .map((seg) => ({
      type: 'Feature',
      properties: { dayId: day.id },
      geometry: { type: 'LineString', coordinates: seg },
    }));
}

function bboxOf(coordsList) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const coords of coordsList) {
    for (const [x, y] of coords) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return [[minX, minY], [maxX, maxY]];
}

const fullTripBbox = bboxOf(trip.days.flatMap((d) => d.routeSegments));

const map = new MapLibreMap({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [139.7, 38.5],
  zoom: isMobile ? 3.8 : 4.4,
  pitch: 0,
  bearing: 0,
  attributionControl: { compact: true },
  scrollZoom: false,
});

new ResizeObserver(() => map.resize()).observe(document.getElementById('map'));

const canvas = map.getCanvas();
canvas.addEventListener('webglcontextlost', (e) => {
  console.error('[map] WebGL context lost', e);
});
canvas.addEventListener('webglcontextrestored', () => {
  console.warn('[map] WebGL context restored');
});

function applyMapTheme() {
  const NAVY_DEEP = '#14417e';
  const WATER = '#1b589a';
  const GREEN_DARK = '#2d8838';
  const GREEN = '#3e9e49';
  const GREEN_LIGHT = '#45a94b';
  const SAND = '#61553c';
  const ICE = '#415461';
  const BUILDING = '#4b3d32';
  const ROAD_CASING = '#4a4234';
  const ROAD_MAJOR = '#e8dcc8';
  const ROAD_MINOR = '#a89d8d';

  for (const layer of map.getStyle().layers) {
    const id = layer.id;
    const sourceLayer = layer['source-layer'];
    try {
      if (id === 'background') map.setPaintProperty(id, 'background-color', NAVY_DEEP);
      else if (id === 'natural_earth') map.setPaintProperty(id, 'raster-opacity', 0.2);
      else if (id === 'water') map.setPaintProperty(id, 'fill-color', WATER);
      else if (sourceLayer === 'waterway') map.setPaintProperty(id, 'line-color', WATER);
      else if (id === 'park') map.setPaintProperty(id, 'fill-color', GREEN_LIGHT);
      else if (id.includes('landcover_wood') || id.includes('landcover_grass')) map.setPaintProperty(id, 'fill-color', GREEN);
      else if (id.includes('landcover_wetland')) map.setPaintProperty(id, 'fill-color', GREEN_DARK);
      else if (id.includes('landcover_ice')) map.setPaintProperty(id, 'fill-color', ICE);
      else if (id.includes('landcover_sand')) map.setPaintProperty(id, 'fill-color', SAND);
      else if (id.startsWith('landuse')) map.setPaintProperty(id, 'fill-color', GREEN_DARK);
      else if (id === 'building') map.setPaintProperty(id, 'fill-color', BUILDING);
      else if (sourceLayer === 'transportation' && layer.type === 'line') {
        const isCasing = id.includes('casing');
        const isMajor = id.includes('motorway') || id.includes('trunk') || id.includes('primary');
        map.setPaintProperty(id, 'line-color', isCasing ? ROAD_CASING : isMajor ? ROAD_MAJOR : ROAD_MINOR);
        // Thin down base-map roads so our highlighted route (added separately,
        // after this style, at line-width 4) stands out rather than competing.
        const currentWidth = layer.paint?.['line-width'] ?? 1;
        map.setPaintProperty(id, 'line-width', scaleWidthExpression(currentWidth, isMajor ? 0.18 : 0.5));
      } else if (layer.type === 'symbol') {
        map.setPaintProperty(id, 'text-color', '#f2ece2');
        map.setPaintProperty(id, 'text-halo-color', NAVY_DEEP);
      }
      if (layer.type === 'fill-extrusion') {
        // 3D building extrusions are GPU-heavy once the camera pitches, and can
        // crash WebGL on weaker/integrated GPUs. Not needed for this map.
        map.setLayoutProperty(id, 'visibility', 'none');
      }
      // Cut label/POI clutter: keep place names (cities/towns) for orientation,
      // drop street/POI-level detail that competes visually with the route.
      if (id.startsWith('poi_') || id === 'label_village' || id === 'label_other' || id === 'airport') {
        map.setLayoutProperty(id, 'visibility', 'none');
      }
      if (id.startsWith('highway-name') || id.startsWith('highway-shield') || id === 'road_shield_us') {
        map.setLayoutProperty(id, 'visibility', 'none');
      }
      if (id === 'building') {
        map.setPaintProperty(id, 'fill-opacity', 0.5);
      }
    } catch (e) {
      // paint property doesn't apply to this layer; skip
    }
  }
}

// Ease/jump to a bounds fit that shows ~10% more area than a tight fitBounds
// would, so the route never feels cropped right up to the frame edge.
const ZOOM_OUT_FACTOR = 0.1;
function fitBoundsWithMargin(bounds, { padding, pitch = 0, duration = 0, essential = false } = {}) {
  const cam = map.cameraForBounds(bounds, { padding });
  if (!cam) return;
  map.easeTo({
    center: cam.center,
    zoom: cam.zoom - Math.log2(1 + ZOOM_OUT_FACTOR),
    pitch,
    duration,
    essential,
  });
}

map.on('style.load', () => {
  applyMapTheme();

  map.addSource('full-route', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: trip.days.flatMap(segmentsToFeatures),
    },
  });
  map.addLayer({
    id: 'full-route-line',
    type: 'line',
    source: 'full-route',
    paint: {
      'line-color': '#f2ece2',
      'line-width': 1.6,
      'line-opacity': 0.28,
    },
  });

  map.addSource('active-route', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'active-route-line',
    type: 'line',
    source: 'active-route',
    paint: {
      'line-color': '#e8552c',
      'line-width': 4,
      'line-opacity': 0.95,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });

  fitBoundsWithMargin(fullTripBbox, { padding: 60, duration: 0 });

  setupScrollBinding();
});

function setupScrollBinding() {
  const daySections = Array.from(document.querySelectorAll('.day-section[data-day-id]'));
  const navLinks = Array.from(document.querySelectorAll('.day-nav a'));
  let currentDayId = null;

  function activateDay(dayId) {
    if (dayId === currentDayId) return;
    currentDayId = dayId;
    const day = trip.days.find((d) => d.id === dayId);
    if (!day) return;

    map.getSource('active-route')?.setData({
      type: 'FeatureCollection',
      features: segmentsToFeatures(day),
    });

    const bbox = bboxOf(day.routeSegments);
    const pitch = isMobile ? 0 : Math.min(45, 15 + day.stats.elevationGainM / 30);
    fitBoundsWithMargin(bbox, {
      padding: isMobile ? 40 : 80,
      pitch,
      duration: 1400,
      essential: true,
    });

    navLinks.forEach((a) => a.classList.toggle('active', a.dataset.dayId === dayId));
  }

  // A beat pulls the camera back to show a whole leg of the trip at once,
  // with every day in that leg lit up rather than a single day.
  function activateBeat(beatEl) {
    const key = `beat:${beatEl.dataset.beatDays}`;
    if (key === currentDayId) return;
    currentDayId = key;

    const ids = beatEl.dataset.beatDays.split(',');
    const legDays = trip.days.filter((d) => ids.includes(d.id));
    if (!legDays.length) return;

    map.getSource('active-route')?.setData({
      type: 'FeatureCollection',
      features: legDays.flatMap(segmentsToFeatures),
    });

    fitBoundsWithMargin(bboxOf(legDays.flatMap((d) => d.routeSegments)), {
      padding: isMobile ? 40 : 120,
      pitch: 0,
      duration: 1800,
      essential: true,
    });

    navLinks.forEach((a) => a.classList.remove('active'));
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (entry.target.dataset.beatDays) {
          activateBeat(entry.target);
        } else {
          activateDay(entry.target.dataset.dayId);
        }
      }
    },
    { rootMargin: '-45% 0px -45% 0px', threshold: 0 }
  );

  daySections.forEach((section) => observer.observe(section));
  document.querySelectorAll('.map-beat[data-beat-days]').forEach((beat) => observer.observe(beat));

  // Gentle entrance animation for each day section's content.
  gsap.utils.toArray('.day-section').forEach((section) => {
    gsap.from(section.querySelectorAll('.stat-bar, .chapter-block, .photo-strip, .day-title'), {
      opacity: 0,
      y: 24,
      duration: 0.6,
      stagger: 0.08,
      ease: 'power2.out',
      scrollTrigger: {
        trigger: section,
        start: 'top 75%',
      },
    });
  });

  gsap.utils.toArray('.map-beat').forEach((beat) => {
    gsap.from(beat.querySelectorAll('.map-beat-kicker, .map-beat-name, .map-beat-meta'), {
      opacity: 0,
      y: 30,
      duration: 0.9,
      stagger: 0.12,
      ease: 'power2.out',
      scrollTrigger: { trigger: beat, start: 'top 70%' },
    });
  });

  // Hero fades/scales away as the reader scrolls into the story.
  gsap.to('.hero-inner', {
    opacity: 0,
    y: -40,
    scrollTrigger: {
      trigger: '.hero',
      start: 'top top',
      end: 'bottom top',
      scrub: true,
    },
  });
}

document.querySelectorAll('.day-nav a').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById(a.getAttribute('href').slice(1))?.scrollIntoView({ behavior: 'smooth' });
  });
});

const lightbox = document.createElement('div');
lightbox.className = 'lightbox';
const lightboxImg = document.createElement('img');
lightboxImg.className = 'lightbox-img';
lightbox.appendChild(lightboxImg);
document.body.appendChild(lightbox);

function closeLightbox() {
  lightbox.classList.remove('open');
}

document.addEventListener('click', (e) => {
  const photo = e.target.closest('.photo-grid img, .prelude-post-media img');
  if (photo) {
    lightboxImg.src = photo.src;
    lightboxImg.alt = photo.alt;
    lightbox.classList.add('open');
    return;
  }
  if (lightbox.classList.contains('open')) closeLightbox();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

// Day videos: play while scrolled into view, pause once scrolled off. Sound
// is per-video (data-sound, set in the assign tool) and defaults to muted;
// if the browser blocks autoplay-with-sound, fall back to muted playback
// rather than leaving the video stalled.
const dayVideos = Array.from(document.querySelectorAll('.video-block video'));
if (dayVideos.length) {
  const videoObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const video = entry.target;
        if (entry.isIntersecting) {
          if (video.dataset.sound === 'true' && video.muted) {
            video.muted = false;
            video.play().catch(() => {
              video.muted = true;
              video.play().catch(() => {});
            });
          } else {
            video.play().catch(() => {});
          }
        } else {
          video.pause();
        }
      }
    },
    { threshold: 0.5 }
  );
  dayVideos.forEach((video) => videoObserver.observe(video));
}

// Full-width feature photos: the image is oversized (see CSS) and slides
// vertically as its section crosses the viewport, giving a parallax drift
// instead of sitting static behind the clipped frame.
gsap.utils.toArray('.day-hero-photo img').forEach((img) => {
  gsap.fromTo(
    img,
    { y: 150 },
    {
      y: -150,
      ease: 'none',
      scrollTrigger: {
        trigger: img.closest('.day-hero-photo'),
        start: 'top bottom',
        end: 'bottom top',
        scrub: true,
      },
    }
  );
});
