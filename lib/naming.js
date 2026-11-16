// naming.js - pure helpers that build file names. No DOM, no browser APIs,
// so everything here can be tested with `node --test`.
//
// All timestamps use the LOCAL time zone of the device (getHours(), not getUTCHours()).

/** Drive/Apps Script file names are cut to this many characters. */
export const MAX_NAME_LENGTH = 150;

/** Left-pad a number with zeros: pad(5) -> "05". */
const pad = (n, width = 2) => String(n).padStart(width, '0');

/** "2026-11-15" */
export function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-11-15 0905" - used in file names (no colon: colons are not allowed in names). */
export function formatStamp(d) {
  return `${formatDate(d)} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** "2026-11-15 09:05" - used inside the markdown front matter. */
export function formatClock(d) {
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Make ONE piece of text safe to put in a file name.
 * Removes characters that are illegal or troublesome in file names and in
 * Obsidian links ( \ / : * ? " < > | # ^ [ ] ) plus control characters,
 * collapses whitespace, and trims stray dots/spaces at the ends.
 */
export function cleanSegment(value) {
  return String(value ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim();
}

/** First `count` words of `text`, cleaned. Falls back to "capture" if nothing is left. */
export function firstWords(text, count = 4) {
  // Clean first (so "Prof/Tremblay" becomes two words), then count words.
  const words = cleanSegment(text)
    .split(' ')
    .map(cleanSegment)
    .filter(Boolean)
    .slice(0, count)
    .join(' ');
  return words || 'capture';
}

/** Cut a string to `max` UTF-16 units without leaving half of an emoji behind. */
function cut(str, max) {
  if (str.length <= max) return str;
  let out = str.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1); // lone high surrogate
  return out.trimEnd();
}

/**
 * Join stem + extension and make sure the whole name is at most `max` long.
 * The extension is always kept; the stem is shortened.
 * `ext` includes the dot, e.g. ".md".
 */
export function fitName(stem, ext, max = MAX_NAME_LENGTH) {
  return cut(stem, max - ext.length) + ext;
}

/** If `stem+ext` is already taken, try "stem 2", "stem 3", ... Returns the free stem. */
export function uniqueStem(stem, exts, taken) {
  const isTaken = (s) => exts.some((e) => taken.has(fitName(s, e)));
  if (!isTaken(stem)) return stem;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} ${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${stem} ${Date.now()}`;
}

/** Text capture stem: "2026-11-15 0905 first four words". */
export function textStem(now, text) {
  // Keep room for the extension and a possible " 99" uniqueness suffix.
  return `${formatStamp(now)} ${firstWords(text, 4)}`;
}

/** Tag list -> "[ELE1001, MTH1101]" for file names (empty string when no tags). */
export function tagsForName(tags) {
  const clean = (tags || []).map(cleanSegment).filter(Boolean);
  return clean.length ? `[${clean.join(', ')}]` : '';
}

/**
 * Binary capture stem:
 *   "2026-11-15 0905 photo [caption words] [tag1, tag2]"
 * The caption is shortened first if the whole name would be too long.
 */
export function binaryStem(now, label, caption, tags, ext = '.jpg') {
  const head = `${formatStamp(now)} ${label}`;
  const tagPart = tagsForName(tags);
  const captionWords = caption && String(caption).trim() ? firstWords(caption, 4) : '';
  // Room left for the caption: total - ext - head - tags - separating spaces - uniqueness suffix.
  const reserved = ext.length + head.length + (tagPart ? tagPart.length + 1 : 0) + 4 + 1;
  const room = Math.max(0, MAX_NAME_LENGTH - reserved);
  const shortCaption = captionWords ? cut(captionWords, room) : '';
  return [head, shortCaption, tagPart].filter(Boolean).join(' ');
}

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif', 'image/avif': 'avif',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a',
  'video/webm': 'webm', 'video/mp4': 'mp4',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md',
  'text/html': 'html', 'text/csv': 'csv', 'application/json': 'json', 'application/zip': 'zip',
};

/** "audio/webm;codecs=opus" -> "audio/webm" */
export function baseMime(mimeType) {
  return String(mimeType || '').split(';')[0].trim().toLowerCase();
}

/**
 * Pick a file extension (without dot). Prefer the original file name's
 * extension, then the MIME type, then "bin".
 */
export function extensionFor(mimeType, originalName = '') {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(originalName));
  if (m) return m[1].toLowerCase();
  return MIME_EXT[baseMime(mimeType)] || 'bin';
}
