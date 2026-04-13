# Pagewalk

> **Beta** — Pagewalk is under active development. Expect breaking changes, incomplete features, and rough edges. Feedback and bug reports are welcome.

**A privacy-first, open-source Chrome extension that records step-by-step browser guides with automatic screenshots. A local alternative to Scribe and Tango — no cloud, no account, no telemetry.**

Pagewalk captures every click, keystroke, and page navigation as you work, takes a screenshot at each step, and assembles them into a polished walkthrough you can annotate, export, and share. Everything stays in your browser's local storage. Nothing ever leaves your machine.

## Features

**Recording**
- Automatic screenshot capture on every click and keystroke
- Click + keystroke merging (click a field then type into it = one step, not two)
- Navigation tracking across pages and domains, including new-tab follows
- Manual screenshot capture for anything the auto-recorder misses
- Pause, resume, and discard controls from both the floating widget and the side panel
- Password fields automatically masked before reaching storage

**Viewer & Editor**
- Read mode with animated click indicators showing exactly where each action happened
- Inline edit mode — rewrite descriptions, reorder steps via drag-and-drop, delete steps
- Fabric.js annotation canvas with arrows, rectangles, text, blur regions, and freehand drawing
- Full color picker for annotations
- Movable click-pin badge that updates the click indicator position on save
- Lightbox with keyboard navigation (arrow keys, Home/End) and step captions
- Version history with one-click restore (snapshots taken automatically on each edit session)
- Inline-editable guide title and description

**Guide Me (Live Replay)**
- Highlights the real DOM element for each step as you follow along on the live site
- Works across full page loads and SPA client-side routing (Next.js, SvelteKit, React Router)
- Five-tier element resolution: CSS selector, XPath, attribute match, text match, coordinate fallback

**Export & Share**
- PDF with branded cover page, numbered steps, and click indicators
- Standalone HTML file (works offline, no external dependencies)
- Markdown
- Copy as plain text
- Custom branding: primary color, logo, brand name, tagline

**Privacy & Security**
- Auto-redact sensitive data (emails, phone numbers, credit cards, SSNs) with configurable categories
- Custom regex redaction patterns
- Redaction style: black blocks or blur

**Settings**
- Screenshot delay, JPEG quality, capture-on-start toggle
- Show/hide floating widget (side panel has full feature parity)
- Default guide title template with tokens: `{host}`, `{title}`, `{date}`, `{time}`
- Versions per guide (1-50)
- Full backup export/import (JSON)
- Storage usage monitor
- Delete all data

## Install

No build step, no npm, no setup script.

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the downloaded/cloned folder
5. Click the Pagewalk icon in your toolbar to open the side panel

## Quick Start

1. **Open the side panel** — click the Pagewalk icon in the Chrome toolbar
2. **Click "Start Capture"** — navigate to the page you want to document
3. **Do the thing** — click through your workflow normally. Pagewalk captures a screenshot at each step automatically.
4. **Click "Complete"** — the guide opens in the viewer in edit mode so you can polish descriptions, reorder steps, and add annotations
5. **Export or share** — PDF, HTML, Markdown, or copy as text

## Privacy

Pagewalk is local-only by design:

- **No server.** There is no backend. No API calls. No analytics endpoint.
- **No account.** No sign-up, no login, no user tracking.
- **No telemetry.** Zero network requests to any Pagewalk-owned or third-party service.
- **All data stays in IndexedDB** inside your browser profile. Guides, screenshots, settings, version history — everything.
- **The `<all_urls>` host permission** is required so the extension can inject the recorder into any website you choose to record. It is never used to read pages you aren't actively recording.
- **Audit it yourself.** The entire codebase is vanilla JS with no build step. What you read is exactly what runs.

## Architecture

Manifest V3 Chrome extension. Vanilla JavaScript, ES modules, no framework, no bundler.

```
background/service-worker.js   # Message router, state machine, screenshot capture
sidepanel/                     # Entry UI — toolbar icon opens this
viewer/                        # Guide viewer + inline editor + Fabric.js annotator
dashboard/                     # Guide library (list, search, sort, settings)
content/recorder.js            # Injected during recording — captures clicks/keystrokes
content/player.js              # Injected during Guide Me — live element highlighting
lib/storage.js                 # IndexedDB access (idb@8 wrapper)
lib/annotations.js             # Fabric.js canvas wrapper
lib/export.js                  # PDF, HTML, Markdown exporters
assets/                        # Shared CSS, icons
```

Vendor libraries (committed, no download needed):
- [idb](https://github.com/jakearchibald/idb) v8.0.2 — IndexedDB wrapper
- [Fabric.js](http://fabricjs.com/) v5.3.1 — Canvas annotation
- [jsPDF](https://github.com/parallax/jsPDF) v2.5.1 — PDF generation
- [SortableJS](https://github.com/SortableJS/Sortable) v1.15.0 — Drag-and-drop reorder

## Limitations

- Cannot record on `chrome://`, `chrome-extension://`, `edge://`, or Chrome Web Store pages (browser policy)
- Screenshots capture the visible viewport only — no full-page scroll capture (MV3 constraint)
- Guide Me element resolution is best-effort on heavily dynamic SPAs where the DOM structure changes significantly between sessions
- The floating recording widget uses a closed Shadow DOM — sites with aggressive content security policies may occasionally interfere

## License

MIT
