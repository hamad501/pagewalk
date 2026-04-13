/**
 * sidepanel.js — Pagewalk side panel entry UI
 * Mirrors the popup's start/stop flow but lives in chrome.sidePanel.
 */
import { listGuides, getStep, getGuide, listSteps } from '../lib/storage.js';
import { showConfirmModal } from '../lib/confirm-modal.js';

const STEP_TYPE_LABEL = { click: 'Click', keystroke: 'Type', navigate: 'Go' };

// Expand tokens in a guide title template. Tokens: {host}, {title}, {date},
// {time}, {url}. Unknown tokens are left untouched so the user sees what
// they typed. Empty result falls back to a plain host-based title.
function renderTitleTemplate(template, { host, title, url }) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const vars = { host: host || 'website', title: title || '', date, time, url: url || '' };
  const rendered = template.replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m,
  ).trim();
  return rendered || `Guide — ${vars.host}`;
}

const stateIdle  = document.getElementById('state-idle');
const stateRec   = document.getElementById('state-rec');
const startBtn   = document.getElementById('start-btn');
const stopBtn    = document.getElementById('stop-btn');
const discardBtn = document.getElementById('discard-btn');
const pauseBtn   = document.getElementById('pause-btn');
const pauseIcon  = document.getElementById('pause-icon');
const resumeIcon = document.getElementById('resume-icon');
const pauseLabel = document.getElementById('pause-label');
const captureBtn = document.getElementById('capture-btn');
const recPulse   = document.getElementById('rec-pulse');
const recLabel   = document.getElementById('rec-label');
const stepCountEl = document.getElementById('step-count');

const recentList   = document.getElementById('recent-list');
const recentEmpty  = document.getElementById('recent-empty');
const viewAllBtn   = document.getElementById('view-all-btn');
const dashboardBtn = document.getElementById('dashboard-btn');
const settingsBtn  = document.getElementById('settings-btn');

const feedEl      = document.getElementById('step-feed');
const feedEmptyEl = document.getElementById('feed-empty');

let currentState = null;
let pollTimer = null;
// Map stepId → feed DOM node, so STEP_UPDATED rewrites in place
let feedNodes = new Map();

// ─── Init ─────────────────────────────────────────────────────────────────

async function init() {
  try {
    currentState = await sendMessage({ type: 'GET_STATE' });
  } catch (err) {
    console.error('[SidePanel] init error:', err);
    currentState = { recording: false, stepCount: 0 };
  }
  render();
  await loadRecent();

  // If we opened mid-recording, seed the feed from IndexedDB so the user
  // doesn't see an empty "waiting for first click" state on a guide that
  // already has steps.
  if (currentState?.recording && currentState.guideId) {
    await seedFeedFromStorage(currentState.guideId);
  }

  // Listen for state changes from the service worker so the step counter
  // stays live while the panel is open.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATE_CHANGED') {
      const wasRecording = currentState?.recording;
      currentState = msg.state;
      // Clear feed only when recording ENDS. The start-side reset happens
      // in the Start Capture click handler, before START_RECORDING is sent,
      // so the initial captureOnStart step isn't wiped by a late STATE_CHANGED.
      if (wasRecording && !currentState.recording) clearFeed();
      render();
    }
    if (msg.type === 'STEP_ADDED') {
      appendFeedItem(msg.step);
    }
    if (msg.type === 'STEP_UPDATED') {
      updateFeedItem(msg.step);
    }
  });
  startPolling();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const s = await sendMessage({ type: 'GET_STATE' });
      if (s && JSON.stringify(s) !== JSON.stringify(currentState)) {
        currentState = s;
        render();
        // If recording just ended, refresh the recent list
        if (!s.recording) await loadRecent();
      }
    } catch (_) {}
  }, 1200);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function render() {
  if (!currentState) return;
  const { recording, paused, stepCount } = currentState;
  if (recording) {
    stateIdle.classList.add('hidden');
    stateRec.classList.remove('hidden');
    stepCountEl.textContent = stepCount || 0;
    if (paused) {
      recLabel.textContent = 'Paused';
      recPulse.classList.add('paused');
      pauseIcon.style.display = 'none';
      resumeIcon.style.display = '';
      pauseLabel.textContent = 'Resume';
      pauseBtn.title = 'Resume capture';
      captureBtn.disabled = true;
    } else {
      recLabel.textContent = 'Recording';
      recPulse.classList.remove('paused');
      pauseIcon.style.display = '';
      resumeIcon.style.display = 'none';
      pauseLabel.textContent = 'Pause';
      pauseBtn.title = 'Pause capture';
      captureBtn.disabled = false;
    }
  } else {
    stateIdle.classList.remove('hidden');
    stateRec.classList.add('hidden');
  }
}

