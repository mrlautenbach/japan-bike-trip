// maplibre-gl resolves its worker script at runtime relative to its own
// import.meta.url, which only works when the library is served unbundled.
// Astro's build inlines it into a hashed chunk, so site.js points the worker
// at a static copy in public/ instead (see setWorkerUrl in src/scripts/site.js).
//
// That worker file itself imports a sibling "shared" chunk via a relative
// path, so both files have to be copied together and kept in sync with
// whatever maplibre-gl version is actually installed — copying only the
// worker (as a one-off, by hand) leaves the shared chunk 404ing at runtime,
// which silently breaks the whole map with no console error (the failure is
// inside a Web Worker's module graph, which doesn't surface to the page).
// Runs automatically before dev/build so this can't drift again.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'node_modules', 'maplibre-gl', 'dist');
const publicDir = join(here, '..', 'public');

mkdirSync(publicDir, { recursive: true });

for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  copyFileSync(join(distDir, file), join(publicDir, file));
  console.log(`synced ${file} -> public/`);
}
