/**
 * service-worker.js — Background service worker for Pagewalk
 * Module type: uses static imports.
 */
import { createGuide, createStep, updateStep, listSteps, deleteGuide, getGuide } from '../lib/storage.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const SCREENSHOT_DELAY_MS = 300;
const SCREENSHOT_QUALITY  = 85;
const SESSION_KEY         = 'pagewalk_state';
const GUIDE_ME_KEY        = 'pw_guideme';
const WIDGET_HIDE_DELAY   = 60;

// ─── Recording session state ─────────────────────────────────────────────────

let state = {
  recording: false,
  paused: false,
  guideId: null,
  tabId: null,
  stepCount: 0,
  lastClickStepId: null,   // for click+keystroke merging
  lastClickFieldEl: null,  // not serializable but we only use inside a single event loop
};

// pendingCapture is a transient in-memory lock — must NOT be persisted or
// restored by loadState(), otherwise the loadState() race across concurrent
// messages can leave it stuck at true and silently drop all subsequent clicks.
let pendingCapture = false;

async function loadState() {
  try {
    const s = await chrome.storage.session.get(SESSION_KEY);
    if (s[SESSION_KEY]) state = { ...state, ...s[SESSION_KEY] };
  } catch (_) {}
}
async function saveState() {
  try { await chrome.storage.session.set({ [SESSION_KEY]: state }); } catch (_) {}
}
async function clearState() {
  state = { recording: false, paused: false, guideId: null, tabId: null, stepCount: 0, lastClickStepId: null };
  pendingCapture = false;
  await chrome.storage.session.remove(SESSION_KEY);
}

// ─── Side panel wiring ───────────────────────────────────────────────────────

// Open the side panel when the user clicks the toolbar icon.
chrome.runtime.onInstalled.addListener(() => {
  try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (_) {}
});
chrome.runtime.onStartup.addListener(() => {
  try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (_) {}
});
// Also set it at SW startup in case neither event fires (dev reload)
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (_) {}

// ─── Badge helpers ───────────────────────────────────────────────────────────

function setBadgeRecording() {
  chrome.action.setBadgeText({ text: 'REC' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
}
function setBadgePaused() {
  chrome.action.setBadgeText({ text: 'II' });
  chrome.action.setBadgeBackgroundColor({ color: '#94a3b8' });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
}
function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
}

// ─── Settings ────────────────────────────────────────────────────────────────

async function getSettings() {
  const r = await chrome.storage.local.get('pagewalk_settings');
  return r.pagewalk_settings || {
    screenshotDelay: SCREENSHOT_DELAY_MS,
    jpegQuality: SCREENSHOT_QUALITY,
    captureOnStart: true,
    showWidget: true,
  };
}

// ─── Message router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    console.error('[Pagewalk SW] error:', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(msg, sender) {
  await loadState();

  switch (msg.type) {
    case 'GET_STATE': {
      const s = await getSettings();
      return {
        recording: state.recording,
        paused: state.paused,
        guideId: state.guideId,
        stepCount: state.stepCount,
        tabId: state.tabId,
        showWidget: s.showWidget !== false,
      };
    }
    case 'START_RECORDING':
      return startRecording(msg.tabId, msg.title);
    case 'STOP_RECORDING':
      return stopRecording();
    case 'DISCARD_RECORDING':
      return discardRecording();
    case 'PAUSE_RECORDING':
      return setPaused(true);
    case 'RESUME_RECORDING':
      return setPaused(false);
    case 'RESUME_CAPTURE_FOR_GUIDE':
      return resumeCaptureForGuide(msg.guideId, msg.tabId);
    case 'START_GUIDE_ME':
      return startGuideMe(msg.guideId, msg.guideTitle, msg.steps);
    case 'GET_GUIDE_ME_STATE':
      return getGuideMeStateForSender(sender, msg);
    case 'GUIDE_ME_ADVANCE':
      return advanceGuideMe(msg.delta || 1);
    case 'END_GUIDE_ME':
      return endGuideMe();
    case 'INSTALL_HISTORY_PATCH':
      return installHistoryPatchForSender(sender);
    case 'CLICK_DETECTED':
      return handleClickDetected(msg, sender);
    case 'MANUAL_CAPTURE':
      return handleManualCapture(msg, sender);
    case 'KEYSTROKE_DETECTED':
      return handleKeystrokeDetected(msg, sender);
    default:
      return { ok: false, error: `Unknown: ${msg.type}` };
  }
}

// ─── Recording lifecycle ─────────────────────────────────────────────────────