// ─── Start / stop / discard ───────────────────────────────────────────────

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');
    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('edge://')) {
      alert('Cannot record on browser internal pages. Navigate to a website first.');
      return;
    }
    // Reset the feed NOW — before START_RECORDING fires — so any initial
    // captureOnStart step that arrives over STEP_ADDED isn't wiped later.
    clearFeed();

    const hostname = (() => {
      try { return new URL(url).hostname; } catch (_) { return 'website'; }
    })();
    const { pagewalk_settings: settings = {} } =
      await chrome.storage.local.get('pagewalk_settings');
    const template = (settings.titleTemplate || 'Guide — {host}').trim();
    const title = renderTitleTemplate(template, {
      host: hostname,
      title: tab.title || '',
      url,
    });
    const result = await sendMessage({
      type: 'START_RECORDING',
      tabId: tab.id,
      title,
    });
    if (result?.ok) {
      currentState = await sendMessage({ type: 'GET_STATE' });
      render();
    } else {
      alert(result?.error || 'Failed to start recording');
    }
  } finally {
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  try {
    await sendMessage({ type: 'STOP_RECORDING' });
    currentState = await sendMessage({ type: 'GET_STATE' });
    render();
    await loadRecent();
  } finally {
    stopBtn.disabled = false;
  }
});

pauseBtn.addEventListener('click', async () => {
  if (!currentState?.recording) return;
  pauseBtn.disabled = true;
  try {
    const next = !currentState.paused;
    await sendMessage({ type: next ? 'PAUSE_RECORDING' : 'RESUME_RECORDING' });
    currentState = await sendMessage({ type: 'GET_STATE' });
    render();
  } finally {
    pauseBtn.disabled = false;
  }
});

captureBtn.addEventListener('click', async () => {
  if (!currentState?.recording || currentState.paused) return;
  captureBtn.disabled = true;
  try {
    // Sidepanel has no page context for pageUrl/title — SW's
    // handleManualCapture falls back to looking up the recording tab.
    await sendMessage({ type: 'MANUAL_CAPTURE' });
  } finally {
    captureBtn.disabled = false;
  }
});

discardBtn.addEventListener('click', async () => {
  const ok = await showConfirmModal({
    title: 'Discard this recording?',
    body: 'All captured steps will be permanently deleted. This cannot be undone.',
    confirmLabel: 'Discard',
    cancelLabel: 'Keep recording',
    danger: true,
  });
  if (!ok) return;
  discardBtn.disabled = true;
  try {
    await sendMessage({ type: 'DISCARD_RECORDING' });
    currentState = await sendMessage({ type: 'GET_STATE' });
    render();
    await loadRecent();
  } finally {
    discardBtn.disabled = false;
  }
});

// ─── Recent guides ────────────────────────────────────────────────────────

