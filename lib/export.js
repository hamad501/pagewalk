/**
 * export.js — PDF, HTML, and Markdown exporters for Pagewalk
 * Requires jsPDF to be loaded as a global (window.jspdf) for PDF export.
 */

// ─── Branding helpers ────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

/** Derive a full PDF color palette from a brand hex color. */
function buildPdfColors(hex) {
  const [r,g,b] = hexToRgb(hex);
  return {
    primary:      [r, g, b],
    primaryDark:  [r,g,b].map(v => Math.round(v * 0.52)),
    primaryLight: [r,g,b].map(v => Math.round(v + (255 - v) * 0.94)),
    text:         [26, 20, 51],
    textMuted:    [107, 101, 133],
    border:       [236, 231, 243],
    bg:           [255, 255, 255],
    bgAlt:        [250, 248, 252],
    click:        [225, 29, 72],
    white:        [255, 255, 255],
    textOnDark:   [r,g,b].map(v => Math.round(v + (255 - v) * 0.6)),
  };
}

/** Darken a hex color by multiplying RGB by factor (0–1). */
function hexDarken(hex, f) {
  return '#' + hexToRgb(hex).map(v => Math.round(v * f).toString(16).padStart(2, '0')).join('');
}

/** Lighten a hex color by mixing with white at factor (0–1 = full white). */
function hexLighten(hex, f) {
  return '#' + hexToRgb(hex).map(v => Math.round(v + (255 - v) * f).toString(16).padStart(2, '0')).join('');
}

// ─── PDF Export ───────────────────────────────────────────────────────────────
//
// Designed to match the in-extension viewer and feel like Tango's PDFs:
// deep-purple cover with an accent gradient bar, optional big hero cover
// image (isInitialCapture step) or a thumbnail grid, then one step per
// page with a number badge + description + type tag pill + optional notes
// + screenshot with a red click ring drawn as a vector primitive (never
// baked into the bitmap). Special handling for heading/callout/text
// step types.

// Palette — RGB tuples, jsPDF expects 0-255.
const PDF_COLORS = {
  primary:      [93, 46, 140],    // #5D2E8C
  primaryDark:  [48, 31, 64],     // #301f40
  primaryLight: [243, 237, 250],  // #f3edfa
  text:         [26, 20, 51],     // #1a1433
  textMuted:    [107, 101, 133],  // #6b6585
  border:       [236, 231, 243],  // #ece7f3
  bg:           [255, 255, 255],
  bgAlt:        [250, 248, 252],  // #faf8fc
  click:        [225, 29, 72],    // #e11d48
  white:        [255, 255, 255],
  textOnDark:   [222, 214, 236],
};

// Accent gradient stops from shared.css
const PDF_ACCENT_STOPS = [
  [70, 171, 248],   // #46abf8
  [153, 149, 253],  // #9995fd
  [214, 121, 231],  // #d679e7
  [249, 107, 161],  // #f96ba1
  [255, 115, 74],   // #ff734a
  [255, 160, 86],   // #ffa056
];

const DEFAULT_BRANDING = {
  brandColor: '#5D2E8C',
  brandName: 'Pagewalk',
  logoMark: 'PW',
  tagline: 'Private guide recorder',
};

// Set at the start of each export — safe because the browser is single-threaded.
let _C = PDF_COLORS;       // current PDF color palette
let _B = DEFAULT_BRANDING; // current branding strings

// Callout variant definitions shared across exports
const CALLOUT_ICONS_HTML = {
  info:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><line x1="10" y1="9" x2="10" y2="14"/><circle cx="10" cy="6.5" r=".5" fill="currentColor"/></svg>',
  success:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><polyline points="7,10 9.5,12.5 13.5,7.5"/></svg>',
  warning:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L1.5 17h17z"/><line x1="10" y1="8" x2="10" y2="12"/><circle cx="10" cy="14.5" r=".5" fill="currentColor"/></svg>',
  danger:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><line x1="7" y1="7" x2="13" y2="13"/><line x1="13" y1="7" x2="7" y2="13"/></svg>',
  important: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="10,2 12.5,7.5 18,8 14,12 15,17.5 10,15 5,17.5 6,12 2,8 7.5,7.5"/></svg>',
};
const CALLOUT_VARIANT_COLORS = {
  info:      { border: '#3b82f6', bg: '#eff6ff', badge: [59, 130, 246],  tagBg: '#dbeafe', tagFg: '#1d4ed8' },
  success:   { border: '#22c55e', bg: '#f0fdf4', badge: [34, 197, 94],   tagBg: '#dcfce7', tagFg: '#15803d' },
  warning:   { border: '#f59e0b', bg: '#fffbeb', badge: [245, 158, 11],  tagBg: '#fef3c7', tagFg: '#b45309' },
  danger:    { border: '#ef4444', bg: '#fef2f2', badge: [239, 68, 68],   tagBg: '#fee2e2', tagFg: '#dc2626' },
  important: { border: '#8b5cf6', bg: '#faf5ff', badge: [139, 92, 246],  tagBg: '#ede9fe', tagFg: '#6d28d9' },
};

const PDF_TYPE_LABELS = {
  click: 'CLICK',
  keystroke: 'TYPE',
  navigate: 'GO',
  text: 'NOTE',
  callout: 'CALLOUT',
  heading: 'HEADING',
};
const PDF_TYPE_TAG_COLORS = {
  click:     { bg: [255, 241, 243], fg: [193, 19, 55] },
  keystroke: { bg: [238, 245, 255], fg: [33, 102, 196] },
  navigate:  { bg: [243, 237, 250], fg: [93, 46, 140] },
  text:      { bg: [250, 248, 252], fg: [107, 101, 133] },
  callout:   { bg: [254, 243, 199], fg: [180, 83, 9] },
  heading:   { bg: [219, 234, 254], fg: [29, 78, 216] },
};

export async function exportPDF(guide, steps, branding = {}) {
  _B = { ...DEFAULT_BRANDING, ...branding };
  _C = buildPdfColors(_B.brandColor);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const dims = {
    PAGE_W: 210,
    PAGE_H: 297,
    MARGIN: 15,
    CONT_W: 180,
    // Canvas text rendering: 1800px canvas spread over 180mm → 1px = 0.1mm.
    TEXT_PX_WIDTH: 1800,
    PX_TO_MM: 180 / 1800,
  };

  // Split cover step (isInitialCapture) from action steps — find by flag,
  // not position, so user-reordered guides render correctly.
  const coverStep   = steps.find(s => s.isInitialCapture) || null;
  const actionSteps = steps.filter(s => !s.isInitialCapture);

  await renderCoverPage(doc, guide, actionSteps, coverStep, dims);

  for (let i = 0; i < actionSteps.length; i++) {
    doc.addPage();
    await renderStepPage(doc, actionSteps[i], i + 1, actionSteps.length, guide, dims);
  }

  doc.save(sanitizeFilename(guide.title) + '.pdf');
}