async function startRecording(tabId, title) {
  if (state.recording) return { ok: false, error: 'Already recording' };
  const guide = await createGuide(title || `Guide ${new Date().toLocaleString()}`);
  state.recording = true;
  state.paused = false;
  state.guideId   = guide.id;
  state.tabId     = tabId;
  state.stepCount = 0;
  // Reserve the capture pipeline while we set up, so a user click
  // doesn't race the initial captureOnStart screenshot.
  pendingCapture = true;
  state.lastClickStepId = null;
  await saveState();
  setBadgeRecording();

  const settings = await getSettings();

  // Capture the starting page FIRST (before injecting the recorder) so
  // there's no chance of a click arriving mid-capture and reordering the
  // first two steps. Screenshot capture and step creation are in separate
  // try blocks so a captureVisibleTab failure (rate limit, backgrounded
  // tab, etc.) doesn't prevent the step itself from being recorded.
  if (settings.captureOnStart) {
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch (_) {}

    let screenshotDataUrl = null;
    if (tab) {
      try {
        await delay(settings.screenshotDelay ?? SCREENSHOT_DELAY_MS);
        screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: 'jpeg', quality: settings.jpegQuality || SCREENSHOT_QUALITY,
        });
      } catch (err) {
        console.warn('[Pagewalk SW] captureOnStart screenshot failed:', err.message);
      }
    }

    // Create the initial step regardless — we'd rather have a text-only
    // "Navigate to …" step than silently drop it.
    try {
      const initialStep = await createStep(guide.id, {
        description: `Starting on ${tab?.title || tab?.url || 'page'}`,
        screenshotRaw: screenshotDataUrl,
        clickX: 0, clickY: 0,
        pageUrl: tab?.url || '', pageTitle: tab?.title || '',
        devicePixelRatio: 1,
        type: 'navigate',
        toUrl: tab?.url || '',
        // Flag this step so the viewer renders it as a hero cover and
        // Guide Me skips past it. Detectable regardless of whether the
        // captureOnStart setting is still enabled later.
        isInitialCapture: true,
      });
      state.stepCount = 1;
      await saveState();
      broadcastStepAdded(initialStep, 0);
    } catch (err) {
      console.warn('[Pagewalk SW] initial step creation failed:', err.message);
    }
  }

  // Now it's safe to inject the recorder and show the widget — any
  // clicks from this point forward become regular click steps.
  pendingCapture = false;
  await saveState();
  await injectRecorder(tabId);
  await showWidgetInTab(tabId, state.stepCount);

  // Persistent redaction: mask the page for the entire recording session
  await applyPersistentRedact(tabId);

  broadcastState();
  return { ok: true, guideId: guide.id };
}

async function stopRecording() {
  if (!state.recording) return { ok: false, error: 'Not recording' };
  const guideId = state.guideId;
  const tabId   = state.tabId;
  if (tabId) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'REDACT_PERSISTENT_STOP' }); } catch (_) {}
    try { await chrome.tabs.sendMessage(tabId, { type: 'STOP_RECORDING' }); } catch (_) {}
  }
  clearBadge();
  await clearState();
  broadcastState();
  // Open the new viewer for the finished guide
  // Open the finished guide in the viewer in edit mode so the user can
  // polish it immediately (matches Tango's "draft workflow" flow).
  chrome.tabs.create({ url: chrome.runtime.getURL(`viewer/viewer.html?id=${encodeURIComponent(guideId)}&edit=1`) });
  return { ok: true, guideId };
}

async function discardRecording() {
  if (!state.recording) return { ok: false, error: 'Not recording' };
  const guideId = state.guideId;
  const tabId   = state.tabId;
  if (tabId) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'REDACT_PERSISTENT_STOP' }); } catch (_) {}
    try { await chrome.tabs.sendMessage(tabId, { type: 'STOP_RECORDING' }); } catch (_) {}
  }
  if (guideId) {
    try { await deleteGuide(guideId); } catch (err) { console.warn('discard: deleteGuide failed', err); }
  }
  clearBadge();
  await clearState();
  broadcastState();
  return { ok: true };
}

// Resume capture on an existing guide (used by the viewer's "Capture more
// steps" option). New clicks/keystrokes will append to the existing guide.
async function resumeCaptureForGuide(guideId, tabId) {
  if (state.recording) return { ok: false, error: 'Already recording' };
  if (!guideId || !tabId) return { ok: false, error: 'Missing guide or tab' };
  const existing = await getGuide(guideId);
  if (!existing) return { ok: false, error: 'Guide not found' };
  const steps = await listSteps(guideId);
  state.recording = true;
  state.paused = false;
  state.guideId = guideId;
  state.tabId = tabId;
  state.stepCount = steps.length;
  pendingCapture = false;
  state.lastClickStepId = null;
  await saveState();
  await injectRecorder(tabId);
  await showWidgetInTab(tabId, state.stepCount);
  setBadgeRecording();
  broadcastState();
  return { ok: true, guideId };
}

