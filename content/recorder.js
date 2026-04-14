/**
 * recorder.js — Injected into recording tab to capture clicks, keystrokes,
 * and render the in-page floating capture widget (Tango-style).
 * NOT an ES module. Uses chrome.runtime.sendMessage to talk to the SW.
 */
(function () {
  'use strict';

  // Guard: don't inject twice
  if (window.__pagewalkRecorderActive) return;
  window.__pagewalkRecorderActive = true;

  // TEMP instrumentation — toggle off to silence page-console capture logs.
  const PW_DEBUG_CAPTURE = false;
  const _pwT0 = Date.now();
  function pwLog(tag, data) {
    if (!PW_DEBUG_CAPTURE) return;
    const t = ((Date.now() - _pwT0) / 1000).toFixed(3);
    console.log(`[pw+${t}s] ${tag}`, data || '');
  }

  // ─── State ──────────────────────────────────────────────────────────────
  let tearingDown   = false;
  let paused        = false;
  let widgetHost    = null;
  let widgetShadow  = null;
  let widgetStepCountEl = null;
  let widgetPauseBtn = null;
  let widgetStatusDot = null;
  let widgetStatusLabel = null;

  // Page-settle watcher state (for post-load screenshot signalling)
  let _settleTimer    = null;
  let _settleObserver = null;

  // Per-element debounced keystroke buffers. key = element reference
  const keystrokeBuffers = new WeakMap();
  // For merging click+type on the same field we track last clicked element
  let lastClickedElement = null;

  // ─── Click highlight animation ───────────────────────────────────────────
  function flashHighlight(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const pad = 4;
    const hl = document.createElement('div');
    hl.setAttribute('data-pagewalk', 'highlight');
    hl.style.cssText = 'all:initial;position:fixed;pointer-events:none;z-index:2147483646;'
      + 'border:2px solid #5D2E8C;border-radius:6px;'
      + 'box-shadow:0 0 0 0 rgba(93,46,140,0.5);'
      + 'left:' + (r.left - pad) + 'px;top:' + (r.top - pad) + 'px;'
      + 'width:' + (r.width + pad * 2) + 'px;height:' + (r.height + pad * 2) + 'px;'
      + 'transition:box-shadow 0.35s ease-out,opacity 0.35s ease-out;';
    document.documentElement.appendChild(hl);
    requestAnimationFrame(() => {
      hl.style.boxShadow = '0 0 0 6px rgba(93,46,140,0)';
      hl.style.opacity = '0';
    });
    setTimeout(() => hl.remove(), 400);
  }

  // ─── Click listener (capture phase, does NOT prevent default) ───────────
  function onCapture(event) {
    if (tearingDown || paused) return;
    if (event.button !== 0) return;
    if (event.target && event.target.closest && event.target.closest('[data-pagewalk]')) return;
    // Ignore clicks on our shadow host
    if (event.target === widgetHost || (widgetHost && event.composedPath && event.composedPath().includes(widgetHost))) return;

    // Native click fired — cancel any pending synthesis from mousedown.
    if (typeof clearPendingDown === 'function') clearPendingDown();

    // Walk up to the nearest interactive ancestor so we target the button,
    // not a span inside it.
    const targetEl = event.target.closest(INTERACTIVE_SELECTORS) || event.target;
    const description = getElementDescription(event.target);
    const rect = targetEl.getBoundingClientRect();
    const targetMeta = captureTargetMetadata(targetEl);

    // Track for potential click+type merge
    const interactiveEl = event.target.closest(INPUT_SELECTORS);
    lastClickedElement = interactiveEl || null;

    flashHighlight(targetEl);

    pwLog('click detected', { desc: description?.slice?.(0, 60), x: event.clientX, y: event.clientY });
    chrome.runtime.sendMessage({
      type: 'CLICK_DETECTED',
      description,
      clickX: Math.round(event.clientX),
      clickY: Math.round(event.clientY),
      elementRect: rect ? {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      } : null,
      pageUrl: location.href,
      pageTitle: document.title,
      devicePixelRatio: window.devicePixelRatio || 1,
      // Element identity for Guide Me replay
      targetSelector: targetMeta.selector,
      targetXPath:    targetMeta.xpath,
      targetText:     targetMeta.text,
      targetAttrs:    targetMeta.attrs,
      targetTag:      targetMeta.tag,
    }).catch(() => {});

    // After sending the click, watch for the DOM to settle so the SW
    // knows when to take the post-load screenshot (SPA route changes).
    startPageSettleWatcher();
  }

  // ─── Page-settle watcher ─────────────────────────────────────────────────
  // Sends PAGE_SETTLED to the SW once the DOM stops mutating after a click.
  // On traditional navigations this script is destroyed before it can fire,
  // which is the correct signal — the SW aborts via webNavigation.onCommitted.
  function startPageSettleWatcher() {
    if (_settleTimer)    { clearTimeout(_settleTimer);       _settleTimer = null; }
    if (_settleObserver) { _settleObserver.disconnect(); _settleObserver = null; }

    let fired = false;

    function signal() {
      if (fired || tearingDown) return;
      fired = true;
      if (_settleTimer)    { clearTimeout(_settleTimer);       _settleTimer = null; }
      if (_settleObserver) { _settleObserver.disconnect(); _settleObserver = null; }
      chrome.runtime.sendMessage({ type: 'PAGE_SETTLED' }).catch(() => {});
    }

    // Safety net: fire after 5 s even if the DOM keeps mutating
    _settleTimer = setTimeout(signal, 5000);

    function startObserving() {
      let quietTimer = null;
      _settleObserver = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(signal, 500);
      });
      _settleObserver.observe(document.body || document.documentElement, {
        childList: true, subtree: true, characterData: true,
      });
      // Fire immediately if the DOM is already quiet
      quietTimer = setTimeout(signal, 500);
    }

    if (document.readyState === 'complete') {
      startObserving();
    } else {
      document.addEventListener('readystatechange', function onReady() {
        if (document.readyState === 'complete') {
          document.removeEventListener('readystatechange', onReady);
          startObserving();
        }
      });
    }
  }

  // ─── Mousedown listener — fires before any click handlers ──────────────
  // Signals the SW to take the pre-click screenshot at the earliest possible
  // moment, before JS event handlers, focus rings, or active states change
  // the page appearance. Also captures target metadata as a FALLBACK for
  // sites (e.g. Coolify) that navigate on pointerdown — in those cases the
  // original click-target element is removed from the DOM before mouseup,
  // which causes Chrome to suppress the `click` event entirely. Without
  // this fallback, such clicks never produce a step.
  let _pendingDown = null;
  let _pendingSynthTimer = null;
  const CLICK_DRAG_THRESHOLD_PX = 8;
  const CLICK_SYNTH_DELAY_MS = 300;

  function clearPendingDown() {
    _pendingDown = null;
    if (_pendingSynthTimer) {
      clearTimeout(_pendingSynthTimer);
      _pendingSynthTimer = null;
    }
  }

  function onMousedown(event) {
    if (tearingDown || paused) return;
    if (event.button !== 0) return;
    if (event.target?.closest?.('[data-pagewalk]')) return;
    if (event.target === widgetHost || (widgetHost && event.composedPath?.().includes(widgetHost))) return;

    pwLog('mousedown', { tag: event.target?.tagName, cls: String(event.target?.className || '').slice(0, 40) });

    // Capture target metadata NOW, while the element is still in the DOM.
    // If a sync pointerdown handler on the page then removes/replaces this
    // element, we can still synthesize a click from this stashed data.
    try {
      const targetEl = event.target.closest(INTERACTIVE_SELECTORS) || event.target;
      const rect = targetEl.getBoundingClientRect();
      const targetMeta = captureTargetMetadata(targetEl);
      _pendingDown = {
        description: getElementDescription(event.target),
        clickX: event.clientX, clickY: event.clientY,
        downX: event.clientX, downY: event.clientY,
        rect,
        targetMeta,
        pageUrl: location.href,
        pageTitle: document.title,
        devicePixelRatio: window.devicePixelRatio || 1,
        interactiveEl: event.target.closest(INPUT_SELECTORS) || null,
        ts: Date.now(),
      };
    } catch (_) {
      _pendingDown = null;
    }

    hideWidgetForCapture('MOUSEDOWN_CAPTURE');
  }

  // Fires after mouseup when the browser dispatches click normally.
  // Cancels the synthesis fallback — the real click handler (onCapture)
  // will produce the step using fresh event data.
  function onPointerupForSynth(event) {
    if (!_pendingDown) return;
    if (event.button !== 0) return;
    const dx = event.clientX - _pendingDown.downX;
    const dy = event.clientY - _pendingDown.downY;
    if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) {
      // Pointer moved too far — treat as drag, NOT a click. Abort synthesis.
      pwLog('pointerup drag — abort synth', { dx, dy });
      clearPendingDown();
      return;
    }
    // Arm the synthesis timer. If a real `click` event arrives first, it
    // calls clearPendingDown() via onCapture. Otherwise we synthesize.
    if (_pendingSynthTimer) clearTimeout(_pendingSynthTimer);
    _pendingSynthTimer = setTimeout(() => {
      if (!_pendingDown) return;
      const d = _pendingDown;
      _pendingDown = null;
      _pendingSynthTimer = null;
      pwLog('synth click (no native click fired)', { desc: d.description?.slice?.(0, 60) });
      chrome.runtime.sendMessage({
        type: 'CLICK_DETECTED',
        description: d.description,
        clickX: Math.round(d.clickX),
        clickY: Math.round(d.clickY),
        elementRect: d.rect ? {
          top: Math.round(d.rect.top),
          left: Math.round(d.rect.left),
          width: Math.round(d.rect.width),
          height: Math.round(d.rect.height),
        } : null,
        pageUrl: d.pageUrl,
        pageTitle: d.pageTitle,
        devicePixelRatio: d.devicePixelRatio,
        targetSelector: d.targetMeta.selector,
        targetXPath:    d.targetMeta.xpath,
        targetText:     d.targetMeta.text,
        targetAttrs:    d.targetMeta.attrs,
        targetTag:      d.targetMeta.tag,
        synthesized:    true,
      }).catch(() => {});
      lastClickedElement = d.interactiveEl;
      startPageSettleWatcher();
    }, CLICK_SYNTH_DELAY_MS);
  }

  document.addEventListener('pointerup', onPointerupForSynth, { capture: true, passive: true });

  // Hide the widget, wait for the compositor to paint the hidden state,
  // THEN ask the SW to capture. Without the double-rAF, Chrome can sample
  // captureVisibleTab from a frame that was rasterized before the
  // visibility:hidden change landed, leaving the widget in the screenshot.
  //
  // Restore is DEBOUNCED so rapid-fire proactive-hover captures don't strobe
  // the widget visible → hidden → visible every 900 ms. The widget stays
  // hidden during a burst of captures and only fades back in once the user
  // stops hovering over interactive elements for WIDGET_RESTORE_DELAY_MS.
  let _widgetRestoreTimer = null;
  const WIDGET_RESTORE_DELAY_MS = 400;
  const WIDGET_OFFSCREEN_TRANSFORM = 'translate(-99999px, -99999px)';
  function hideWidgetForCapture(messageType) {
    if (_widgetRestoreTimer) {
      clearTimeout(_widgetRestoreTimer);
      _widgetRestoreTimer = null;
    }
    // Translate the widget off-screen instead of visibility:hidden.
    // `visibility: hidden` leaves the element on its existing compositor
    // layer, and Chrome can serve a stale cached raster for that layer to
    // captureVisibleTab — so the widget still appears in the screenshot.
    // A transform moves the widget outside the viewport entirely; the
    // capture API only reads the visible viewport, so the widget is
    // guaranteed absent from the frame regardless of layer caching.
    if (widgetHost) widgetHost.style.transform = WIDGET_OFFSCREEN_TRANSFORM;
    const fire = () => {
      chrome.runtime.sendMessage({ type: messageType })
        .catch(() => {})
        .finally(() => {
          if (_widgetRestoreTimer) clearTimeout(_widgetRestoreTimer);
          _widgetRestoreTimer = setTimeout(() => {
            if (widgetHost) widgetHost.style.transform = '';
            _widgetRestoreTimer = null;
          }, WIDGET_RESTORE_DELAY_MS);
        });
    };
    // Two rAFs = one full paint cycle — first rAF runs before paint, second
    // runs after the off-screen frame has been committed to the compositor.
    requestAnimationFrame(() => requestAnimationFrame(fire));
  }

  document.addEventListener('mousedown', onMousedown, { capture: true, passive: true });
  document.addEventListener('click', onCapture, { capture: true, passive: true });

  // ─── Proactive snapshot on hover ────────────────────────────────────────
  // captureVisibleTab waits for the next compositor frame, so a capture
  // fired on mousedown can still rasterize AFTER a SPA router (e.g.
  // YouTube) has already swapped the DOM on mousedown itself — the click
  // step ends up showing the destination's loading state. To beat that,
  // we proactively snapshot while the user is merely HOVERING over an
  // interactive element. By the time they press down, a clean pre-click
  // frame is already cached in the SW. Throttled to respect Chrome's
  // ~2 captures/sec rate limit on captureVisibleTab.
  let _lastProactiveFire = 0;
  const PROACTIVE_MIN_GAP_MS = 900;
  function onProactiveHover(event) {
    if (tearingDown || paused) return;
    const t = event.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-pagewalk]')) return;
    if (!t.closest(INTERACTIVE_SELECTORS)) return;
    const now = Date.now();
    if (now - _lastProactiveFire < PROACTIVE_MIN_GAP_MS) return;
    _lastProactiveFire = now;

    pwLog('proactive hover fire', { tag: t.tagName });
    hideWidgetForCapture('PROACTIVE_SNAPSHOT');
  }
  document.addEventListener('pointerover', onProactiveHover, { capture: true, passive: true });

  // ─── Keystroke capture ──────────────────────────────────────────────────
  // Debounce per-field so we emit one step per field (on blur / Enter / idle).

  const INPUT_SELECTORS = 'input, textarea, [contenteditable="true"], [contenteditable=""]';
  const KEYSTROKE_IDLE_MS = 900;

  function onInput(event) {
    if (tearingDown || paused) return;
    const el = event.target;
    if (!el || !el.matches || !el.matches(INPUT_SELECTORS)) return;
    if (el.closest && el.closest('[data-pagewalk]')) return;
    // Skip checkboxes, radios, buttons, file pickers
    const type = (el.type || '').toLowerCase();
    if (['checkbox','radio','button','submit','reset','file','color','range'].includes(type)) return;

    const existing = keystrokeBuffers.get(el);
    if (existing) clearTimeout(existing.timer);

    const isPassword = type === 'password';
    const raw = el.isContentEditable ? (el.textContent || '') : (el.value || '');
    const value = isPassword ? '••••••' : raw;

    const timer = setTimeout(() => emitKeystroke(el), KEYSTROKE_IDLE_MS);
    keystrokeBuffers.set(el, { timer, value, isPassword });
  }

  function onBlurOrEnter(event) {
    if (tearingDown || paused) return;
    const el = event.target;
    if (!el || !keystrokeBuffers.has(el)) return;
    if (event.type === 'keydown' && event.key !== 'Enter') return;
    const buf = keystrokeBuffers.get(el);
    clearTimeout(buf.timer);
    emitKeystroke(el);
  }

  function emitKeystroke(el) {
    const buf = keystrokeBuffers.get(el);
    if (!buf) return;
    keystrokeBuffers.delete(el);
    // Don't emit empty fields
    const rawValue = buf.value || '';
    if (!rawValue.trim()) return;

    const rect = el.getBoundingClientRect();
    const fieldDescription = getFieldLabel(el);
    const mergeWithClick = lastClickedElement === el;
    const targetMeta = captureTargetMetadata(el);
    lastClickedElement = null;

    chrome.runtime.sendMessage({
      type: 'KEYSTROKE_DETECTED',
      fieldDescription,
      value: rawValue,
      isPassword: buf.isPassword,
      mergeWithPreviousClick: mergeWithClick,
      clickX: Math.round(rect.left + rect.width / 2),
      clickY: Math.round(rect.top + rect.height / 2),
      elementRect: rect ? {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      } : null,
      pageUrl: location.href,
      pageTitle: document.title,
      devicePixelRatio: window.devicePixelRatio || 1,
      targetSelector: targetMeta.selector,
      targetXPath:    targetMeta.xpath,
      targetText:     targetMeta.text,
      targetAttrs:    targetMeta.attrs,
      targetTag:      targetMeta.tag,
    }).catch(() => {});
  }

  document.addEventListener('input',  onInput, { capture: true, passive: true });
  document.addEventListener('blur',   onBlurOrEnter, { capture: true, passive: true });
  document.addEventListener('keydown', onBlurOrEnter, { capture: true, passive: true });

  // Flush any in-flight keystroke buffer before navigation
  window.addEventListener('beforeunload', () => {
    // WeakMap has no iteration; best-effort flush of the last clicked element
    if (lastClickedElement && keystrokeBuffers.has(lastClickedElement)) {
      emitKeystroke(lastClickedElement);
    }
  });

  // ─── Auto-redaction engine ───────────────────────────────────────────────
  // Scans visible DOM for sensitive patterns, temporarily masks them for
  // screenshot capture, then restores the originals.

  const REDACT_CHAR = '█';
  const REDACT_PATTERNS = [
    // Email addresses
    /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    // Phone numbers — international and common formats
    /(?:\+?\d{1,3}[\s\-.]?)?\(?\d{2,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}/g,
    // Credit card numbers (13-19 digits, optionally grouped)
    /\b(?:\d[ \-]?){12,18}\d\b/g,
    // SSN / national ID (US format)
    /\b\d{3}[\s\-]?\d{2}[\s\-]?\d{4}\b/g,
    // Money amounts — symbol-prefixed ($1,234.56) or suffixed (500 USD)
    // Symbols: $ pound euro yen rupee won lira ruble baht dong colón guarani kip riyal shekel
    // Codes: 40+ most-used ISO 4217 currencies
    /(?:[\$\u00a3\u20ac\u00a5\u20b9\u20a9\u20ba\u20bd\u20b1\u20b4\u20ab\u20a1\u20b2\u20ad\ufdfc\u20aa]|R\$|RM|Rp|Rs|kr|zł|Kč|Ft)\s?\d{1,3}(?:[,\.]\d{3})*(?:\.\d{1,2})?|\d{1,3}(?:[,\.]\d{3})*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|JPY|AED|SAR|BHD|KWD|QAR|OMR|CAD|AUD|CHF|INR|CNY|SGD|HKD|NZD|SEK|NOK|DKK|ZAR|MXN|BRL|THB|PHP|IDR|MYR|EGP|TRY|PKR|NGN|KES|GHS|MAD|TND|JOD|IQD|LBP|COP|ARS|CLP|PEN|VND|KRW|TWD|PLN|CZK|HUF|RON|BGN|HRK|ILS|RUB|UAH)\b/gi,
  ];

  // Input types and autocomplete hints that likely contain sensitive data
  const SENSITIVE_INPUT_TYPES = ['email', 'tel'];
  const SENSITIVE_AUTOCOMPLETE = [
    'email', 'tel', 'phone', 'cc-number', 'cc-csc', 'cc-exp',
    'cc-name', 'name', 'given-name', 'family-name', 'address-line1',
    'address-line2', 'postal-code', 'bday',
  ];

  let _redactBackup = []; // stores { node, original } or { el, attr, original }

  function redactDOM(style, categories, customPatterns) {
    // Restore any previous redaction first so we don't double-redact
    restoreDOM();
    const useBlur = style === 'blur';
    const cats = categories || {};
    const noCats = Object.keys(cats).length === 0;

    // Build active patterns from enabled categories + custom
    const activePatterns = [];
    if (noCats || cats.emails !== false)      activePatterns.push(REDACT_PATTERNS[0]);
    if (noCats || cats.phones !== false)      activePatterns.push(REDACT_PATTERNS[1]);
    if (noCats || cats.creditCards !== false) activePatterns.push(REDACT_PATTERNS[2]);
    if (noCats || cats.ssn !== false)         activePatterns.push(REDACT_PATTERNS[3]);
    if (cats.money)                           activePatterns.push(REDACT_PATTERNS[4]);

    // Custom patterns: array of {name, pattern}
    const rawCustom = customPatterns;
    if (Array.isArray(rawCustom)) {
      for (const { pattern } of rawCustom) {
        if (!pattern) continue;
        try { activePatterns.push(new RegExp(pattern, 'g')); } catch (_) {}
      }
    } else if (typeof rawCustom === 'string' && rawCustom) {
      for (const line of rawCustom.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { activePatterns.push(new RegExp(t, 'g')); } catch (_) {}
      }
    }

    // 1. Redact sensitive input/textarea values (field-type detection, unaffected by categories)
    const inputs = document.querySelectorAll('input, textarea');
    for (const el of inputs) {
      if (el.closest('[data-pagewalk]')) continue;
      const inputType = (el.type || '').toLowerCase();
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (inputType === 'password') continue;

      const isSensitiveType = SENSITIVE_INPUT_TYPES.includes(inputType);
      const isSensitiveAc = SENSITIVE_AUTOCOMPLETE.some(s => ac.includes(s));
      const valueMatchesPattern = activePatterns.some(p => { p.lastIndex = 0; return p.test(el.value); });

      if ((isSensitiveType || isSensitiveAc || valueMatchesPattern) && el.value.trim()) {
        if (useBlur) {
          _redactBackup.push({ el, attr: 'filter', original: el.style.getPropertyValue('filter'), priority: el.style.getPropertyPriority('filter') });
          el.style.setProperty('filter', 'blur(6px)', 'important');
        } else {
          _redactBackup.push({ el, attr: 'value', original: el.value });
          el.value = REDACT_CHAR.repeat(Math.min(el.value.length, 20));
        }
      }
    }

    // 1b. Blanket form-field redaction (all inputs, textareas, selects)
    if (cats.formFields) {
      const fields = document.querySelectorAll('input, textarea, select');
      for (const el of fields) {
        if (el.closest('[data-pagewalk]')) continue;
        if ((el.type || '').toLowerCase() === 'hidden') continue;
        if (useBlur) {
          if (_redactBackup.some(e => e.el === el && e.attr === 'filter')) continue;
          _redactBackup.push({ el, attr: 'filter', original: el.style.getPropertyValue('filter'), priority: el.style.getPropertyPriority('filter') });
          el.style.setProperty('filter', 'blur(6px)', 'important');
        } else if (el.value && el.value.trim()) {
          if (_redactBackup.some(e => e.el === el && e.attr === 'value')) continue;
          _redactBackup.push({ el, attr: 'value', original: el.value });
          el.value = REDACT_CHAR.repeat(Math.min(el.value.length, 20));
        }
      }
    }

    // 1c. Table data redaction (all td/th cell content)
    if (cats.tableData) {
      const cells = document.querySelectorAll('td, th');
      for (const cell of cells) {
        if (cell.closest('[data-pagewalk]')) continue;
        const st = getComputedStyle(cell);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        if (useBlur) {
          _redactBackup.push({ el: cell, attr: 'filter', original: cell.style.getPropertyValue('filter'), priority: cell.style.getPropertyPriority('filter') });
          cell.style.setProperty('filter', 'blur(6px)', 'important');
        } else {
          const textNodes = [];
          const tw = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
          let tn;
          while ((tn = tw.nextNode())) textNodes.push(tn);
          for (const tn of textNodes) {
            if (tn.textContent.trim()) {
              _redactBackup.push({ node: tn, original: tn.textContent });
              tn.textContent = REDACT_CHAR.repeat(Math.min(tn.textContent.length, 30));
            }
          }
        }
      }
    }

    // 2. Walk visible text nodes and redact/blur pattern matches
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.closest('[data-pagewalk]')) return NodeFilter.FILTER_REJECT;
          if (p.closest('script, style, noscript')) return NodeFilter.FILTER_REJECT;
          const st = getComputedStyle(p);
          if (st.display === 'none' || st.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    const blurredEls = new Set();

    for (const node of textNodes) {
      const original = node.textContent;
      let hasMatch = false;
      for (const pattern of activePatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(original)) { hasMatch = true; break; }
      }
      if (!hasMatch) continue;

      if (useBlur) {
        const parent = node.parentElement;
        if (parent && !blurredEls.has(parent)) {
          blurredEls.add(parent);
          _redactBackup.push({ el: parent, attr: 'filter', original: parent.style.getPropertyValue('filter'), priority: parent.style.getPropertyPriority('filter') });
          parent.style.setProperty('filter', 'blur(6px)', 'important');
        }
      } else {
        let replaced = original;
        for (const pattern of activePatterns) {
          pattern.lastIndex = 0;
          replaced = replaced.replace(pattern, (m) => REDACT_CHAR.repeat(m.length));
        }
        _redactBackup.push({ node, original });
        node.textContent = replaced;
      }
    }

  }

  function restoreDOM() {
    for (const entry of _redactBackup) {
      if (entry.node) {
        entry.node.textContent = entry.original;
      } else if (entry.el && entry.attr === 'value') {
        entry.el.value = entry.original;
      } else if (entry.el && entry.attr === 'filter') {
        if (entry.original) {
          entry.el.style.setProperty('filter', entry.original, entry.priority || '');
        } else {
          entry.el.style.removeProperty('filter');
        }
      }
    }
    _redactBackup = [];
  }

  // ─── Message handler ────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg.type === 'SCROLL_TO_ELEMENT') {
      const el = document.elementFromPoint(msg.clientX, msg.clientY);
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      sendResponse({ type: 'READY' });
      return false;
    }
    if (msg.type === 'REDACT_FOR_CAPTURE') {
      redactDOM(msg.style || 'redact', msg.categories, msg.customPatterns);
      // Double-rAF: wait for the browser to actually paint the blur/redact
      // before telling the SW it's safe to screenshot
      requestAnimationFrame(() => requestAnimationFrame(() => sendResponse({ ok: true })));
      return true; // keep channel open for async response
    }
    if (msg.type === 'RESTORE_AFTER_CAPTURE') {
      restoreDOM();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'REDACT_PERSISTENT_START') {
      redactDOM(msg.style || 'redact', msg.categories, msg.customPatterns);
      requestAnimationFrame(() => requestAnimationFrame(() => sendResponse({ ok: true })));
      return true;
    }
    if (msg.type === 'REDACT_PERSISTENT_STOP') {
      restoreDOM();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'HIDE_WIDGET_FOR_CAPTURE') {
      if (widgetHost && widgetHost.parentNode) widgetHost.parentNode.removeChild(widgetHost);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'SHOW_WIDGET_AFTER_CAPTURE') {
      if (widgetHost && !widgetHost.parentNode) document.documentElement.appendChild(widgetHost);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'STEP_COUNT_UPDATE') {
      updateStepCount(msg.count);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'SET_PAUSED') {
      setPaused(!!msg.paused);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'SHOW_WIDGET') {
      showWidget(msg.stepCount || 0);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'STOP_RECORDING') {
      teardown();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'PING') {
      sendResponse({ alive: true, hasWidget: !!widgetHost });
      return false;
    }
  });

  // Self-initialize: on a cross-domain navigation the SW re-injects this
  // script and then fires SHOW_WIDGET, but Chrome's message router may not
  // have committed the new onMessage listener yet and the send is silently
  // dropped. Ask the SW for state ourselves — we know exactly when we're
  // ready, which removes the race.
  try {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }).then((res) => {
      if (!res || !res.recording) return;
      if (res.showWidget !== false) showWidget(res.stepCount || 0);
      if (res.paused) setPaused(true);
    }).catch(() => {});
  } catch (_) {}

  function teardown() {
    tearingDown = true;
    document.removeEventListener('mousedown', onMousedown, { capture: true });
    document.removeEventListener('click',     onCapture,   { capture: true });
    document.removeEventListener('input',     onInput,     { capture: true });
    document.removeEventListener('blur',      onBlurOrEnter, { capture: true });
    document.removeEventListener('keydown',   onBlurOrEnter, { capture: true });
    removeWidget();
    window.__pagewalkRecorderActive = false;
  }

  // ─── Floating widget (Shadow DOM) ───────────────────────────────────────

  function showWidget(initialStepCount) {
    if (widgetHost) {
      if (!widgetHost.parentNode) document.documentElement.appendChild(widgetHost);
      widgetHost.style.visibility = '';
      updateStepCount(initialStepCount);
      return;
    }
    widgetHost = document.createElement('div');
    widgetHost.setAttribute('data-pagewalk', 'widget');
    widgetHost.style.cssText = [
      'all: initial',
      'position: fixed',
      'bottom: 24px',
      'right: 24px',
      'z-index: 2147483646',
      'pointer-events: auto',
    ].join('; ');
    widgetShadow = widgetHost.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    widgetShadow.appendChild(style);

    const root = document.createElement('div');
    root.className = 'sl-widget';
    root.innerHTML = WIDGET_HTML;
    widgetShadow.appendChild(root);

    widgetStepCountEl  = widgetShadow.querySelector('.sl-step-count');
    widgetPauseBtn     = widgetShadow.querySelector('.sl-pause-btn');
    widgetStatusDot    = widgetShadow.querySelector('.sl-status-dot');
    widgetStatusLabel  = widgetShadow.querySelector('.sl-status-label');
    updateStepCount(initialStepCount || 0);

    // Button handlers
    widgetPauseBtn.addEventListener('click', () => {
      setPaused(!paused);
      chrome.runtime.sendMessage({ type: paused ? 'PAUSE_RECORDING' : 'RESUME_RECORDING' }).catch(() => {});
    });
    widgetShadow.querySelector('.sl-complete-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {});
    });
    const captureBtn = widgetShadow.querySelector('.sl-capture-btn');
    captureBtn.addEventListener('click', () => {
      if (paused) return;
      captureBtn.disabled = true;
      chrome.runtime.sendMessage({
        type: 'MANUAL_CAPTURE',
        pageUrl: window.location.href,
        pageTitle: document.title,
        devicePixelRatio: window.devicePixelRatio || 1,
      }).catch(() => {}).finally(() => { captureBtn.disabled = false; });
    });
    widgetShadow.querySelector('.sl-discard-btn').addEventListener('click', () => {
      if (confirm('Discard this recording? All captured steps will be deleted.')) {
        chrome.runtime.sendMessage({ type: 'DISCARD_RECORDING' }).catch(() => {});
      }
    });

    // Drag-to-reposition
    makeDraggable(widgetHost, widgetShadow.querySelector('.sl-drag-handle'));

    // Restore saved position
    try {
      chrome.storage.session.get('pw_widget_pos').then(({ pw_widget_pos }) => {
        if (pw_widget_pos && typeof pw_widget_pos.left === 'number') {
          widgetHost.style.left   = pw_widget_pos.left + 'px';
          widgetHost.style.top    = pw_widget_pos.top  + 'px';
          widgetHost.style.right  = 'auto';
          widgetHost.style.bottom = 'auto';
        }
      });
    } catch (_) {}

    document.documentElement.appendChild(widgetHost);
  }

  function removeWidget() {
    if (widgetHost && widgetHost.parentNode) widgetHost.parentNode.removeChild(widgetHost);
    widgetHost = null;
    widgetShadow = null;
    widgetStepCountEl = null;
    widgetPauseBtn = null;
    widgetStatusDot = null;
    widgetStatusLabel = null;
  }

  function updateStepCount(n) {
    if (widgetStepCountEl) widgetStepCountEl.textContent = String(n || 0);
  }

  function setPaused(next) {
    paused = next;
    if (!widgetShadow) return;
    if (paused) {
      widgetStatusDot.classList.add('paused');
      widgetStatusLabel.textContent = 'Paused';
      widgetPauseBtn.innerHTML = RESUME_ICON + '<span>Resume</span>';
    } else {
      widgetStatusDot.classList.remove('paused');
      widgetStatusLabel.textContent = 'Recording';
      widgetPauseBtn.innerHTML = PAUSE_ICON + '<span>Pause</span>';
    }
  }

  function makeDraggable(hostEl, handleEl) {
    let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;
    handleEl.addEventListener('pointerdown', (e) => {
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = hostEl.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      hostEl.style.right  = 'auto';
      hostEl.style.bottom = 'auto';
      handleEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handleEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const left = Math.max(0, Math.min(window.innerWidth  - 80, startLeft + (e.clientX - startX)));
      const top  = Math.max(0, Math.min(window.innerHeight - 40, startTop  + (e.clientY - startY)));
      hostEl.style.left = left + 'px';
      hostEl.style.top  = top  + 'px';
    });
    handleEl.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      handleEl.releasePointerCapture(e.pointerId);
      const rect = hostEl.getBoundingClientRect();
      try { chrome.storage.session.set({ pw_widget_pos: { left: rect.left, top: rect.top } }); } catch (_) {}
    });
  }

  const PAUSE_ICON  = '<svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="3" width="4" height="14" rx="1"/><rect x="11" y="3" width="4" height="14" rx="1"/></svg>';
  const RESUME_ICON = '<svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor"><path d="M5 3.5l12 6.5-12 6.5V3.5z"/></svg>';

  const WIDGET_HTML = `
    <div class="sl-drag-handle">
      <div class="sl-status">
        <span class="sl-status-dot"></span>
        <span class="sl-status-label">Recording</span>
        <span class="sl-divider">·</span>
        <span class="sl-step-count">0</span>
        <span class="sl-steps-label">steps</span>
      </div>
    </div>
    <div class="sl-actions">
      <button class="sl-pause-btn sl-btn" title="Pause">
        ${PAUSE_ICON}<span>Pause</span>
      </button>
      <button class="sl-complete-btn sl-btn sl-btn-primary" title="Complete">
        <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,11 8,15 16,5"/></svg>
        <span>Complete</span>
      </button>
      <button class="sl-capture-btn sl-btn sl-btn-icon" title="Take screenshot">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6h-4.5l-2-3h-3l-2 3H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z"/><circle cx="10" cy="12" r="3"/></svg>
      </button>
      <button class="sl-discard-btn sl-btn sl-btn-icon" title="Discard">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,5 5,5 17,5"/><path d="M16,5l-1,12H5L4,5"/><path d="M8,9v5M12,9v5"/><path d="M8,5V3.5h4V5"/></svg>
      </button>
    </div>
  `;

  const SHADOW_CSS = `
    :host, .sl-widget, .sl-widget * {
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    .sl-widget {
      background: #ffffff;
      border-radius: 14px;
      box-shadow: 0 16px 40px -12px rgba(26, 20, 51, 0.35), 0 4px 12px -2px rgba(26, 20, 51, 0.12);
      border: 1px solid rgba(93, 46, 140, 0.14);
      display: flex;
      flex-direction: column;
      min-width: 240px;
      user-select: none;
      overflow: hidden;
      animation: sl-widget-in 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    @keyframes sl-widget-in {
      from { transform: translateY(10px) scale(0.95); opacity: 0; }
      to   { transform: translateY(0)    scale(1);    opacity: 1; }
    }
    .sl-drag-handle {
      cursor: move;
      padding: 10px 14px 8px;
      background: linear-gradient(135deg, #faf8fc, #ffffff);
      border-bottom: 1px solid #ece7f3;
    }
    .sl-status {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      color: #1a1433;
    }
    .sl-status-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #ef4444;
      box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.55);
      animation: sl-dot-pulse 1.6s infinite;
    }
    .sl-status-dot.paused {
      background: #94a3b8;
      animation: none;
      box-shadow: none;
    }
    @keyframes sl-dot-pulse {
      0%   { box-shadow: 0 0 0 0    rgba(239, 68, 68, 0.55); }
      70%  { box-shadow: 0 0 0 8px  rgba(239, 68, 68, 0);    }
      100% { box-shadow: 0 0 0 0    rgba(239, 68, 68, 0);    }
    }
    .sl-status-label {
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .sl-divider {
      color: #b8b1c8;
      margin: 0 1px;
    }
    .sl-step-count {
      font-weight: 700;
      color: #5D2E8C;
    }
    .sl-steps-label {
      color: #6b6585;
    }
    .sl-actions {
      display: flex;
      gap: 6px;
      padding: 8px 10px 10px;
      background: #ffffff;
    }
    .sl-btn {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      height: 30px;
      padding: 0 12px;
      font-size: 12px;
      font-weight: 600;
      color: #4a4259;
      background: #faf8fc;
      border: 1px solid #ece7f3;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
      font-family: inherit;
    }
    .sl-btn:hover { background: #f3edfa; border-color: #d9c8ea; color: #1a1433; }
    .sl-btn-primary {
      background: #5D2E8C;
      color: #ffffff;
      border-color: #5D2E8C;
    }
    .sl-btn-primary:hover {
      background: #4a2470;
      border-color: #4a2470;
      color: #ffffff;
    }
    .sl-btn-icon {
      flex: 0 0 auto;
      width: 30px;
      padding: 0;
    }
    .sl-btn-icon:hover {
      color: #e11d48;
      border-color: #fecaca;
      background: #fff5f5;
    }
    .sl-capture-btn:hover {
      color: #5D2E8C;
      border-color: #d9c8ea;
      background: #f3edfa;
    }
    .sl-capture-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .sl-btn svg { flex-shrink: 0; }
  `;

  // ─── Element description algorithm (unchanged from original) ────────────
  const INTERACTIVE_SELECTORS = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="option"], [role="switch"], [role="combobox"], label';

  function getElementDescription(target) {
    const el = target.closest(INTERACTIVE_SELECTORS) || target;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.trim().split(/\s+/);
      const text = ids.map(id => {
        const ref = document.getElementById(id);
        return ref ? ref.textContent.trim() : '';
      }).filter(Boolean).join(' ');
      if (text) return formatDescription(el, text);
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return formatDescription(el, ariaLabel.trim());

    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) {
        const text = label.textContent.trim();
        if (text) return formatDescription(el, text);
      }
    }
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      const label = el.closest('label') || el.previousElementSibling;
      if (label && label.tagName === 'LABEL') {
        const text = label.textContent.trim();
        if (text) return formatDescription(el, text);
      }
    }

    const img = el.querySelector('img[alt]');
    if (img && img.alt.trim()) return formatDescription(el, img.alt.trim());

    const text = getVisibleText(el);
    if (text) return formatDescription(el, truncate(text, 60));

    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return formatDescription(el, placeholder.trim());

    const title = el.getAttribute('title');
    if (title && title.trim()) return formatDescription(el, title.trim());

    return getFallbackDescription(el);
  }

  // getFieldLabel — strip "Enter text in" / "Click" prefixes so keystroke
  // descriptions read cleanly: "Type *foo* in *Email*".
  function getFieldLabel(el) {
    const desc = getElementDescription(el);
    // "Enter text in 'Email' field" -> "Email"
    const m = desc.match(/["']([^"']+)["']/);
    if (m) return m[1];
    // Fallback to input name / placeholder / type
    return el.getAttribute('aria-label')
        || el.getAttribute('placeholder')
        || el.getAttribute('name')
        || (el.type ? el.type : 'field');
  }

  function getVisibleText(el) {
    const walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    const parts = [];
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (t) parts.push(t);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function formatDescription(el, label) {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || '';
    if (tag === 'a') return `Click "${label}" link`;
    if (tag === 'button' || el.getAttribute('role') === 'button') return `Click "${label}" button`;
    if (tag === 'input') {
      if (type === 'submit' || type === 'button') return `Click "${label}" button`;
      if (type === 'checkbox') return `Toggle "${label}" checkbox`;
      if (type === 'radio') return `Select "${label}" option`;
      return `Enter text in "${label}" field`;
    }
    if (tag === 'select') return `Select from "${label}" dropdown`;
    if (tag === 'textarea') return `Enter text in "${label}" text area`;
    return `Click "${label}"`;
  }

  function getFallbackDescription(el) {
    const tag  = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (tag === 'a') return 'Click link';
    if (tag === 'button') return 'Click button';
    if (role === 'button') return 'Click button';
    if (role === 'link') return 'Click link';
    if (role === 'menuitem') return 'Click menu item';
    if (role === 'tab') return 'Click tab';
    if (role === 'checkbox') return 'Toggle checkbox';
    if (role === 'radio') return 'Select option';
    if (tag === 'input') {
      if (type === 'submit') return 'Click submit button';
      if (type === 'button') return 'Click button';
      if (type === 'checkbox') return 'Toggle checkbox';
      if (type === 'radio') return 'Select option';
      if (type === 'email') return 'Enter email address';
      if (type === 'password') return 'Enter password';
      if (type === 'search') return 'Enter search query';
      if (type === 'number') return 'Enter number';
      if (type === 'tel') return 'Enter phone number';
      return 'Enter text in field';
    }
    if (tag === 'select') return 'Select from dropdown';
    if (tag === 'textarea') return 'Enter text in text area';
    if (tag === 'img') return 'Click image';
    return `Click on ${tag}`;
  }

  function truncate(str, maxLen) {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 1) + '…';
  }

  // ─── Element identity capture ───────────────────────────────────────────
  // Capture multiple signals per element so the player can re-locate it
  // across layout changes. Priority during replay:
  //   1. CSS selector  (unique at record time)
  //   2. XPath         (positional fallback)
  //   3. Text + tag + attrs  (content-based fallback)

  function captureTargetMetadata(el) {
    try {
      return {
        selector: getUniqueSelector(el),
        xpath:    getXPath(el),
        text:     (el.textContent || '').trim().slice(0, 120) || null,
        attrs: {
          id:         el.id || null,
          name:       el.getAttribute('name') || null,
          ariaLabel:  el.getAttribute('aria-label') || null,
          testId:     el.getAttribute('data-testid') || el.getAttribute('data-test-id') || null,
          role:       el.getAttribute('role') || null,
          placeholder:el.getAttribute('placeholder') || null,
        },
        tag: el.tagName ? el.tagName.toLowerCase() : null,
      };
    } catch (_) {
      return { selector: null, xpath: null, text: null, attrs: {}, tag: null };
    }
  }

  // Generate a CSS selector that uniquely identifies `el` on the current
  // page. Prefer stable attributes, fall back to nth-of-type path.
  function getUniqueSelector(el) {
    if (!(el instanceof Element)) return null;

    // 1. Valid DOM id
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
      const sel = `#${CSS.escape(el.id)}`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // 2. data-testid
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) {
      const sel = `[data-testid="${CSS.escape(testId)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // 3. aria-label + tag
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      const sel = `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // 4. name attribute (forms)
    const name = el.getAttribute('name');
    if (name) {
      const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // 5. Build a positional path — walk up until we hit an element with
    //    an id or we reach body.
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && parts.length < 8) {
      let segment = current.tagName.toLowerCase();
      if (current.id && /^[A-Za-z][\w-]*$/.test(current.id)) {
        segment = `#${CSS.escape(current.id)}`;
        parts.unshift(segment);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          segment += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(segment);
      current = parent;
    }
    return parts.length ? parts.join(' > ') : null;
  }

  // XPath — simpler fallback for when the CSS selector breaks due to a
  // class rename or structural tweak.
  function getXPath(el) {
    if (!(el instanceof Element)) return null;
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `//*[@id="${el.id}"]`;
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
      current = current.parentElement;
    }
    return '/' + parts.join('/');
  }
})();
