/**
 * dashboard.js — Guide list for Pagewalk
 */
import {
  listGuides, getGuide, getStep, updateGuide, deleteGuide, listSteps, getStorageEstimate,
  pruneVersions, listVersions, DEFAULT_MAX_VERSIONS, bulkImportGuide, generateId, listAllSteps,
  clearAllGuideData,
} from '../lib/storage.js';
import { showConfirmModal } from '../lib/confirm-modal.js';

// ── Element refs ──────────────────────────────────────────────────────────────

const guidesView  = document.getElementById('guides-view');
const settingsView = document.getElementById('settings-view');
const guidesGrid  = document.getElementById('guides-grid');
const guideCount  = document.getElementById('guide-count');
const deleteModal = document.getElementById('delete-modal');
const deleteModalDesc = document.getElementById('delete-modal-desc');
const deleteCancelBtn = document.getElementById('delete-cancel');
const deleteConfirmBtn = document.getElementById('delete-confirm');
const storageInfoEl = document.getElementById('storage-info');
const newGuideBtn   = document.getElementById('new-guide-btn');
const settingsBtn   = document.getElementById('settings-btn');
const toastEl       = document.getElementById('toast');

// Search / sort
const searchInput    = document.getElementById('search-input');
const sortSelect     = document.getElementById('sort-select');
const tagFilterBar   = document.getElementById('tag-filter-bar');
const tagFilterLabel = document.getElementById('tag-filter-label');
const tagFilterClear = document.getElementById('tag-filter-clear');

// Settings form elements
const spDelay           = document.getElementById('sp-delay');
const spDelayVal        = document.getElementById('sp-delay-val');
const spQuality         = document.getElementById('sp-quality');
const spQualityVal      = document.getElementById('sp-quality-val');
const spSaveBtn         = document.getElementById('sp-save-btn');
const spStorage         = document.getElementById('sp-storage');
const spDeleteAll       = document.getElementById('sp-delete-all');
const spCaptureOnStart  = document.getElementById('sp-capture-on-start');
const spShowWidget      = document.getElementById('sp-show-widget');
const spAutoRedact      = document.getElementById('sp-auto-redact');
const spRedactOptions   = document.getElementById('sp-redact-options');
const spRedactStyle     = document.getElementById('sp-redact-style');
const spRedactMode      = document.getElementById('sp-redact-mode');
const spCatEmails       = document.getElementById('sp-cat-emails');
const spCatPhones       = document.getElementById('sp-cat-phones');
const spCatCards        = document.getElementById('sp-cat-cards');
const spCatSsn          = document.getElementById('sp-cat-ssn');
const spCatMoney        = document.getElementById('sp-cat-money');
const spCatFormFields   = document.getElementById('sp-cat-form-fields');
const spCatTableData    = document.getElementById('sp-cat-table-data');
const spAddPatternBtn   = document.getElementById('sp-add-pattern-btn');
const spColorPicker     = document.getElementById('sp-color-picker');
const spColorHex        = document.getElementById('sp-color-hex');
const spColorSwatch     = document.getElementById('sp-color-swatch');
const spBrandName       = document.getElementById('sp-brand-name');
const spLogoMark        = document.getElementById('sp-logo-mark');
const spTagline         = document.getElementById('sp-tagline');
const spLogoPreview     = document.getElementById('sp-logo-preview');
const spLogoUploadBtn   = document.getElementById('sp-logo-upload-btn');
const spLogoRemoveBtn   = document.getElementById('sp-logo-remove-btn');
const spLogoFileInput   = document.getElementById('sp-logo-file-input');
const spMaxVersions     = document.getElementById('sp-max-versions');
const spTitleTemplate   = document.getElementById('sp-title-template');
const spSaveBrandingBtn = document.getElementById('sp-save-branding-btn');
const spExportBtn       = document.getElementById('sp-export-btn');
const spImportBtn       = document.getElementById('sp-import-btn');
const spImportInput     = document.getElementById('sp-import-input');

let pendingDeleteId = null;
let allGuides = [];
let _stepIndex = {};              // guideId → lowercased descriptions+notes string
let activeTagFilter = null;       // tag string currently filtering the grid, or null
let _spPendingLogo = undefined;   // undefined = unchanged, null = cleared, string = new data URL

const SETTINGS_KEY = 'pagewalk_settings';

const DEFAULT_BRANDING = {
  brandColor: '#5D2E8C',
  brandName: 'Pagewalk',
  logoMark: 'PW',
  tagline: 'Private guide recorder',
};