async function setPaused(paused) {
  if (!state.recording) return { ok: false, error: 'Not recording' };
  state.paused = paused;
  await saveState();
  if (state.tabId) {
    try { await chrome.tabs.sendMessage(state.tabId, { type: 'SET_PAUSED', paused }); } catch (_) {}
  }
  if (paused) setBadgePaused(); else setBadgeRecording();
  broadcastState();
  return { ok: true, paused };
}

// ─── Guide Me session (persists across tab navigations) ────────────────────

async function getGuideMeSession() {
  try {
    const r = await chrome.storage.session.get(GUIDE_ME_KEY);
    return r[GUIDE_ME_KEY] || null;
  } catch (_) { return null; }
}

// Returns Guide Me state only if the requesting content script is in the
// Guide Me tab. Lets the dynamic content script register globally but
// cleanly no-op on every other tab. If the player provides a currentUrl,
// we auto-advance currentIndex here — this covers the case where the
// webNavigation event for the URL change arrives after (or never, on
// strict SPA sites) the player's own locationchange detection.
async function getGuideMeStateForSender(sender, msg) {
  const gm = await getGuideMeSession();
  if (!gm) return null;
  if (sender?.tab?.id && sender.tab.id !== gm.tabId) return null;
  if (msg?.currentUrl && sender?.tab?.id) {
    await handleGuideMeNavigation(sender.tab.id, msg.currentUrl);
    // Re-read session after potential index advance
    return (await getGuideMeSession()) || gm;
  }
  return gm;
}

async function setGuideMeSession(session) {
  try {
    if (session) await chrome.storage.session.set({ [GUIDE_ME_KEY]: session });
    else         await chrome.storage.session.remove(GUIDE_ME_KEY);
  } catch (_) {}
}

const GUIDE_ME_CONTENT_SCRIPT_ID = 'pagewalk-player';

// Monkey-patch installed into the page's MAIN world. Wraps history
// methods to dispatch a custom 'sl:locationchange' event that the
// content-script player listens for. Must be a plain function (no
// closures) so chrome.scripting.executeScript can serialize it.
function mainWorldHistoryPatch() {
  if (window.__slHistoryPatched) return;
  window.__slHistoryPatched = true;
  const fire = () => {
    try { window.dispatchEvent(new Event('sl:locationchange')); } catch (_) {}
  };
  const wrap = (name) => {
    const orig = history[name];
    if (!orig) return;
    history[name] = function () {
      const r = orig.apply(this, arguments);
      fire();
      return r;
    };
  };
  wrap('pushState');
  wrap('replaceState');
  window.addEventListener('popstate', fire);
  window.addEventListener('hashchange', fire);
}

// Inject the history patch into a tab's page MAIN world, bypassing page
// CSP via extension privilege. world:'MAIN' is available since Chrome 111.
async function injectMainWorldHistoryPatch(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: mainWorldHistoryPatch,
    });
  } catch (err) {
    console.warn('[Pagewalk SW] main-world patch inject failed:', err.message);
  }
}

async function installHistoryPatchForSender(sender) {
  if (!sender?.tab?.id) return { ok: false };
  await injectMainWorldHistoryPatch(sender.tab.id);
  return { ok: true };
}

async function startGuideMe(guideId, guideTitle, steps) {
  if (!Array.isArray(steps) || !steps.length) {
    return { ok: false, error: 'No steps to play' };
  }
  // Skip initial-capture steps — those are cover pages, not actions.
  const firstActionable = steps.findIndex(s => !s.isInitialCapture);
  const startIndex = firstActionable === -1 ? 0 : firstActionable;
  const firstUrl = steps[startIndex]?.pageUrl || steps.find(s => s.pageUrl)?.pageUrl;
  if (!firstUrl) return { ok: false, error: 'No starting URL' };

  // Open the first actionable step URL in a new tab.
  const tab = await chrome.tabs.create({ url: firstUrl, active: true });

  await setGuideMeSession({
    guideId,
    guideTitle: guideTitle || 'Guide',
    tabId: tab.id,
    steps,
    currentIndex: startIndex,
  });

  // Register player.js as a dynamic content script so it auto-runs on
  // every future navigation in any tab (SPA client routing included).
  // The script checks the session and bails on tabs that aren't ours.
  try {
    // Unregister any stale registration from a previous session
    try { await chrome.scripting.unregisterContentScripts({ ids: [GUIDE_ME_CONTENT_SCRIPT_ID] }); } catch (_) {}
    await chrome.scripting.registerContentScripts([{
      id: GUIDE_ME_CONTENT_SCRIPT_ID,
      js: ['content/player.js'],
      matches: ['http://*/*', 'https://*/*'],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: false,
    }]);
  } catch (err) {
    console.warn('[Pagewalk SW] registerContentScripts failed:', err.message);
  }

  // Wait for the tab to finish loading BEFORE injecting — trying to
  // inject into a still-loading tab (especially with world:'MAIN') often
  // fails silently because the page's JS realm isn't ready yet.
  await waitForTabComplete(tab.id, 10000);

  // Main-world history patch first so pushState events are caught from
  // the very first SPA route change on this page.
  try { await injectMainWorldHistoryPatch(tab.id); } catch (_) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/player.js'],
    });
  } catch (_) {}

  return { ok: true, tabId: tab.id };
}