// ─── Cover page ──────────────────────────────────────────────────────────────

async function renderCoverPage(doc, guide, actionSteps, coverStep, dims) {
  const { PAGE_W, PAGE_H, MARGIN, CONT_W, TEXT_PX_WIDTH, PX_TO_MM } = dims;

  // Full deep-purple background
  setFill(doc, _C.primaryDark);
  doc.rect(0, 0, PAGE_W, PAGE_H, 'F');

  // Accent gradient bar at top (approximated as 6 side-by-side stripes)
  const stripeW = PAGE_W / PDF_ACCENT_STOPS.length;
  PDF_ACCENT_STOPS.forEach((c, i) => {
    setFill(doc, c);
    doc.rect(i * stripeW, 0, stripeW + 0.5, 4, 'F');
  });

  // Logo row: image or text badge + brand text
  const logoSize = 14; // height in mm
  const logoY = 22;
  let logoEndX = MARGIN + logoSize; // x where brand text starts
  if (_B.logoImage) {
    const dims = await getImageNaturalSize(_B.logoImage);
    const aspect = dims ? dims.width / dims.height : 1;
    const logoW = Math.min(logoSize * aspect, 50); // cap at 50mm
    doc.addImage(_B.logoImage, 'JPEG', MARGIN, logoY, logoW, logoSize);
    logoEndX = MARGIN + logoW;
  } else {
    setFill(doc, _C.primary);
    doc.roundedRect(MARGIN, logoY, logoSize, logoSize, 3, 3, 'F');
    doc.setFont('helvetica', 'bold');
    const _markFontSize = _B.logoMark.length <= 2 ? 9 : _B.logoMark.length === 3 ? 7.5 : 6.5;
    doc.setFontSize(_markFontSize);
    setText(doc, _C.white);
    doc.text(_B.logoMark, MARGIN + logoSize / 2, logoY + logoSize / 2 + 1.2, { align: 'center' });
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  setText(doc, _C.white);
  doc.text(_B.brandName, logoEndX + 5, logoY + logoSize / 2 + 0.4);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  setText(doc, _C.textOnDark);
  doc.text(_B.tagline, logoEndX + 5, logoY + logoSize / 2 + 5);

  // Big title — canvas-rendered to support Unicode/RTL
  const titleY = logoY + logoSize + 22;
  const titleImg = await textToImage(guide.title, {
    width: TEXT_PX_WIDTH,
    fontSize: 62,
    bold: true,
    color: '#ffffff',
  });
  const titleH = titleImg.heightPx * PX_TO_MM;
  doc.addImage(titleImg.dataUrl, 'PNG', MARGIN, titleY, CONT_W, titleH);

  // Optional description below title
  let descEndY = titleY + titleH + 2;
  if (guide.description) {
    const descImg = await textToImage(guide.description, {
      width: TEXT_PX_WIDTH,
      fontSize: 24,
      color: 'rgba(222, 214, 236, 0.7)',
    });
    const descY = titleY + titleH + 6;
    doc.addImage(descImg.dataUrl, 'PNG', MARGIN, descY, CONT_W, descImg.heightPx * PX_TO_MM);
    descEndY = descY + descImg.heightPx * PX_TO_MM + 4;
  }

  // Meta row — step count · export date
  const dateStr = new Date().toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  });
  const stepCount = actionSteps.length;
  const metaText = `${stepCount} step${stepCount === 1 ? '' : 's'}  ·  Exported ${dateStr}`;
  const metaImg = await textToImage(metaText, {
    width: TEXT_PX_WIDTH,
    fontSize: 20,
    color: 'rgba(222, 214, 236, 0.85)',
  });
  const metaY = descEndY;
  doc.addImage(metaImg.dataUrl, 'PNG', MARGIN, metaY, CONT_W, metaImg.heightPx * PX_TO_MM);

  // Content: either a big hero cover screenshot or a thumbnail grid
  const contentY   = metaY + (metaImg.heightPx * PX_TO_MM) + 18;
  const availableH = PAGE_H - contentY - 22;

  if (coverStep && (coverStep.screenshotRaw || coverStep.screenshotAnnotated)) {
    await renderCoverHeroImage(doc, coverStep, contentY, availableH, dims);
  } else {
    await renderCoverThumbnailGrid(doc, actionSteps, contentY, availableH, dims);
  }

  // Bottom footer text
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  setText(doc, _C.textOnDark);
  doc.text(`${_B.tagline}  ·  100% private`, PAGE_W / 2, PAGE_H - 12, { align: 'center' });
}

async function renderCoverHeroImage(doc, coverStep, contentY, availableH, dims) {
  const { MARGIN, CONT_W } = dims;
  const src = coverStep.screenshotAnnotated || coverStep.screenshotRaw;
  const sizes = await getImageNaturalSize(src);

  // Preserve aspect ratio, cap height so footer stays clear
  let imgH;
  if (sizes && sizes.width && sizes.height) {
    imgH = Math.min(availableH * 0.92, CONT_W * (sizes.height / sizes.width));
  } else {
    imgH = Math.min(availableH * 0.92, CONT_W * (9 / 16));
  }

  // White card frame behind the image
  setFill(doc, _C.white);
  doc.roundedRect(MARGIN - 1.5, contentY - 1.5, CONT_W + 3, imgH + 3, 3, 3, 'F');
  try { doc.addImage(src, 'JPEG', MARGIN, contentY, CONT_W, imgH); } catch (_) {}

  // STARTING HERE pill overlay
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  const labelW  = doc.getTextWidth('STARTING HERE');
  const pillPad = 3;
  const pillW   = labelW + pillPad * 2;
  const pillH   = 5.2;
  const pillX   = MARGIN + 8;
  const pillY   = contentY + 7;
  setFill(doc, _C.white);
  doc.roundedRect(pillX, pillY, pillW, pillH, pillH / 2, pillH / 2, 'F');
  setText(doc, _C.primary);
  doc.text('STARTING HERE', pillX + pillW / 2, pillY + pillH / 2 + 1, { align: 'center' });
}

