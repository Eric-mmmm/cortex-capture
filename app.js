// app.js - the screen logic. Everything that decides names, markdown and
// queue rules lives in lib/ (and is unit tested); this file only wires
// buttons to those functions.

import * as db from './db.js';
import { enqueueText, enqueueBinary } from './enqueue.js';
import { drain, saveConfig } from './uploader.js';
import { pendingCount, recentCaptures, nextDueAt } from './lib/queue.js';
import { parseTags, timeLogText, stepHours, formatHours } from './lib/capture.js';
import { withDefaults, parseLangs, checkScriptUrl } from './lib/settings.js';
import { WARN_BYTES } from './lib/protocol.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'cortex.settings';

/* ---------- settings (localStorage) ---------- */

let settings = withDefaults(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'));
const selectedTags = new Set(); // tag chips toggled on the home screen

async function persistSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  await saveConfig(settings); // copy for the service worker (it cannot read localStorage)
}

/* ---------- small UI helpers ---------- */

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function setStatus(id, message, kind = '') {
  const el = $(id);
  el.textContent = message;
  el.className = `status ${kind}`.trim();
}

const SCREENS = ['home', 'speak', 'type', 'photo', 'log', 'settings'];
let currentScreen = 'home';

function show(name) {
  if (currentScreen === 'speak' && name !== 'speak') { stopDictation(); stopRecording(true); }
  currentScreen = name;
  SCREENS.forEach((s) => { $(`screen-${s}`).hidden = s !== name; });
  window.scrollTo(0, 0);
  if (name === 'log') prepareLog();
  if (name === 'settings') fillSettings();
  if (name === 'speak') prepareSpeak();
  if (name === 'home') refresh();
}

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-go]');
  if (target) show(target.dataset.go);
});
$('open-settings').addEventListener('click', () => show('settings'));

/** Called after every Save: back to home, tell Eric, start uploading. */
async function afterSave(message) {
  toast(message);
  show('home');
  requestSync();
  upload();
}

/* ---------- home: chips, recent list, queue badge ---------- */

function renderChips(container, onToggle, isOn) {
  container.replaceChildren();
  for (const tag of settings.tags) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = tag;
    b.setAttribute('aria-pressed', String(isOn(tag)));
    b.addEventListener('click', () => { onToggle(tag); renderChips(container, onToggle, isOn); });
    container.append(b);
  }
}

function renderHomeChips() {
  renderChips($('chips'), (tag) => {
    if (selectedTags.has(tag)) selectedTags.delete(tag); else selectedTags.add(tag);
  }, (tag) => selectedTags.has(tag));
}

const STATUS_WORD = { queued: 'queued', sending: 'sending', sent: 'sent', failed: 'failed' };

function renderRecent(items) {
  const list = $('recent');
  list.replaceChildren();
  const recent = recentCaptures(items, 3);
  if (!recent.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing captured yet.';
    list.append(li);
    return;
  }
  for (const item of recent) {
    const li = document.createElement('li');
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = item.label || item.name;
    if (item.status === 'failed' && item.lastError) {
      const err = document.createElement('span');
      err.className = 'err';
      err.textContent = item.lastError;
      what.append(err);
    }
    const pill = document.createElement('span');
    pill.className = `pill ${item.status}`;
    pill.textContent = STATUS_WORD[item.status];
    li.append(what, pill);
    list.append(li);
  }
}

let retryTimer;
async function refresh() {
  const items = await db.items.list();
  const count = pendingCount(items);
  $('queue-badge').hidden = count === 0;
  $('queue-badge').textContent = `${count} waiting`;
  $('send-now').hidden = count === 0;
  renderRecent(items);
  // If something is waiting for its retry time, wake up then.
  clearTimeout(retryTimer);
  const due = nextDueAt(items);
  if (due !== null) retryTimer = setTimeout(upload, Math.max(1000, due - Date.now() + 500));
}

/* ---------- uploading ---------- */

let draining = false;
async function upload({ force = false } = {}) {
  if (draining) return;
  draining = true;
  try {
    const result = await drain({ force, onChange: refresh });
    if (result.notConfigured) toast('Set the URL and token in Settings first.');
    else if (force && result.offline) toast('Still offline. Will retry.');
    else if (force && result.sent) toast(`Sent ${result.sent}`);
  } catch (err) {
    console.error('upload error', err);
  } finally {
    draining = false;
    refresh();
  }
}