// Poll until chrome.tabs.get reports status 'complete' or we time out.
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete') return resolve(t);
      } catch (_) { return resolve(null); }
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(check, 150);
    };
    check();
  });
}

async function advanceGuideMe(delta) {
  const session = await getGuideMeSession();
  if (!session) return { ok: false };
  // Skip past any initial-capture cover steps — they're not actionable.
  let next = session.currentIndex + delta;
  const step = delta > 0 ? 1 : -1;
  while (next >= 0 && next < session.steps.length && session.steps[next]?.isInitialCapture) {
    next += step;
  }
  next = Math.max(0, Math.min(session.steps.length - 1, next));
  session.currentIndex = next;
  await setGuideMeSession(session);
  return {
    ok: true,
    currentIndex: next,
    totalSteps: session.steps.length,
    step: session.steps[next],
  };
}

async function endGuideMe() {
  const session = await getGuideMeSession();
  if (session?.tabId) {
    try { await chrome.tabs.sendMessage(session.tabId, { type: 'END_GUIDE_ME' }); } catch (_) {}
  }
  await setGuideMeSession(null);
  // Tear down the dynamic content script so player.js stops running on
  // future page loads across all tabs.
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [GUIDE_ME_CONTENT_SCRIPT_ID] });
  } catch (_) {}
  return { ok: true };
}

// Lightweight path comparison — same host + pathname = same "page".
function urlsMatchLoose(a, b) {
  try {
    const ua = new URL(a), ub = new URL(b);
    return ua.host === ub.host && ua.pathname === ub.pathname;
  } catch (_) { return a === b; }
}

// Advance Guide Me currentIndex when the tab's URL no longer matches the
// current step. Called from tabs.onUpdated / webNavigation listeners. The
// player itself is injected via a dynamic content script (registered in
// startGuideMe), so we never need to executeScript here.
async function handleGuideMeNavigation(tabId, newUrl) {
  const gm = await getGuideMeSession();
  if (!gm || gm.tabId !== tabId || !newUrl) return;

  const currentStep = gm.steps[gm.currentIndex];
  if (!currentStep?.pageUrl || urlsMatchLoose(currentStep.pageUrl, newUrl)) return;

  // Advance until we match the new URL or run out of steps. Skip
  // initial-capture cover pages while advancing.
  let idx = gm.currentIndex + 1;
  while (idx < gm.steps.length) {
    const s = gm.steps[idx];
    if (s.isInitialCapture) { idx++; continue; }
    if (!s.pageUrl || urlsMatchLoose(s.pageUrl, newUrl)) break;
    idx++;
  }
  gm.currentIndex = Math.min(idx, gm.steps.length - 1);
  await setGuideMeSession(gm);
}

// ─── Click + keystroke handlers ─────────────────────────────────────────────

async function handleClickDetected(msg, sender) {
  if (!state.recording || state.paused || !state.guideId) return { ok: false };
  if (pendingCapture) return { ok: false, reason: 'busy' };
  const tabId    = sender.tab?.id  || state.tabId;
  const windowId = sender.tab?.windowId || null;
  if (!tabId) return { ok: false };

  pendingCapture = true;

  try {
    const settings = await getSettings();
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SCROLL_TO_ELEMENT', clientX: msg.clickX, clientY: msg.clickY,
      });
    } catch (_) {}
    await hideWidgetInTab(tabId);
    await delay(settings.screenshotDelay ?? SCREENSHOT_DELAY_MS);
    await redactInTab(tabId);

    let screenshotDataUrl = null;
    try {
      screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: 'jpeg', quality: settings.jpegQuality || SCREENSHOT_QUALITY,
      });
    } catch (err) {
      console.warn('[Pagewalk SW] captureVisibleTab failed:', err.message);
    }
    await unredactInTab(tabId);

    const step = await createStep(state.guideId, {
      description: msg.description || '',
      screenshotRaw: screenshotDataUrl,
      clickX: msg.clickX, clickY: msg.clickY,
      pageUrl: msg.pageUrl || '', pageTitle: msg.pageTitle || '',
      devicePixelRatio: msg.devicePixelRatio || 1,
      type: 'click',
      targetSelector: msg.targetSelector,
      targetXPath:    msg.targetXPath,
      targetText:     msg.targetText,
      targetAttrs:    msg.targetAttrs,
      targetTag:      msg.targetTag,
    });
    state.stepCount += 1;
    state.lastClickStepId = step.id;
    await saveState();
    broadcastStepAdded(step, state.stepCount - 1);
    await showWidgetInTab(tabId, state.stepCount);
    broadcastState();
    return { ok: true, stepCount: state.stepCount };
  } finally {
    pendingCapture = false;
  }
}

