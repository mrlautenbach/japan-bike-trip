// Posts end — and often interrupt themselves — with a day's tally:
// "Distance (day) - 99 km", "Tunnels (total) -28". Several posts cover more
// than one day and carry a block per day, so the text is parsed into a
// sequence of paragraph and stat blocks rather than a body plus one tail.
//
// Blocks are found by shape (label, optional qualifier, dash, number) rather
// than by a "Day N" heading: plenty of posts omit the heading, and the spacing
// around the dash is inconsistent in the source.
// Two styles appear in the source: the per-day tallies use a dash
// ("Distance (day) - 99 km") and the closing summary uses a colon
// ("Total Distance: 2254 km", "Cost Per Day: $158.39").
const STAT_DASH = /^[A-Za-z][A-Za-z' ]*(\([^)]*\))?\s*[-–—]\s*\d/;
const STAT_COLON = /^[A-Za-z][A-Za-z0-9'()/ ,.]*:\s*[$£¥]?\d/;
// A trailing entry whose value isn't a number ("Smiles: Too many to count")
// only counts when it's short and already adjoining a run of real stats.
const STAT_COLON_LOOSE = /^[A-Za-z][A-Za-z0-9'()/ ,.]*:\s*\S/;
const LOOSE_MAX_WORDS = 10;

const DAY_MARKER = /^Day\s*\d+[a-z]?$/i;
const MIN_STAT_LINES = 2;

// Some posts (e.g. a list of standalone observations) are hand-marked in the
// source with a leading "- " so they render as a plain bulleted list rather
// than prose, without being mistaken for the day-tally stat shape above.
const BULLET_LINE = /^[-•]\s+/;

// The scraped source drops heading markup, so section heads ("Focus is
// essential", "Kobe Beef Menu") arrive as bare lines. They're recognisable as
// short, unpunctuated, and followed by a longer paragraph.
const HEADING_MAX_WORDS = 14;
const ENDS_LIKE_SENTENCE = /[.!?:;,"”'’)\]…]$/;

function wordCount(line: string): number {
  return line.split(/\s+/).length;
}

function isStatLine(line: string): boolean {
  return STAT_DASH.test(line) || STAT_COLON.test(line);
}

function isLooseStatLine(line: string): boolean {
  return STAT_COLON_LOOSE.test(line) && wordCount(line) <= LOOSE_MAX_WORDS;
}

function isHeading(line: string, next: string | undefined): boolean {
  if (!next || DAY_MARKER.test(line) || STAT_COLON_LOOSE.test(line) || isStatLine(line)) return false;
  const words = wordCount(line);
  return words <= HEADING_MAX_WORDS && !ENDS_LIKE_SENTENCE.test(line) && wordCount(next) > words;
}

export type PostBlock =
  | { type: 'para'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'stats'; label: string | null; items: string[] };

export function parsePostBlocks(text: string | null | undefined): PostBlock[] {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const blocks: PostBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (BULLET_LINE.test(lines[i])) {
      let end = i;
      while (end < lines.length && BULLET_LINE.test(lines[end])) end++;
      blocks.push({ type: 'stats', label: null, items: lines.slice(i, end).map((l) => l.replace(BULLET_LINE, '')) });
      i = end - 1;
      continue;
    }

    let end = i;
    while (end < lines.length && isStatLine(lines[end])) end++;

    if (end - i >= MIN_STAT_LINES) {
      while (end < lines.length && isLooseStatLine(lines[end])) end++;

      const prev = blocks[blocks.length - 1];
      let label: string | null = null;
      if (prev && prev.type === 'para' && DAY_MARKER.test(prev.text)) {
        label = prev.text;
        blocks.pop();
      }
      blocks.push({ type: 'stats', label, items: lines.slice(i, end) });
      i = end - 1;
    } else if (isHeading(lines[i], lines[i + 1])) {
      blocks.push({ type: 'heading', text: lines[i] });
    } else {
      blocks.push({ type: 'para', text: lines[i] });
    }
  }

  return blocks;
}