async function renderCoverThumbnailGrid(doc, actionSteps, contentY, availableH, dims) {
  const { MARGIN, CONT_W } = dims;
  const cols = 2;
  const rows = 3;
  const gap  = 5;
  const baseThumbW = (CONT_W - gap * (cols - 1)) / cols;
  const baseThumbH = baseThumbW * (9 / 16);
  const gridH = baseThumbH * rows + gap * (rows - 1);
  // If the grid would overflow the available space, shrink it uniformly.
  const scale = gridH > availableH ? availableH / gridH : 1;
  const drawW = baseThumbW * scale;
  const drawH = baseThumbH * scale;
  const maxThumbs = Math.min(actionSteps.length, cols * rows);

  for (let i = 0; i < maxThumbs; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = MARGIN + col * (drawW + gap);
    const y = contentY + row * (drawH + gap);
    const src = actionSteps[i].screenshotAnnotated || actionSteps[i].screenshotRaw;

    // White card frame
    setFill(doc, _C.white);
    doc.roundedRect(x - 0.8, y - 0.8, drawW + 1.6, drawH + 1.6, 1.8, 1.8, 'F');
    if (src) {
      try { doc.addImage(src, 'JPEG', x, y, drawW, drawH); } catch (_) {}
    }

    // Step number mini-badge
    const pillD = 6;
    setFill(doc, _C.primary);
    doc.circle(x + 4, y + 4, pillD / 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6);
    setText(doc, _C.white);
    doc.text(String(i + 1), x + 4, y + 4 + 1.1, { align: 'center' });
  }
}

// ─── Step page ───────────────────────────────────────────────────────────────

