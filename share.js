// share.js - turns an Android "Share" (multipart POST from the share sheet)
// into queue items. Called by the service worker.

import { enqueueText, enqueueBinary } from './enqueue.js';
import { shareToText } from './lib/capture.js';

/** Returns how many items were saved. */
export async function handleShare(formData) {
  let count = 0;
  const text = shareToText({
    title: formData.get('title') || '',
    text: formData.get('text') || '',
    url: formData.get('url') || '',
  });
  if (text) {
    await enqueueText({ text, via: 'share' });
    count += 1;
  }
  for (const file of formData.getAll('files')) {
    if (file && typeof file === 'object' && file.size > 0) {
      await enqueueBinary({ blob: file, label: 'file', originalName: file.name });
      count += 1;
    }
  }
  return count;
}
