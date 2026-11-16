// capture.js - pure logic that turns what Eric typed/said/photographed into
// "parts" ready for the queue: a file name, a MIME type and (for text) the
// markdown content. No DOM, no browser APIs.

import {
  formatClock, textStem, binaryStem, fitName, uniqueStem, extensionFor, baseMime,
} from './naming.js';

/** How a capture arrived. The markdown `via:` line is "phone-" + one of these. */
export const VIA = ['speak', 'type', 'log', 'share'];

/* ---------- tags ---------- */

/**
 * Turn user input into a clean tag list.
 * Accepts a string ("ELE1001, MTH1101" or one tag per line) or an array.
 * Trims, collapses spaces, removes a leading "#", drops empties and
 * duplicates (case-insensitive, first spelling wins), limits length to 40.
 */
export function parseTags(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,;\n]+/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const tag = String(item ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^#+\s*/, '')
      .slice(0, 40)
      .trim();
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

/**
 * One tag as it should appear inside the YAML list `[a, b]`.
 * Plain words stay plain; anything with YAML-special characters is
 * written as a double-quoted string (JSON quoting is valid YAML).
 */
export function yamlTag(tag) {
  const plain = /^[\p{L}\p{N}_][\p{L}\p{N}_ .+/-]*$/u.test(tag) && !/\s$/.test(tag);
  return plain ? tag : JSON.stringify(tag);
}

/** "tags: [ELE1001, MTH1101]" */
export function tagsLine(tags) {
  return `tags: [${(tags || []).map(yamlTag).join(', ')}]`;
}

/* ---------- markdown ---------- */

/**
 * The markdown file body. Format (exact):
 *
 *   ---
 *   type: capture
 *   captured: 2026-11-15 09:05
 *   via: phone-type
 *   tags: [ELE1001]
 *   ---
 *
 *   <the text>
 *
 * A single newline is added at the very end of the file.
 */
export function buildMarkdown({ text, via, tags, now }) {
  return [
    '---',
    'type: capture',
    `captured: ${formatClock(now)}`,
    `via: ${via}`,
    tagsLine(tags),
    '---',
    '',
    `${String(text ?? '').trim()}`,
    '',
  ].join('\n');
}

/* ---------- time log ---------- */

/** 1 -> "1", 0.25 -> "0.25", 1.5 -> "1.5" */
export function formatHours(hours) {
  return String(Number(Number(hours).toFixed(2)));
}

/** "2 hours on ELE1001" or "1.5 hours on Descent (not deep)". */
export function timeLogText(hours, tag, deep = true) {
  return `${formatHours(hours)} hours on ${tag}${deep ? '' : ' (not deep)'}`;
}

/** Move the hours stepper by one 0.25 step; stays between 0.25 and 24. */
export function stepHours(hours, direction) {
  const next = Math.round((Number(hours) + direction * 0.25) * 4) / 4;
  return Math.min(24, Math.max(0.25, next));
}

/* ---------- building queue parts ---------- */

/** Short text shown in the "last captures" list. */
export function labelFor(kind, text, caption) {
  if (kind === 'text') {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > 44 ? `${t.slice(0, 43)}…` : t;
  }
  const c = String(caption ?? '').replace(/\s+/g, ' ').trim();
  const name = kind.charAt(0).toUpperCase() + kind.slice(1);
  return c ? `${name}: ${c.length > 36 ? `${c.slice(0, 35)}…` : c}` : name;
}

/**
 * A text capture (dictation, typed note, time log, shared text).
 * `via` is one of VIA. `taken` is a Set of names already in the queue so
 * two notes in the same minute with the same first words do not collide.
 * Returns { file: { name, mimeType, text, label } }.
 */
export function buildTextCapture({ text, via, tags = [], now, taken = new Set() }) {
  if (!VIA.includes(via)) throw new Error(`unknown via: ${via}`);
  const stem = uniqueStem(textStem(now, text), ['.md'], taken);
  return {
    file: {
      name: fitName(stem, '.md'),
      mimeType: 'text/markdown',
      text: buildMarkdown({ text, via: `phone-${via}`, tags, now }),
      label: labelFor('text', text),
    },
  };
}

/**
 * A binary capture (photo, recording, shared file). The caller attaches the
 * actual bytes; this only decides names.
 *   label: 'photo' | 'recording' | 'file'
 * Returns { file: { name, mimeType, label }, sidecar: { name, mimeType, text } | null }.
 * The sidecar (caption) shares the stem of the file: "<stem>.md".
 */
export function buildBinaryCapture({
  label, mimeType, originalName = '', caption = '', tags = [], now, taken = new Set(),
}) {
  const ext = `.${extensionFor(mimeType, originalName)}`;
  const hasCaption = Boolean(String(caption).trim());
  const exts = hasCaption ? [ext, '.md'] : [ext];
  const stem = uniqueStem(binaryStem(now, label, caption, tags, ext), exts, taken);
  const file = {
    name: fitName(stem, ext),
    mimeType: baseMime(mimeType) || 'application/octet-stream',
    label: labelFor(label, '', caption),
  };
  let sidecar = null;
  if (hasCaption) {
    const via = label === 'recording' ? 'speak' : label;
    sidecar = {
      name: fitName(stem, '.md'),
      mimeType: 'text/markdown',
      // Same front matter as a text capture, plus a pointer to the attachment.
      text: buildMarkdown({ text: `${caption}\n\nAttachment: ${file.name}`, via: `phone-${via}`, tags, now }),
    };
  }
  return { file, sidecar };
}

/** Combine the fields of an Android share into one text (dedupes repeats). */
export function shareToText({ title = '', text = '', url = '' } = {}) {
  const parts = [];
  for (const piece of [title, text, url]) {
    const p = String(piece ?? '').trim();
    if (p && !parts.some((x) => x.includes(p))) parts.push(p);
  }
  return parts.join('\n');
}
