/**
 * viewer.js — Tango-style guide viewer + inline editor
 * Renders a finished guide as a sidebar + scrollable vertical step cards.
 * Edit mode enables inline description editing, delete/reorder, add text
 * steps, and per-step Fabric.js annotation (AnnotationCanvas).
 */
import {
  getGuide, listSteps, updateGuide, updateStep, deleteStep, reorderSteps, createStep,
  createVersion, listVersions, restoreVersion, deleteVersion, DEFAULT_MAX_VERSIONS,
} from '../lib/storage.js';
import { exportPDF, exportHTML, exportMarkdown } from '../lib/export.js';
import { AnnotationCanvas } from '../lib/annotations.js';
import { showConfirmModal } from '../lib/confirm-modal.js';

// Load jsPDF for PDF export (vendor global)
const jspdfScript = document.createElement('script');
jspdfScript.src = chrome.runtime.getURL('lib/vendor/jspdf.umd.min.js');
document.head.appendChild(jspdfScript);

const guideTitleEl = document.getElementById('guide-title');
const heroTitleEl  = document.getElementById('hero-title');
const heroDescEl   = document.getElementById('hero-desc');
const heroMetaEl   = document.getElementById('hero-meta');
const stepsWrap    = document.getElementById('steps-wrap');
const stepsNavEl   = document.getElementById('steps-nav');
const sidebarCount = document.getElementById('sidebar-count');
const backBtn      = document.getElementById('back-btn');
const guideMeBtn   = document.getElementById('guide-me-btn');
const shareBtn     = document.getElementById('share-btn');
const shareMenu    = document.getElementById('share-menu');
const toastEl      = document.getElementById('toast');
const modeToggleEl   = document.getElementById('mode-toggle');
const lightboxEl       = document.getElementById('vw-lightbox');
const lightboxImgWrap  = document.getElementById('vw-lightbox-img-wrap');
const lightboxImg      = document.getElementById('vw-lightbox-img');
const lightboxClose    = document.getElementById('vw-lightbox-close');
const lightboxPrevBtn  = document.getElementById('vw-lb-prev');
const lightboxNextBtn  = document.getElementById('vw-lb-next');
const lightboxCaption  = document.getElementById('vw-lb-caption');
const lightboxBadge    = document.getElementById('vw-lb-badge');
const lightboxType     = document.getElementById('vw-lb-type');
const lightboxTitle    = document.getElementById('vw-lb-title');
const lightboxNotes    = document.getElementById('vw-lb-notes');
const historyBtn          = document.getElementById('history-btn');
const historyOverlay      = document.getElementById('vw-history-overlay');
const historyClose        = document.getElementById('vw-history-close');
const historyList         = document.getElementById('vw-history-list');
const historyHint         = document.getElementById('vw-history-hint');
const historyEmpty        = document.getElementById('vw-history-empty');
const historyPreview      = document.getElementById('vw-history-preview');
const historyPreviewEmpty = document.getElementById('vw-history-preview-empty');

let currentGuide = null;
let currentSteps = [];       // raw sequence including any initial-capture cover
let actionSteps  = [];       // currentSteps.filter(s => !s.isInitialCapture) — what gets rendered as numbered steps
let coverStep    = null;     // the initial-capture step (rendered as hero) or null
let editMode = false;
let _versionSnapshotTaken  = false; // take at most one snapshot per page load
let _selectedVersion       = null;  // version currently shown in the preview pane
let _maxVersionsPerGuide   = DEFAULT_MAX_VERSIONS; // read from settings on init
let activeAnnotator = null;        // AnnotationCanvas instance
let activeAnnotatorStepId = null;  // id of the step currently being annotated
let activeAnnotatorScale = null;   // { naturalW, naturalH, canvasW, canvasH } for coord conversion
let sortableInstance = null;

const SWATCH_COLORS = ['#e11d48', '#f97316', '#eab308', '#22c55e', '#5D2E8C', '#0ea5e9'];

const CALLOUT_VARIANTS = {
  info:      { label: 'Info',      icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><line x1="10" y1="9" x2="10" y2="14"/><circle cx="10" cy="6.5" r=".5" fill="currentColor"/></svg>' },
  success:   { label: 'Success',   icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><polyline points="7,10 9.5,12.5 13.5,7.5"/></svg>' },
  warning:   { label: 'Warning',   icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L1.5 17h17z"/><line x1="10" y1="8" x2="10" y2="12"/><circle cx="10" cy="14.5" r=".5" fill="currentColor"/></svg>' },
  danger:    { label: 'Danger',    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><line x1="7" y1="7" x2="13" y2="13"/><line x1="13" y1="7" x2="7" y2="13"/></svg>' },
  important: { label: 'Important', icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="10,2 12.5,7.5 18,8 14,12 15,17.5 10,15 5,17.5 6,12 2,8 7.5,7.5"/></svg>' },
};

// ─── Lightbox ────────────────────────────────────────────────────────────

// Current flippable set — rebuilt on every open so edits (deletes, image
// removals, annotations) don't leave a stale list behind.
let lightboxSet   = [];
let lightboxIndex = 0;

const LB_TYPE_ICONS = {
  click: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v3M10 14v3M3 10h3M14 10h3M5.6 5.6l2.1 2.1M12.3 12.3l2.1 2.1M5.6 14.4l2.1-2.1M12.3 7.7l2.1-2.1"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/></svg>',
  keystroke: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="16" height="10" rx="2"/><path d="M5 9h.01M8 9h.01M11 9h.01M14 9h.01M5 12h10"/></svg>',
  navigate: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h12M12 6l4 4-4 4"/></svg>',
};
const LB_TYPE_LABELS = { click: 'Click', keystroke: 'Type', navigate: 'Navigate' };

function buildLightboxSet() {
  return currentSteps.filter(s => s.screenshotRaw || s.screenshotAnnotated);
}

function openLightbox(step) {
  if (!step) return;
  lightboxSet = buildLightboxSet();
  const idx = lightboxSet.findIndex(s => s.id === step.id);
  lightboxIndex = idx >= 0 ? idx : 0;
  lightboxEl.hidden = false;
  renderLightboxStep();
}

function renderLightboxStep() {
  const step = lightboxSet[lightboxIndex];
  if (!step) { closeLightbox(); return; }

  lightboxImg.src = step.screenshotAnnotated || step.screenshotRaw || '';

  // Remove any click circle from the previous render
  lightboxImgWrap.querySelector('.vw-lb-circle')?.remove();

  const type = step.type || 'click';
  const showCircle = (type === 'click' || type === 'keystroke')
    && (step.clickX > 0 || step.clickY > 0);

  if (showCircle) {
    const circle = document.createElement('div');
    circle.className = 'vw-lb-circle';
    lightboxImgWrap.appendChild(circle);

    if (step.clickXPct != null) {
      circle.style.left = `${step.clickXPct}%`;
      circle.style.top  = `${step.clickYPct}%`;
    } else {
      const position = () => {
        const nW = lightboxImg.naturalWidth;
        const nH = lightboxImg.naturalHeight;
        if (!nW || !nH) return;
        const dpr = step.devicePixelRatio || 1;
        circle.style.left = `${(step.clickX * dpr / nW) * 100}%`;
        circle.style.top  = `${(step.clickY * dpr / nH) * 100}%`;
      };
      if (lightboxImg.naturalWidth) position();
      else lightboxImg.addEventListener('load', position, { once: true });
    }
  }

  // Caption — step badge, type icon, title, notes
  if (step.isInitialCapture) {
    lightboxBadge.textContent = 'Cover';
  } else {
    const actionIdx = actionSteps.findIndex(s => s.id === step.id);
    if (actionIdx >= 0 && actionSteps.length > 0) {
      lightboxBadge.textContent = `Step ${actionIdx + 1} of ${actionSteps.length}`;
    } else {
      lightboxBadge.textContent = '';
    }
  }

  const typeIcon  = LB_TYPE_ICONS[type] || '';
  const typeLabel = LB_TYPE_LABELS[type] || '';
  lightboxType.innerHTML = typeIcon ? `${typeIcon}<span>${typeLabel}</span>` : '';
  lightboxType.hidden = !typeIcon;

  const title = step.description || '';
  lightboxTitle.textContent = title;
  lightboxTitle.hidden = !title;

  const notes = step.notes || '';
  lightboxNotes.textContent = notes;
  lightboxNotes.hidden = !notes;

  const hasAnyCaption = lightboxBadge.textContent || title || notes;
  lightboxCaption.hidden = !hasAnyCaption;

  // Nav buttons — hidden entirely when there's only one image
  const multi = lightboxSet.length > 1;
  lightboxPrevBtn.hidden = !multi;
  lightboxNextBtn.hidden = !multi;
  lightboxPrevBtn.disabled = lightboxIndex <= 0;
  lightboxNextBtn.disabled = lightboxIndex >= lightboxSet.length - 1;
}

function navigateLightbox(delta) {
  if (lightboxEl.hidden) return;
  const next = lightboxIndex + delta;
  if (next < 0 || next >= lightboxSet.length) return;
  lightboxIndex = next;
  renderLightboxStep();
}

function closeLightbox() {
  lightboxEl.hidden = true;
  lightboxImg.src = '';
  lightboxImgWrap.querySelector('.vw-lb-circle')?.remove();
  lightboxSet = [];
}

lightboxClose.addEventListener('click', closeLightbox);
lightboxPrevBtn.addEventListener('click', (e) => { e.stopPropagation(); navigateLightbox(-1); });
lightboxNextBtn.addEventListener('click', (e) => { e.stopPropagation(); navigateLightbox(1); });
lightboxEl.addEventListener('click', (e) => {
  if (e.target === lightboxEl) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (lightboxEl.hidden) return;
  if (e.key === 'Escape')    { closeLightbox(); return; }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); navigateLightbox(1);  return; }
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); navigateLightbox(-1); return; }
  if (e.key === 'Home') { e.preventDefault(); lightboxIndex = 0; renderLightboxStep(); return; }
  if (e.key === 'End')  { e.preventDefault(); lightboxIndex = Math.max(0, lightboxSet.length - 1); renderLightboxStep(); return; }
});

// ─── Version History modal ────────────────────────────────────────────────

historyBtn.addEventListener('click', () => openHistoryModal());
historyClose.addEventListener('click', closeHistoryModal);
historyOverlay.addEventListener('click', (e) => {
  if (e.target === historyOverlay) closeHistoryModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !historyOverlay.hidden) closeHistoryModal();
});