// ── View routing ──────────────────────────────────────────────────────────────

function showView(view, pushHistory = true) {
  const isSettings = view === 'settings';

  guidesView.style.display  = isSettings ? 'none' : '';
  settingsView.style.display = isSettings ? '' : 'none';

  // Topbar adapts: settings button becomes the back affordance
  settingsBtn.textContent    = isSettings ? '← Guides' : '⚙ Settings';
  newGuideBtn.style.display  = isSettings ? 'none' : '';
  storageInfoEl.style.display = isSettings ? 'none' : '';

  if (pushHistory) {
    if (isSettings) {
      history.pushState({ view: 'settings' }, '', '#settings');
    } else {
      history.pushState({ view: 'guides' }, '', window.location.pathname);
    }
  }

  if (isSettings) loadSettingsData();
}

window.addEventListener('popstate', () => {
  showView(window.location.hash === '#settings' ? 'settings' : 'guides', false);
});

settingsBtn.addEventListener('click', () => {
  showView(settingsView.style.display === 'none' ? 'settings' : 'guides');
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await loadGuides();
  await loadStorageInfo();

  // If the page was opened with #settings (e.g. from sidepanel), go straight there
  if (window.location.hash === '#settings') {
    showView('settings', false);
  }
}

async function loadGuides() {
  const [guides, allSteps] = await Promise.all([listGuides(), listAllSteps()]);
  allGuides = guides;
  _stepIndex = {};
  for (const step of allSteps) {
    const text = [step.description, step.notes].filter(Boolean).join(' ');
    if (text) _stepIndex[step.guideId] = (_stepIndex[step.guideId] || '') + ' ' + text;
  }
  for (const id of Object.keys(_stepIndex)) {
    _stepIndex[id] = _stepIndex[id].toLowerCase();
  }
  filterAndRender();
}

function filterAndRender() {
  const query = searchInput.value.trim().toLowerCase();
  const sort  = sortSelect.value;

  let filtered = query
    ? allGuides.filter(g =>
        g.title.toLowerCase().includes(query) ||
        (g.description || '').toLowerCase().includes(query) ||
        (g.tags || []).some(t => t.toLowerCase().includes(query)) ||
        (_stepIndex[g.id] || '').includes(query)
      )
    : [...allGuides];

  if (activeTagFilter) {
    filtered = filtered.filter(g => (g.tags || []).includes(activeTagFilter));
  }

  if (sort === 'oldest') {
    filtered.sort((a, b) => a.createdAt - b.createdAt);
  } else if (sort === 'az') {
    filtered.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sort === 'za') {
    filtered.sort((a, b) => b.title.localeCompare(a.title));
  }

  // Pinned guides always float to the top regardless of sort
  filtered.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  // Tag filter bar
  tagFilterBar.style.display = activeTagFilter ? '' : 'none';
  tagFilterLabel.textContent = activeTagFilter || '';

  renderGuides(filtered, query);
}

async function loadStorageInfo() {
  const estimate = await getStorageEstimate();
  if (estimate) {
    const usedMB = (estimate.usage / 1024 / 1024).toFixed(1);
    const quotaMB = estimate.quota ? (estimate.quota / 1024 / 1024 / 1024).toFixed(1) + ' GB' : '—';
    storageInfoEl.textContent = `Storage: ${usedMB} MB used`;
    storageInfoEl.title = `Quota: ~${quotaMB}`;
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderGuides(guides, query = '') {
  guidesGrid.innerHTML = '';

  if (guides.length === 0) {
    guideCount.textContent = '';
    if (query) {
      guidesGrid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <h2>No results for "${escapeHtml(query)}"</h2>
          <p>Try a different title, tag, or step description.</p>
        </div>`;
    } else {
      guidesGrid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <h2>No guides yet</h2>
          <p>Open the Pagewalk side panel from your toolbar to start recording a step-by-step guide on any webpage.</p>
        </div>`;
    }
    return;
  }

  guideCount.textContent = `(${guides.length})`;

  for (const guide of guides) {
    guidesGrid.appendChild(createGuideCard(guide));
    renderGuideTags(guide.id, guide.tags || []);
  }

  for (const guide of guides) {
    loadThumbnail(guide.id);
  }
}

function createGuideCard(guide) {
  const card = document.createElement('div');
  card.className = 'guide-card' + (guide.pinned ? ' guide-card--pinned' : '');
  card.dataset.guideId = guide.id;

  const dateStr = formatDate(guide.updatedAt || guide.createdAt);
  const stepText = `${guide.stepCount} step${guide.stepCount !== 1 ? 's' : ''}`;

  const PIN_ICON = `<svg width="14" height="14" viewBox="0 0 20 20" fill="${guide.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="10,2 12.4,7.5 18.5,8 14,12.5 15.5,18.5 10,15.5 4.5,18.5 6,12.5 1.5,8 7.6,7.5"/></svg>`;

  card.innerHTML = `
    <div class="guide-thumbnail">
      <div class="guide-thumbnail-empty" id="thumb-${escapeAttr(guide.id)}">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="14" rx="2"/>
          <path d="M7 21h10M12 17v4"/>
        </svg>
      </div>
    </div>
    <div class="guide-body">
      <div class="guide-title-row">
        <span class="guide-title" id="title-${escapeAttr(guide.id)}" title="${escapeHtml(guide.title)}">${escapeHtml(guide.title)}</span>
        <button class="pin-btn${guide.pinned ? ' active' : ''}" title="${guide.pinned ? 'Unpin' : 'Pin'}" data-id="${escapeAttr(guide.id)}">${PIN_ICON}</button>
        <button class="btn-icon rename-btn" title="Rename" data-id="${escapeAttr(guide.id)}" style="width:24px;height:24px;font-size:12px">✏️</button>
      </div>
      <div class="guide-meta">
        <span>${stepText}</span>
        <span>${dateStr}</span>
      </div>
      <div class="guide-tags" id="tags-${escapeAttr(guide.id)}"></div>
    </div>
    <div class="guide-actions">
      <button class="btn-primary open-btn" style="flex:1;font-size:12px" data-id="${escapeAttr(guide.id)}" ${guide.stepCount === 0 ? 'disabled' : ''}>View</button>
      <button class="btn-ghost edit-btn" style="font-size:12px" data-id="${escapeAttr(guide.id)}">Edit</button>
      <button class="btn-ghost duplicate-btn" style="font-size:12px" data-id="${escapeAttr(guide.id)}">Copy</button>
      <button class="btn-ghost delete-btn" style="font-size:12px" data-id="${escapeAttr(guide.id)}">Delete</button>
    </div>
  `;

  card.querySelector('.guide-thumbnail').addEventListener('click', () => playGuide(guide.id));
  card.querySelector('.open-btn').addEventListener('click', (e) => { e.stopPropagation(); playGuide(guide.id); });
  card.querySelector('.edit-btn').addEventListener('click', (e) => { e.stopPropagation(); openEditor(guide.id); });
  card.querySelector('.duplicate-btn').addEventListener('click', (e) => { e.stopPropagation(); duplicateGuide(guide.id, guide.title); });
  card.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); promptDelete(guide.id, guide.title); });
  card.querySelector('.rename-btn').addEventListener('click', (e) => { e.stopPropagation(); startRename(guide.id); });
  card.querySelector('.pin-btn').addEventListener('click', (e) => { e.stopPropagation(); togglePin(guide.id); });

  return card;
}