/** Ask the browser to upload later, even if the app is closed (Chrome only; optional). */
async function requestSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if ('sync' in reg) await reg.sync.register('cortex-drain');
  } catch { /* Background Sync is a bonus, never required */ }
}

$('send-now').addEventListener('click', () => upload({ force: true }));
window.addEventListener('online', () => upload());
document.addEventListener('visibilitychange', () => { if (!document.hidden) upload(); });

/* ---------- type ---------- */

$('type-save').addEventListener('click', async () => {
  const text = $('type-text').value.trim();
  if (!text) { toast('Nothing to save yet.'); return; }
  await enqueueText({ text, via: 'type', tags: [...selectedTags] });
  $('type-text').value = '';
  afterSave('Saved');
});

/* ---------- speak: dictate (Web Speech API) ---------- */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;
let dictLang = settings.langs[0];
let committed = ''; // text already final
let restarts = 0;

function prepareSpeak() {
  // Dictation availability
  if (!Recognition) {
    $('pane-dictate').hidden = true;
    $('tab-dictate').hidden = true;
    $('dictate-missing').hidden = false;
    $('dictate-missing').textContent = 'Dictation is not available in this browser (no Web Speech API). Use Type or Record.';
    selectSpeakTab('record');
  }
  // Recording availability
  const canRecord = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!canRecord) {
    $('tab-record').hidden = true;
    $('pane-record').hidden = true;
    $('record-missing').hidden = false;
    $('record-missing').textContent = 'Recording is not available in this browser (no MediaRecorder or microphone access).';
  }
  if (Recognition && !listening) renderLangs();
}

function renderLangs() {
  const box = $('lang-toggle');
  box.replaceChildren();
  if (!settings.langs.includes(dictLang)) dictLang = settings.langs[0];
  for (const lang of settings.langs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = lang;
    b.setAttribute('aria-pressed', String(lang === dictLang));
    b.addEventListener('click', () => {
      if (listening) return; // change the language only while stopped
      dictLang = lang;
      renderLangs();
    });
    box.append(b);
  }
}

function selectSpeakTab(which) {
  const dictate = which === 'dictate';
  if (!dictate) stopDictation();
  if (dictate) stopRecording(true);
  $('tab-dictate').setAttribute('aria-selected', String(dictate));
  $('tab-record').setAttribute('aria-selected', String(!dictate));
  $('pane-dictate').hidden = !dictate || !Recognition;
  $('pane-record').hidden = dictate || $('tab-record').hidden;
}
$('tab-dictate').addEventListener('click', () => selectSpeakTab('dictate'));
$('tab-record').addEventListener('click', () => selectSpeakTab('record'));

function startDictation() {
  recognition = new Recognition();
  recognition.lang = dictLang;
  // Android Chrome repeats text when continuous=true, so we listen one phrase
  // at a time and restart in onend while the user has not pressed Stop.
  recognition.continuous = false;
  recognition.interimResults = true;
  committed = $('dictate-text').value ? `${$('dictate-text').value.trimEnd()} ` : '';
  restarts = 0;

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) committed += `${piece.trim()} `; else interim += piece;
    }
    $('dictate-text').value = committed + interim;
    restarts = 0;
  };
  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return; // normal pauses
    const reasons = {
      'not-allowed': 'Microphone permission was denied.',
      'service-not-allowed': 'Speech service is not allowed on this device.',
      'network': 'Dictation needs internet (the browser sends audio to a speech service).',
      'language-not-supported': `Language ${dictLang} is not supported here.`,
    };
    setStatus('dictate-status', reasons[event.error] || `Dictation error: ${event.error}`, 'bad');
    stopDictation(true);
  };
  recognition.onend = () => {
    if (!listening) return;
    restarts += 1;
    if (restarts > 8) { stopDictation(); return; } // too many empty rounds: give up quietly
    try { recognition.start(); } catch { stopDictation(); }
  };

  listening = true;
  recognition.start();
  $('dictate-toggle').textContent = 'Stop';
  $('dictate-toggle').classList.add('active');
  setStatus('dictate-status', `Listening (${dictLang})...`);
}

function stopDictation(keepStatus = false) {
  listening = false;
  if (recognition) { try { recognition.abort(); } catch { /* already stopped */ } }
  recognition = null;
  $('dictate-toggle').textContent = 'Start dictating';
  $('dictate-toggle').classList.remove('active');
  if (!keepStatus) setStatus('dictate-status', '');
}