function openHistoryModal() {
  historyOverlay.hidden = false;
  renderHistoryList();
}

function closeHistoryModal() {
  historyOverlay.hidden = true;
}

async function renderHistoryList() {
  if (!currentGuide) return;
  historyList.querySelectorAll('.vw-history-item').forEach(el => el.remove());

  let versions;
  try { versions = await listVersions(currentGuide.id); }
  catch (err) { console.error(err); versions = []; }

  historyEmpty.style.display = versions.length ? 'none' : '';
  if (!versions.length) {
    _selectedVersion = null;
    renderVersionPreview(null);
    return;
  }

  versions.forEach((v, index) => {
    const item = document.createElement('div');
    item.className = 'vw-history-item';
    item.dataset.versionId = v.id;

    const stepWord = v.stepCount === 1 ? 'step' : 'steps';
    item.innerHTML = `
      <span class="vw-history-date">${formatDateTime(v.createdAt)}</span>
      <div class="vw-history-item-foot">
        <span class="vw-history-meta">${v.stepCount} ${stepWord}</span>
        <div class="vw-history-actions">
          <button class="vw-history-restore" type="button">Restore</button>
          <button class="vw-history-del" type="button" title="Delete this snapshot">
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,5 5,5 17,5"/><path d="M16,5l-1,12H5L4,5"/><path d="M8,9v5M12,9v5"/><path d="M8,5V3.5h4V5"/></svg>
          </button>
        </div>
      </div>
    `;

    item.querySelector('.vw-history-restore').addEventListener('click', (e) => {
      e.stopPropagation();
      doRestoreVersion(v.id);
    });

    item.querySelector('.vw-history-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await deleteVersion(v.id);
        const wasSelected = _selectedVersion && _selectedVersion.id === v.id;
        item.remove();
        const remaining = historyList.querySelectorAll('.vw-history-item');
        if (!remaining.length) {
          historyEmpty.style.display = '';
          _selectedVersion = null;
          renderVersionPreview(null);
        } else if (wasSelected) {
          remaining[0].click();
        }
      } catch (_) { showToast('Could not delete version'); }
    });

    item.addEventListener('click', () => {
      historyList.querySelectorAll('.vw-history-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      _selectedVersion = v;
      renderVersionPreview(v);
    });

    historyList.appendChild(item);
    if (index === 0) item.click(); // auto-select newest
  });
}

// Build the right-hand step preview for the selected version.
function renderVersionPreview(version) {
  historyPreview.querySelectorAll('.vw-hprev-header, .vw-hprev-step, .vw-hprev-nosteps').forEach(el => el.remove());

  if (!version) {
    historyPreviewEmpty.style.display = '';
    return;
  }
  historyPreviewEmpty.style.display = 'none';

  // Sticky header
  const header = document.createElement('div');
  header.className = 'vw-hprev-header';
  const titleDiffers = version.guide?.title && version.guide.title !== currentGuide?.title;
  header.innerHTML = `
    ${titleDiffers ? `<div class="vw-hprev-guide-name">${escapeHtml(version.guide.title)}</div>` : ''}
    <div class="vw-hprev-meta">${version.stepCount} action step${version.stepCount === 1 ? '' : 's'} &middot; ${formatDateTime(version.createdAt)}</div>
  `;
  historyPreview.appendChild(header);

  const TYPE_LABELS = { click: 'Click', keystroke: 'Type', navigate: 'Go', text: 'Note', callout: 'Callout', heading: 'Heading' };
  const actionStepList = (version.steps || []).filter(s => !s.isInitialCapture);

  if (!actionStepList.length) {
    const empty = document.createElement('div');
    empty.className = 'vw-hprev-nosteps';
    empty.textContent = 'This version has no action steps.';
    historyPreview.appendChild(empty);
    return;
  }

  actionStepList.forEach((step, i) => {
    const row = document.createElement('div');
    row.className = 'vw-hprev-step';

    // Thumbnail
    const src = step.screenshotAnnotated || step.screenshotRaw;
    const thumb = document.createElement('div');
    thumb.className = 'vw-hprev-thumb' + (src ? '' : ' no-img');
    if (src) {
      const img = document.createElement('img');
      img.src = src; img.alt = ''; img.loading = 'lazy';
      thumb.appendChild(img);
    }

    // Body: number + type tag + description + optional notes
    const type = step.type || 'click';
    const body = document.createElement('div');
    body.className = 'vw-hprev-body';
    body.innerHTML = `
      <div class="vw-hprev-step-meta">
        <span class="vw-hprev-num">${i + 1}</span>
        <span class="vw-hprev-type type-${type}">${TYPE_LABELS[type] || 'Step'}</span>
      </div>
      <div class="vw-hprev-desc">${escapeHtml(step.description || `Step ${i + 1}`)}</div>
      ${step.notes ? `<div class="vw-hprev-notes">${escapeHtml(step.notes)}</div>` : ''}
    `;

    row.appendChild(thumb);
    row.appendChild(body);
    historyPreview.appendChild(row);
  });
}

async function doRestoreVersion(versionId) {
  const ok = await showConfirmModal({
    title: 'Restore this version?',
    body: 'Your current guide will be replaced. A snapshot of the current state is saved first so you can undo.',
    confirmLabel: 'Restore',
    cancelLabel: 'Cancel',
    danger: false,
  });
  if (!ok) return;
  try {
    closeHistoryModal();
    showToast('Restoring…', 1500);
    const restoredGuide = await restoreVersion(versionId, _maxVersionsPerGuide);
    // Reload the viewer with the restored state
    currentGuide = restoredGuide;
    currentSteps = await listSteps(currentGuide.id);
    deriveCoverAndActions();
    guideTitleEl.textContent = currentGuide.title;
    heroTitleEl.textContent = currentGuide.title;
    document.title = `${currentGuide.title} — Pagewalk`;
    renderHero();
    sidebarCount.textContent = actionSteps.length;
    renderSteps();
    renderSidebar();
    wireSidebarScrollSpy();
    _versionSnapshotTaken = true; // don't immediately re-snapshot after a restore
    showToast('Guide restored');
  } catch (err) {
    console.error(err);
    showToast('Restore failed: ' + (err.message || 'unknown'));
  }
}

function formatDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// ─── Manual step image upload ─────────────────────────────────────────────

const imgUploadInput = document.getElementById('vw-img-upload-input');
let _pendingUploadStepId = null;

function triggerImageUpload(stepId) {
  _pendingUploadStepId = stepId;
  imgUploadInput.value = '';
  imgUploadInput.click();
}

imgUploadInput.addEventListener('change', async () => {
  const file = imgUploadInput.files[0];
  if (!file || !_pendingUploadStepId) return;
  const stepId = _pendingUploadStepId;
  _pendingUploadStepId = null;

  const dataUrl = await readImageFile(file);
  if (!dataUrl) { showToast('Could not read image'); return; }

  try {
    await updateStep(stepId, { screenshotRaw: dataUrl, screenshotAnnotated: null });
    currentSteps = await listSteps(currentGuide.id);
    deriveCoverAndActions();
    renderSteps(); renderSidebar(); wireSidebarScrollSpy();
    showToast('Image added');
  } catch (_) { showToast('Failed to save image'); }
});

function readImageFile(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX_W = 1920;
      const scale = Math.min(MAX_W / img.width, 1);
      const w = Math.round(img.width  * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ─── Init ────────────────────────────────────────────────────────────────

async function init() {
  // Read the configurable version limit from settings (non-blocking for the rest of init)
  try {
    const s = await chrome.storage.local.get('pagewalk_settings');
    const max = s?.pagewalk_settings?.maxVersionsPerGuide;
    if (typeof max === 'number' && max >= 1) _maxVersionsPerGuide = max;
  } catch (_) { /* leave default */ }
  historyHint.textContent = `A snapshot is saved automatically when you enter Edit mode. Up to ${_maxVersionsPerGuide} version${_maxVersionsPerGuide === 1 ? '' : 's'} are kept per guide.`;

  const params = new URLSearchParams(location.search);
  const guideId = params.get('id');
  const startInEdit = params.get('edit') === '1';
  if (!guideId) {
    showEmpty('No guide selected', 'Open a guide from the dashboard or side panel.');
    return;
  }

  currentGuide = await getGuide(guideId);
  if (!currentGuide) {
    showEmpty('Guide not found', 'It may have been deleted.');
    return;
  }
  currentSteps = await listSteps(guideId);
  deriveCoverAndActions();

  document.title = `${currentGuide.title} — Pagewalk`;
  guideTitleEl.textContent = currentGuide.title;
  renderHero();

  sidebarCount.textContent = actionSteps.length;
  renderSteps();
  renderSidebar();
  wireSidebarScrollSpy();

  if (startInEdit) setMode('edit');
}

// Split currentSteps into cover + action lists. Find the cover by flag,
// NOT by position — the user may have moved other steps before it, or
// deleted it entirely.
function deriveCoverAndActions() {
  coverStep = currentSteps.find(s => s.isInitialCapture) || null;
  actionSteps = currentSteps.filter(s => !s.isInitialCapture);
}

// Render the hero section — either with the cover step's screenshot
// as a background, or plain text if there's no cover.
function renderHero() {
  heroTitleEl.textContent = currentGuide.title;
  const heroSection = heroTitleEl.closest('.vw-hero');

  // Description — shown as placeholder in edit mode, hidden when empty in read mode
  const desc = currentGuide.description || '';
  heroDescEl.textContent = desc;
  heroDescEl.setAttribute('data-placeholder', 'Add a description…');
  heroDescEl.style.display = (!desc && !editMode) ? 'none' : '';

  const stepCount = actionSteps.length;
  heroMetaEl.innerHTML = `
    <span>${stepCount} step${stepCount === 1 ? '' : 's'}</span>
    <span class="dot"></span>
    <span>${formatDate(currentGuide.updatedAt || currentGuide.createdAt)}</span>
    <span class="dot"></span>
    <span>Stored locally</span>
  `;

  // Remove any existing cover preview
  heroSection.querySelectorAll('.vw-hero-cover, .vw-hero-cover-actions').forEach(el => el.remove());
  heroSection.classList.toggle('has-cover', !!coverStep);

  if (!coverStep) return;

  const coverWrap = document.createElement('div');
  coverWrap.className = 'vw-hero-cover';
  const src = coverStep.screenshotAnnotated || coverStep.screenshotRaw;
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Starting page';
    coverWrap.appendChild(img);
  } else {
    coverWrap.classList.add('no-image');
    coverWrap.textContent = coverStep.description || 'Starting page';
  }
  heroSection.appendChild(coverWrap);

  // Edit-mode-only delete button for the cover step
  const actionsRow = document.createElement('div');
  actionsRow.className = 'vw-hero-cover-actions';
  actionsRow.innerHTML = `
    <button class="vw-hero-cover-del" type="button" title="Remove starting screenshot">
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,5 5,5 17,5"/><path d="M16,5l-1,12H5L4,5"/><path d="M8,9v5M12,9v5"/><path d="M8,5V3.5h4V5"/></svg>
      Remove starting screenshot
    </button>
  `;
  actionsRow.querySelector('.vw-hero-cover-del').addEventListener('click', async () => {
    const ok = await showConfirmModal({
      title: 'Remove starting screenshot?',
      body: 'This permanently deletes the cover step. This cannot be undone.',
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteStep(coverStep.id);
      currentSteps = currentSteps.filter(s => s.id !== coverStep.id);
      deriveCoverAndActions();
      renderHero();
      sidebarCount.textContent = actionSteps.length;
      renderSteps();
      renderSidebar();
      wireSidebarScrollSpy();
      showToast('Cover removed');
    } catch (err) {
      console.error(err);
      showToast('Delete failed');
    }
  });
  heroSection.appendChild(actionsRow);
}

function showEmpty(title, msg) {
  stepsWrap.innerHTML = `
    <div class="vw-empty">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(msg)}</p>
    </div>`;
  heroTitleEl.textContent = title;
  heroMetaEl.textContent = '';
  sidebarCount.textContent = '0';
}

// ─── Step rendering ──────────────────────────────────────────────────────

function renderSteps() {
  // Before destroying cards, tear down any active annotator so Fabric
  // doesn't hold onto a dead canvas.
  destroyAnnotator();
  stepsWrap.innerHTML = '';

  if (!actionSteps.length) {
    if (coverStep) {
      // We have a cover but no action steps — show a gentle placeholder.
      stepsWrap.innerHTML = `
        <div class="vw-empty">
          <h3>Add your first step</h3>
          <p>Use the + button below to add a text step, or click Capture more steps.</p>
        </div>`;
    } else {
      showEmpty('No steps captured', 'This guide is empty.');
    }
    if (editMode) stepsWrap.appendChild(buildAddStepButton(0));
    return;
  }

  actionSteps.forEach((step, i) => {
    stepsWrap.appendChild(buildStepCard(step, i));
    stepsWrap.appendChild(buildAddStepButton(i + 1));
  });

  if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }
  if (editMode) setupSortable();
}

function buildStepCard(step, i) {
  const card = document.createElement('section');
  card.className = 'vw-step-card';
  card.id = `step-${i}`;
  card.dataset.idx = i;
  card.dataset.stepId = step.id;

  const type = step.type || (step.clickX > 0 || step.clickY > 0 ? 'click' : 'click');
  card.classList.add(`type-${type}`);
  if (type === 'navigate') card.classList.add('nav-step');

  // Callout variant
  const calloutType = step.calloutType || 'warning';
  const calloutShowIcon = step.calloutShowIcon !== false; // default true
  if (type === 'callout') card.classList.add(`callout-${calloutType}`);

  const hasImage = !!step.screenshotRaw || !!step.screenshotAnnotated;
  if (!hasImage) card.classList.add('text-only');

  const isRTL = /[\u0600-\u06FF\u0590-\u05FF]/.test(step.description || '');
  const dir = isRTL ? 'rtl' : 'ltr';

  const TYPE_TAG_LABELS = {
    click: 'Click',
    keystroke: 'Type',
    navigate: 'Go',
    text: 'Note',
    callout: 'Callout',
    heading: 'Heading',
  };
  const typeTagLabel = TYPE_TAG_LABELS[type] || 'Step';

  const head = document.createElement('div');
  head.className = 'vw-step-head';
  const numberContent = (type === 'callout' && calloutShowIcon && CALLOUT_VARIANTS[calloutType])
    ? CALLOUT_VARIANTS[calloutType].icon
    : String(i + 1);

  head.innerHTML = `
    <div class="vw-step-number${type === 'callout' && calloutShowIcon ? ' has-icon' : ''}">${numberContent}</div>
    <div class="vw-step-desc" dir="${dir}" spellcheck="false">${escapeHtml(step.description || `Step ${i + 1}`)}</div>
    <span class="vw-step-type-tag type-${type}">${typeTagLabel}</span>
    <div class="vw-step-actions">
      <button class="vw-step-action-btn vw-step-drag" title="Drag to reorder" type="button" aria-label="Drag to reorder">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="1" width="3" height="3" rx="0.75"/><rect x="10" y="1" width="3" height="3" rx="0.75"/><rect x="3" y="6.5" width="3" height="3" rx="0.75"/><rect x="10" y="6.5" width="3" height="3" rx="0.75"/><rect x="3" y="12" width="3" height="3" rx="0.75"/><rect x="10" y="12" width="3" height="3" rx="0.75"/></svg>
      </button>
      <button class="vw-step-action-btn vw-step-mv-up" title="Move up" type="button">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,12 10,7 15,12"/></svg>
      </button>
      <button class="vw-step-action-btn vw-step-mv-dn" title="Move down" type="button">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,8 10,13 15,8"/></svg>
      </button>
      <button class="vw-step-action-btn del" title="Delete step" type="button">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,5 5,5 17,5"/><path d="M16,5l-1,12H5L4,5"/><path d="M8,9v5M12,9v5"/><path d="M8,5V3.5h4V5"/></svg>
      </button>
    </div>
  `;
  card.appendChild(head);

  const descEl = head.querySelector('.vw-step-desc');
  // Only editable when in edit mode; toggled via setMode.
  if (editMode) enableInlineDescEdit(descEl, step);

  // Callout variant picker (edit mode only)
  if (type === 'callout' && editMode) {
    const pickerWrap = document.createElement('div');
    pickerWrap.className = 'vw-callout-picker';
    const variants = Object.entries(CALLOUT_VARIANTS);
    variants.forEach(([key, v]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `vw-callout-pick callout-${key}${key === calloutType ? ' active' : ''}`;
      btn.title = v.label;
      btn.innerHTML = v.icon;
      btn.addEventListener('click', async () => {
        try {
          const updated = await updateStep(step.id, { calloutType: key });
          Object.assign(step, updated);
          renderSteps(); renderSidebar(); wireSidebarScrollSpy();
        } catch (_) { showToast('Failed to save'); }
      });
      pickerWrap.appendChild(btn);
    });
    // Icon toggle
    const iconToggle = document.createElement('label');
    iconToggle.className = 'vw-callout-icon-toggle';
    iconToggle.innerHTML = `<input type="checkbox" ${calloutShowIcon ? 'checked' : ''}><span>Icon</span>`;
    iconToggle.querySelector('input').addEventListener('change', async (e) => {
      try {
        const updated = await updateStep(step.id, { calloutShowIcon: e.target.checked });
        Object.assign(step, updated);
        renderSteps(); renderSidebar(); wireSidebarScrollSpy();
      } catch (_) { showToast('Failed to save'); }
    });
    pickerWrap.appendChild(iconToggle);
    card.appendChild(pickerWrap);
  }

  // Notes field — always rendered (hidden when empty in read mode via CSS)
  if (type !== 'heading') {
    const notesEl = document.createElement('div');
    notesEl.className = 'vw-step-notes';
    notesEl.textContent = step.notes || '';
    if (editMode) {
      notesEl.contentEditable = 'true';
      notesEl.spellcheck = false;
      enableInlineNotesEdit(notesEl, step);
    }
    card.appendChild(notesEl);
  }

  if (hasImage) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'vw-step-image';

    const img = document.createElement('img');
    img.alt = `Step ${i + 1} screenshot`;
    img.loading = 'lazy';
    img.src = step.screenshotAnnotated || step.screenshotRaw;
    imgWrap.appendChild(img);

    // Overlay the auto click circle (only for click/keystroke steps with coords).
    // Always show regardless of screenshotAnnotated — the CSS circle is the canonical
    // click indicator; auto-pins in the Fabric canvas are stripped from the export.
    const showCircle = (type === 'click' || type === 'keystroke')
                      && (step.clickX > 0 || step.clickY > 0);
    if (showCircle) {
      const circle = document.createElement('div');
      circle.className = 'vw-click-circle';
      if (step.clickXPct != null) {
        // Position was saved directly as a canvas percentage after the user moved
        // the pin — use it immediately, no image-load event needed.
        circle.style.left = `${step.clickXPct}%`;
        circle.style.top  = `${step.clickYPct}%`;
      } else {
        img.addEventListener('load', () => {
          const naturalW = img.naturalWidth;
          const naturalH = img.naturalHeight;
          if (!naturalW || !naturalH) return;
          const dpr = step.devicePixelRatio || 1;
          const px = step.clickX * dpr;
          const py = step.clickY * dpr;
          circle.style.left = `${(px / naturalW) * 100}%`;
          circle.style.top  = `${(py / naturalH) * 100}%`;
        });
      }
      imgWrap.appendChild(circle);
    }

    // Annotate button (edit mode only, shown via CSS)
    const annotateBtn = document.createElement('button');
    annotateBtn.className = 'vw-annotate-btn';
    annotateBtn.type = 'button';
    annotateBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3l4 4-9 9H4v-4z"/></svg>
      Annotate
    `;
    annotateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startAnnotation(step.id);
    });
    imgWrap.appendChild(annotateBtn);

    // Remove image button — only for manual (text) steps in edit mode
    if (type === 'text' && editMode) {
      const removeImgBtn = document.createElement('button');
      removeImgBtn.className = 'vw-annotate-btn vw-remove-img-btn';
      removeImgBtn.type = 'button';
      removeImgBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,5 5,5 17,5"/><path d="M16,5l-1,12H5L4,5"/><path d="M8,9v5M12,9v5"/><path d="M8,5V3.5h4V5"/></svg>
        Remove image
      `;
      removeImgBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await showConfirmModal({
          title: 'Remove image?',
          body: 'This removes the screenshot from this step. This cannot be undone.',
          confirmLabel: 'Remove',
          cancelLabel: 'Cancel',
          danger: true,
        });
        if (!ok) return;
        try {
          await updateStep(step.id, { screenshotRaw: null, screenshotAnnotated: null, annotationState: null });
          currentSteps = await listSteps(currentGuide.id);
          deriveCoverAndActions();
          renderSteps(); renderSidebar(); wireSidebarScrollSpy();
          showToast('Image removed');
        } catch (_) { showToast('Failed to remove image'); }
      });
      imgWrap.appendChild(removeImgBtn);
    }

    // Click image: open annotator in edit mode, lightbox in read mode.
    imgWrap.addEventListener('click', (e) => {
      if (e.target.closest('.vw-annotate-btn')) return;
      if (editMode) {
        startAnnotation(step.id);
      } else {
        openLightbox(step);
      }
    });

    card.appendChild(imgWrap);
  } else if (type === 'text' && editMode) {
    // Upload zone — manual steps with no image show a dashed drop area in edit mode
    const uploadZone = document.createElement('div');
    uploadZone.className = 'vw-img-upload-zone';
    uploadZone.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="16" height="12" rx="2"/><circle cx="7" cy="9" r="1.5"/><polyline points="2,14 6,10 9,13 12,10 18,14"/></svg>
      <span>Upload image <span class="vw-upload-hint">(optional)</span></span>
    `;
    uploadZone.addEventListener('click', () => triggerImageUpload(step.id));
    card.appendChild(uploadZone);
  }

  if (step.pageUrl || editMode) {
    const urlEl = document.createElement('div');
    urlEl.className = 'vw-step-url';
    if (editMode) {
      urlEl.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12l-2 2a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0"/><path d="M12 8l2-2a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0"/></svg>
        <span class="vw-step-url-text" contenteditable="true" spellcheck="false" data-placeholder="Add URL…">${escapeHtml(step.pageUrl || '')}</span>
        ${step.pageUrl ? '<button class="vw-step-url-rm" type="button" title="Remove URL">&times;</button>' : ''}
      `;
      const urlText = urlEl.querySelector('.vw-step-url-text');
      urlText.addEventListener('blur', async () => {
        const next = urlText.textContent.trim();
        if (next === (step.pageUrl || '')) return;
        try {
          const updated = await updateStep(step.id, { pageUrl: next || '' });
          Object.assign(step, updated);
          showToast(next ? 'URL updated' : 'URL removed');
        } catch (_) { showToast('Failed to save'); }
      });
      urlText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); urlText.blur(); }
      });
      const rmBtn = urlEl.querySelector('.vw-step-url-rm');
      if (rmBtn) {
        rmBtn.addEventListener('click', async () => {
          try {
            const updated = await updateStep(step.id, { pageUrl: '' });
            Object.assign(step, updated);
            urlText.textContent = '';
            rmBtn.remove();
            showToast('URL removed');
          } catch (_) { showToast('Failed to save'); }
        });
      }
    } else if (step.pageUrl) {
      urlEl.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12l-2 2a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0"/><path d="M12 8l2-2a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0"/></svg>
        <a href="${escapeAttr(step.pageUrl)}" target="_blank" rel="noopener">${escapeHtml(step.pageUrl)}</a>
      `;
    }
    card.appendChild(urlEl);
  }

  // Wire card-level edit buttons
  const delBtn = head.querySelector('.vw-step-action-btn.del');
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    promptDeleteStep(step.id);
  });

  const upBtn = head.querySelector('.vw-step-mv-up');
  const dnBtn = head.querySelector('.vw-step-mv-dn');
  upBtn.disabled = i === 0;
  dnBtn.disabled = i === actionSteps.length - 1;
  upBtn.addEventListener('click', (e) => { e.stopPropagation(); moveStep(step.id, -1); });
  dnBtn.addEventListener('click', (e) => { e.stopPropagation(); moveStep(step.id, +1); });

  return card;
}

function buildAddStepButton(insertIndex) {
  const wrap = document.createElement('div');
  wrap.className = 'vw-add-step-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'vw-add-step';
  btn.dataset.insertIndex = String(insertIndex);
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="4" x2="10" y2="16"/><line x1="4" y1="10" x2="16" y2="10"/></svg>
    Add step
  `;
  wrap.appendChild(btn);

  const menu = document.createElement('div');
  menu.className = 'vw-add-step-menu';
  menu.innerHTML = `
    <button class="vw-add-step-item" data-kind="text" type="button">
      <span class="vw-ai-icon">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h14M3 10h14M3 15h9"/></svg>
      </span>
      <span class="vw-ai-body">
        <span class="vw-ai-title">Manual step</span>
        <span class="vw-ai-sub">Text step with optional image and notes</span>
      </span>
    </button>
    <button class="vw-add-step-item" data-kind="callout" type="button">
      <span class="vw-ai-icon">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><line x1="10" y1="6.5" x2="10" y2="11"/><circle cx="10" cy="14" r=".6" fill="currentColor"/></svg>
      </span>
      <span class="vw-ai-body">
        <span class="vw-ai-title">Insert callout</span>
        <span class="vw-ai-sub">Highlighted info box for warnings or tips</span>
      </span>
    </button>
    <button class="vw-add-step-item" data-kind="heading" type="button">
      <span class="vw-ai-icon">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v12M12 4v12M4 10h8"/></svg>
      </span>
      <span class="vw-ai-body">
        <span class="vw-ai-title">Insert heading</span>
        <span class="vw-ai-sub">A section divider with larger text</span>
      </span>
    </button>
    <button class="vw-add-step-item" data-kind="capture" type="button">
      <span class="vw-ai-icon">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3.5"/><path d="M3 7V5a2 2 0 0 1 2-2h2M17 7V5a2 2 0 0 0-2-2h-2M3 13v2a2 2 0 0 0 2 2h2M17 13v2a2 2 0 0 1-2 2h-2"/></svg>
      </span>
      <span class="vw-ai-body">
        <span class="vw-ai-title">Capture more steps</span>
        <span class="vw-ai-sub">Resume recording on the active tab</span>
      </span>
    </button>
  `;
  wrap.appendChild(menu);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllAddMenus(menu);
    menu.classList.toggle('open');
  });

  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('.vw-add-step-item');
    if (!item) return;
    menu.classList.remove('open');
    const kind = item.dataset.kind;
    if (kind === 'capture') {
      await resumeCapture();
    } else {
      await addStepAt(insertIndex, kind);
    }
  });

  return wrap;
}

