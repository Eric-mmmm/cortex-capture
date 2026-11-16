// protocol.js - the JSON "letter" the PWA sends to Apps Script, and how the
// answer is read. Pure (the base64 conversion is passed in).

/** Above this size we warn: base64 grows the payload by 1/3 and Apps Script has limits. */
export const WARN_BYTES = 25 * 1024 * 1024;

/**
 * Build the JSON body for one queue item.
 * Text items send `text`; binary items send `base64`.
 * `toBase64` is async (blob) => string.
 */
export async function buildPayload(item, token, toBase64) {
  const body = { token, name: item.name, mimeType: item.mimeType };
  if (item.kind === 'text') body.text = item.text ?? '';
  else body.base64 = await toBase64(item.blob);
  return body;
}

/**
 * Read the server's answer text. Apps Script returns an HTML page when
 * something is wrong with the deployment, so never assume JSON.
 * Always returns { ok, id?, name?, error? }.
 */
export function parseResponse(status, bodyText) {
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: `Server did not answer with JSON (HTTP ${status}). Check the deployment: Execute as Me, access Anyone.` };
  }
  if (data && data.ok === true) return { ok: true, id: data.id || '', name: data.name || '' };
  return { ok: false, error: (data && data.error) || `Server refused (HTTP ${status})` };
}