async function handleManualCapture(msg, sender) {
  if (!state.recording || state.paused || !state.guideId) return { ok: false };
  if (pendingCapture) return { ok: false, reason: 'busy' };
  const tabId = sender.tab?.id || state.tabId;
  if (!tabId) return { ok: false };
  // When fired from the sidepanel, sender.tab is undefined — look up the
  // real recording tab so we capture the right window and stamp the step
  // with the tab's actual URL/title instead of the sidepanel's.
  let windowId = sender.tab?.windowId || null;
  let pageUrl  = msg.pageUrl || '';
  let pageTitle = msg.pageTitle || '';
  if (!sender.tab) {
    try {
      const tab = await chrome.tabs.get(tabId);
      windowId = tab.windowId;
      pageUrl = pageUrl || tab.url || '';
      pageTitle = pageTitle || tab.title || '';
    } catch (_) { return { ok: false }; }
  }

  pendingCapture = true;
  try {
    const settings = await getSettings();
    await hideWidgetInTab(tabId);
    await delay(settings.screenshotDelay ?? SCREENSHOT_DELAY_MS);
    await redactInTab(tabId);

    let screenshotDataUrl = null;
    try {
      screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: 'jpeg', quality: settings.jpegQuality || SCREENSHOT_QUALITY,
      });
    } catch (err) {
      console.warn('[Pagewalk SW] captureVisibleTab failed:', err.message);
    }
    await unredactInTab(tabId);

    const step = await createStep(state.guideId, {
      description: 'Screenshot',
      screenshotRaw: screenshotDataUrl,
      clickX: 0, clickY: 0,
      pageUrl,
      pageTitle,
      devicePixelRatio: msg.devicePixelRatio || 1,
      type: 'click',
    });
    state.stepCount += 1;
    state.lastClickStepId = null; // manual captures don't merge with subsequent keystrokes
    await saveState();
    broadcastStepAdded(step, state.stepCount - 1);
    await showWidgetInTab(tabId, state.stepCount);
    broadcastState();
    return { ok: true, stepCount: state.stepCount };
  } finally {
    pendingCapture = false;
  }
}

async function handleKeystrokeDetected(msg, sender) {
  if (!state.recording || state.paused || !state.guideId) return { ok: false };
  const tabId    = sender.tab?.id  || state.tabId;
  const windowId = sender.tab?.windowId || null;
  if (!tabId) return { ok: false };

  // If the user just clicked this field and now typed into it, merge the two:
  // rewrite the previous click step into a "Type ... in ..." step instead of
  // adding a duplicate. Tango does the same thing.
  const maskedOrReal = msg.isPassword ? '••••••' : msg.value;
  const description = `Type "${truncate(maskedOrReal, 50)}" in "${msg.fieldDescription}"`;

  if (msg.mergeWithPreviousClick && state.lastClickStepId) {
    try {
      const merged = await updateStep(state.lastClickStepId, {
        type: 'keystroke',
        description,
        value: maskedOrReal,
      });
      state.lastClickStepId = null;
      await saveState();
      // Broadcast as update so the feed rewrites the existing card
      broadcastStepUpdated(merged, state.stepCount - 1);
      broadcastState();
      return { ok: true, merged: true };
    } catch (err) {
      console.warn('[Pagewalk SW] merge keystroke failed:', err.message);
      // fall through to new step
    }
  }

  // Otherwise create a new step, capturing a screenshot of the field
  if (pendingCapture) return { ok: false, reason: 'busy' };
  pendingCapture = true;

  try {
    const settings = await getSettings();
    await hideWidgetInTab(tabId);
    await delay(settings.screenshotDelay ?? SCREENSHOT_DELAY_MS);
    await redactInTab(tabId);

    let screenshotDataUrl = null;
    try {
      screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: 'jpeg', quality: settings.jpegQuality || SCREENSHOT_QUALITY,
      });
    } catch (err) {
      console.warn('[Pagewalk SW] captureVisibleTab failed:', err.message);
    }
    await unredactInTab(tabId);

    const step = await createStep(state.guideId, {
      description,
      screenshotRaw: screenshotDataUrl,
      clickX: msg.clickX, clickY: msg.clickY,
      pageUrl: msg.pageUrl || '', pageTitle: msg.pageTitle || '',
      devicePixelRatio: msg.devicePixelRatio || 1,
      type: 'keystroke',
      value: maskedOrReal,
      targetSelector: msg.targetSelector,
      targetXPath:    msg.targetXPath,
      targetText:     msg.targetText,
      targetAttrs:    msg.targetAttrs,
      targetTag:      msg.targetTag,
    });
    state.stepCount += 1;
    state.lastClickStepId = null;
    await saveState();
    broadcastStepAdded(step, state.stepCount - 1);
    await showWidgetInTab(tabId, state.stepCount);
    broadcastState();
    return { ok: true, stepCount: state.stepCount };
  } finally {
    pendingCapture = false;
  }
}

