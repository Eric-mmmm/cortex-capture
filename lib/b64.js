// b64.js - bytes -> base64 without blowing the call stack on big files.
// Works in browsers, service workers and Node (all have btoa).

export function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000; // convert 32 KB at a time
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Blob (or File) -> base64 string. */
export async function blobToBase64(blob) {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}
