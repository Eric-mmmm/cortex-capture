// settings.js - defaults and validation for the Settings screen. Pure.

export const DEFAULT_TAGS = [];

/** Dictation languages offered by the Speak screen (first one is the default). */
export const DEFAULT_LANGS = ['fr-CA', 'en-CA'];

/**
 * "fr-CA, en-CA" -> ["fr-CA", "en-CA"]. Keeps only things that look like
 * BCP-47 language tags; falls back to the defaults if nothing valid is left.
 */
export function parseLangs(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,\s;]+/);
  const ok = [];
  for (const item of raw) {
    const lang = String(item).trim();
    if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang) && !ok.includes(lang)) ok.push(lang);
  }
  return ok.length ? ok : [...DEFAULT_LANGS];
}

/** Returns an error message, or '' when the URL looks like an Apps Script web app URL. */
export function checkScriptUrl(url) {
  const u = String(url ?? '').trim();
  if (!u) return 'Paste the web app URL from Apps Script.';
  let parsed;
  try { parsed = new URL(u); } catch { return 'That is not a valid URL.'; }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'; // allowed for testing
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return 'The URL must start with https://';
  if (!parsed.pathname.endsWith('/exec')) return 'The URL should end with /exec (use the deployed web app URL, not /dev).';
  return '';
}

/** Fill in missing settings with defaults. `stored` is whatever came from localStorage. */
export function withDefaults(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  return {
    url: String(s.url ?? '').trim(),
    token: String(s.token ?? '').trim(),
    langs: parseLangs(s.langs),
    tags: Array.isArray(s.tags) ? s.tags : [...DEFAULT_TAGS],
  };
}
