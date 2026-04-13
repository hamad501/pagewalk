/**
 * player.js — Pagewalk live guide playback overlay
 * Injected into the page by the service worker during guide playback.
 * NOT a module — plain IIFE so it works with executeScript.
 */
(function () {
  'use strict';
  if (window.__slPlayerActive) return;
  // Claim the slot synchronously so a second injection that arrives before
  // the async session check resolves cannot also pass the guard above.
  window.__slPlayerActive = true;

  // sendMessage with exponential-backoff retry. Cold service workers can
  // briefly reject messages with "Receiving end does not exist" until
  // they finish booting; retry quietly.
  function sendMessageRetry(msg, tries = 5) {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tick = () => {
        attempt++;
        try {
          chrome.runtime.sendMessage(msg, (res) => {
            if (chrome.runtime.lastError) {
              const m = chrome.runtime.lastError.message || '';
              if (attempt < tries && /Receiving end does not exist|message port closed|Could not establish connection/.test(m)) {
                return setTimeout(tick, 50 * Math.pow(2, attempt - 1));
              }
              return reject(new Error(m));
            }
            resolve(res);
          });
        } catch (e) {
          if (attempt < tries) return setTimeout(tick, 50 * Math.pow(2, attempt - 1));
          reject(e);
        }
      };
      tick();
    });
  }
  // Expose for runPlayer scope
  window.__slSendMessageRetry = sendMessageRetry;

  // Quick check: is Guide Me active on this tab? The SW returns null
  // unless this message came from the Guide Me tab, so this content
  // script silently no-ops on every other page.
  sendMessageRetry({ type: 'GET_GUIDE_ME_STATE' }).then((res) => {
    if (!res || !res.steps || !res.steps.length) {
      window.__slPlayerActive = false; // release the slot — Guide Me not active on this tab
      return;
    }
    bootPlayer(res);
  }).catch(() => {
    window.__slPlayerActive = false; // SW unreachable — release so a later retry can run
  });

  function bootPlayer(initialGm) {
    // Mount under documentElement (not body) so SPA hydration that
    // replaces body children can't wipe us out.
    const mountTarget = document.documentElement || document.body;
    if (!mountTarget) {
      document.addEventListener('DOMContentLoaded', () => bootPlayer(initialGm), { once: true });
      return;
    }
    runPlayer(initialGm);
  }

  // Everything below here runs only when we've confirmed Guide Me is
  // active on this tab. Wrapped in runPlayer() so the whole body is
  // deferred until after the session check.
  function runPlayer(initialGm) {

  // ─── State ──────────────────────────────────────────────────────────────────
  let step       = null; // current step metadata
  let totalSteps = 0;
  let stepIndex  = 0;
  let isTransitioning = false;
  let localSteps = null;  // legacy in-process playback (unused by Guide Me now)
  let localGuideTitle = '';
  let guideMeMode = false;  // true when driven by SW-persisted Guide Me session

  // ─── DOM ────────────────────────────────────────────────────────────────────
  // Mount on <html>, not <body> — SPA hydration frameworks (SvelteKit,
  // Next, etc.) frequently wipe body children but leave html alone.
  const ROOT = document.createElement('div');
  ROOT.id    = 'sl-player-root';
  document.documentElement.appendChild(ROOT);

  const STYLE = document.createElement('style');
  STYLE.textContent = `
    #sl-player-root * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Arabic", sans-serif; }

    /* Dimming vignette behind the highlighted element */
    #sl-dim {
      position: fixed;
      inset: 0;
      z-index: 2147483638;
      background: rgba(10, 7, 22, 0.55);
      pointer-events: none;
      opacity: 0;
      transition: opacity .25s ease;
    }
    #sl-dim.visible { opacity: 1; }

    /* Element highlight box — drawn around the resolved live element */
    #sl-highlight {
      position: fixed;
      z-index: 2147483640;
      border: 3px solid #5D2E8C;
      border-radius: 8px;
      pointer-events: none;
      box-shadow:
        0 0 0 3px rgba(255, 255, 255, 0.95),
        0 0 0 6px rgba(93, 46, 140, 0.45),
        0 0 28px 8px rgba(93, 46, 140, 0.4),
        0 0 0 9999px transparent;
      transition: left .4s cubic-bezier(.4,0,.2,1),
                  top  .4s cubic-bezier(.4,0,.2,1),
                  width .3s, height .3s, opacity .25s, border-color .2s;
      opacity: 0;
      animation: sl-outline-pulse 2.4s ease-in-out infinite;
    }
    #sl-highlight.visible { opacity: 1; }
    @keyframes sl-outline-pulse {
      0%, 100% {
        box-shadow:
          0 0 0 3px rgba(255, 255, 255, 0.95),
          0 0 0 6px rgba(93, 46, 140, 0.45),
          0 0 28px 8px rgba(93, 46, 140, 0.4);
      }
      50% {
        box-shadow:
          0 0 0 3px rgba(255, 255, 255, 0.95),
          0 0 0 10px rgba(93, 46, 140, 0.55),
          0 0 40px 14px rgba(93, 46, 140, 0.55);
      }
    }

    /* Keep the old spotlight selector live as a backup for coord fallback */
    #sl-spotlight {
      position: fixed;
      z-index: 2147483640;
      border-radius: 50%;
      pointer-events: none;
      transition: left .45s cubic-bezier(.4,0,.2,1),
                  top  .45s cubic-bezier(.4,0,.2,1),
                  width .3s, height .3s, opacity .3s;
      box-shadow:
        0 0 0 3px #fff,
        0 0 0 6px #5D2E8C,
        0 0 0 9999px rgba(0,0,0,0.62);
      opacity: 0;
    }
    #sl-spotlight.visible { opacity: 1; }

    /* Tooltip card */
    #sl-tooltip {
      position: fixed;
      z-index: 2147483641;
      width: 320px;
      background: #fff;
      border-radius: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.1);
      overflow: hidden;
      transition: left .45s cubic-bezier(.4,0,.2,1), top .45s cubic-bezier(.4,0,.2,1), opacity .2s;
    }
    #sl-tooltip.sl-dragging {
      transition: opacity .2s;
      cursor: grabbing;
    }

    /* Drag handle — the header row doubles as the drag grip */
    #sl-header {
      cursor: grab;
      user-select: none;
    }
    #sl-close-btn { cursor: pointer; }
    #sl-tooltip.sl-entering { animation: sl-pop .25s cubic-bezier(.34,1.56,.64,1) forwards; }
    @keyframes sl-pop {
      from { transform: scale(0.88); opacity: 0; }
      to   { transform: scale(1);    opacity: 1; }
    }

    /* Progress bar */
    #sl-progress-track {
      height: 3px;
      background: #e2e8f0;
    }
    #sl-progress-fill {
      height: 3px;
      background: linear-gradient(90deg, #5D2E8C, #d679e7);
      transition: width .4s ease;
    }

    /* Header row */
    #sl-header {
      display: flex;
      align-items: center;
      padding: 10px 14px 6px;
      gap: 8px;
    }
    #sl-step-badge {
      background: #5D2E8C;
      color: #fff;
      font-size: 11px;
      font-weight: 800;
      padding: 2px 9px;
      border-radius: 99px;
      white-space: nowrap;
      letter-spacing: .03em;
    }
    #sl-guide-title {
      font-size: 11px;
      color: #94a3b8;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #sl-close-btn {
      background: none;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 2px 4px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    #sl-close-btn:hover { background: #f1f5f9; color: #1e293b; }

    /* Description */
    #sl-desc {
      font-size: 14px;
      font-weight: 600;
      color: #1e293b;
      padding: 6px 14px 4px;
      line-height: 1.5;
      word-break: break-word;
    }
    #sl-desc[dir="rtl"] { text-align: right; }

    /* Notes */
    #sl-notes {
      font-size: 12.5px;
      font-weight: 400;
      color: #64748b;
      padding: 0 14px 12px;
      line-height: 1.55;
      overflow-wrap: break-word;
      word-break: break-word;
      white-space: pre-wrap;
      max-height: 100px;
      overflow-y: auto;
      display: none;
    }
    #sl-notes.visible { display: block; }
    #sl-notes[dir="rtl"] { text-align: right; }

    /* Navigation */
    #sl-nav {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px 12px;
      border-top: 1px solid #f1f5f9;
      background: #fafafa;
    }
    .sl-nav-btn {
      flex: 1;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: background .15s, transform .1s;
    }
    .sl-nav-btn:active { transform: scale(0.97); }
    #sl-prev-btn {
      background: #f1f5f9;
      color: #475569;
    }
    #sl-prev-btn:hover { background: #e2e8f0; }
    #sl-prev-btn:disabled { opacity: .4; cursor: not-allowed; }
    #sl-next-btn {
      background: #5D2E8C;
      color: #fff;
    }
    #sl-next-btn:hover { background: #4a2470; }
    #sl-next-btn:disabled { opacity: .4; cursor: not-allowed; }

    /* Step dots */
    #sl-dots {
      display: flex;
      gap: 4px;
      justify-content: center;
      padding-bottom: 10px;
    }
    .sl-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #e2e8f0;
      transition: background .2s, transform .2s;
    }
    .sl-dot.active { background: #5D2E8C; transform: scale(1.3); }
    .sl-dot.done   { background: #c9b4e0; }
  `;
  // Build the overlay markup FIRST — ROOT.innerHTML replaces all children,
  // so if we appended STYLE before this, the stylesheet would be wiped
  // out and none of the overlay elements would have any styles applied
  // (invisible box-less divs). Append STYLE afterwards so it survives
  // as a sibling of the overlay nodes inside ROOT.
  ROOT.innerHTML = `
    <div id="sl-dim"></div>
    <div id="sl-highlight"></div>
    <div id="sl-spotlight"></div>
    <div id="sl-tooltip">
      <div id="sl-progress-track"><div id="sl-progress-fill"></div></div>
      <div id="sl-header">
        <span id="sl-step-badge">Step 1</span>
        <span id="sl-guide-title"></span>
        <button id="sl-close-btn" title="Close guide (Esc)">&#x2715;</button>
      </div>
      <p id="sl-desc"></p>
      <p id="sl-notes"></p>
      <div id="sl-nav">
        <button class="sl-nav-btn" id="sl-prev-btn">&#8592; Back</button>
        <button class="sl-nav-btn" id="sl-next-btn">Next &#8594;</button>
      </div>
      <div id="sl-dots"></div>
    </div>
  `;
  // Now append the stylesheet — survives re-mount because it travels
  // inside ROOT, and isn't wiped because innerHTML was already set.
  ROOT.appendChild(STYLE);
  makeTooltipDraggable();

  const dimEl      = ROOT.querySelector('#sl-dim');
  const highlight  = ROOT.querySelector('#sl-highlight');
  const spotlight  = ROOT.querySelector('#sl-spotlight');
  const tooltip    = ROOT.querySelector('#sl-tooltip');
  const stepBadge  = ROOT.querySelector('#sl-step-badge');
  const guideTitle = ROOT.querySelector('#sl-guide-title');
  const closeBtn   = ROOT.querySelector('#sl-close-btn');
  const descEl     = ROOT.querySelector('#sl-desc');
  const notesEl    = ROOT.querySelector('#sl-notes');
  const progressEl = ROOT.querySelector('#sl-progress-fill');
  const prevBtn    = ROOT.querySelector('#sl-prev-btn');
  const nextBtn    = ROOT.querySelector('#sl-next-btn');
  const dotsEl     = ROOT.querySelector('#sl-dots');

  let highlightTarget = null; // current live DOM element being highlighted
  let rafId = 0;
  let tooltipDragged = false; // true once user has manually repositioned the tooltip

  // ─── Render ─────────────────────────────────────────────────────────────────

  function render() {
    if (!step) return;

    const num = stepIndex + 1;
    stepBadge.textContent  = `Step ${num} of ${totalSteps}`;
    progressEl.style.width = `${(num / totalSteps) * 100}%`;

    // Description with RTL detection
    const isRTL = /[\u0600-\u06FF\u0590-\u05FF]/.test(step.description || '');
    descEl.textContent = step.description || `Step ${num}`;
    descEl.dir         = isRTL ? 'rtl' : 'ltr';

    // Notes (optional)
    const notes = (step.notes || '').trim();
    notesEl.textContent = notes;
    notesEl.dir         = isRTL ? 'rtl' : 'ltr';
    notesEl.classList.toggle('visible', !!notes);

    // Dots
    dotsEl.innerHTML = '';
    for (let i = 0; i < totalSteps; i++) {
      const d = document.createElement('div');
      d.className = 'sl-dot' + (i < stepIndex ? ' done' : i === stepIndex ? ' active' : '');
      dotsEl.appendChild(d);
    }

    // Nav buttons
    prevBtn.disabled = stepIndex === 0;
    nextBtn.textContent = stepIndex === totalSteps - 1 ? '✓ Done' : 'Next →';

    // Spotlight position
    positionSpotlight();

    // Tooltip position (after spotlight settled)
    requestAnimationFrame(() => requestAnimationFrame(() => positionTooltip()));

    // Pop animation
    tooltip.classList.remove('sl-entering');
    void tooltip.offsetWidth; // reflow
    tooltip.classList.add('sl-entering');
  }

  // Resolve the live element for the current step using the stored
  // identifiers. Priority: selector → xpath → text/attrs → tag. Returns
  // null if nothing matches (fallback to coordinate spotlight).
  function resolveTargetElement(s) {
    if (!s) return null;

    // 1. CSS selector
    if (s.targetSelector) {
      try {
        const found = document.querySelector(s.targetSelector);
        if (found && isVisible(found)) return found;
      } catch (_) {}
    }

    // 2. XPath
    if (s.targetXPath) {
      try {
        const result = document.evaluate(s.targetXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const node = result.singleNodeValue;
        if (node && node.nodeType === 1 && isVisible(node)) return node;
      } catch (_) {}
    }

    // 3. Attribute match
    const attrs = s.targetAttrs || {};
    const tag = s.targetTag || '*';
    const candidates = [];
    if (attrs.id) {
      try { candidates.push(document.getElementById(attrs.id)); } catch (_) {}
    }
    if (attrs.testId) {
      try { candidates.push(...document.querySelectorAll(`[data-testid="${CSS.escape(attrs.testId)}"]`)); } catch (_) {}
    }
    if (attrs.ariaLabel) {
      try { candidates.push(...document.querySelectorAll(`${tag}[aria-label="${CSS.escape(attrs.ariaLabel)}"]`)); } catch (_) {}
    }
    if (attrs.name) {
      try { candidates.push(...document.querySelectorAll(`${tag}[name="${CSS.escape(attrs.name)}"]`)); } catch (_) {}
    }
    const hit = candidates.find(el => el && isVisible(el));
    if (hit) return hit;

    // 4. Text content match (slow path — only for buttons/links)
    if (s.targetText && tag && (tag === 'button' || tag === 'a' || tag === 'span' || tag === 'div')) {
      const needle = s.targetText.trim().toLowerCase();
      const list = document.querySelectorAll(tag);
      for (const el of list) {
        if (isVisible(el) && (el.textContent || '').trim().toLowerCase().startsWith(needle.slice(0, 40))) {
          return el;
        }
      }
    }

    return null;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
    return true;
  }

  let resolveRetryTimer = 0;
  // Retry schedule in ms — after a navigation the SPA router may not have
  // mounted the target yet, so keep trying until it appears or we give up.
  const RESOLVE_RETRY_DELAYS = [120, 300, 600, 1200, 2000];

  function positionHighlight() {
    cancelAnimationFrame(rafId);
    clearTimeout(resolveRetryTimer);

    // Text-only / narrative step types (no interactive target) — skip
    // the highlight and spotlight entirely and just show the tooltip.
    const narrative = ['text', 'heading', 'callout', 'navigate'];
    if (narrative.includes(step.type)) {
      highlightTarget = null;
      highlight.classList.remove('visible');
      spotlight.classList.remove('visible');
      dimEl.classList.add('visible');
      return;
    }

    tryResolveAndPaint(0);
  }

  function tryResolveAndPaint(attempt) {
    const found = resolveTargetElement(step);
    if (found) {
      highlightTarget = found;
      const vr = found.getBoundingClientRect();
      const needsScroll = vr.top < 60 || vr.bottom > window.innerHeight - 60 || vr.left < 0 || vr.right > window.innerWidth;
      if (needsScroll) {
        try { found.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }); } catch (_) {}
      }
      requestAnimationFrame(() => paintHighlight(found));
      startTrackingHighlight();
      spotlight.classList.remove('visible');
      dimEl.classList.add('visible');
      return;
    }

    // Not found — retry with a backoff schedule. On SPA navigation the
    // router may mount the element a few hundred ms after DOMContentLoaded.
    if (attempt < RESOLVE_RETRY_DELAYS.length) {
      resolveRetryTimer = setTimeout(() => tryResolveAndPaint(attempt + 1), RESOLVE_RETRY_DELAYS[attempt]);
      return;
    }

    // Final fallback: circular spotlight at recorded coordinates
    stopTrackingHighlight();
    highlight.classList.remove('visible');
    dimEl.classList.remove('visible');
    const cx = step.clickX || window.innerWidth  / 2;
    const cy = step.clickY || window.innerHeight / 2;
    const r  = 40;
    spotlight.style.left   = `${cx - r}px`;
    spotlight.style.top    = `${cy - r}px`;
    spotlight.style.width  = `${r * 2}px`;
    spotlight.style.height = `${r * 2}px`;
    spotlight.classList.add('visible');
  }

  function paintHighlight(el) {
    const r = el.getBoundingClientRect();
    const pad = 4;
    highlight.style.left   = `${r.left - pad}px`;
    highlight.style.top    = `${r.top  - pad}px`;
    highlight.style.width  = `${r.width  + pad * 2}px`;
    highlight.style.height = `${r.height + pad * 2}px`;
    highlight.classList.add('visible');
  }

  function startTrackingHighlight() {
    const tick = () => {
      if (!highlightTarget || !document.contains(highlightTarget)) {
        stopTrackingHighlight();
        return;
      }
      paintHighlight(highlightTarget);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopTrackingHighlight() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    highlightTarget = null;
  }

  // Keep the old name pointing to the new function so the rest of the
  // file doesn't need rewriting.
  const positionSpotlight = positionHighlight;

  function positionTooltip() {
    if (tooltipDragged) return; // user has manually placed it — leave it there
    const TW = 320, TH = 220; // estimated tooltip dimensions
    let cx, cy, r;
    if (highlightTarget && document.contains(highlightTarget)) {
      const rect = highlightTarget.getBoundingClientRect();
      cx = rect.left + rect.width / 2;
      cy = rect.top  + rect.height / 2;
      r = Math.max(rect.width, rect.height) / 2 + 24;
    } else {
      cx = step.clickX || window.innerWidth  / 2;
      cy = step.clickY || window.innerHeight / 2;
      r = 56;
    }
    const vw = window.innerWidth, vh = window.innerHeight;

    // Try positions in preference order: right, left, below, above
    const candidates = [
      { left: cx + r,       top: cy - TH / 2  },  // right of spotlight
      { left: cx - r - TW,  top: cy - TH / 2  },  // left of spotlight
      { left: cx - TW / 2,  top: cy + r        },  // below
      { left: cx - TW / 2,  top: cy - r - TH   },  // above
    ];

    for (const pos of candidates) {
      const cl = Math.max(12, Math.min(vw - TW - 12, pos.left));
      const ct = Math.max(12, Math.min(vh - TH - 12, pos.top));
      // Accept if tooltip doesn't overlap spotlight significantly
      const centerOverlapX = Math.abs(cl + TW / 2 - cx);
      const centerOverlapY = Math.abs(ct + TH / 2 - cy);
      if (centerOverlapX > 80 || centerOverlapY > 80) {
        tooltip.style.left = `${cl}px`;
        tooltip.style.top  = `${ct}px`;
        return;
      }
    }
    // Fallback: bottom-right corner
    tooltip.style.left = `${vw - TW - 12}px`;
    tooltip.style.top  = `${vh - TH - 12}px`;
  }

  function makeTooltipDraggable() {
    const header = ROOT.querySelector('#sl-header');
    let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#sl-close-btn')) return; // close btn stays clickable
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const r = tooltip.getBoundingClientRect();
      startLeft = r.left; startTop = r.top;
      tooltip.classList.add('sl-dragging');
      header.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const left = Math.max(8, Math.min(window.innerWidth  - 328, startLeft + (e.clientX - startX)));
      const top  = Math.max(8, Math.min(window.innerHeight -  60, startTop  + (e.clientY - startY)));
      tooltip.style.left = left + 'px';
      tooltip.style.top  = top  + 'px';
      tooltipDragged = true;
    });

    header.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      tooltip.classList.remove('sl-dragging');
    });
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  async function navigate(direction) {
    if (isTransitioning) return;
    isTransitioning = true;
    try {
      // Guide Me mode: playback state lives in the SW so it survives
      // tab navigation. Ask the SW to advance and render what it returns.
      if (guideMeMode) {
        if (direction === 'next' && stepIndex >= totalSteps - 1) {
          // At the last step — pressing Next ends the guide.
          await sendMessage({ type: 'END_GUIDE_ME' });
          teardown();
          return;
        }
        const delta = direction === 'next' ? 1 : -1;
        const res = await sendMessage({ type: 'GUIDE_ME_ADVANCE', delta });
        if (res?.ok) {
          stepIndex = res.currentIndex;
          totalSteps = res.totalSteps;
          step = res.step;
          render();
        }
        return;
      }

      // Legacy local-playback mode (unused by Guide Me now, kept for compat).
      if (localSteps) {
        if (direction === 'next') {
          if (stepIndex >= localSteps.length - 1) { teardown(); return; }
          stepIndex++;
        } else {
          if (stepIndex <= 0) return;
          stepIndex--;
        }
        step = localSteps[stepIndex];
        render();
        return;
      }
    } finally {
      isTransitioning = false;
    }
  }

  // ─── Event listeners ────────────────────────────────────────────────────────

  nextBtn.addEventListener('click', () => navigate('next'));
  prevBtn.addEventListener('click', () => navigate('prev'));
  closeBtn.addEventListener('click', stopPlayback);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')      stopPlayback();
    if (e.key === 'ArrowRight')  navigate('next');
    if (e.key === 'ArrowLeft')   navigate('prev');
  });

  async function stopPlayback() {
    if (guideMeMode) {
      try { await sendMessage({ type: 'END_GUIDE_ME' }); } catch (_) {}
    }
    teardown();
  }

  // ─── Message listener (for SW-pushed updates) ───────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'END_GUIDE_ME') {
      teardown();
      return;
    }
    if (msg.type === 'GUIDE_ME_URL_CHANGED') {
      // SW detected a navigation (SPA or full) and wants us to re-fetch
      // session state (possibly at an advanced index) and re-render.
      refreshFromSession();
      return;
    }
    if (msg.type === 'SL_PLAY_GUIDE' && Array.isArray(msg.steps) && msg.steps.length) {
      // Legacy message path — still works if anything uses it.
      localSteps = msg.steps;
      totalSteps = msg.steps.length;
      stepIndex  = 0;
      step       = msg.steps[0];
      localGuideTitle = msg.guide?.title || '';
      guideTitle.textContent = localGuideTitle || 'Guide';
      render();
      return;
    }
    if (msg.type === 'PLAYBACK_UPDATE') {
      stepIndex = msg.currentIndex;
      step      = msg.step;
      totalSteps = msg.totalSteps;
      render();
    }
    if (msg.type === 'STOP_PLAYBACK') teardown();
  });

  // ─── SPA navigation detection ──────────────────────────────────────────
  //
  // Dynamic content scripts don't re-run on history.pushState, and the
  // isolated-world content script can't intercept the page's own history
  // calls directly (different JS realms). We:
  //   (a) inject a tiny patch into the page's MAIN world that dispatches
  //       a 'locationchange' event whenever pushState/replaceState/popstate
  //       fires
  //   (b) also use the modern Navigation API when available
  //   (c) listen for both here and refresh on any URL change.

  const currentUrl = { href: location.href };
  function onPotentialNav() {
    if (location.href === currentUrl.href) return;
    currentUrl.href = location.href;
    refreshFromSession();
  }

  // The page's main-world history patch is injected by the service worker
  // via chrome.scripting.executeScript({ world: 'MAIN' }) because
  // strict-CSP sites (like Coolify) block inline <script> tags. We just
  // ask the SW to inject it — the SW bypasses page CSP via extension
  // privilege. The patch, once installed, dispatches 'sl:locationchange'
  // on every history navigation which we listen for below.
  try {
    window.__slSendMessageRetry({ type: 'INSTALL_HISTORY_PATCH' })
      .catch(e => console.warn('[Pagewalk Player] history patch request failed:', e));
  } catch (_) {}

  window.addEventListener('sl:locationchange', onPotentialNav);
  window.addEventListener('popstate',    onPotentialNav);
  window.addEventListener('hashchange',  onPotentialNav);

  // Modern Navigation API — fires for all same-document navigations.
  // Falls back silently if the browser doesn't support it.
  try {
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigate', () => {
        // Defer one frame so the SPA router has run
        requestAnimationFrame(onPotentialNav);
      });
    }
  } catch (_) {}

  // Re-resolve state + re-render. Used whenever the URL changes
  // (full nav, pushState, popstate, hashchange) or when the SW tells us to.
  // We pass the current page URL so the SW can auto-advance currentIndex
  // even if its webNavigation listeners missed the event.
  async function refreshFromSession() {
    try {
      const gm = await window.__slSendMessageRetry({
        type: 'GET_GUIDE_ME_STATE',
        currentUrl: location.href,
      });
      if (!gm || !gm.steps || !gm.steps.length) {
        teardown();
        return;
      }
      stepIndex  = gm.currentIndex || 0;
      totalSteps = gm.steps.length;
      step       = gm.steps[stepIndex];
      localSteps = gm.steps;
      guideTitle.textContent = gm.guideTitle || 'Guide';
      ensureMounted();
      render();
    } catch (err) {
      console.warn('[Pagewalk Player] refreshFromSession failed:', err);
    }
  }

  // ─── Self-healing mount ─────────────────────────────────────────────────
  // Some SPA hydrations wipe elements aggressively. If ROOT gets removed
  // from the DOM, re-append it. MutationObserver on documentElement
  // watches its child list.
  function ensureMounted() {
    if (!document.contains(ROOT)) {
      try { document.documentElement.appendChild(ROOT); } catch (_) {}
    }
  }
  const mountObserver = new MutationObserver(() => ensureMounted());
  try {
    mountObserver.observe(document.documentElement, { childList: true, subtree: false });
  } catch (_) {}

  // ─── Init ───────────────────────────────────────────────────────────────────

  async function init() {
    // The outer IIFE already fetched Guide Me state and passed it in as
    // initialGm. Render from that directly.
    const gm = initialGm;
    if (gm && Array.isArray(gm.steps) && gm.steps.length) {
      guideMeMode = true;
      stepIndex   = gm.currentIndex || 0;
      totalSteps  = gm.steps.length;
      step        = gm.steps[stepIndex];
      localSteps  = gm.steps;
      guideTitle.textContent = gm.guideTitle || 'Guide';
      render();
      return;
    }

    // Legacy SW playback state (no longer used but kept for compat).
    try {
      const state = await sendMessage({ type: 'GET_PLAYBACK_STATE' });
      if (state && state.active) {
        stepIndex  = state.currentIndex;
        totalSteps = state.totalSteps;
        step       = state.step;
        guideTitle.textContent = state.guideTitle || 'Guide';
        render();
      }
    } catch (_) {}
  }

  function teardown() {
    cancelAnimationFrame(rafId);
    clearTimeout(resolveRetryTimer);
    rafId = 0;
    resolveRetryTimer = 0;
    highlightTarget = null;
    try { mountObserver.disconnect(); } catch (_) {}
    try { window.removeEventListener('sl:locationchange', onPotentialNav); } catch (_) {}
    try { window.removeEventListener('popstate',    onPotentialNav); } catch (_) {}
    try { window.removeEventListener('hashchange',  onPotentialNav); } catch (_) {}
    ROOT.remove();
    // STYLE lives inside ROOT now, removed along with it
    window.__slPlayerActive = false;
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });
  }

  init();
  } // end runPlayer
})();
