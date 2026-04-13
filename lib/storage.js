/**
 * storage.js — Single point of IndexedDB access for Pagewalk
 * DB: pagewalk_db v2
 */
import { openDB } from './vendor/idb.min.js';

const DB_NAME = 'pagewalk_db';
const DB_VERSION = 2;

let _db = null;

async function getDb() {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // v1: guides + steps
      if (oldVersion < 1) {
        const guidesStore = db.createObjectStore('guides', { keyPath: 'id' });
        guidesStore.createIndex('createdAt', 'createdAt');
        const stepsStore = db.createObjectStore('steps', { keyPath: 'id' });
        stepsStore.createIndex('guideId', 'guideId');
        stepsStore.createIndex('guideId_order', ['guideId', 'order']);
      }
      // v2: version history snapshots
      if (oldVersion < 2) {
        const versionsStore = db.createObjectStore('versions', { keyPath: 'id' });
        versionsStore.createIndex('guideId', 'guideId');
        versionsStore.createIndex('guideId_createdAt', ['guideId', 'createdAt']);
      }
    },
  });
  return _db;
}

// ─── Guides ────────────────────────────────────────────────────────────────

export async function createGuide(title = 'Untitled Guide') {
  const db = await getDb();
  const guide = {
    id: generateId(),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stepCount: 0,
    coverStep: null,
  };
  await db.put('guides', guide);
  return guide;
}

export async function getGuide(id) {
  const db = await getDb();
  return db.get('guides', id);
}

export async function listGuides() {
  const db = await getDb();
  const guides = await db.getAllFromIndex('guides', 'createdAt');
  return guides.reverse(); // newest first
}

export async function updateGuide(id, changes) {
  const db = await getDb();
  const guide = await db.get('guides', id);
  if (!guide) throw new Error(`Guide ${id} not found`);
  const updated = { ...guide, ...changes, updatedAt: Date.now() };
  await db.put('guides', updated);
  return updated;
}

export async function deleteGuide(id) {
  const db = await getDb();
  // delete all steps + version snapshots for this guide
  const steps = await listSteps(id);
  const versions = await listVersions(id);
  const tx = db.transaction(['guides', 'steps', 'versions'], 'readwrite');
  await tx.objectStore('guides').delete(id);
  for (const step of steps) {
    await tx.objectStore('steps').delete(step.id);
  }
  for (const v of versions) {
    await tx.objectStore('versions').delete(v.id);
  }
  await tx.done;
}

// Nuke every guide, step, and version snapshot in one transaction.
// Used by the dashboard's "Delete all" button — deleting guide-by-guide
// leaves orphaned version snapshots and misses anything absent from the
// dashboard's local cache.
export async function clearAllGuideData() {
  const db = await getDb();
  const tx = db.transaction(['guides', 'steps', 'versions'], 'readwrite');
  await tx.objectStore('guides').clear();
  await tx.objectStore('steps').clear();
  await tx.objectStore('versions').clear();
  await tx.done;
}

// ─── Steps ─────────────────────────────────────────────────────────────────

export async function createStep(guideId, data) {
  const db = await getDb();
  const existingSteps = await listSteps(guideId);
  const maxOrder = existingSteps.length > 0
    ? Math.max(...existingSteps.map(s => s.order))
    : -1;
  const step = {
    id: generateId(),
    guideId,
    order: maxOrder + 1,
    description: data.description || '',
    screenshotRaw: data.screenshotRaw || null,
    screenshotAnnotated: null,
    annotationState: null,
    clickX: data.clickX || 0,
    clickY: data.clickY || 0,
    devicePixelRatio: data.devicePixelRatio || 1,
    pageUrl: data.pageUrl || '',
    pageTitle: data.pageTitle || '',
    // Extended fields (click-only guides recorded before this change
    // just have type undefined; the renderer treats that as 'click').
    type: data.type || 'click',
    value: data.value || null,
    fromUrl: data.fromUrl || null,
    toUrl: data.toUrl || null,
    notes: data.notes || null,
    // Marks steps created by the "capture on start" setting so the
    // viewer can render them as a hero cover and Guide Me can skip past
    // them. Persisting this on the step (rather than checking the
    // setting at render time) means it stays correct even if the user
    // toggles the setting later.
    isInitialCapture: !!data.isInitialCapture,
    // Element-identity signals for Guide Me live replay
    targetSelector: data.targetSelector || null,
    targetXPath:    data.targetXPath    || null,
    targetText:     data.targetText     || null,
    targetAttrs:    data.targetAttrs    || null,
    targetTag:      data.targetTag      || null,
    createdAt: Date.now(),
  };
  await db.put('steps', step);
  // update guide step count and cover
  const guide = await db.get('guides', guideId);
  if (guide) {
    await db.put('guides', {
      ...guide,
      stepCount: guide.stepCount + 1,
      coverStep: guide.coverStep || step.id,
      updatedAt: Date.now(),
    });
  }
  return step;
}

export async function getStep(id) {
  const db = await getDb();
  return db.get('steps', id);
}