async function loadThumbnail(guideId) {
  const thumbContainer = document.getElementById(`thumb-${guideId}`);
  if (!thumbContainer) return;

  const guide = await getGuide(guideId);
  if (!guide || !guide.coverStep) return;

  const step = await getStep(guide.coverStep);
  if (!step) {
    const steps = await listSteps(guideId);
    if (steps.length === 0) return;
    const src = steps[0].screenshotAnnotated || steps[0].screenshotRaw;
    if (src) setThumbnailImg(thumbContainer, src);
    return;
  }

  const src = step.screenshotAnnotated || step.screenshotRaw;
  if (src) setThumbnailImg(thumbContainer, src);
}

function setThumbnailImg(container, src) {
  const img = document.createElement('img');
  img.className = 'guide-thumbnail';
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
  img.src = src;
  img.alt = 'Guide thumbnail';
  container.replaceWith(img);
}

// ── Rename ────────────────────────────────────────────────────────────────────

function startRename(guideId) {
  const titleEl = document.getElementById(`title-${guideId}`);
  if (!titleEl) return;

  const current = titleEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'guide-title-input';
  input.value = current;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  async function commit() {
    const newTitle = input.value.trim() || current;
    await updateGuide(guideId, { title: newTitle });
    const span = document.createElement('span');
    span.className = 'guide-title';
    span.id = `title-${guideId}`;
    span.title = newTitle;
    span.textContent = newTitle;
    input.replaceWith(span);
    showToast('Guide renamed');
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

// ── Delete ────────────────────────────────────────────────────────────────────

function promptDelete(guideId, title) {
  pendingDeleteId = guideId;
  deleteModalDesc.textContent = `Delete "${title}" and all its steps? This cannot be undone.`;
  deleteModal.classList.add('open');
}

deleteCancelBtn.addEventListener('click', () => {
  pendingDeleteId = null;
  deleteModal.classList.remove('open');
});

deleteConfirmBtn.addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  deleteConfirmBtn.disabled = true;
  deleteConfirmBtn.textContent = 'Deleting…';
  try {
    await deleteGuide(pendingDeleteId);
    await loadGuides();
    showToast('Guide deleted');
  } finally {
    deleteConfirmBtn.disabled = false;
    deleteConfirmBtn.textContent = 'Delete';
    pendingDeleteId = null;
    deleteModal.classList.remove('open');
  }
});