$('dictate-toggle').addEventListener('click', () => (listening ? stopDictation() : startDictation()));
// Editing by hand while listening becomes the new base text.
$('dictate-text').addEventListener('input', () => { committed = `${$('dictate-text').value.trimEnd()} `; });
$('dictate-save').addEventListener('click', async () => {
  const text = $('dictate-text').value.trim();
  if (!text) { toast('Nothing to save yet.'); return; }
  stopDictation();
  await enqueueText({ text, via: 'speak', tags: [...selectedTags] });
  $('dictate-text').value = '';
  afterSave('Saved');
});

/* ---------- speak: record (MediaRecorder) ---------- */

let recorder = null;
let recStream = null;
let recChunks = [];
let recBytes = 0;
let recStarted = 0;
let recTimer;
let recBlob = null;
const STOP_BYTES = 25 * 1024 * 1024;

/** Pick a format the browser can record (Chrome gives audio/webm with Opus). */
function pickAudioType() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setStatus('record-status', 'Microphone permission was denied.', 'bad');
    return;
  }
  const type = pickAudioType();
  recorder = new MediaRecorder(recStream, type ? { mimeType: type } : undefined);
  recChunks = []; recBytes = 0; recBlob = null;
  $('record-preview').hidden = true;
  $('record-save').disabled = true;
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    recChunks.push(e.data);
    recBytes += e.data.size;
    if (recBytes >= STOP_BYTES) { stopRecording(); setStatus('record-status', 'Stopped at 25 MB: larger files may fail to upload.', 'warn'); }
  };
  recorder.onstop = () => {
    clearInterval(recTimer);
    recStream.getTracks().forEach((t) => t.stop());
    if (recChunks.length) {
      recBlob = new Blob(recChunks, { type: recorder.mimeType || type || 'audio/webm' });
      $('record-preview').src = URL.createObjectURL(recBlob);
      $('record-preview').hidden = false;
      $('record-save').disabled = false;
    }
    $('record-toggle').textContent = 'Record again';
    $('record-toggle').classList.remove('active');
  };
  recorder.start(1000); // a chunk every second so we can watch the size
  recStarted = Date.now();
  $('record-toggle').textContent = 'Stop recording';
  $('record-toggle').classList.add('active');
  recTimer = setInterval(updateRecordStatus, 500);
  updateRecordStatus();
}

function updateRecordStatus() {
  const secs = Math.floor((Date.now() - recStarted) / 1000);
  const mb = (recBytes / 1048576).toFixed(1);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  const near = recBytes > STOP_BYTES * 0.8;
  setStatus('record-status', `Recording ${mm}:${ss} - ${mb} MB${near ? ' - close to the 25 MB limit, stop soon' : ''}`, near ? 'warn' : '');
}

/** discard=true throws the recording away (leaving the screen). */
function stopRecording(discard = false) {
  if (recorder && recorder.state !== 'inactive') {
    if (discard) recorder.onstop = () => { clearInterval(recTimer); recStream.getTracks().forEach((t) => t.stop()); };
    recorder.stop();
  }
  if (discard) {
    recBlob = null;
    $('record-preview').hidden = true;
    $('record-save').disabled = true;
    $('record-toggle').textContent = 'Start recording';
    $('record-toggle').classList.remove('active');
    setStatus('record-status', '');
  }
}

$('record-toggle').addEventListener('click', () => (recorder && recorder.state === 'recording' ? stopRecording() : startRecording()));
$('record-save').addEventListener('click', async () => {
  if (!recBlob) return;
  if (recBlob.size > WARN_BYTES && !confirm('This recording is over 25 MB and may fail to upload. Save anyway?')) return;
  await enqueueBinary({ blob: recBlob, label: 'recording', tags: [...selectedTags] });
  recBlob = null;
  $('record-preview').hidden = true;
  $('record-save').disabled = true;
  $('record-toggle').textContent = 'Start recording';
  afterSave('Saved');
});

/* ---------- photo ---------- */

let photoFile = null;
$('photo-input').addEventListener('change', () => {
  photoFile = $('photo-input').files[0] || null;
  $('photo-save').disabled = !photoFile;
  if (!photoFile) { $('photo-preview').hidden = true; return; }
  $('photo-preview').src = URL.createObjectURL(photoFile);
  $('photo-preview').hidden = false;
  const mb = photoFile.size / 1048576;
  setStatus('photo-status', `${mb.toFixed(1)} MB`, photoFile.size > WARN_BYTES ? 'warn' : '');
});
$('photo-save').addEventListener('click', async () => {
  if (!photoFile) return;
  if (photoFile.size > WARN_BYTES && !confirm('This photo is over 25 MB and may fail to upload. Save anyway?')) return;
  await enqueueBinary({ blob: photoFile, label: 'photo', caption: $('photo-caption').value, tags: [...selectedTags], originalName: photoFile.name });
  photoFile = null;
  $('photo-input').value = '';
  $('photo-caption').value = '';
  $('photo-preview').hidden = true;
  $('photo-save').disabled = true;
  setStatus('photo-status', '');
  afterSave('Saved');
});