export async function listSteps(guideId) {
  const db = await getDb();
  const steps = await db.getAllFromIndex('steps', 'guideId', guideId);
  return steps.sort((a, b) => a.order - b.order);
}

export async function updateStep(id, changes) {
  const db = await getDb();
  const step = await db.get('steps', id);
  if (!step) throw new Error(`Step ${id} not found`);
  const updated = { ...step, ...changes };
  await db.put('steps', updated);
  return updated;
}

export async function deleteStep(id) {
  const db = await getDb();
  const step = await db.get('steps', id);
  if (!step) return;
  await db.delete('steps', id);
  // update guide count
  const guide = await db.get('guides', step.guideId);
  if (guide) {
    const remaining = await listSteps(step.guideId);
    await db.put('guides', {
      ...guide,
      stepCount: remaining.length,
      coverStep: remaining.length > 0 ? remaining[0].id : null,
      updatedAt: Date.now(),
    });
  }
}

export async function reorderSteps(steps) {
  // steps: array of {id, order}
  const db = await getDb();
  const tx = db.transaction('steps', 'readwrite');
  for (const { id, order } of steps) {
    const step = await tx.store.get(id);
    if (step) await tx.store.put({ ...step, order });
  }
  await tx.done;
}

// ─── Version History ────────────────────────────────────────────────────────

export const DEFAULT_MAX_VERSIONS = 5;

// Snapshot the current guide + all its steps into the versions store.
// Called once per edit session (viewer handles the "only once" gate).
export async function createVersion(guideId, maxVersions = DEFAULT_MAX_VERSIONS) {
  const db = await getDb();
  const guide = await db.get('guides', guideId);
  if (!guide) throw new Error(`Guide ${guideId} not found`);
  const steps = await listSteps(guideId);
  const version = {
    id: generateId(),
    guideId,
    createdAt: Date.now(),
    stepCount: steps.filter(s => !s.isInitialCapture).length,
    guide: { ...guide },
    steps: steps.map(s => ({ ...s })),
  };
  await db.put('versions', version);
  await pruneVersions(guideId, maxVersions);
  return version;
}

// Return all versions for a guide, newest first.
export async function listVersions(guideId) {
  const db = await getDb();
  const versions = await db.getAllFromIndex('versions', 'guideId', guideId);
  return versions.sort((a, b) => b.createdAt - a.createdAt);
}

// Restore a snapshot. First saves the current state as a new version so
// the user can undo the restore, then replaces all steps + guide metadata.
export async function restoreVersion(versionId, maxVersions = DEFAULT_MAX_VERSIONS) {
  const db = await getDb();
  const version = await db.get('versions', versionId);
  if (!version) throw new Error(`Version ${versionId} not found`);

  const guideId = version.guideId;

  // Save current state before overwriting (allows "undo restore")
  await createVersion(guideId, maxVersions);

  // Replace steps
  const existing = await listSteps(guideId);
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  for (const step of existing) {
    await tx.objectStore('steps').delete(step.id);
  }
  for (const step of version.steps) {
    await tx.objectStore('steps').put({ ...step, guideId });
  }
  // Restore guide metadata, keep same id, bump updatedAt
  const restoredGuide = { ...version.guide, id: guideId, updatedAt: Date.now() };
  await tx.objectStore('guides').put(restoredGuide);
  await tx.done;

  return restoredGuide;
}

// Delete a single version snapshot.
export async function deleteVersion(versionId) {
  const db = await getDb();
  await db.delete('versions', versionId);
}

// Keep only the most recent `maxVersions` snapshots, drop the rest.
export async function pruneVersions(guideId, maxVersions = DEFAULT_MAX_VERSIONS) {
  maxVersions = Math.max(maxVersions, 1); // guard against 0 / negative
  const db = await getDb();
  const versions = await listVersions(guideId);
  if (versions.length <= maxVersions) return;
  const toDelete = versions.slice(maxVersions);
  for (const v of toDelete) {
    await db.delete('versions', v.id);
  }
}

// ─── Storage usage ──────────────────────────────────────────────────────────

// Return every step across all guides in one query — used for search indexing.
export async function listAllSteps() {
  const db = await getDb();
  return db.getAll('steps');
}

export async function getStorageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    return navigator.storage.estimate();
  }
  return null;
}

// ─── Bulk import ────────────────────────────────────────────────────────────

// Write a fully-formed guide + its steps directly into IndexedDB.
// All ID remapping must be done by the caller before passing in.
// stepCount is always recomputed from the steps array so stale values
// from export files can't corrupt the guide record.
export async function bulkImportGuide(guide, steps, versions = []) {
  const db = await getDb();
  const tx = db.transaction(['guides', 'steps', 'versions'], 'readwrite');
  await tx.objectStore('guides').put({ ...guide, stepCount: steps.length });
  for (const step of steps) {
    await tx.objectStore('steps').put(step);
  }
  for (const version of versions) {
    await tx.objectStore('versions').put(version);
  }
  await tx.done;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}
