/**
 * annotations.js — Fabric.js wrapper for Pagewalk annotation tools
 * Requires fabric.min.js (v5.3) to be loaded as a global before this module.
 */

export class AnnotationCanvas {
  constructor(canvasEl, { width, height } = {}) {
    this._canvas = new fabric.Canvas(canvasEl, {
      width:  width  || 800,
      height: height || 450,
      selection: true,
      preserveObjectStacking: true,
      enableRetinaScaling: false,
    });

    this._tool    = 'select';
    this._color   = '#ef4444';
    this._undoStack = [];
    this._redoStack = [];
    this._maxUndo   = 50;
    this._drawing   = false;
    this._startX    = 0;
    this._startY    = 0;
    this._activeDrawObj  = null;
    this._suppressSnapshot = false;

    this._setupEvents();
  }

  // ─── Background ─────────────────────────────────────────────────────────────

  setBackground(src) {
    return new Promise((resolve) => {
      fabric.Image.fromURL(src, (img) => {
        if (!img || !img.width) { resolve(); return; }
        img.set({
          left: 0, top: 0,
          scaleX: this._canvas.width  / img.width,
          scaleY: this._canvas.height / img.height,
          selectable: false,
          evented: false,
          originX: 'left',
          originY: 'top',
        });
        this._canvas.setBackgroundImage(img, () => {
          this._canvas.renderAll();
          resolve();
        });
      }, { crossOrigin: 'anonymous' });
    });
  }

  // ─── Tool selection ──────────────────────────────────────────────────────────

  setTool(tool) {
    this._tool = tool;
    const c = this._canvas;
    c.isDrawingMode = false;
    c.selection     = (tool === 'select');
    c.defaultCursor = (tool === 'select') ? 'default' : 'crosshair';
    if (tool !== 'select') c.discardActiveObject().renderAll();
  }

  setColor(color) {
    this._color = color;
    const obj = this._canvas.getActiveObject();
    if (!obj) return;
    const apply = (o) => {
      if (o.stroke && o.stroke !== 'transparent') o.set('stroke', color);
      if (o.fill   && o.fill   !== 'transparent' && o.fill !== 'rgba(253,224,71,0.35)') {
        o.set('fill', color);
      }
    };
    obj.type === 'group' ? obj.getObjects().forEach(apply) : apply(obj);
    this._canvas.renderAll();
  }

  // ─── Mouse events ────────────────────────────────────────────────────────────

  _setupEvents() {
    const c = this._canvas;
    c.on('mouse:down',  opt => this._onMouseDown(opt));
    c.on('mouse:move',  opt => this._onMouseMove(opt));
    c.on('mouse:up',    opt => this._onMouseUp(opt));
    c.on('object:added',    () => this._saveSnapshot());
    c.on('object:modified', () => this._saveSnapshot());
    c.on('object:removed',  () => this._saveSnapshot());
  }

  _ptr(opt) {
    const p = this._canvas.getPointer(opt.e);
    return { x: p.x, y: p.y };
  }

  _onMouseDown(opt) {
    if (this._tool === 'select') return;
    if (this._tool === 'text') {
      if (!opt.target) this._addText(this._ptr(opt).x, this._ptr(opt).y);
      return;
    }
    if (opt.target) return;

    this._drawing = true;
    const { x, y } = this._ptr(opt);
    this._startX = x; this._startY = y;

    if (this._tool === 'highlight') {
      this._activeDrawObj = new fabric.Rect({
        left: x, top: y, width: 1, height: 1,
        fill: 'rgba(253,224,71,0.35)',
        stroke: '#ca8a04', strokeWidth: 2,
        selectable: false, evented: false,
        data: { type: 'highlight' },
      });
      this._canvas.add(this._activeDrawObj);
    }

    if (this._tool === 'blur') {
      this._activeDrawObj = new fabric.Rect({
        left: x, top: y, width: 1, height: 1,
        fill: 'rgba(15,23,42,0.55)',
        stroke: '#475569', strokeWidth: 2,
        strokeDashArray: [5, 3],
        selectable: false, evented: false,
        data: { type: 'blur' },
      });
      this._canvas.add(this._activeDrawObj);
    }

    if (this._tool === 'redact') {
      this._activeDrawObj = new fabric.Rect({
        left: x, top: y, width: 1, height: 1,
        fill: '#000000',
        stroke: '#000000', strokeWidth: 0,
        selectable: false, evented: false,
        data: { type: 'redact' },
      });
      this._canvas.add(this._activeDrawObj);
    }
  }