function closeAllAddMenus(except) {
  document.querySelectorAll('.vw-add-step-menu.open').forEach(m => {
    if (m !== except) m.classList.remove('open');
  });
}

// Close any open add-step menu on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.vw-add-step-wrap')) closeAllAddMenus();
});

// ─── Sidebar ─────────────────────────────────────────────────────────────

function renderSidebar() {
  stepsNavEl.innerHTML = '';
  actionSteps.forEach((step, i) => {
    const type = step.type || 'click';
    const icon = type === 'keystroke'
      ? '<svg class="vw-nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="16" height="10" rx="2"/><path d="M5 9h.01M8 9h.01M11 9h.01M14 9h.01M5 12h10"/></svg>'
      : type === 'navigate'
      ? '<svg class="vw-nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h12M12 6l4 4-4 4"/></svg>'
      : '<svg class="vw-nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l5.5 13 2.2-5.3L16 8.5z"/></svg>';

    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'vw-nav-item';
    btn.dataset.idx = i;
    btn.innerHTML = `
      <div class="vw-nav-num">${i + 1}</div>
      ${icon}
      <span class="vw-nav-text">${escapeHtml(step.description || `Step ${i + 1}`)}</span>
    `;
    btn.addEventListener('click', () => {
      // Immediately highlight the clicked item
      stepsNavEl.querySelectorAll('.vw-nav-item').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById(`step-${i}`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    li.appendChild(btn);
    stepsNavEl.appendChild(li);
  });
}

function wireSidebarScrollSpy() {
  const cards = Array.from(stepsWrap.querySelectorAll('.vw-step-card'));
  if (!cards.length) return;
  const navItems = Array.from(stepsNavEl.querySelectorAll('.vw-nav-item'));

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const idx = Number(entry.target.dataset.idx);
        navItems.forEach(el => el.classList.remove('active'));
        const match = navItems.find(el => Number(el.dataset.idx) === idx);
        if (match) {
          match.classList.add('active');
          // Keep active item visible in the sidebar
          match.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    });
  }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });

  cards.forEach(card => observer.observe(card));
  // Mark first as active initially
  if (navItems[0]) navItems[0].classList.add('active');
}