// ─── Widget show/hide helpers ────────────────────────────────────────────────

async function showWidgetInTab(tabId, stepCount) {
  const settings = await getSettings();
  if (settings.showWidget === false) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_WIDGET', stepCount });
  } catch (_) {}
}

async function hideWidgetInTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'HIDE_WIDGET_FOR_CAPTURE' });
    // Give the browser a tick to actually repaint before captureVisibleTab
    await delay(WIDGET_HIDE_DELAY);
  } catch (_) {}
}

async function applyPersistentRedact(tabId) {
  try {
    const settings = await getSettings();
    if (!settings.autoRedact || settings.redactMode !== 'persistent') return;
    await chrome.tabs.sendMessage(tabId, {
      type: 'REDACT_PERSISTENT_START',
      style: settings.redactStyle || 'redact',
      categories: settings.redactCategories || {},
      customPatterns: settings.redactCustomPatterns || [],
    });
  } catch (_) {}
}

async function redactInTab(tabId) {
  try {
    const settings = await getSettings();
    if (!settings.autoRedact) return;
    // Always re-run redaction before capture — catches new DOM content even in persistent mode.
    // Always re-run redaction before capture — catches new DOM content even in persistent mode
    await chrome.tabs.sendMessage(tabId, {
      type: 'REDACT_FOR_CAPTURE',
      style: settings.redactStyle || 'redact',
      categories: settings.redactCategories || {},
      customPatterns: settings.redactCustomPatterns || [],
    });
    await delay(WIDGET_HIDE_DELAY);
  } catch (_) {}
}

async function unredactInTab(tabId) {
  try {
    const settings = await getSettings();
    // In persistent mode, don't restore after each capture
    if (settings.autoRedact && settings.redactMode === 'persistent') return;
    await chrome.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_CAPTURE' });
  } catch (_) {}
}

// ─── Broadcast state to side panel ───────────────────────────────────────────

function broadcastState() {
  const snapshot = {
    recording: state.recording,
    paused: state.paused,
    guideId: state.guideId,
    stepCount: state.stepCount,
    tabId: state.tabId,
  };
  try { chrome.runtime.sendMessage({ type: 'STATE_CHANGED', state: snapshot }); } catch (_) {}
}

// Broadcast when a new step has been captured so the side panel can
// append it to the live feed without re-querying IndexedDB.
function broadcastStepAdded(step, index) {
  try {
    chrome.runtime.sendMessage({
      type: 'STEP_ADDED',
      step: {
        id: step.id,
        index,
        description: step.description,
        type: step.type || 'click',
        screenshotRaw: step.screenshotRaw,
        isInitialCapture: !!step.isInitialCapture,
      },
    });
  } catch (_) {}
}

// Broadcast when a step has been updated (e.g. merged click+type) so the
// feed can re-render the affected item instead of appending.
function broadcastStepUpdated(step, index) {
  try {
    chrome.runtime.sendMessage({
      type: 'STEP_UPDATED',
      step: {
        id: step.id,
        index,
        description: step.description,
        type: step.type || 'click',
        screenshotRaw: step.screenshotRaw,
        isInitialCapture: !!step.isInitialCapture,
      },
    });
  } catch (_) {}
}

// ─── Tab navigation re-injection + nav step capture ─────────────────────────

// ─── Guide Me re-injection via webNavigation ────────────────────────────
// These fire more reliably than chrome.tabs.onUpdated for both full loads
// and SPA client-side routing. Early injection on DOMContentLoaded so the
// overlay flash between pages is as short as possible.
chrome.webNavigation.onDOMContentLoaded.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await handleGuideMeNavigation(details.tabId, details.url);
}, { url: [{ schemes: ['http', 'https'] }] });

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  // Backup: also re-inject when the full page finishes loading in case
  // DOMContentLoaded fired before the SPA router wrote its app shell.
  await handleGuideMeNavigation(details.tabId, details.url);
}, { url: [{ schemes: ['http', 'https'] }] });