async function loadRecent() {
  const guides = await listGuides();
  if (!guides.length) {
    recentEmpty.style.display = '';
    // Remove any existing items
    Array.from(recentList.querySelectorAll('.sp-guide-item')).forEach(el => el.remove());
    return;
  }
  recentEmpty.style.display = 'none';
  // Clear old items
  Array.from(recentList.querySelectorAll('.sp-guide-item')).forEach(el => el.remove());

  const top = guides.slice(0, 5);
  for (const guide of top) {
    const item = document.createElement('button');
    item.className = 'sp-guide-item';
    item.innerHTML = `
      <div class="sp-guide-thumb" id="sp-thumb-${escapeAttr(guide.id)}"></div>
      <div class="sp-guide-body">
        <div class="sp-guide-title">${escapeHtml(guide.title)}</div>
        <div class="sp-guide-meta">${guide.stepCount} step${guide.stepCount === 1 ? '' : 's'} · ${formatDate(guide.updatedAt || guide.createdAt)}</div>
      </div>
    `;
    item.addEventListener('click', () => openViewer(guide.id));
    recentList.appendChild(item);
    // Lazy-load thumb
    loadThumb(guide);
  }
}

async function loadThumb(guide) {
  const el = document.getElementById(`sp-thumb-${escapeAttr(guide.id)}`);
  if (!el) return;
  let step = null;
  if (guide.coverStep) step = await getStep(guide.coverStep);
  if (!step) {
    const steps = await listSteps(guide.id);
    step = steps[0];
  }
  if (!step) return;
  const src = step.screenshotAnnotated || step.screenshotRaw;
  // Use <img> instead of background-image to avoid data-URL quoting issues
  // and to benefit from native image decoding.
  if (src) {
    const img = document.createElement('img');
    img.className = 'sp-guide-thumb-img';
    img.alt = '';
    img.src = src;
    el.innerHTML = '';
    el.appendChild(img);
  }
}

function openViewer(guideId) {
  const url = chrome.runtime.getURL(`viewer/viewer.html?id=${encodeURIComponent(guideId)}`);
  chrome.tabs.create({ url });
}

viewAllBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});
dashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});
settingsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') + '#settings' });
});

// ─── Live step feed ───────────────────────────────────────────────────────

function clearFeed() {
  feedNodes.clear();
  Array.from(feedEl.querySelectorAll('.sp-feed-item')).forEach(el => el.remove());
  feedEmptyEl.style.display = '';
}

async function seedFeedFromStorage(guideId) {
  try {
    const steps = await listSteps(guideId);
    clearFeed();
    steps.forEach((s, i) => {
      appendFeedItem({
        id: s.id,
        index: i,
        description: s.description,
        type: s.type || 'click',
        screenshotRaw: s.screenshotRaw,
      });
    });
  } catch (err) {
    console.warn('[SidePanel] seedFeedFromStorage failed', err);
  }
}

function appendFeedItem(step) {
  feedEmptyEl.style.display = 'none';
  const node = buildFeedNode(step);
  feedNodes.set(step.id, node);
  feedEl.appendChild(node);
  // Auto-scroll to bottom so the newest step is visible
  feedEl.scrollTop = feedEl.scrollHeight;
}

function updateFeedItem(step) {
  const existing = feedNodes.get(step.id);
  if (!existing) { appendFeedItem(step); return; }
  const fresh = buildFeedNode(step);
  existing.replaceWith(fresh);
  feedNodes.set(step.id, fresh);
}

function buildFeedNode(step) {
  const el = document.createElement('div');
  el.className = 'sp-feed-item';
  el.dataset.id = step.id;

  const type = step.type || 'click';

  const numEl = document.createElement('div');
  numEl.className = 'sp-feed-num';
  numEl.textContent = String((step.index ?? 0) + 1);
  el.appendChild(numEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'sp-feed-body';

  const descEl = document.createElement('div');
  descEl.className = 'sp-feed-desc';
  descEl.textContent = step.description || 'Step';
  bodyEl.appendChild(descEl);

  const typeEl = document.createElement('span');
  typeEl.className = `sp-feed-type type-${type}`;
  typeEl.textContent = STEP_TYPE_LABEL[type] || 'Step';
  bodyEl.appendChild(typeEl);

  el.appendChild(bodyEl);
  return el;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]/g, '_');
}
function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffMins = Math.floor((now - d) / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

window.addEventListener('beforeunload', stopPolling);
init();