// ─── Title inline editing ────────────────────────────────────────────────

async function saveTitle(newTitle) {
  if (!currentGuide || !newTitle || newTitle === currentGuide.title) return;
  await updateGuide(currentGuide.id, { title: newTitle });
  currentGuide.title = newTitle;
  document.title = `${newTitle} — Pagewalk`;
  showToast('Title updated');
}

// Sidebar title
guideTitleEl.addEventListener('blur', async () => {
  if (!currentGuide) return;
  const newTitle = guideTitleEl.textContent.trim();
  if (!newTitle || newTitle === currentGuide.title) {
    guideTitleEl.textContent = currentGuide.title;
    return;
  }
  await saveTitle(newTitle);
  heroTitleEl.textContent = currentGuide.title;
});
guideTitleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); guideTitleEl.blur(); }
  if (e.key === 'Escape') {
    guideTitleEl.textContent = currentGuide?.title || '';
    guideTitleEl.blur();
  }
});

// Hero title (edit mode only — contentEditable is toggled in setMode)
heroTitleEl.addEventListener('blur', async () => {
  if (!currentGuide || !editMode) return;
  const newTitle = heroTitleEl.textContent.trim();
  if (!newTitle || newTitle === currentGuide.title) {
    heroTitleEl.textContent = currentGuide.title;
    return;
  }
  await saveTitle(newTitle);
  guideTitleEl.textContent = currentGuide.title;
});
heroTitleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); heroTitleEl.blur(); }
  if (e.key === 'Escape') {
    heroTitleEl.textContent = currentGuide?.title || '';
    heroTitleEl.blur();
  }
});