async function renderStepPage(doc, step, stepNum, totalSteps, guide, dims) {
  const { PAGE_W, PAGE_H, MARGIN, CONT_W, TEXT_PX_WIDTH, PX_TO_MM } = dims;
  const type = step.type || 'click';

  // ── Header strip ───────────────────────────────────────────────────────
  const headerH = 14;
  setFill(doc, _C.bgAlt);
  doc.rect(0, 0, PAGE_W, headerH, 'F');
  setDraw(doc, _C.border);
  doc.setLineWidth(0.2);
  doc.line(0, headerH, PAGE_W, headerH);

  // Mini PW logo
  const miniLogoSize = 6; // height in mm
  const miniLogoY = (headerH - miniLogoSize) / 2;
  let miniLogoEndX = MARGIN + miniLogoSize;
  if (_B.logoImage) {
    const dims = await getImageNaturalSize(_B.logoImage);
    const aspect = dims ? dims.width / dims.height : 1;
    const miniLogoW = Math.min(miniLogoSize * aspect, 24); // cap at 24mm
    doc.addImage(_B.logoImage, 'JPEG', MARGIN, miniLogoY, miniLogoW, miniLogoSize);
    miniLogoEndX = MARGIN + miniLogoW;
  } else {
    setFill(doc, _C.primary);
    doc.roundedRect(MARGIN, miniLogoY, miniLogoSize, miniLogoSize, 1.2, 1.2, 'F');
    doc.setFont('helvetica', 'bold');
    const _miniMarkFontSize = _B.logoMark.length <= 2 ? 5.5 : _B.logoMark.length === 3 ? 4.8 : 4.2;
    doc.setFontSize(_miniMarkFontSize);
    setText(doc, _C.white);
    doc.text(_B.logoMark, MARGIN + miniLogoSize / 2, miniLogoY + miniLogoSize / 2 + 0.9, { align: 'center' });
  }

  // Brand text
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  setText(doc, _C.text);
  doc.text(_B.brandName, miniLogoEndX + 2.5, headerH / 2 + 0.9);

  // ASCII-safe guide title next to brand (jsPDF core fonts don't
  // support full Unicode with direct text calls — canvas fallback is
  // used for step descriptions)
  const safeTitle = stripNonLatin(guide.title);
  if (safeTitle) {
    const afterBrandX = miniLogoEndX + 2.5 + doc.getTextWidth(_B.brandName) + 2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    setText(doc, _C.textMuted);
    const truncated = safeTitle.length > 48 ? safeTitle.slice(0, 48) + '…' : safeTitle;
    doc.text('·  ' + truncated, afterBrandX, headerH / 2 + 0.9);
  }

  // Step counter pill (top-right)
  const counterLabel = `STEP ${stepNum} / ${totalSteps}`;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  const counterW = doc.getTextWidth(counterLabel) + 6;
  const counterH = 6;
  const counterX = PAGE_W - MARGIN - counterW;
  const counterY = (headerH - counterH) / 2;
  setFill(doc, _C.primaryLight);
  doc.roundedRect(counterX, counterY, counterW, counterH, counterH / 2, counterH / 2, 'F');
  setText(doc, _C.primary);
  doc.text(counterLabel, counterX + counterW / 2, counterY + counterH / 2 + 1.2, { align: 'center' });

  let y = headerH + 14;

  // ── Heading steps ── centered big title + horizontal rule ─────────────
  if (type === 'heading') {
    const hImg = await textToImage(step.description || `Section ${stepNum}`, {
      width: TEXT_PX_WIDTH,
      fontSize: 52,
      bold: true,
      color: '#1a1433',
    });
    const hH = hImg.heightPx * PX_TO_MM;
    doc.addImage(hImg.dataUrl, 'PNG', MARGIN, y, CONT_W, hH);
    y += hH + 6;
    setDraw(doc, _C.border);
    doc.setLineWidth(0.6);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    drawPageFooter(doc, stepNum, totalSteps, dims);
    return;
  }

  // ── Number badge + type tag + description ─────────────────────────────
  const badgeSize = 12;
  const badgeX = MARGIN;
  const badgeY = y;
  const cVariant = step.calloutType || 'warning';
  const cColors = CALLOUT_VARIANT_COLORS[cVariant] || CALLOUT_VARIANT_COLORS.warning;
  const badgeColor = type === 'callout' ? cColors.badge : _C.primary;
  setFill(doc, badgeColor);
  doc.circle(badgeX + badgeSize / 2, badgeY + badgeSize / 2, badgeSize / 2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  setText(doc, _C.white);
  doc.text(String(stepNum), badgeX + badgeSize / 2, badgeY + badgeSize / 2 + 1.7, { align: 'center' });

  // Type tag pill (to the right of the badge, above the description)
  const tagLabel = PDF_TYPE_LABELS[type] || 'STEP';
  let tagColors = PDF_TYPE_TAG_COLORS[type] || PDF_TYPE_TAG_COLORS.click;
  if (type === 'callout') {
    // Use variant-specific tag colors
    const hexToRgb = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
    tagColors = { bg: hexToRgb(cColors.tagBg), fg: hexToRgb(cColors.tagFg) };
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  const tagLabelW = doc.getTextWidth(tagLabel);
  const tagPadX = 3;
  const tagW = tagLabelW + tagPadX * 2;
  const tagH = 5;
  const tagX = badgeX + badgeSize + 5;
  const tagY = badgeY + 1;
  setFill(doc, tagColors.bg);
  doc.roundedRect(tagX, tagY, tagW, tagH, tagH / 2, tagH / 2, 'F');
  setText(doc, tagColors.fg);
  doc.text(tagLabel, tagX + tagW / 2, tagY + tagH / 2 + 1, { align: 'center' });

  // Description — canvas-rendered, wrapped to the width beside the badge
  const descX = badgeX + badgeSize + 5;
  const descY = badgeY + tagH + 3;
  const descW = CONT_W - (badgeSize + 5);
  const descPxWidth = Math.round(descW / PX_TO_MM);
  const descImg = await textToImage(step.description || `Step ${stepNum}`, {
    width: descPxWidth,
    fontSize: 26,
    bold: true,
    color: '#1a1433',
  });
  const descH = descImg.heightPx * PX_TO_MM;
  doc.addImage(descImg.dataUrl, 'PNG', descX, descY, descW, descH);

  y = Math.max(badgeY + badgeSize, descY + descH) + 4;

  // Notes (optional secondary paragraph)
  if (step.notes && step.notes.trim()) {
    const notesImg = await textToImage(step.notes, {
      width: descPxWidth,
      fontSize: 17,
      color: '#6b6585',
    });
    const notesH = notesImg.heightPx * PX_TO_MM;
    doc.addImage(notesImg.dataUrl, 'PNG', descX, y, descW, notesH);
    y += notesH + 3;
  }

  y += 2;

  // ── Callout tint background behind the above content ──────────────────
  // Drawn LAST, at a lower z-index, would require redrawing — instead we
  // accept that the text sits on white. To simulate a callout we draw
  // a thin amber accent bar along the left margin.
  if (type === 'callout') {
    setFill(doc, cColors.badge);
    doc.rect(MARGIN - 4, badgeY - 3, 2, (y - badgeY) + 3, 'F');
  }

  // ── Screenshot ─────────────────────────────────────────────────────────
  const src = step.screenshotAnnotated || step.screenshotRaw;
  if (src) {
    const maxImgH = PAGE_H - y - MARGIN - 14; // leave room for URL + footer
    const imgW = CONT_W;
    const sizes = await getImageNaturalSize(src);
    let imgH;
    if (sizes && sizes.width && sizes.height) {
      imgH = Math.min(maxImgH, imgW * (sizes.height / sizes.width));
    } else {
      imgH = Math.min(maxImgH, imgW * (9 / 16));
    }

    if (imgH > 10) {
      // Rounded white frame with light border
      setFill(doc, _C.white);
      setDraw(doc, _C.border);
      doc.setLineWidth(0.3);
      doc.roundedRect(MARGIN, y, imgW, imgH, 2, 2, 'FD');
      try { doc.addImage(src, 'JPEG', MARGIN, y, imgW, imgH); } catch (_) {}

      // Draw red click ring ON TOP of the image as vector primitives —
      // matches the viewer's CSS ring style. Only for click/keystroke
      // steps that have coordinates and haven't been manually annotated.
      const isClickType = (type === 'click' || type === 'keystroke');
      const hasCoords   = (step.clickX > 0 || step.clickY > 0);
      if (isClickType && hasCoords && !step.screenshotAnnotated && sizes) {
        const dpr = step.devicePixelRatio || 1;
        const scale = imgW / sizes.width;
        const cx = MARGIN + (step.clickX * dpr) * scale;
        const cy = y + (step.clickY * dpr) * scale;
        drawClickRing(doc, cx, cy);
      }

      y += imgH + 4;
    }
  }

  // ── Page URL ───────────────────────────────────────────────────────────
  if (step.pageUrl) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    setText(doc, _C.textMuted);
    const urlText = step.pageUrl.length > 110
      ? step.pageUrl.slice(0, 110) + '…'
      : step.pageUrl;
    doc.text(urlText, MARGIN, y + 1);
    y += 5;
  }

  drawPageFooter(doc, stepNum, totalSteps, dims);
}

// ─── PDF primitives ──────────────────────────────────────────────────────────

function setFill(doc, rgb) { doc.setFillColor(rgb[0], rgb[1], rgb[2]); }
function setDraw(doc, rgb) { doc.setDrawColor(rgb[0], rgb[1], rgb[2]); }
function setText(doc, rgb) { doc.setTextColor(rgb[0], rgb[1], rgb[2]); }

// Draws a red ring + white halo matching the viewer's .vw-click-circle.
function drawClickRing(doc, cx, cy) {
  const r = 5.5; // mm radius
  // Outer faint red glow
  setDraw(doc, _C.click);
  doc.setLineWidth(1.8);
  doc.circle(cx, cy, r + 1.2, 'S');
  // White halo outside the main ring
  setDraw(doc, _C.white);
  doc.setLineWidth(1.2);
  doc.circle(cx, cy, r + 0.5, 'S');
  // Main red ring
  setDraw(doc, _C.click);
  doc.setLineWidth(1);
  doc.circle(cx, cy, r, 'S');
  // White highlight ring (inside)
  setDraw(doc, _C.white);
  doc.setLineWidth(0.5);
  doc.circle(cx, cy, r - 0.6, 'S');
}

// Subtle page footer: "N / Total" centered, "Made with Pagewalk" right
function drawPageFooter(doc, stepNum, totalSteps, dims) {
  const { PAGE_W, PAGE_H, MARGIN } = dims;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  setText(doc, _C.textMuted);
  doc.text(`${stepNum} / ${totalSteps}`, PAGE_W / 2, PAGE_H - 8, { align: 'center' });
  doc.text(`Made with ${_B.brandName}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
}

// ─── Render any text (including Arabic) to a PNG data URL ────────────────────

async function textToImage(text, {
  width    = 1800,
  fontSize = 28,
  color    = '#1e293b',
  bold     = false,
} = {}) {
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const fontStr = `${bold ? 'bold ' : ''}${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Arabic", "Segoe UI Historic", Arial, sans-serif`;
  const PADDING = 10;
  const LINE_H  = Math.round(fontSize * 1.55);
  const maxW    = width - PADDING * 2;

  // Measure with the right font
  ctx.font = fontStr;

  // Detect RTL (Arabic, Hebrew, etc.)
  const isRTL = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0590-\u05FF]/.test(text);

  // Word-wrap
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length === 0) lines.push('');

  canvas.width  = width;
  canvas.height = lines.length * LINE_H + PADDING * 2;

  // Re-apply after resize (resize clears canvas state)
  ctx.font      = fontStr;
  ctx.fillStyle = color;
  if (isRTL) {
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';
  } else {
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
  }

  lines.forEach((line, i) => {
    const x = isRTL ? canvas.width - PADDING : PADDING;
    const y = PADDING + (i + 1) * LINE_H - LINE_H * 0.2;
    ctx.fillText(line, x, y);
  });

  return { dataUrl: canvas.toDataURL('image/png'), heightPx: canvas.height };
}

// Strip characters outside the Latin + common ASCII range (for jsPDF direct text calls)
function stripNonLatin(str) {
  return str.replace(/[^\x20-\x7E]/g, '').trim();
}

// ─── HTML Export ─────────────────────────────────────────────────────────────
//
// Produces a self-contained HTML file that mirrors the in-extension viewer:
// sticky left sidebar with numbered step nav, scrollable main column with
// hero (plus optional cover for captureOnStart), numbered step cards with
// red click circles overlaid via CSS, and a Pagewalk footer. No edit
// controls — read-only. All CSS inlined, images as data URLs, a small
// vanilla JS blob handles scroll-spy, smooth-scroll and a lightbox.

export async function exportHTML(guide, steps, branding = {}) {
  const b = { ...DEFAULT_BRANDING, ...branding };
  const colorPrimary      = b.brandColor;
  const colorPrimaryHover = hexDarken(b.brandColor, 0.8);
  const colorPrimaryLight = hexLighten(b.brandColor, 0.94);
  const colorPrimaryDark  = hexDarken(b.brandColor, 0.52);
  const [pr, pg, pb] = hexToRgb(b.brandColor);
  const shadowPrimary = `rgba(${pr},${pg},${pb},0.18)`;
  const glowPrimary   = `rgba(${pr},${pg},${pb},0.4)`;

  const hasRTL = steps.some(s => /[\u0600-\u06FF]/.test(s.description || ''));

  // Split cover (isInitialCapture) from action steps — matches viewer logic.
  // Find cover by flag, NOT by position, because the user might have
  // reordered or deleted it.
  const coverStep   = steps.find(s => s.isInitialCapture) || null;
  const actionSteps = steps.filter(s => !s.isInitialCapture);

  // Pre-compute natural dimensions for every action-step screenshot so
  // click circles can be positioned with inline percentage styles.
  const stepDims = await Promise.all(
    actionSteps.map(s => {
      const src = s.screenshotAnnotated || s.screenshotRaw;
      return src ? getImageNaturalSize(src) : Promise.resolve(null);
    })
  );

  const TYPE_TAG_LABELS = {
    click: 'Click', keystroke: 'Type', navigate: 'Go',
    text: 'Note', callout: 'Callout', heading: 'Heading',
  };

  const sidebarHtml = actionSteps.map((step, i) => {
    const type = step.type || 'click';
    const iconSvg = type === 'keystroke'
      ? '<svg class="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="16" height="10" rx="2"/><path d="M5 9h.01M8 9h.01M11 9h.01M14 9h.01M5 12h10"/></svg>'
      : type === 'navigate'
      ? '<svg class="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h12M12 6l4 4-4 4"/></svg>'
      : '<svg class="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l5.5 13 2.2-5.3L16 8.5z"/></svg>';
    return `
      <li>
        <button class="nav-item${i === 0 ? ' active' : ''}" data-idx="${i}">
          <div class="nav-num">${i + 1}</div>
          ${iconSvg}
          <span class="nav-text">${escapeHtml(step.description || `Step ${i + 1}`)}</span>
        </button>
      </li>`;
  }).join('');

  const stepsHtml = actionSteps.map((step, i) => {
    const type  = step.type || 'click';
    const dims  = stepDims[i];
    const src   = step.screenshotAnnotated || step.screenshotRaw;
    const isRTL = /[\u0600-\u06FF\u0590-\u05FF]/.test(step.description || '');
    const hasImage = !!src;

    // Click circle percentage coordinates (matches viewer.js logic)
    let circleHtml = '';
    const showCircle = (type === 'click' || type === 'keystroke')
                      && (step.clickX > 0 || step.clickY > 0)
                      && !step.screenshotAnnotated
                      && dims && dims.width && dims.height;
    if (showCircle) {
      const dpr = step.devicePixelRatio || 1;
      const px = step.clickX * dpr;
      const py = step.clickY * dpr;
      const leftPct = (px / dims.width)  * 100;
      const topPct  = (py / dims.height) * 100;
      circleHtml = `<div class="click-circle" style="left:${leftPct.toFixed(2)}%;top:${topPct.toFixed(2)}%"></div>`;
    }

    const imgHtml = hasImage
      ? `<div class="step-image">
           <img src="${escapeHtmlAttr(src)}" alt="Step ${i + 1} screenshot" loading="lazy" onclick="lb(this.src)">
           ${circleHtml}
         </div>`
      : '';

    const notesHtml = step.notes
      ? `<div class="step-notes">${escapeHtml(step.notes)}</div>`
      : '';

    const urlHtml = step.pageUrl
      ? `<div class="step-url">
           <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12l-2 2a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0"/><path d="M12 8l2-2a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0"/></svg>
           <a href="${escapeHtmlAttr(step.pageUrl)}" target="_blank" rel="noopener">${escapeHtml(step.pageUrl)}</a>
         </div>`
      : '';

    const classes = ['step-card', `type-${type}`];
    if (!hasImage) classes.push('text-only');
    if (type === 'navigate') classes.push('nav-step');
    const cVariant = step.calloutType || 'warning';
    if (type === 'callout') classes.push(`callout-${cVariant}`);

    const showCalloutIcon = type === 'callout' && step.calloutShowIcon !== false;
    const numberInner = showCalloutIcon ? CALLOUT_ICONS_HTML[cVariant] || String(i + 1) : String(i + 1);

    return `
      <section class="${classes.join(' ')}" id="step-${i}" data-idx="${i}">
        <div class="step-head">
          <div class="step-number${showCalloutIcon ? ' has-icon' : ''}">${numberInner}</div>
          <div class="step-desc"${isRTL ? ' dir="rtl"' : ''}>${escapeHtml(step.description || `Step ${i + 1}`)}</div>
          <span class="step-type-tag type-${type}">${TYPE_TAG_LABELS[type] || 'Step'}</span>
        </div>
        ${notesHtml}
        ${imgHtml}
        ${urlHtml}
      </section>`;
  }).join('\n');

  // Hero cover (only when a cover step exists)
  let heroCoverHtml = '';
  if (coverStep) {
    const coverSrc = coverStep.screenshotAnnotated || coverStep.screenshotRaw;
    heroCoverHtml = coverSrc
      ? `<div class="hero-cover"><img src="${escapeHtmlAttr(coverSrc)}" alt="Starting page"></div>`
      : `<div class="hero-cover no-image">${escapeHtml(coverStep.description || 'Starting page')}</div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="${hasRTL ? 'ar' : 'en'}"${hasRTL ? ' dir="rtl"' : ''}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(guide.title)}</title>
  <style>
    :root {
      --color-primary: ${colorPrimary};
      --color-primary-hover: ${colorPrimaryHover};
      --color-primary-light: ${colorPrimaryLight};
      --color-primary-dark: ${colorPrimaryDark};
      --color-accent-gradient: linear-gradient(90deg,#46abf8,#9995fd 20%,#d679e7 40%,#f96ba1 60%,#ff734a 80%,#ffa056);
      --color-click: #e11d48;
      --color-click-glow: rgba(225, 29, 72, 0.35);
      --color-text: #1a1433;
      --color-text-muted: #6b6585;
      --color-border: #ece7f3;
      --color-bg: #ffffff;
      --color-bg-alt: #faf8fc;
      --radius-md: 10px;
      --radius-lg: 16px;
      --shadow-sm: 0 1px 2px rgba(26, 20, 51, 0.04), 0 1px 3px rgba(26, 20, 51, 0.06);
      --shadow-md: 0 10px 30px -10px ${shadowPrimary}, 0 4px 10px -4px rgba(26, 20, 51, 0.08);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--color-bg-alt);
      color: var(--color-text);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      scrollbar-gutter: stable;
    }

    /* ── Topbar ──────────────────────────────────────────── */
    .topbar {
      position: sticky; top: 0; z-index: 20;
      display: flex; align-items: center; gap: 12px;
      padding: 0 24px; height: 60px;
      background: rgba(255, 255, 255, 0.92);
      backdrop-filter: saturate(180%) blur(14px);
      -webkit-backdrop-filter: saturate(180%) blur(14px);
      border-bottom: 1px solid var(--color-border);
    }
    .logo-mark {
      height: 32px; border-radius: 9px;
      background: var(--color-primary); color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-weight: 900; font-size: 12px; flex-shrink: 0;
      box-shadow: 0 4px 12px -4px ${glowPrimary};
      flex-shrink: 0;
    }
    .topbar-title {
      flex: 1; min-width: 0;
      font-size: 16px; font-weight: 700; color: var(--color-text);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* ── Layout ─────────────────────────────────────────── */
    .layout {
      display: grid;
      grid-template-columns: 260px 1fr;
      gap: 24px;
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }

    /* ── Sidebar ────────────────────────────────────────── */
    .sidebar {
      position: sticky; top: 84px; align-self: start;
      height: calc(100vh - 108px);
      overflow: hidden;
      display: flex; flex-direction: column;
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
    }
    .sidebar-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px 12px;
      border-bottom: 1px solid var(--color-border);
    }
    .sidebar-title {
      font-size: 11px; font-weight: 800;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--color-text-muted);
    }
    .sidebar-count {
      font-size: 11px; font-weight: 700;
      color: var(--color-primary);
      background: var(--color-primary-light);
      padding: 2px 9px; border-radius: 99px;
    }
    .steps-nav {
      flex: 1; overflow-y: auto;
      list-style: none; padding: 8px; margin: 0;
      display: flex; flex-direction: column; gap: 3px;
    }
    .steps-nav::-webkit-scrollbar { width: 6px; }
    .steps-nav::-webkit-scrollbar-track { background: transparent; }
    .steps-nav::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: 3px; }
    .nav-item {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 9px 12px;
      font-size: 12px; font-family: inherit;
      color: var(--color-text-muted);
      background: transparent; border: none;
      border-radius: 8px; cursor: pointer;
      text-align: left; line-height: 1.45;
      transition: background 0.15s, color 0.15s;
      width: 100%;
    }
    .nav-item:hover { background: var(--color-bg-alt); color: var(--color-text); }
    .nav-item.active {
      background: var(--color-primary-light);
      color: var(--color-primary);
      font-weight: 600;
    }
    .nav-num {
      flex-shrink: 0; width: 20px; height: 20px;
      border-radius: 50%;
      background: var(--color-bg-alt);
      color: var(--color-text-muted);
      font-size: 11px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      border: 1px solid var(--color-border);
    }
    .nav-item.active .nav-num {
      background: var(--color-primary); color: #fff;
      border-color: var(--color-primary);
    }
    .nav-text {
      flex: 1; min-width: 0;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .nav-icon {
      flex-shrink: 0; width: 14px; height: 14px;
      color: var(--color-text-muted);
      margin-top: 3px;
    }
    .nav-item.active .nav-icon { color: var(--color-primary); }

    /* ── Content ────────────────────────────────────────── */
    .content { min-width: 0; }
    .hero {
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      padding: 32px 36px;
      margin-bottom: 20px;
      box-shadow: var(--shadow-sm);
      position: relative;
      overflow: hidden;
    }
    .hero::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 4px;
      background: var(--color-accent-gradient);
    }
    .hero-title {
      font-size: 28px; font-weight: 800;
      color: var(--color-text);
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    .hero-meta {
      font-size: 13px;
      color: var(--color-text-muted);
      margin-top: 10px;
      display: flex; align-items: center; gap: 14px;
      flex-wrap: wrap;
    }
    .hero-meta .dot {
      width: 3px; height: 3px; border-radius: 50%;
      background: var(--color-text-muted); opacity: 0.6;
    }
    .hero-cover {
      margin-top: 22px;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--color-border);
      background: var(--color-bg-alt);
      box-shadow: 0 12px 28px -12px rgba(93, 46, 140, 0.22);
      position: relative;
    }
    .hero-cover img {
      display: block; width: 100%; height: auto;
      max-height: 360px;
      object-fit: cover; object-position: top center;
      cursor: zoom-in;
    }
    .hero-cover.no-image {
      padding: 32px 24px;
      text-align: center;
      color: var(--color-text-muted);
      font-size: 14px;
    }
    .hero-cover::before {
      content: 'STARTING HERE';
      position: absolute;
      top: 14px; left: 14px;
      background: rgba(255, 255, 255, 0.95);
      color: var(--color-primary);
      font-size: 10px; font-weight: 800;
      letter-spacing: 0.08em;
      padding: 4px 10px;
      border-radius: 99px;
      backdrop-filter: blur(6px);
      z-index: 2;
    }

    /* ── Step cards ─────────────────────────────────────── */
    .steps { display: flex; flex-direction: column; gap: 20px; padding-bottom: 40px; }
    .step-card {
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
      transition: box-shadow 0.2s, border-color 0.2s;
      scroll-margin-top: 84px;
    }
    .step-card:hover {
      box-shadow: var(--shadow-md);
      border-color: var(--color-primary-light);
    }
    .step-head {
      display: flex; align-items: center; gap: 14px;
      padding: 18px 22px 14px;
    }
    .step-number {
      width: 32px; height: 32px; border-radius: 50%;
      background: var(--color-primary); color: #fff;
      font-size: 13px; font-weight: 800;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      box-shadow: 0 4px 12px -4px ${glowPrimary};
    }
    .step-desc {
      flex: 1;
      font-size: 17px; font-weight: 600;
      color: var(--color-text);
      line-height: 1.4;
      word-break: break-word;
    }
    .step-desc[dir="rtl"] { text-align: right; }
    .step-type-tag {
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.06em;
      padding: 3px 8px; border-radius: 99px;
      flex-shrink: 0;
    }
    .step-type-tag.type-click     { background: #fff1f3; color: #c11337; }
    .step-type-tag.type-keystroke { background: #eef5ff; color: #2166c4; }
    .step-type-tag.type-navigate  { background: #f3edfa; color: #5D2E8C; }
    .step-type-tag.type-text      { background: var(--color-bg-alt); color: var(--color-text-muted); }
    .step-type-tag.type-callout   { background: #fef3c7; color: #b45309; }
    .step-type-tag.type-heading   { background: #dbeafe; color: #1d4ed8; }
    .step-notes {
      padding: 4px 22px 12px 68px;
      font-size: 14px;
      color: var(--color-text-muted);
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .step-image {
      position: relative;
      margin: 0 22px 18px;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--color-border);
      background: var(--color-bg-alt);
    }
    .step-image img {
      display: block; width: 100%; height: auto;
      cursor: zoom-in;
    }

    /* Pulsing red click circle — positioned via inline % coords */
    .click-circle {
      position: absolute;
      width: 44px; height: 44px;
      border: 3px solid var(--color-click);
      border-radius: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
      box-shadow: 0 0 0 3px #fff, 0 0 18px 4px var(--color-click-glow);
      animation: click-pulse 2.4s ease-in-out infinite;
    }
    @keyframes click-pulse {
      0%, 100% {
        box-shadow: 0 0 0 3px #fff, 0 0 18px 4px var(--color-click-glow);
        transform: translate(-50%, -50%) scale(1);
      }
      50% {
        box-shadow: 0 0 0 3px #fff, 0 0 28px 8px rgba(225, 29, 72, 0.5);
        transform: translate(-50%, -50%) scale(1.08);
      }
    }

    .step-url {
      padding: 0 22px 16px;
      font-size: 12px;
      color: var(--color-text-muted);
      display: flex; align-items: center; gap: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .step-url a { color: var(--color-text-muted); text-decoration: none; word-break: break-all; }
    .step-url a:hover { color: var(--color-primary); text-decoration: underline; }

    /* Special step types */
    .step-card.type-heading {
      background: transparent;
      border: none; box-shadow: none;
      padding: 8px 0 0;
      margin-top: 8px;
    }
    .step-card.type-heading .step-head {
      padding: 8px 0 6px;
      border-bottom: 2px solid var(--color-border);
      gap: 10px;
    }
    .step-card.type-heading .step-number { display: none; }
    .step-card.type-heading .step-desc {
      font-size: 22px; font-weight: 800;
      color: var(--color-text);
      letter-spacing: -0.015em;
    }
    .step-card.type-heading .step-type-tag { display: none; }
    .step-card.type-callout.callout-info      { background: linear-gradient(135deg, #eff6ff, #fff); border-color: #bfdbfe; border-left: 4px solid #3b82f6; }
    .step-card.type-callout.callout-success   { background: linear-gradient(135deg, #f0fdf4, #fff); border-color: #bbf7d0; border-left: 4px solid #22c55e; }
    .step-card.type-callout.callout-warning   { background: linear-gradient(135deg, #fffbeb, #fff); border-color: #fde68a; border-left: 4px solid #f59e0b; }
    .step-card.type-callout.callout-danger    { background: linear-gradient(135deg, #fef2f2, #fff); border-color: #fecaca; border-left: 4px solid #ef4444; }
    .step-card.type-callout.callout-important { background: linear-gradient(135deg, #faf5ff, #fff); border-color: #ddd6fe; border-left: 4px solid #8b5cf6; }
    .step-card.type-callout.callout-info      .step-number { background: #3b82f6; }
    .step-card.type-callout.callout-success   .step-number { background: #22c55e; }
    .step-card.type-callout.callout-warning   .step-number { background: #f59e0b; }
    .step-card.type-callout.callout-danger    .step-number { background: #ef4444; }
    .step-card.type-callout.callout-important .step-number { background: #8b5cf6; }
    .step-card.type-callout .step-number { box-shadow: none; }
    .step-card.type-callout .step-number.has-icon { display: flex; align-items: center; justify-content: center; }
    .step-card.type-callout .step-number.has-icon svg { width: 16px; height: 16px; color: #fff; }
    .step-card.type-callout.callout-info      .step-type-tag { background: #dbeafe; color: #1d4ed8; }
    .step-card.type-callout.callout-success   .step-type-tag { background: #dcfce7; color: #15803d; }
    .step-card.type-callout.callout-warning   .step-type-tag { background: #fef3c7; color: #b45309; }
    .step-card.type-callout.callout-danger    .step-type-tag { background: #fee2e2; color: #dc2626; }
    .step-card.type-callout.callout-important .step-type-tag { background: #ede9fe; color: #6d28d9; }
    .step-card.nav-step {
      background: linear-gradient(135deg, #faf8fc, #ffffff);
    }
    .step-card.text-only .step-head { padding: 22px; }

    /* ── Footer ─────────────────────────────────────────── */
    .footer {
      margin-top: 32px;
      padding: 24px 0;
      border-top: 1px solid var(--color-border);
      display: flex; align-items: center; justify-content: center;
    }
    .footer-brand { display: flex; align-items: center; gap: 12px; }
    .footer-logo {
      height: 34px; border-radius: 9px; flex-shrink: 0;
      background: var(--color-primary); color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-weight: 900; font-size: 12px;
    }
    .footer-name { font-size: 13px; font-weight: 700; color: var(--color-text); }
    .footer-tagline { font-size: 11px; color: var(--color-text-muted); margin-top: 2px; }

    /* ── Lightbox ───────────────────────────────────────── */
    #lb {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(10, 7, 22, 0.92);
      z-index: 9999;
      align-items: center;
      justify-content: center;
      cursor: zoom-out;
      padding: 16px;
    }
    #lb.open { display: flex; }
    #lb img {
      max-width: 100%;
      max-height: 100vh;
      border-radius: 8px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6);
      object-fit: contain;
      pointer-events: none;
    }
    #lb-close {
      position: fixed;
      top: 16px; right: 20px;
      color: #fff;
      font-size: 28px;
      line-height: 1;
      cursor: pointer;
      opacity: 0.7;
      border: none;
      background: none;
      padding: 6px 10px;
      border-radius: 8px;
    }
    #lb-close:hover { opacity: 1; background: rgba(255,255,255,0.08); }

    /* ── Responsive ─────────────────────────────────────── */
    @media (max-width: 880px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
        max-height: 40vh;
      }
      .hero-title { font-size: 22px; }
      .hero { padding: 24px 20px; }
    }
    @media (max-width: 600px) {
      .layout { padding: 16px; gap: 16px; }
      .step-head { padding: 16px 18px 12px; }
      .step-image { margin: 0 18px 16px; }
      .step-notes { padding-left: 58px; padding-right: 18px; }
    }
  </style>
</head>
<body>

  <!-- Topbar -->
  <header class="topbar">
    ${b.logoImage
      ? `<img src="${b.logoImage}" style="height:32px;width:auto;max-width:140px;object-fit:contain;display:block" alt="${escapeHtmlAttr(b.brandName)}">`
      : `<div class="logo-mark" style="min-width:32px;padding:0 6px">${escapeHtml(b.logoMark)}</div>`}
    <h1 class="topbar-title">${escapeHtml(guide.title)}</h1>
  </header>

  <!-- Main layout -->
  <div class="layout">

    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-head">
        <span class="sidebar-title">Steps</span>
        <span class="sidebar-count">${actionSteps.length}</span>
      </div>
      <ol class="steps-nav">
        ${sidebarHtml}
      </ol>
    </aside>

    <!-- Content -->
    <main class="content">
      <div class="hero">
        <h2 class="hero-title">${escapeHtml(guide.title)}</h2>
        ${guide.description ? `<p class="hero-desc" style="font-size:15px;color:#6b6585;line-height:1.5;margin:8px 0 0;">${escapeHtml(guide.description)}</p>` : ''}
        <div class="hero-meta">
          <span>${actionSteps.length} step${actionSteps.length === 1 ? '' : 's'}</span>
          <span class="dot"></span>
          <span>Exported ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
          <span class="dot"></span>
          <span>Made with ${escapeHtml(b.brandName)}</span>
        </div>
        ${heroCoverHtml}
      </div>

      <div class="steps">
        ${stepsHtml || '<div style="padding:72px 24px;text-align:center;color:var(--color-text-muted);">No actionable steps in this guide.</div>'}
      </div>

      <footer class="footer">
        <div class="footer-brand">
          ${b.logoImage
            ? `<img src="${b.logoImage}" style="height:34px;width:auto;max-width:120px;object-fit:contain;display:block" alt="${escapeHtmlAttr(b.brandName)}">`
            : `<div class="footer-logo" style="min-width:34px;padding:0 6px">${escapeHtml(b.logoMark)}</div>`}
          <div>
            <div class="footer-name">Made with ${escapeHtml(b.brandName)}</div>
            <div class="footer-tagline">${escapeHtml(b.tagline)}</div>
          </div>
        </div>
      </footer>
    </main>
  </div>

  <!-- Lightbox -->
  <div id="lb" onclick="closeLb()">
    <button id="lb-close" onclick="closeLb()" title="Close (Esc)">&#x2715;</button>
    <img id="lb-img" src="" alt="Full-size screenshot">
  </div>

  <script>
    // Lightbox — click any screenshot to zoom
    function lb(src) {
      document.getElementById('lb-img').src = src;
      document.getElementById('lb').classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function closeLb() {
      document.getElementById('lb').classList.remove('open');
      document.getElementById('lb-img').src = '';
      document.body.style.overflow = '';
    }
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeLb(); });

    // Hero cover click → lightbox
    (function () {
      var coverImg = document.querySelector('.hero-cover img');
      if (coverImg) coverImg.addEventListener('click', function () { lb(coverImg.src); });
    })();

    // Sidebar → smooth-scroll to the matching card
    document.querySelectorAll('.nav-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = btn.getAttribute('data-idx');
        var target = document.getElementById('step-' + idx);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    // Scroll-spy: highlight the nav item whose card is currently in view
    (function () {
      var navItems = Array.prototype.slice.call(document.querySelectorAll('.nav-item'));
      var cards    = Array.prototype.slice.call(document.querySelectorAll('.step-card'));
      if (!cards.length || !('IntersectionObserver' in window)) return;
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            var idx = entry.target.getAttribute('data-idx');
            navItems.forEach(function (el) { el.classList.remove('active'); });
            var match = navItems.find(function (el) { return el.getAttribute('data-idx') === idx; });
            if (match) {
              match.classList.add('active');
              match.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
          }
        });
      }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });
      cards.forEach(function (c) { observer.observe(c); });
    })();
  </script>

</body>
</html>`;

  downloadText(html, sanitizeFilename(guide.title) + '.html', 'text/html');
}

// Return { width, height } of an image data URL, or null on failure.
function getImageNaturalSize(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload  = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// ─── Markdown Export ─────────────────────────────────────────────────────────

export function exportMarkdown(guide, steps) {
  const lines = [
    `# ${guide.title}`,
    '',
  ];
  if (guide.description) {
    lines.push(guide.description, '');
  }
  lines.push(
    `> ${steps.length} step${steps.length !== 1 ? 's' : ''} · Exported ${new Date().toLocaleDateString()}`,
    '',
    '---',
    '',
  );
  const CALLOUT_MD = { info: 'ℹ️', success: '✅', warning: '⚠️', danger: '🚨', important: '⭐' };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const type = step.type || 'click';
    if (type === 'callout') {
      const variant = step.calloutType || 'warning';
      const emoji = CALLOUT_MD[variant] || '💡';
      lines.push(`> ${emoji} **${step.description || ''}**`);
    } else if (type === 'heading') {
      lines.push(`## ${step.description || ''}`);
    } else {
      lines.push(`## Step ${i + 1}: ${step.description || ''}`);
    }
    lines.push('');
    if (step.notes) {
      lines.push(step.notes);
      lines.push('');
    }
    if (step.pageUrl) {
      lines.push(`**Page:** [${escapeMarkdown(step.pageTitle || step.pageUrl)}](${step.pageUrl})`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }
  downloadText(lines.join('\n'), sanitizeFilename(guide.title) + '.md', 'text/markdown');
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function downloadText(content, filename, mimeType) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '_').slice(0, 80) || 'guide';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeHtmlAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeMarkdown(str) {
  return String(str).replace(/[[\]()]/g, '\\$&');
}