// SPA client-side routing (history.pushState) — no real page reload.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await handleGuideMeNavigation(details.tabId, details.url);
}, { url: [{ schemes: ['http', 'https'] }] });

// ─── Guide Me: watch for SPA navigations and full page loads ────────────
// Dynamic content scripts don't re-fire on history.pushState, so we use
// webNavigation events as the authoritative trigger for Guide Me session
// updates. The player itself also listens for locationchange events in
// the page's main world as a second safety net.

async function handleGuideMeNavForSession(tabId, url) {
  const gm = await getGuideMeSession();
  if (!gm || gm.tabId !== tabId) return;

  // Advance currentIndex if the URL no longer matches the current step.
  await handleGuideMeNavigation(tabId, url);

  // Ask the player on this tab to re-fetch state and re-render.
  // If the player isn't there yet (cold load), the SW will also call
  // executeScript below as a backup.
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'GUIDE_ME_URL_CHANGED' });
  } catch (_) { /* player not ready yet — page-load events will cover it */ }
}

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await handleGuideMeNavForSession(details.tabId, details.url);
}, { url: [{ schemes: ['http', 'https'] }] });

chrome.webNavigation.onReferenceFragmentUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await handleGuideMeNavForSession(details.tabId, details.url);
}, { url: [{ schemes: ['http', 'https'] }] });

chrome.webNavigation.onDOMContentLoaded.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const gm = await getGuideMeSession();
  if (!gm || gm.tabId !== details.tabId) return;
  await handleGuideMeNavigation(details.tabId, details.url);
  // Re-install the main-world history patch — a full navigation resets
  // the page's JS realm, so the previous patch is gone.
  await injectMainWorldHistoryPatch(details.tabId);
  // On full page loads the dynamic content script SHOULD run, but inject
  // as a backup in case registration is stale.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['content/player.js'],
    });
  } catch (_) {}
}, { url: [{ schemes: ['http', 'https'] }] });

// If a click on the recording/Guide-Me tab opens a new tab/window (common
// on banking sites that pop the login portal into a new window, OAuth
// flows, etc.), follow it: make the new tab the active tab for that
// session so subsequent clicks, screenshots, nav steps, and Guide Me
// overlays all land there. The original tab is abandoned — the user can
// always click it back if they want to continue there instead.
// If a click on the recording/Guide-Me tab opens a new tab/window (banking
// login portals, OAuth popups, SSO flows), follow it: make the new tab
// the active tab for that session so subsequent clicks, screenshots, nav
// steps, and Guide Me overlays all land there.
//
// We only follow FOREGROUND tabs (`tab.active === true`) so middle-click
// and Ctrl+click — which open background tabs — don't silently pull the
// recording away from what the user is looking at.
//
// We also remember the previous tab so onRemoved can restore it when a
// popup (OAuth dialog, etc.) closes.
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.openerTabId || !tab.active) return;

  await loadState();
  if (state.recording && !state.paused && tab.openerTabId === state.tabId) {
    state.previousTabId = state.tabId;
    state.tabId = tab.id;
    await saveState();
    // Widget/recorder injection happens in the onUpdated 'complete'
    // handler once the new tab finishes loading.
  }

  try {
    const gm = await getGuideMeSession();
    if (gm && tab.openerTabId === gm.tabId) {
      gm.previousTabId = gm.tabId;
      gm.tabId = tab.id;
      await setGuideMeSession(gm);
      // player.js is registered as a dynamic content script on all
      // http(s) URLs, so it will auto-run on the new tab's first
      // navigation. The webNavigation handlers further down will also
      // re-inject the main-world history patch.
    }
  } catch (_) {}
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  // details.frameId === 0 for main frame
  if (details.frameId !== 0) return;
  await loadState();
  if (!state.recording || state.paused || details.tabId !== state.tabId) return;
  // Ignore sub-document/history transitions that don't actually change the URL
  if (details.transitionType === 'auto_subframe' || details.transitionType === 'manual_subframe') return;

  // Record a navigation step. No screenshot: the next post-load load event
  // will inject the recorder which triggers the captureOnNavigation below.
  try {
    const navStep = await createStep(state.guideId, {
      description: `Navigate to ${friendlyUrl(details.url)}`,
      screenshotRaw: null,
      clickX: 0, clickY: 0,
      pageUrl: details.url || '',
      pageTitle: '',
      devicePixelRatio: 1,
      type: 'navigate',
      toUrl: details.url || '',
    });
    state.stepCount += 1;
    state.lastClickStepId = null;
    await saveState();
    broadcastStepAdded(navStep, state.stepCount - 1);
    broadcastState();
  } catch (err) {
    console.warn('[Pagewalk SW] nav step failed:', err.message);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;

  // Guide Me: re-inject on full page loads. Also handled by webNavigation
  // listeners below, but this is a belt-and-braces fallback.
  try {
    const tab = await chrome.tabs.get(tabId);
    await handleGuideMeNavigation(tabId, tab.url);
  } catch (_) {}

  await loadState();

  if (state.recording && tabId === state.tabId) {
    await delay(200);
    await injectRecorder(tabId);
    await applyPersistentRedact(tabId);
    await showWidgetInTab(tabId, state.stepCount);

    // Back-fill a screenshot + title onto the most recent nav step (if any)
    if (!state.paused) {
      try {
        const steps = await listSteps(state.guideId);
        const lastNav = [...steps].reverse().find(s => s.type === 'navigate' && !s.screenshotRaw);
        if (lastNav) {
          const settings = await getSettings();
          await hideWidgetInTab(tabId);
          await delay(settings.screenshotDelay ?? SCREENSHOT_DELAY_MS);
          await redactInTab(tabId);
          let shot = null;
          const tab = await chrome.tabs.get(tabId);
          try {
            shot = await chrome.tabs.captureVisibleTab(tab.windowId, {
              format: 'jpeg', quality: settings.jpegQuality || SCREENSHOT_QUALITY,
            });
          } catch (_) {}
          await unredactInTab(tabId);
          const updated = await updateStep(lastNav.id, {
            screenshotRaw: shot,
            pageTitle: tab.title || '',
            description: `Navigate to ${tab.title || friendlyUrl(tab.url || '')}`,
          });
          // Re-broadcast so the side panel feed replaces the placeholder
          // nav entry with the one that now has a thumbnail + page title.
          const navIdx = steps.findIndex(s => s.id === lastNav.id);
          broadcastStepUpdated(updated, navIdx >= 0 ? navIdx : state.stepCount - 1);
          await showWidgetInTab(tabId, state.stepCount);
        }
      } catch (err) {
        console.warn('[Pagewalk SW] nav backfill failed:', err.message);
      }
    }
  }
});