// ─── Description inline editing ──────────────────────────────────────────

heroDescEl.addEventListener('blur', async () => {
  if (!currentGuide) return;
  const newDesc = heroDescEl.textContent.trim();
  if (newDesc === (currentGuide.description || '')) return;
  await updateGuide(currentGuide.id, { description: newDesc });
  currentGuide.description = newDesc;
  if (!newDesc && !editMode) heroDescEl.style.display = 'none';
  showToast('Description updated');
});
heroDescEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); heroDescEl.blur(); }
  if (e.key === 'Escape') {
    heroDescEl.textContent = currentGuide?.description || '';
    heroDescEl.blur();
  }
});

// ─── Navigation ──────────────────────────────────────────────────────────

backBtn.addEventListener('click', (e) => {
  e.preventDefault();
  location.href = '../dashboard/dashboard.html';
});

// ─── Edit mode ───────────────────────────────────────────────────────────

modeToggleEl.addEventListener('click', (e) => {
  const opt = e.target.closest('.vw-mode-opt');
  if (!opt) return;
  setMode(opt.dataset.mode);
});

function setMode(mode) {
  const next = mode === 'edit';
  if (editMode === next) return;
  editMode = next;

  // Take a "before edit" snapshot the first time the user enters edit mode
  // in this page session. Fire-and-forget — errors are non-fatal.
  if (editMode && !_versionSnapshotTaken && currentGuide) {
    _versionSnapshotTaken = true;
    createVersion(currentGuide.id, _maxVersionsPerGuide).catch(err => console.warn('Version snapshot failed', err));
  }

  document.body.classList.toggle('edit-mode', editMode);
  Array.from(modeToggleEl.querySelectorAll('.vw-mode-opt')).forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode);
  });
  // Title and description editable in edit mode
  heroTitleEl.contentEditable = editMode ? 'true' : 'false';
  heroTitleEl.spellcheck = false;
  heroDescEl.contentEditable = editMode ? 'true' : 'false';
  heroDescEl.style.display = (!currentGuide.description && !editMode) ? 'none' : '';
  // Re-render cards so inline editable bits get wired up / torn down
  destroyAnnotator();
  renderSteps();
  // Reflect in URL so a browser reload returns to the same mode
  const url = new URL(location.href);
  if (editMode) url.searchParams.set('edit', '1');
  else url.searchParams.delete('edit');
  history.replaceState(null, '', url);
}

function enableInlineDescEdit(descEl, step) {
  descEl.contentEditable = 'true';
  descEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); descEl.blur(); }
    if (e.key === 'Escape') {
      descEl.textContent = step.description || `Step ${currentSteps.indexOf(step) + 1}`;
      descEl.blur();
    }
  });
  descEl.addEventListener('blur', async () => {
    const next = descEl.textContent.trim();
    if (next === (step.description || '')) return;
    try {
      const updated = await updateStep(step.id, { description: next });
      Object.assign(step, updated);
      // Refresh sidebar label only (don't re-render cards — blurs current focus)
      refreshSidebarLabel(step.id, next);
      showToast('Step updated');
    } catch (err) {
      console.error(err);
      showToast('Failed to save');
    }
  });
}

function enableInlineNotesEdit(notesEl, step) {
  notesEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      notesEl.textContent = step.notes || '';
      notesEl.blur();
    }
    // Enter on its own inserts a newline (good — notes are multi-line).
    // Cmd/Ctrl+Enter commits.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      notesEl.blur();
    }
  });
  notesEl.addEventListener('blur', async () => {
    const next = notesEl.textContent.trim();
    if (next === (step.notes || '')) return;
    try {
      const updated = await updateStep(step.id, { notes: next || null });
      Object.assign(step, updated);
      showToast(next ? 'Note saved' : 'Note removed');
    } catch (err) {
      console.error(err);
      showToast('Failed to save note');
    }
  });
}

function refreshSidebarLabel(stepId, text) {
  const match = Array.from(stepsNavEl.querySelectorAll('.vw-nav-item'))
    .find(el => actionSteps[Number(el.dataset.idx)]?.id === stepId);
  if (match) {
    const textEl = match.querySelector('.vw-nav-text');
    if (textEl) textEl.textContent = text;
  }
}

async function promptDeleteStep(stepId) {
  const step = currentSteps.find(s => s.id === stepId);
  if (!step) return;
  const ok = await showConfirmModal({
    title: 'Delete this step?',
    body: 'This permanently removes the step and its screenshot. This cannot be undone.',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteStep(stepId);
    currentSteps = currentSteps.filter(s => s.id !== stepId);
    deriveCoverAndActions();
    sidebarCount.textContent = actionSteps.length;
    if (step.isInitialCapture) renderHero();
    renderSteps();
    renderSidebar();
    wireSidebarScrollSpy();
    showToast('Step deleted');
  } catch (err) {
    console.error(err);
    showToast('Delete failed');
  }
}

async function moveStep(stepId, delta) {
  const idx = actionSteps.findIndex(s => s.id === stepId);
  if (idx < 0) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= actionSteps.length) return;
  [actionSteps[idx], actionSteps[newIdx]] = [actionSteps[newIdx], actionSteps[idx]];
  try {
    await persistActionOrder();
    currentSteps = await listSteps(currentGuide.id);
    deriveCoverAndActions();
    renderSteps();
    renderSidebar();
    wireSidebarScrollSpy();
  } catch (err) {
    console.error(err);
    showToast('Reorder failed');
  }
}

async function addStepAt(insertIndex, kind = 'text') {
  const defaults = {
    text:    { type: 'text',    description: 'New step' },
    callout: { type: 'callout', description: 'Update this with your note', calloutType: 'info', calloutShowIcon: true },
    heading: { type: 'heading', description: 'Section heading' },
  };
  const preset = defaults[kind] || defaults.text;
  try {
    const newStep = await createStep(currentGuide.id, {
      description: preset.description,
      screenshotRaw: null,
      clickX: 0, clickY: 0,
      pageUrl: '', pageTitle: '',
      devicePixelRatio: 1,
      type: preset.type,
    });
    // insertIndex is relative to actionSteps. We need to place the new
    // step at that position in the action sequence. Rebuild the full
    // order by splicing actionSteps, then concat the (unchanged) cover.
    currentSteps = await listSteps(currentGuide.id);
    deriveCoverAndActions();
    // The new step is currently at the end of actionSteps because
    // createStep gave it max+1 order. Move it to insertIndex.
    const newActionIdx = actionSteps.findIndex(s => s.id === newStep.id);
    if (newActionIdx !== -1 && newActionIdx !== insertIndex) {
      const moved = actionSteps.splice(newActionIdx, 1)[0];
      actionSteps.splice(insertIndex, 0, moved);
      await persistActionOrder();
      currentSteps = await listSteps(currentGuide.id);
      deriveCoverAndActions();
    }
    sidebarCount.textContent = actionSteps.length;
    renderSteps();
    renderSidebar();
    wireSidebarScrollSpy();
    setTimeout(() => {
      const card = stepsWrap.querySelector(`[data-step-id="${newStep.id}"] .vw-step-desc`);
      if (card) { card.focus(); selectAll(card); }
    }, 40);
  } catch (err) {
    console.error(err);
    showToast('Could not add step');
  }
}

