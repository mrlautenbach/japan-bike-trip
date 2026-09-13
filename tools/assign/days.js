// Thin re-export so the assignment tool and the build pipeline share one
// implementation of day/file parsing (see scripts/lib/gpx.js).
const { loadDayMeta, toJstDateStr, JST_OFFSET_MS } = require('../../scripts/lib/gpx');

module.exports = { loadDays: loadDayMeta, toJstDateStr, JST_OFFSET_MS: JST_OFFSET_MS || 9 * 60 * 60 * 1000 };