// Clean up the Guide Me session if its tab is closed.
chrome.tabs.onRemoved.addListener(async (closedTabId) => {
  // Recording: if the active recording tab is a popup we followed into
  // (OAuth dialog, SSO window) and it closes, restore the previous tab so
  // recording resumes where the user came from.
  try {
    await loadState();
    if (state.recording && state.tabId === closedTabId && state.previousTabId) {
      try {
        const prev = await chrome.tabs.get(state.previousTabId);
        if (prev) {
          state.tabId = state.previousTabId;
          state.previousTabId = null;
          await saveState();
          await injectRecorder(prev.id);
          await showWidgetInTab(prev.id, state.stepCount);
        }
      } catch (_) {
        // Previous tab is also gone — clear pointer so we don't retry.
        state.previousTabId = null;
        await saveState();
      }
    }
  } catch (_) {}

  // Guide Me: same fallback — restore opener when a followed popup closes.
  try {
    const gm = await getGuideMeSession();
    if (!gm || gm.tabId !== closedTabId) return;
    if (gm.previousTabId) {
      try {
        const prev = await chrome.tabs.get(gm.previousTabId);
        if (prev) {
          gm.tabId = gm.previousTabId;
          gm.previousTabId = null;
          await setGuideMeSession(gm);
          return;
        }
      } catch (_) {}
    }
    await setGuideMeSession(null);
  } catch (_) {}
});

// ─── Inject helpers ──────────────────────────────────────────────────────────

async function injectRecorder(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/recorder.js'],
      injectImmediately: true,
    });
  } catch (err) {
    console.warn('[Pagewalk SW] inject recorder failed:', err.message);
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function hostname(url) {
  try { return new URL(url || '').hostname; } catch (_) { return 'website'; }
}

function friendlyUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname === '/' ? '' : u.pathname);
  } catch (_) { return url || 'page'; }
}

function truncate(str, n) {
  if (!str) return '';
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

// Restore recording badge on SW startup and clean up any stale Guide Me
// registration from a previous run.
(async () => {
  await loadState();
  if (state.recording) {
    if (state.paused) setBadgePaused(); else setBadgeRecording();
  }
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [GUIDE_ME_CONTENT_SCRIPT_ID] });
    if (scripts.length && !(await getGuideMeSession())) {
      await chrome.scripting.unregisterContentScripts({ ids: [GUIDE_ME_CONTENT_SCRIPT_ID] });
    }
  } catch (_) {}
})();