// Reassign orders to action steps only, leaving the cover step's order
// untouched. Cover keeps whatever order it had (usually 0) and action
// steps get orders cover.order + 1 .. n. Works even if the cover was
// manually dragged or if there's no cover at all.
async function persistActionOrder() {
  const coverOrder = coverStep ? coverStep.order : -1;
  const updates = actionSteps.map((s, i) => ({ id: s.id, order: coverOrder + 1 + i }));
  if (coverStep) updates.push({ id: coverStep.id, order: coverOrder });
  await reorderSteps(updates);
}

// "Capture more steps" — resume recording on a normal web tab so the user
// can add screenshots mid-guide. The viewer IS a chrome-extension:// URL,
// so we can't reuse the current tab. Strategy:
//   1. Find the most recently used http(s) tab across all windows
//   2. If none exists, open a new tab at the guide's last known URL
//   3. Start the capture there
async function resumeCapture() {
  if (!currentGuide) return;
  try {
    let targetTab = await findBestWebTab();
    if (!targetTab) {
      // No suitable tab exists — open one at the guide's last URL
      const fallbackUrl = [...currentSteps].reverse().find(s => s.pageUrl)?.pageUrl;
      if (!fallbackUrl) {
        showToast('No web page to capture on — open a tab first');
        return;
      }
      targetTab = await chrome.tabs.create({ url: fallbackUrl, active: false });
      // Wait for it to finish loading so the recorder can be injected
      await waitForTabComplete(targetTab.id, 8000);
    }

    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'RESUME_CAPTURE_FOR_GUIDE',
        guideId: currentGuide.id,
        tabId: targetTab.id,
      }, resolve);
    });
    if (result?.ok) {
      showToast('Recording resumed — switching to that tab');
      // Switch focus to the target tab so the user can interact
      chrome.tabs.update(targetTab.id, { active: true });
      if (targetTab.windowId) chrome.windows.update(targetTab.windowId, { focused: true });
    } else {
      showToast(result?.error || 'Could not resume capture');
    }
  } catch (err) {
    console.error(err);
    showToast('Could not resume capture');
  }
}

// Return the most recently accessed http(s) tab across all windows, or
// null if none exists. Excludes the current viewer tab, other extension
// pages, and browser internal URLs.
async function findBestWebTab() {
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter(t => {
    const u = t.url || '';
    if (!u.startsWith('http://') && !u.startsWith('https://')) return false;
    return true;
  });
  if (!candidates.length) return null;
  // Prefer the most recently active by lastAccessed (Chrome 121+), falling
  // back to the currently active tab in the last focused window.
  candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return candidates[0];
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete') return resolve(t);
      } catch (_) { return resolve(null); }
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(check, 200);
    };
    check();
  });
}