  _onMouseMove(opt) {
    if (!this._drawing) return;
    const { x, y } = this._ptr(opt);
    const x0 = this._startX, y0 = this._startY;

    if (this._tool === 'highlight' || this._tool === 'blur' || this._tool === 'redact') {
      const obj = this._activeDrawObj;
      if (!obj) return;
      obj.set({
        left:   Math.min(x, x0), top:    Math.min(y, y0),
        width:  Math.abs(x - x0), height: Math.abs(y - y0),
      });
      this._canvas.renderAll();
    }

    if (this._tool === 'arrow') {
      if (this._activeDrawObj) { this._canvas.remove(this._activeDrawObj); this._activeDrawObj = null; }
      if (Math.hypot(x - x0, y - y0) > 5) {
        this._activeDrawObj = this._buildArrow(x0, y0, x, y, true);
        this._canvas.add(this._activeDrawObj);
        this._canvas.renderAll();
      }
    }
  }

  _onMouseUp(opt) {
    if (!this._drawing) return;
    this._drawing = false;

    const { x, y } = this._ptr(opt);
    const dist = Math.hypot(x - this._startX, y - this._startY);

    if (this._tool === 'highlight' || this._tool === 'blur' || this._tool === 'redact') {
      const obj = this._activeDrawObj; this._activeDrawObj = null;
      if (!obj) return;
      if (dist < 6) { this._canvas.remove(obj); return; }
      obj.set({ selectable: true, evented: true });
      this._canvas.setActiveObject(obj);
      this._canvas.renderAll();
    }

    if (this._tool === 'arrow') {
      if (this._activeDrawObj) { this._canvas.remove(this._activeDrawObj); this._activeDrawObj = null; }
      if (dist < 10) return;
      const arrow = this._buildArrow(this._startX, this._startY, x, y, false);
      this._canvas.add(arrow);
      this._canvas.setActiveObject(arrow);
      this._canvas.renderAll();
    }

    this._saveSnapshot();
  }

  // ─── Arrow ───────────────────────────────────────────────────────────────────

  _buildArrow(x1, y1, x2, y2, isTemp) {
    const color = this._color;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const HEAD  = 20;

    const line = new fabric.Line([x1, y1, x2, y2], {
      stroke: color, strokeWidth: 3, strokeLineCap: 'round',
      selectable: false, evented: false,
      originX: 'center', originY: 'center',
    });
    const head = new fabric.Triangle({
      width: HEAD, height: HEAD, fill: color,
      left: x2, top: y2,
      angle: (angle * 180 / Math.PI) + 90,
      originX: 'center', originY: 'center',
      selectable: false, evented: false,
    });
    return new fabric.Group([line, head], {
      selectable: !isTemp, evented: !isTemp,
      data: { type: 'arrow', color },
    });
  }

  // ─── Text label (uses IText — avoids _setTextStyles crash in Fabric v5) ──────

  _addText(x, y) {
    // Use fabric.IText (not Textbox) to avoid _setTextStyles issues in Fabric v5.3
    const t = new fabric.IText('Label', {
      left: x, top: y,
      fontSize: 18,
      fontFamily: 'Arial, sans-serif',
      fontWeight: 'bold',
      fill: '#ffffff',
      shadow: 'rgba(0,0,0,0.6) 1px 1px 3px',
      editable: true,
      data: { type: 'text' },
    });
    // Tinted background via rect underneath
    const bg = new fabric.Rect({
      left: x - 4, top: y - 4,
      width: 108, height: 30,
      fill: this._color,
      rx: 3, ry: 3,
      selectable: false, evented: false,
      data: { type: 'text-bg' },
    });
    this._canvas.add(bg);
    this._canvas.add(t);
    this._canvas.setActiveObject(t);
    t.enterEditing();
    t.selectAll();
    this._canvas.renderAll();
  }

  // ─── Click-pin — canvas-rendered badge (avoids fabric.Text inside Group) ─────

  async addClickPin(x, y, stepNumber) {
    this._suppressSnapshot = true;
    try {
      const HALF    = 23; // (SIZE + 8) / 2 = 46 / 2
      const dataUrl = AnnotationCanvas._renderBadge(stepNumber);

      await new Promise((resolve) => {
        fabric.Image.fromURL(dataUrl, (img) => {
          const cx = Math.max(HALF, Math.min(this._canvas.width  - HALF, x));
          const cy = Math.max(HALF, Math.min(this._canvas.height - HALF, y));
          img.set({
            left: cx - HALF,
            top:  cy - HALF,
            selectable: true,
            evented: true,
            hasControls: false,
            hasBorders: true,
            data: { type: 'click-pin', stepNumber, autoGenerated: true },
          });
          this._canvas.add(img);
          this._canvas.renderAll();
          resolve();
        });
      });
    } finally {
      this._suppressSnapshot = false;
    }
  }