deleteModal.addEventListener('click', (e) => {
  if (e.target === deleteModal) {
    pendingDeleteId = null;
    deleteModal.classList.remove('open');
  }
});

// ── New recording ─────────────────────────────────────────────────────────────

newGuideBtn.addEventListener('click', () => {
  showToast('Open the Pagewalk side panel (toolbar icon) to start recording');
});

searchInput.addEventListener('input', filterAndRender);
sortSelect.addEventListener('change', filterAndRender);

// ── Open viewer / editor ──────────────────────────────────────────────────────

function openEditor(guideId) {
  location.href = `../viewer/viewer.html?id=${encodeURIComponent(guideId)}&edit=1`;
}

function playGuide(guideId) {
  location.href = `../viewer/viewer.html?id=${encodeURIComponent(guideId)}`;
}

// ── Pin ───────────────────────────────────────────────────────────────────────

async function togglePin(guideId) {
  const guide = allGuides.find(g => g.id === guideId);
  if (!guide) return;
  const updated = await updateGuide(guideId, { pinned: !guide.pinned });
  Object.assign(guide, updated);
  const card = guidesGrid.querySelector(`[data-guide-id="${escapeAttr(guideId)}"]`);
  if (card) {
    const btn = card.querySelector('.pin-btn');
    if (btn) {
      btn.classList.toggle('active', !!updated.pinned);
      btn.title = updated.pinned ? 'Unpin' : 'Pin';
      const filled = updated.pinned ? 'currentColor' : 'none';
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 20 20" fill="${filled}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="10,2 12.4,7.5 18.5,8 14,12.5 15.5,18.5 10,15.5 4.5,18.5 6,12.5 1.5,8 7.6,7.5"/></svg>`;
    }
    card.classList.toggle('guide-card--pinned', !!updated.pinned);
  }
  filterAndRender(); // re-sort so pinned floats to top
}

// ── Duplicate ─────────────────────────────────────────────────────────────────

async function duplicateGuide(guideId, originalTitle) {
  try {
    const [guide, steps] = await Promise.all([getGuide(guideId), listSteps(guideId)]);
    if (!guide) return;

    const newGuideId = generateId();

    // Build old → new ID map for steps
    const idMap = {};
    for (const step of steps) {
      if (step.id) idMap[step.id] = generateId();
    }

    const newGuide = {
      ...guide,
      id: newGuideId,
      title: `Copy of ${guide.title}`,
      coverStep: guide.coverStep ? (idMap[guide.coverStep] || null) : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false, // copies start unpinned
    };

    const newSteps = steps.map(step => ({
      ...step,
      id: step.id ? idMap[step.id] : generateId(),
      guideId: newGuideId,
    }));

    await bulkImportGuide(newGuide, newSteps);
    await loadGuides();
    showToast(`"${originalTitle}" duplicated`);
  } catch (err) {
    console.error('Duplicate failed', err);
    showToast('Duplicate failed');
  }
}

// ── Tags ──────────────────────────────────────────────────────────────────────

function renderGuideTags(guideId, tags) {
  const container = document.getElementById(`tags-${escapeAttr(guideId)}`);
  if (!container) return;
  container.innerHTML = '';

  for (const tag of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip' + (tag === activeTagFilter ? ' tag-active' : '');
    chip.innerHTML = `${escapeHtml(tag)}<button class="tag-remove" title="Remove tag" data-tag="${escapeHtml(tag)}" data-id="${escapeAttr(guideId)}">×</button>`;
    chip.addEventListener('click', (e) => {
      if (e.target.closest('.tag-remove')) {
        e.stopPropagation();
        removeTag(guideId, tag);
      } else {
        e.stopPropagation();
        activeTagFilter = activeTagFilter === tag ? null : tag;
        filterAndRender();
      }
    });
    container.appendChild(chip);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'tag-add-btn';
  addBtn.textContent = '+ Tag';
  addBtn.addEventListener('click', (e) => { e.stopPropagation(); startTagInput(guideId, addBtn); });
  container.appendChild(addBtn);
}

function startTagInput(guideId, addBtn) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-input';
  input.placeholder = 'tag name…';
  input.maxLength = 20;
  addBtn.replaceWith(input);
  input.focus();

  async function commit() {
    const raw = input.value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (raw) await addTag(guideId, raw);
    else renderGuideTags(guideId, (allGuides.find(g => g.id === guideId) || {}).tags || []);
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
  });
}

async function addTag(guideId, tag) {
  const guide = allGuides.find(g => g.id === guideId);
  if (!guide) return;
  const tags = guide.tags || [];
  if (tags.includes(tag)) { renderGuideTags(guideId, tags); return; }
  const updated = await updateGuide(guideId, { tags: [...tags, tag] });
  Object.assign(guide, updated);
  renderGuideTags(guideId, updated.tags || []);
}

async function removeTag(guideId, tag) {
  const guide = allGuides.find(g => g.id === guideId);
  if (!guide) return;
  const tags = (guide.tags || []).filter(t => t !== tag);
  const updated = await updateGuide(guideId, { tags });
  Object.assign(guide, updated);
  renderGuideTags(guideId, updated.tags || []);
  if (activeTagFilter === tag && !allGuides.some(g => (g.tags || []).includes(tag))) {
    activeTagFilter = null;
  }
  filterAndRender();
}

tagFilterClear.addEventListener('click', () => {
  activeTagFilter = null;
  filterAndRender();
});

// ── Settings: load data into form ─────────────────────────────────────────────

async function loadSettingsData() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const s = r[SETTINGS_KEY] || { screenshotDelay: 300, jpegQuality: 85 };

  spDelay.value          = s.screenshotDelay;
  spDelayVal.textContent = s.screenshotDelay + 'ms';
  spQuality.value          = s.jpegQuality;
  spQualityVal.textContent = s.jpegQuality + '%';
  spCaptureOnStart.checked = s.captureOnStart !== false;
  spShowWidget.checked     = !!s.showWidget;
  spAutoRedact.checked     = !!s.autoRedact;
  spRedactOptions.style.display = s.autoRedact ? '' : 'none';
  spRedactStyle.value = s.redactStyle || 'redact';
  spRedactMode.value  = s.redactMode  || 'capture';

  const cats = s.redactCategories || {};
  spCatEmails.checked = cats.emails !== false;
  spCatPhones.checked = cats.phones !== false;
  spCatCards.checked  = cats.creditCards !== false;
  spCatSsn.checked    = cats.ssn !== false;
  spCatMoney.checked  = !!cats.money;
  spCatFormFields.checked = !!cats.formFields;
  spCatTableData.checked  = !!cats.tableData;
  spRenderCustomPatterns(Array.isArray(s.redactCustomPatterns) ? s.redactCustomPatterns : []);

  spMaxVersions.value = s.maxVersionsPerGuide ?? DEFAULT_MAX_VERSIONS;
  spTitleTemplate.value = s.titleTemplate ?? 'Guide — {host}';

  const br = { ...DEFAULT_BRANDING, ...(s.branding || {}) };
  spApplyColor(br.brandColor);
  spBrandName.value = br.brandName;
  spLogoMark.value  = br.logoMark;
  spTagline.value   = br.tagline;
  _spPendingLogo    = undefined;
  spSetLogoPreview(br.logoImage || null);

  spStorage.textContent = 'Loading…';
  const estimate = await getStorageEstimate();
  if (estimate) {
    const usedMB  = (estimate.usage / 1024 / 1024).toFixed(2);
    const quotaGB = estimate.quota ? (estimate.quota / 1024 / 1024 / 1024).toFixed(1) + ' GB' : '—';
    spStorage.innerHTML = `Used: <strong>${usedMB} MB</strong><br>Quota: ~${quotaGB}`;
  } else {
    spStorage.textContent = 'Unavailable';
  }
}

// ── Settings: branding helpers ────────────────────────────────────────────────

function spApplyColor(hex) {
  const safe = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : DEFAULT_BRANDING.brandColor;
  spColorSwatch.style.background = safe;
  spColorPicker.value = safe;
  spColorHex.value    = safe;
}

function spSetLogoPreview(dataUrl) {
  if (dataUrl) {
    spLogoPreview.innerHTML = `<img src="${dataUrl}" alt="Logo">`;
    spLogoRemoveBtn.style.display = '';
  } else {
    spLogoPreview.textContent = 'none';
    spLogoRemoveBtn.style.display = 'none';
  }
}

async function spResizeLogo(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 128;
      const scale = Math.min(MAX / img.width, MAX / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ── Custom pattern list helpers ───────────────────────────────────────────────

function spRenderCustomPatterns(patterns) {
  const list = document.getElementById('sp-custom-pattern-list');
  if (!list) return;
  list.innerHTML = '';
  patterns.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'sp-pattern-row';
    row.innerHTML = `
      <input type="text" class="sp-pname" placeholder="Name (optional)" value="${escapeHtml(entry.name || '')}">
      <input type="text" class="sp-pregex" placeholder="e.g. EMP-\\d{5}" value="${escapeHtml(entry.pattern || '')}">
      <button class="btn-ghost sp-premove" title="Remove" style="color:var(--color-danger);padding:3px 8px;font-size:13px;flex-shrink:0">×</button>
    `;
    row.querySelector('.sp-premove').addEventListener('click', () => row.remove());
    list.appendChild(row);
  });
}

function spCollectCustomPatterns() {
  const list = document.getElementById('sp-custom-pattern-list');
  if (!list) return [];
  return Array.from(list.querySelectorAll('.sp-pattern-row')).map(row => ({
    name:    row.querySelector('.sp-pname').value.trim(),
    pattern: row.querySelector('.sp-pregex').value.trim(),
  })).filter(e => e.pattern);
}

spAddPatternBtn.addEventListener('click', () => {
  spRenderCustomPatterns(spCollectCustomPatterns().concat([{ name: '', pattern: '' }]));
  const list = document.getElementById('sp-custom-pattern-list');
  if (list && list.lastElementChild) {
    list.lastElementChild.querySelector('.sp-pname').focus();
  }
});

// ── Settings: event listeners ─────────────────────────────────────────────────

spDelay.addEventListener('input',   () => { spDelayVal.textContent   = spDelay.value + 'ms'; });
spQuality.addEventListener('input', () => { spQualityVal.textContent = spQuality.value + '%'; });
spAutoRedact.addEventListener('change', () => {
  spRedactOptions.style.display = spAutoRedact.checked ? '' : 'none';
});

spSaveBtn.addEventListener('click', async () => {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const existing = r[SETTINGS_KEY] || {};

  const newMax = Math.min(50, Math.max(1, parseInt(spMaxVersions.value, 10) || DEFAULT_MAX_VERSIONS));
  spMaxVersions.value = newMax; // normalise display
  const oldMax = existing.maxVersionsPerGuide ?? DEFAULT_MAX_VERSIONS;

  // If the limit was reduced, check the impact BEFORE saving and ask for confirmation.
  let guidesToPrune = null;
  if (newMax < oldMax) {
    try {
      const guides = await listGuides();
      let affectedGuides = 0;
      let totalToDelete  = 0;
      for (const g of guides) {
        const versions = await listVersions(g.id);
        const excess = versions.length - newMax;
        if (excess > 0) {
          affectedGuides++;
          totalToDelete += excess;
        }
      }
      if (totalToDelete > 0) {
        const guideWord   = affectedGuides === 1 ? 'guide' : 'guides';
        const versionWord = totalToDelete  === 1 ? 'snapshot' : 'snapshots';
        const ok = await showConfirmModal({
          title: `Reduce to ${newMax} version${newMax === 1 ? '' : 's'}?`,
          body: `This will permanently delete ${totalToDelete} ${versionWord} across ${affectedGuides} ${guideWord}. This cannot be undone.`,
          confirmLabel: 'Delete snapshots',
          cancelLabel: 'Cancel',
          danger: true,
        });
        if (!ok) return; // user cancelled — abort before anything is written
      }
      guidesToPrune = guides;
    } catch (err) {
      console.warn('Version pruning check failed:', err);
    }
  }

  // Confirmed (or no pruning needed) — now persist the settings.
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...existing,
      screenshotDelay: parseInt(spDelay.value, 10),
      jpegQuality:     parseInt(spQuality.value, 10),
      captureOnStart:  spCaptureOnStart.checked,
      showWidget:      spShowWidget.checked,
      autoRedact:      spAutoRedact.checked,
      redactStyle:     spRedactStyle.value,
      redactMode:      spRedactMode.value,
      redactCategories: {
        emails:      spCatEmails.checked,
        phones:      spCatPhones.checked,
        creditCards: spCatCards.checked,
        ssn:         spCatSsn.checked,
        money:       spCatMoney.checked,
        formFields:  spCatFormFields.checked,
        tableData:   spCatTableData.checked,
      },
      redactCustomPatterns:  spCollectCustomPatterns(),
      maxVersionsPerGuide:   newMax,
      titleTemplate:         (spTitleTemplate.value || '').trim() || 'Guide — {host}',
    }
  });

  if (guidesToPrune) {
    await Promise.all(guidesToPrune.map(g => pruneVersions(g.id, newMax)));
  }

  spSaveBtn.textContent = 'Saved ✓';
  spSaveBtn.style.background = '#22c55e';
  setTimeout(() => { spSaveBtn.textContent = 'Save Settings'; spSaveBtn.style.background = ''; }, 1800);
});

spColorPicker.addEventListener('input', () => spApplyColor(spColorPicker.value));
spColorHex.addEventListener('input', () => {
  if (/^#[0-9a-fA-F]{6}$/.test(spColorHex.value)) spApplyColor(spColorHex.value);
});
spColorHex.addEventListener('blur', () => {
  if (!/^#[0-9a-fA-F]{6}$/.test(spColorHex.value)) spApplyColor(spColorPicker.value);
});

spLogoMark.addEventListener('input', () => {
  spLogoMark.value = spLogoMark.value.toUpperCase().slice(0, 4);
});

spLogoUploadBtn.addEventListener('click', () => spLogoFileInput.click());

spLogoFileInput.addEventListener('change', async () => {
  const file = spLogoFileInput.files[0];
  if (!file) return;
  spLogoUploadBtn.textContent = '…';
  spLogoUploadBtn.disabled = true;
  const dataUrl = await spResizeLogo(file);
  if (dataUrl) { _spPendingLogo = dataUrl; spSetLogoPreview(dataUrl); }
  spLogoUploadBtn.textContent = 'Upload';
  spLogoUploadBtn.disabled = false;
  spLogoFileInput.value = '';
});

spLogoRemoveBtn.addEventListener('click', () => {
  _spPendingLogo = null;
  spSetLogoPreview(null);
});

spSaveBrandingBtn.addEventListener('click', async () => {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const s = r[SETTINGS_KEY] || {};
  const hex = /^#[0-9a-fA-F]{6}$/.test(spColorHex.value) ? spColorHex.value : DEFAULT_BRANDING.brandColor;
  const existingLogo = (s.branding || {}).logoImage || null;
  const newLogo = _spPendingLogo === undefined ? existingLogo : _spPendingLogo;
  s.branding = {
    brandColor: hex,
    brandName:  spBrandName.value.trim() || DEFAULT_BRANDING.brandName,
    logoMark:   spLogoMark.value.trim().toUpperCase().slice(0, 4) || DEFAULT_BRANDING.logoMark,
    tagline:    spTagline.value.trim() || DEFAULT_BRANDING.tagline,
    logoImage:  newLogo,
  };
  _spPendingLogo = undefined;
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  spSaveBrandingBtn.textContent = 'Saved ✓';
  spSaveBrandingBtn.style.background = '#22c55e';
  setTimeout(() => { spSaveBrandingBtn.textContent = 'Save Branding'; spSaveBrandingBtn.style.background = ''; }, 1800);
});

spDeleteAll.addEventListener('click', async () => {
  const ok = await showConfirmModal({
    title: 'Delete all guides?',
    body: 'This permanently removes all guides and screenshots from this device. This cannot be undone.',
    confirmLabel: 'Delete all',
    cancelLabel: 'Cancel',
    danger: true,
  });
  if (!ok) return;
  spDeleteAll.disabled = true;
  spDeleteAll.textContent = 'Deleting…';
  try {
    // Truncate all three stores in one transaction — catches orphaned
    // version snapshots and anything not present in the local cache.
    await clearAllGuideData();
    allGuides = [];
    _stepIndex = {};
    showView('guides');
    filterAndRender();
    showToast('Deleted all guides');
  } finally {
    spDeleteAll.disabled = false;
    spDeleteAll.textContent = 'Delete All';
  }
});

// ── Export / Import ───────────────────────────────────────────────────────────

spExportBtn.addEventListener('click', async () => {
  spExportBtn.disabled = true;
  spExportBtn.textContent = 'Exporting…';
  try {
    const r = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = r[SETTINGS_KEY] || {};
    const guides = await listGuides();
    const guidesData = await Promise.all(guides.map(async g => ({
      guide: { ...g },
      steps: await listSteps(g.id),
      versions: await listVersions(g.id),
    })));
    const payload = {
      version: 2,
      exportedAt: Date.now(),
      settings,
      guides: guidesData,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pagewalk-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${guides.length} guide${guides.length !== 1 ? 's' : ''}`);
  } catch (err) {
    console.error('Export failed', err);
    showToast('Export failed');
  } finally {
    spExportBtn.disabled = false;
    spExportBtn.textContent = 'Export';
  }
});