function selectAll(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// ─── SortableJS drag-reorder (edit mode) ─────────────────────────────────

function setupSortable() {
  if (typeof Sortable === 'undefined') return;
  sortableInstance = new Sortable(stepsWrap, {
    animation: 160,
    draggable: '.vw-step-card',
    handle: '.vw-step-drag',
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    onEnd: async () => {
      // Read DOM order, sync to actionSteps, persist. The cover step
      // isn't in the DOM list so it stays put.
      const ids = Array.from(stepsWrap.querySelectorAll('.vw-step-card'))
        .map(el => el.dataset.stepId);
      actionSteps = ids
        .map(id => actionSteps.find(s => s.id === id))
        .filter(Boolean);
      try {
        await persistActionOrder();
        currentSteps = await listSteps(currentGuide.id);
        deriveCoverAndActions();
        renderSteps();
        renderSidebar();
        wireSidebarScrollSpy();
      } catch (err) {
        console.error(err);
        showToast('Reorder failed');
      }
    },
  });
}

// ─── Inline annotation (per step) ────────────────────────────────────────

async function startAnnotation(stepId) {
  if (activeAnnotatorStepId === stepId) return;  // already annotating
  if (activeAnnotator) destroyAnnotator();

  const step = currentSteps.find(s => s.id === stepId);
  if (!step) return;
  const card = stepsWrap.querySelector(`[data-step-id="${stepId}"]`);
  if (!card) return;

  card.classList.add('annotating');

  // Hide the static image area while annotating
  const imageEl = card.querySelector('.vw-step-image');
  if (imageEl) imageEl.style.display = 'none';

  // Build annotator container with toolbar + canvas
  const annotatorEl = document.createElement('div');
  annotatorEl.className = 'vw-annotator';
  annotatorEl.innerHTML = `
    <div class="vw-annotator-toolbar">
      <button class="vw-tool-btn active" data-tool="select" title="Select (V)">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2l6 16 2-7 7-2z"/></svg>
        Select
      </button>
      <button class="vw-tool-btn" data-tool="arrow" title="Arrow (A)">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="17" x2="15" y2="5"/><polyline points="9,5 15,5 15,11"/></svg>
        Arrow
      </button>
      <button class="vw-tool-btn" data-tool="highlight" title="Highlight (H)">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="14" height="8" rx="1"/></svg>
        Box
      </button>
      <button class="vw-tool-btn" data-tool="blur" title="Blur (B)">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M5 10h10M7 6h6M7 14h6"/></svg>
        Blur
      </button>
      <button class="vw-tool-btn" data-tool="redact" title="Redact (R)">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><rect x="2" y="6" width="16" height="8" rx="1.5"/></svg>
        Redact
      </button>
      <button class="vw-tool-btn" data-tool="text" title="Text (T)">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h10M10 5v10"/></svg>
        Text
      </button>
      <div class="vw-tool-sep"></div>
      <button class="vw-tool-btn" data-action="delete" title="Delete selected (Del)">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,5 5,5 17,5"/><path d="M16,5l-1,12H5L4,5"/></svg>
      </button>
      <div class="vw-tool-sep"></div>
      <div class="vw-color-row">
        ${SWATCH_COLORS.map((c, i) => `<span class="vw-color-swatch${i === 0 ? ' active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></span>`).join('')}
        <label class="vw-color-picker-wrap" title="Custom color">
          <input type="color" class="vw-color-picker-input" value="${SWATCH_COLORS[0]}">
          <span class="vw-color-picker-dot" aria-hidden="true"></span>
        </label>
      </div>
      <div class="vw-annotator-spacer"></div>
      <button class="vw-annotator-cancel" type="button">Cancel</button>
      <button class="vw-annotator-save" type="button">Save</button>
    </div>
    <div class="vw-annotator-canvas-wrap">
      <canvas class="vw-annotation-canvas"></canvas>
    </div>
  `;
  card.appendChild(annotatorEl);

  const canvasEl = annotatorEl.querySelector('.vw-annotation-canvas');
  const wrap = annotatorEl.querySelector('.vw-annotator-canvas-wrap');

  // Compute canvas size from screenshot natural dimensions, capped to the
  // wrapping column's available width.
  const wrapW = Math.min(wrap.clientWidth - 32, 1400);
  let canvasW = wrapW;
  let canvasH = Math.round(canvasW * 9 / 16);
  let naturalW = canvasW, naturalH = canvasH;

  if (step.screenshotRaw) {
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        naturalW = img.naturalWidth  || canvasW;
        naturalH = img.naturalHeight || canvasH;
        const aspect = naturalH / naturalW;
        canvasH = Math.round(canvasW * aspect);
        resolve();
      };
      img.onerror = resolve;
      img.src = step.screenshotRaw;
    });
  }

  canvasEl.width  = canvasW;
  canvasEl.height = canvasH;

  activeAnnotator = new AnnotationCanvas(canvasEl, { width: canvasW, height: canvasH });
  activeAnnotatorStepId = stepId;
  activeAnnotatorScale = { naturalW, naturalH, canvasW, canvasH };

  if (step.screenshotRaw) {
    await activeAnnotator.setBackground(step.screenshotRaw);
  }
  if (step.annotationState) {
    await activeAnnotator.loadState(step.annotationState);
  } else if (step.clickX && step.clickY) {
    const clickSteps = currentSteps.filter(s => s.clickX > 0 || s.clickY > 0);
    const clickNum = clickSteps.findIndex(s => s.id === step.id) + 1;
    const dpr = step.devicePixelRatio || 1;
    // Multiply by dpr so the pin sits at the same visual % as the CSS circle:
    // CSS circle left = (clickX * dpr / naturalW) * 100%
    // Pin canvas x   = that same fraction × canvasW = clickX * dpr * (canvasW / naturalW)
    activeAnnotator.addClickPin(
      step.clickX * dpr * (canvasW / naturalW),
      step.clickY * dpr * (canvasH / naturalH),
      clickNum || 1,
    );
  }

  // Wire toolbar
  const toolBtns = annotatorEl.querySelectorAll('.vw-tool-btn[data-tool]');
  toolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      toolBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeAnnotator.setTool(btn.dataset.tool);
    });
  });
  const deleteBtn = annotatorEl.querySelector('.vw-tool-btn[data-action="delete"]');
  deleteBtn.addEventListener('click', () => activeAnnotator.deleteSelected());

  const swatches = annotatorEl.querySelectorAll('.vw-color-swatch');
  const colorPickerInput = annotatorEl.querySelector('.vw-color-picker-input');
  const colorPickerWrap  = annotatorEl.querySelector('.vw-color-picker-wrap');

  function clearActiveColor() {
    swatches.forEach(s => s.classList.remove('active'));
    colorPickerWrap?.classList.remove('active');
  }

  swatches.forEach(sw => {
    sw.addEventListener('click', () => {
      clearActiveColor();
      sw.classList.add('active');
      activeAnnotator.setColor(sw.dataset.color);
      if (colorPickerInput) colorPickerInput.value = sw.dataset.color;
    });
  });

  if (colorPickerInput) {
    colorPickerInput.addEventListener('input', (e) => {
      clearActiveColor();
      colorPickerWrap.classList.add('active');
      activeAnnotator.setColor(e.target.value);
    });
  }

  annotatorEl.querySelector('.vw-annotator-cancel').addEventListener('click', () => {
    destroyAnnotator();
  });
  annotatorEl.querySelector('.vw-annotator-save').addEventListener('click', () => saveAnnotation(stepId));

  // Scroll the annotator into view
  annotatorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveAnnotation(stepId) {
  if (!activeAnnotator || activeAnnotatorStepId !== stepId) return;
  const step = currentSteps.find(s => s.id === stepId);
  if (!step) return;
  try {
    const annotationState = activeAnnotator.getState();
    // Only produce a screenshotAnnotated when the user has drawn real annotations
    // (arrows, highlights, text, blur, redact).  If the canvas only contains the
    // auto-generated click-pin (e.g. the user just repositioned it), keep
    // screenshotAnnotated null so the lightbox opens the full-resolution screenshotRaw.
    let screenshotAnnotated = null;
    if (step.screenshotRaw && activeAnnotator.hasUserAnnotations()) {
      try { screenshotAnnotated = await activeAnnotator.toAnnotatedDataURL(0.9); }
      catch (err) { console.warn('annotated export failed', err); }
    }

    // If the user moved the auto-generated click-pin, persist its new position as
    // clickXPct/clickYPct (0–100 percentages of the image).  Storing percentages
    // avoids all dpr / naturalW coordinate-space confusion: the canvas and image
    // share the same aspect ratio, so canvas-fraction === image-fraction.
    // Values are clamped so the circle can never go off-screen.
    const coordUpdates = {};
    if (activeAnnotatorScale && (step.clickX || step.clickY)) {
      const pinCenter = activeAnnotator.getClickPinCenter();
      if (pinCenter) {
        const { canvasW, canvasH } = activeAnnotatorScale;
        coordUpdates.clickXPct = Math.max(0.5, Math.min(99.5, (pinCenter.x / canvasW) * 100));
        coordUpdates.clickYPct = Math.max(0.5, Math.min(99.5, (pinCenter.y / canvasH) * 100));
      }
    }

    const updated = await updateStep(stepId, { annotationState, screenshotAnnotated, ...coordUpdates });
    Object.assign(step, updated);
    destroyAnnotator();
    renderSteps();
    renderSidebar();
    wireSidebarScrollSpy();
    showToast('Annotations saved');
  } catch (err) {
    console.error(err);
    showToast('Save failed');
  }
}

function destroyAnnotator() {
  if (!activeAnnotator) return;
  try { activeAnnotator.destroy(); } catch (_) {}
  activeAnnotator = null;
  // Find the card that has the annotator open and restore it
  if (activeAnnotatorStepId) {
    const card = stepsWrap.querySelector(`[data-step-id="${activeAnnotatorStepId}"]`);
    if (card) {
      card.classList.remove('annotating');
      const ann = card.querySelector('.vw-annotator');
      if (ann) ann.remove();
      const imageEl = card.querySelector('.vw-step-image');
      if (imageEl) imageEl.style.display = '';
    }
  }
  activeAnnotatorStepId = null;
  activeAnnotatorScale = null;
}

// ─── Guide Me (interactive walkthrough) ──────────────────────────────────

guideMeBtn.addEventListener('click', async () => {
  if (!currentGuide || !actionSteps.length) {
    showToast('This guide has no actionable steps.');
    return;
  }
  const firstUrl = actionSteps.find(s => s.pageUrl)?.pageUrl
                 || coverStep?.pageUrl;
  if (!firstUrl) {
    showToast('No starting page URL saved with this guide.');
    return;
  }
  // Trim screenshot blobs so the session payload stays small —
  // the player can lazy-fetch them later if needed, but for live
  // highlighting it only needs the target identity fields.
  // We pass ALL steps (including the cover) so the SW can flag
  // isInitialCapture steps and skip past them.
  const lightSteps = currentSteps.map(s => ({
    id: s.id,
    description: s.description,
    notes: s.notes || null,
    screenshotRaw: s.screenshotRaw,
    screenshotAnnotated: s.screenshotAnnotated,
    clickX: s.clickX, clickY: s.clickY,
    pageUrl: s.pageUrl, pageTitle: s.pageTitle,
    devicePixelRatio: s.devicePixelRatio,
    type: s.type || 'click',
    isInitialCapture: !!s.isInitialCapture,
    // Element identity for live highlighting
    targetSelector: s.targetSelector,
    targetXPath:    s.targetXPath,
    targetText:     s.targetText,
    targetAttrs:    s.targetAttrs,
    targetTag:      s.targetTag,
  }));
  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'START_GUIDE_ME',
        guideId: currentGuide.id,
        guideTitle: currentGuide.title,
        steps: lightSteps,
      }, resolve);
    });
    if (!res?.ok) {
      showToast(res?.error || 'Could not launch Guide Me');
    }
  } catch (err) {
    showToast('Could not launch Guide Me on this page.');
    console.error(err);
  }
});

// ─── Share / Export menu ─────────────────────────────────────────────────

shareBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  shareMenu.classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!shareMenu.contains(e.target) && e.target !== shareBtn) shareMenu.classList.remove('open');
});

shareMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.vw-share-item');
  if (!item) return;
  const fmt = item.dataset.fmt;
  shareMenu.classList.remove('open');

  if (!currentGuide || !currentSteps.length) {
    showToast('Nothing to export.');
    return;
  }

  const settingsRes = await chrome.storage.local.get('pagewalk_settings');
  const branding = settingsRes?.pagewalk_settings?.branding || {};

  try {
    if (fmt === 'pdf') {
      if (!window.jspdf) {
        showToast('PDF library still loading, try again in a moment.');
        return;
      }
      await exportPDF(currentGuide, currentSteps, branding);
      showToast('PDF exported');
    } else if (fmt === 'html') {
      await exportHTML(currentGuide, currentSteps, branding);
      showToast('HTML exported');
    } else if (fmt === 'markdown') {
      await exportMarkdown(currentGuide, currentSteps);
      showToast('Markdown exported');
    } else if (fmt === 'copy') {
      const text = stepsToPlainText(currentGuide, currentSteps);
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard');
    }
  } catch (err) {
    console.error(err);
    showToast('Export failed: ' + (err.message || 'unknown'));
  }
});

function stepsToPlainText(guide, steps) {
  const lines = [guide.title, ''];
  steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.description || ''}`);
    if (s.pageUrl) lines.push(`   ${s.pageUrl}`);
  });
  return lines.join('\n');
}

// ─── Utilities ───────────────────────────────────────────────────────────

function showToast(msg, duration = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), duration);
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
  return escapeHtml(str);
}
function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

init();