/* ---------- log time ---------- */

let hours = 1;
let logTag = '';

function prepareLog() {
  // If exactly one chip is selected on the home screen, start with it.
  logTag = selectedTags.size === 1 ? [...selectedTags][0] : '';
  renderLog();
}

function renderLog() {
  $('hours-value').textContent = formatHours(hours);
  renderChips($('log-tags'), (tag) => { logTag = logTag === tag ? '' : tag; renderLog(); }, (tag) => tag === logTag);
  $('log-save').disabled = !logTag;
  $('log-preview').textContent = logTag ? timeLogText(hours, logTag, $('log-deep').checked) : 'Pick what the time was spent on.';
}
$('hours-down').addEventListener('click', () => { hours = stepHours(hours, -1); renderLog(); });
$('hours-up').addEventListener('click', () => { hours = stepHours(hours, 1); renderLog(); });
$('log-deep').addEventListener('change', renderLog);
$('log-save').addEventListener('click', async () => {
  if (!logTag) return;
  await enqueueText({ text: timeLogText(hours, logTag, $('log-deep').checked), via: 'log', tags: [logTag] });
  hours = 1;
  afterSave('Time logged');
});

/* ---------- settings ---------- */

function fillSettings() {
  $('set-url').value = settings.url;
  $('set-token').value = settings.token;
  $('set-langs').value = settings.langs.join(', ');
  $('set-tags').value = settings.tags.join('\n');
  setStatus('set-status', '');
}

function readSettingsForm() {
  return {
    url: $('set-url').value.trim(),
    token: $('set-token').value.trim(),
    langs: parseLangs($('set-langs').value),
    tags: parseTags($('set-tags').value),
  };
}

$('set-test').addEventListener('click', async () => {
  const url = $('set-url').value.trim();
  const problem = checkScriptUrl(url);
  if (problem) { setStatus('set-status', problem, 'bad'); return; }
  setStatus('set-status', 'Testing...');
  try {
    const res = await fetch(url, { redirect: 'follow', credentials: 'omit' });
    const data = await res.json();
    if (data && data.service === 'cortex-capture') setStatus('set-status', 'Connected. The token is only checked on the first upload.', 'ok');
    else setStatus('set-status', 'Reached a server, but it is not the Cortex script.', 'bad');
  } catch {
    setStatus('set-status', 'Could not reach it. Check the URL, that access is "Anyone", and that you are online.', 'bad');
  }
});

$('set-save').addEventListener('click', async () => {
  const next = readSettingsForm();
  const problem = checkScriptUrl(next.url);
  if (problem) { setStatus('set-status', problem, 'bad'); return; }
  if (!next.token) { setStatus('set-status', 'Enter the token.', 'bad'); return; }
  settings = withDefaults(next);
  for (const tag of [...selectedTags]) if (!settings.tags.includes(tag)) selectedTags.delete(tag);
  dictLang = settings.langs[0];
  await persistSettings();
  renderHomeChips();
  toast('Settings saved');
  show('home');
  upload({ force: true }); // new URL/token: retry failed items right away
});

/* ---------- start-up ---------- */

async function start() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js', { type: 'module' }); } catch (err) { console.warn('service worker failed', err); }
  }
  await persistSettings(); // keeps the IndexedDB copy in step with localStorage
  renderHomeChips();

  const params = new URLSearchParams(location.search);
  const shared = params.get('shared');
  const go = params.get('go');
  if (params.has('shared') || params.has('go')) history.replaceState(null, '', location.pathname);

  const configured = Boolean(settings.url && settings.token);
  if (!configured) show('settings');
  else if (SCREENS.includes(go) && go !== 'home') show(go);
  else show('home');

  if (shared !== null) toast(Number(shared) > 0 ? `Saved ${shared} shared item${shared === '1' ? '' : 's'}` : 'Nothing was shared');
  if (configured) upload();
  // Safety net for flaky connections: look at the queue every 30 s while the app is open.
  setInterval(() => { if (!document.hidden) upload(); }, 30000);
}

start();