spImportBtn.addEventListener('click', () => spImportInput.click());

spImportInput.addEventListener('change', async () => {
  const file = spImportInput.files[0];
  spImportInput.value = '';
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    showToast('Invalid file — could not parse JSON');
    return;
  }

  if (!payload || !Array.isArray(payload.guides)) {
    showToast('Invalid backup file');
    return;
  }

  const guideCount = payload.guides.length;
  const hasSettings = payload.settings && typeof payload.settings === 'object';

  const ok = await showConfirmModal({
    title: `Import ${guideCount} guide${guideCount !== 1 ? 's' : ''}?`,
    body: `${guideCount} guide${guideCount !== 1 ? 's' : ''} will be added to your library${hasSettings ? ', and your settings will be replaced with the backup values' : ''}. Existing guides are not affected.`,
    confirmLabel: 'Import',
    cancelLabel: 'Cancel',
    danger: false,
  });
  if (!ok) return;

  spImportBtn.disabled = true;
  spImportBtn.textContent = 'Importing…';
  let imported = 0;
  let failed = 0;

  try {
    for (const entry of payload.guides) {
      if (!entry || !entry.guide || !Array.isArray(entry.steps)) { failed++; continue; }
      try {
        const oldGuideId = entry.guide.id;
        const newGuideId = generateId();

        // Build a map from old step ID → new step ID
        const idMap = {};
        for (const step of entry.steps) {
          if (step.id) idMap[step.id] = generateId();
        }

        const newGuide = {
          ...entry.guide,
          id: newGuideId,
          coverStep: entry.guide.coverStep ? (idMap[entry.guide.coverStep] || null) : null,
          importedAt: Date.now(),
        };

        const newSteps = entry.steps.map(step => ({
          ...step,
          id: step.id ? idMap[step.id] : generateId(),
          guideId: newGuideId,
        }));

        const newVersions = (Array.isArray(entry.versions) ? entry.versions : []).map(v => ({
          ...v,
          id: generateId(),
          guideId: newGuideId,
          steps: (v.steps || []).map(s => ({
            ...s,
            id: idMap[s.id] || generateId(),
            guideId: newGuideId,
          })),
          guide: v.guide ? { ...v.guide, id: newGuideId } : undefined,
        }));

        await bulkImportGuide(newGuide, newSteps, newVersions);
        imported++;
      } catch (e) {
        console.warn('Failed to import guide:', e);
        failed++;
      }
    }

    // Replace settings only if the backup has them
    if (hasSettings) {
      await chrome.storage.local.set({ [SETTINGS_KEY]: payload.settings });
    }

    await loadGuides();
    // Refresh settings UI if currently visible
    if (settingsView.style.display !== 'none') loadSettingsData();

    const msg = failed > 0
      ? `Imported ${imported} guide${imported !== 1 ? 's' : ''} (${failed} failed)`
      : `Imported ${imported} guide${imported !== 1 ? 's' : ''}`;
    showToast(msg, 3000);
  } catch (err) {
    console.error('Import failed', err);
    showToast('Import failed');
  } finally {
    spImportBtn.disabled = false;
    spImportBtn.textContent = 'Import';
  }
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function showToast(msg, duration = 2500) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), duration);
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffMins  = Math.floor((now - d) / 60000);
  const diffHours = Math.floor((now - d) / 3600000);
  const diffDays  = Math.floor((now - d) / 86400000);
  if (diffMins < 1)  return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7)  return `${diffDays}d ago`;
  return d.toLocaleDateString();
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

init();