  // Returns true if the canvas has any user-drawn objects (not counting the auto-generated pin).
  // Used by the viewer to decide whether to produce a screenshotAnnotated JPEG.
  hasUserAnnotations() {
    return this._canvas.getObjects().some(
      o => !(o.data?.type === 'click-pin' && o.data?.autoGenerated),
    );
  }

  // Return the center of the auto-generated click-pin in canvas coordinates, or null if absent.
  getClickPinCenter() {
    const HALF = 23;
    const pin = this._canvas.getObjects().find(o => o.data?.type === 'click-pin' && o.data?.autoGenerated);
    if (!pin) return null;
    return { x: pin.left + HALF, y: pin.top + HALF };
  }

  // Remove all existing pins then place a fresh one — for re-pin button
  async resetClickPin(x, y, stepNumber) {
    const existing = this._canvas.getObjects().filter(o => o.data?.type === 'click-pin');
    existing.forEach(o => this._canvas.remove(o));
    if (existing.length) this._canvas.renderAll();
    await this.addClickPin(x, y, stepNumber);
  }

  // Render the numbered badge as a PNG data URL (no Fabric canvas needed)
  static _renderBadge(stepNumber) {
    const SIZE = 38;
    const badge = document.createElement('canvas');
    badge.width  = SIZE + 8;
    badge.height = SIZE + 8;
    const ctx = badge.getContext('2d');

    ctx.shadowColor   = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur    = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.arc(SIZE / 2 + 4, SIZE / 2 + 4, SIZE / 2 - 1, 0, Math.PI * 2);
    ctx.fillStyle = '#e11d48';
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 3;
    ctx.stroke();

    const label = String(stepNumber);
    const fs = label.length > 2 ? 13 : 16;
    ctx.font         = `bold ${fs}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle    = '#ffffff';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, SIZE / 2 + 4, SIZE / 2 + 5);

    return badge.toDataURL('image/png');
  }

  // Update the pin number inside stored Fabric JSON without needing an active canvas
  static async rebuildPinNumber(jsonStr, newNumber) {
    if (!jsonStr) return null;
    try {
      const state = JSON.parse(jsonStr);
      const pin = state.objects?.find(o => o.data?.type === 'click-pin' && o.data?.autoGenerated);
      if (!pin) return null;
      pin.src  = AnnotationCanvas._renderBadge(newNumber);
      pin.data = { ...pin.data, stepNumber: newNumber };
      return JSON.stringify(state);
    } catch (_) { return null; }
  }

  // ─── Delete selected ─────────────────────────────────────────────────────────

  deleteSelected() {
    const obj = this._canvas.getActiveObject();
    if (!obj) return;
    if (obj.type === 'activeSelection') {
      obj.getObjects().forEach(o => this._canvas.remove(o));
    } else {
      this._canvas.remove(obj);
    }
    this._canvas.discardActiveObject().renderAll();
    this._saveSnapshot();
  }

  // ─── Undo / Redo ─────────────────────────────────────────────────────────────

  _saveSnapshot() {
    if (this._suppressSnapshot) return;
    const json = JSON.stringify(this._canvas.toJSON(['data']));
    if (this._undoStack.length && this._undoStack[this._undoStack.length - 1] === json) return;
    this._undoStack.push(json);
    if (this._undoStack.length > this._maxUndo) this._undoStack.shift();
    this._redoStack = [];
  }

  undo() {
    if (this._undoStack.length < 2) return;
    this._redoStack.push(this._undoStack.pop());
    this._applyJSON(this._undoStack[this._undoStack.length - 1]);
  }

  redo() {
    if (!this._redoStack.length) return;
    const next = this._redoStack.pop();
    this._undoStack.push(next);
    this._applyJSON(next);
  }

  _applyJSON(json) {
    const bg = this._canvas.backgroundImage;
    this._suppressSnapshot = true;
    this._canvas.loadFromJSON(json, () => {
      this._suppressSnapshot = false;
      if (bg) this._canvas.backgroundImage = bg;
      this._canvas.renderAll();
    });
  }

  // ─── Serialize ───────────────────────────────────────────────────────────────

  getState() {
    const json = this._canvas.toJSON(['data']);
    json.canvasWidth  = this._canvas.width;
    json.canvasHeight = this._canvas.height;
    return JSON.stringify(json);
  }

  async loadState(jsonStr) {
    if (!jsonStr) return;
    return new Promise((resolve) => {
      const bg = this._canvas.backgroundImage;
      this._suppressSnapshot = true;
      this._canvas.loadFromJSON(jsonStr, () => {
        this._suppressSnapshot = false;
        if (bg) this._canvas.backgroundImage = bg;
        this._canvas.renderAll();
        resolve();
      });
    });
  }

  // ─── Export with real pixel blur ─────────────────────────────────────────────

  async toAnnotatedDataURL(quality = 0.9) {
    const c = this._canvas;
    const canvasW = c.width, canvasH = c.height;

    // Export at the background image's NATURAL resolution, not the
    // display-sized canvas. On high-DPR screens the fabric canvas is half
    // (or smaller) the pixel dimensions of the original screenshot, so
    // exporting at canvas size would produce a visibly downscaled image
    // in the lightbox after the user adds annotations.
    const bg = c.backgroundImage;
    const naturalW = (bg && bg._element?.naturalWidth)  || canvasW;
    const naturalH = (bg && bg._element?.naturalHeight) || canvasH;
    const scale = naturalW / canvasW;
    const W = naturalW, H = naturalH;

    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');

    // 1. Draw background at natural resolution
    if (bg && bg._element) {
      ctx.drawImage(bg._element, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
    }

    // 2. Real pixel blur on each blur rect (coordinates scaled to natural)
    const blurObjs = c.getObjects().filter(o => o.data?.type === 'blur');
    for (const obj of blurObjs) {
      const b   = obj.getBoundingRect(true);
      const PAD = 24;
      const bx  = Math.max(0, Math.floor(b.left   * scale));
      const by  = Math.max(0, Math.floor(b.top    * scale));
      const bw  = Math.min(W - bx, Math.ceil(b.width  * scale));
      const bh  = Math.min(H - by, Math.ceil(b.height * scale));
      if (bw < 2 || bh < 2) continue;

      const srcX = Math.max(0, bx - PAD), srcY = Math.max(0, by - PAD);
      const srcW = Math.min(W - srcX, bw + PAD * 2);
      const srcH = Math.min(H - srcY, bh + PAD * 2);

      const tmp = document.createElement('canvas');
      tmp.width = srcW; tmp.height = srcH;
      tmp.getContext('2d').drawImage(out, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

      const blr = document.createElement('canvas');
      blr.width = srcW; blr.height = srcH;
      const bCtx = blr.getContext('2d');
      bCtx.filter = 'blur(12px)';
      bCtx.drawImage(tmp, 0, 0);

      const blr2 = document.createElement('canvas');
      blr2.width = srcW; blr2.height = srcH;
      const b2   = blr2.getContext('2d');
      b2.filter  = 'blur(8px)';
      b2.drawImage(blr, 0, 0);

      ctx.save();
      ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
      ctx.drawImage(blr2, srcX, srcY, srcW, srcH);
      ctx.restore();
    }

    // 3. Render annotation layer upscaled to natural resolution. Hide blur
    // rects, auto-generated click-pins, and background before export.
    // Auto-generated click-pins are excluded because the viewer renders its
    // own animated CSS circle on top of the screenshot — baking the pin into
    // the image would create a visual mismatch (static badge vs animated ring).
    const autoPins = c.getObjects().filter(o => o.data?.type === 'click-pin' && o.data?.autoGenerated);
    blurObjs.forEach(o => o.set('visible', false));
    autoPins.forEach(o => o.set('visible', false));
    const savedBg = c.backgroundImage;
    c.backgroundImage = null;
    c.renderAll();
    const annotUrl = c.toDataURL({ format: 'png', multiplier: scale });
    c.backgroundImage = savedBg;
    blurObjs.forEach(o => o.set('visible', true));
    autoPins.forEach(o => o.set('visible', true));
    c.renderAll();

    await _loadAndDraw(ctx, annotUrl, 0, 0, W, H);
    return out.toDataURL('image/jpeg', quality);
  }

  destroy() {
    this._canvas.dispose();
  }
}

function _loadAndDraw(ctx, url, x, y, w, h) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => { ctx.drawImage(img, x, y, w, h); resolve(); };
    img.onerror = reject;
    img.src = url;
  });
}
