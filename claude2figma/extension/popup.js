// Claude2Figma — popup
// Deliberately account-free: no login, no server, no quota, no paywall.
// Capture → local .deck.json download → import in the Figma plugin.

'use strict';

const CLAUDE_DESIGN_URL = 'https://claude.ai/design';
const HISTORY_KEY = 'deckHistory';
const HISTORY_LIMIT = 20;
const COPY_WARN_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------- helpers
const $ = (sel) => document.querySelector(sel);
const screenEl = (id) => document.querySelector(`[data-screen="${id}"]`);
const escapeHtml = (v) => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function slugify(title) {
  const slug = (title || 'deck').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'deck';
}

function relativeTime(ts) {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

// ---------------------------------------------------------------- router
let activeScreen = 'booting';
function go(id) {
  activeScreen = id;
  for (const el of document.querySelectorAll('[data-screen]')) {
    el.classList.toggle('is-active', el.dataset.screen === id);
  }
  for (const [tabId, screen] of [['tab-home', 'home'], ['tab-decks', 'decks'], ['tab-how-to', 'how-to']]) {
    const tab = document.getElementById(tabId);
    if (tab) tab.classList.toggle('is-active', screen === id
      || (screen === 'home' && ['capturing', 'success', 'error', 'booting'].includes(id)));
  }
}

// ---------------------------------------------------------------- storage
async function loadHistory() {
  try {
    const data = await chrome.storage.local.get(HISTORY_KEY);
    return Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  } catch (_) { return []; }
}

async function saveToHistory(entry) {
  const history = (await loadHistory()).filter((item) => item && item.id !== entry.id);
  history.unshift(entry);
  const trimmed = history.slice(0, HISTORY_LIMIT);
  try {
    await chrome.storage.local.set({ [HISTORY_KEY]: trimmed });
    return true;
  } catch (_) {
    // Storage full: keep metadata for older entries, drop their JSON.
    const slim = trimmed.map((e, i) => (i === 0 ? e : { ...e, json: null }));
    try {
      await chrome.storage.local.set({ [HISTORY_KEY]: slim });
      return true;
    } catch (__) { return false; }
  }
}

function makeCaptureId() {
  return `capture-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function finishCapture(entry, result) {
  entry.historySaved = result && result.historySaved === true;
  if (!entry.historySaved) entry.historySaved = await saveToHistory(entry);
  state.lastCapture = entry;
  state.captureInProgress = false;
  state.activeCaptureId = '';
  renderSuccess(); renderDecks();
  go('success');
}

async function deleteFromHistory(id) {
  const history = (await loadHistory()).filter((e) => e.id !== id);
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
  return history;
}

// ---------------------------------------------------------------- state
const state = {
  probe: null,        // { ok, title, formato, slides, rotulos, artboards }
  captureScope: 'full', // 'full' | 'selected' | 'single' | 'page'
  activeCaptureId: '',
  captureInProgress: false,
  selectedArtboards: [],
  singleArtboard: 0,
  lastCapture: null,  // history entry { id, title, capturedAt, slideCount, bytes, json }
  error: '',
  toast: '',
};

function isPageFallbackProbe() {
  return !!(state.probe && state.probe.formato === 'pagina-unica');
}

function probeArtboards() {
  const probe = state.probe;
  if (!probe || !probe.ok || isPageFallbackProbe()) return [];
  if (Array.isArray(probe.artboards) && probe.artboards.length) {
    return probe.artboards.map((a, i) => ({
      index: Number.isInteger(a.index) ? a.index : i,
      name: String(a.name || `Artboard ${i + 1}`),
      w: Math.max(0, Math.round(Number(a.w) || 0)),
      h: Math.max(0, Math.round(Number(a.h) || 0)),
    }));
  }
  const labels = Array.isArray(probe.rotulos) ? probe.rotulos : [];
  const count = Math.max(labels.length, Number(probe.slides) || 0);
  return Array.from({ length: count }, (_, i) => ({
    index: i, name: String(labels[i] || `Artboard ${i + 1}`), w: 0, h: 0,
  }));
}

function captureButtonLabel() {
  const artboards = probeArtboards();
  if (!artboards.length || state.captureScope === 'page') return 'Capture whole page as one frame';
  if (artboards.length === 1) return 'Capture single artboard';
  if (state.captureScope === 'single') {
    const chosen = artboards.find((a) => a.index === state.singleArtboard) || artboards[0];
    return chosen ? `Capture only “${chosen.name}”` : 'Capture single artboard';
  }
  if (state.captureScope === 'selected') {
    const count = state.selectedArtboards.length;
    if (count === 0) return 'Select artboards to capture';
    return `Capture ${count} selected artboard${count === 1 ? '' : 's'}`;
  }
  return `Capture full canvas (${artboards.length})`;
}

function renderScopePicker(artboards) {
  if (!artboards.length) {
    return `
      <div class="card scope-card">
        <div class="row row--between">
          <strong>Capture mode</strong>
          <span class="badge badge--neutral">Whole page</span>
        </div>
        <p class="screen__meta"><strong>No separate artboards were detected in the design frame.</strong>
        Capture will make one frame from the whole page, including surrounding page UI.
        If this is a Claude canvas, wait for all screens to render, zoom so they are visible, then reopen Claude2Figma.</p>
      </div>`;
  }
  if (artboards.length === 1) {
    const a = artboards[0];
    if (!a) return '';
    if (state.probe && state.probe.formato === 'slides') {
      return `
      <div class="card scope-card">
        <div class="row row--between">
          <strong>Capture mode</strong>
          <span class="badge badge--neutral">Single artboard</span>
        </div>
        <p class="screen__meta">Only the inside of “${escapeHtml(a.name)}”${a.w ? ` (${a.w} × ${a.h})` : ''} will be captured.</p>
      </div>`;
    }
    const wholePage = state.captureScope === 'page';
    return `
      <div class="card scope-card">
        <div class="row row--between">
          <strong>Capture mode</strong>
          <span class="badge badge--neutral">${wholePage ? 'Whole page' : 'Single artboard'}</span>
        </div>
        <div class="scope-options" role="radiogroup" aria-label="Capture scope">
          <label class="scope-option">
            <input type="radio" name="capture-scope" value="single" ${wholePage ? '' : 'checked'} />
            <span><strong>Single artboard</strong><small>Only “${escapeHtml(a.name)}”${a.w ? ` (${a.w} × ${a.h})` : ''}</small></span>
          </label>
          <label class="scope-option">
            <input type="radio" name="capture-scope" value="page" ${wholePage ? 'checked' : ''} />
            <span><strong>Whole page</strong><small>Ignore the detected artboard and capture the design frame as one frame</small></span>
          </label>
        </div>
        <p class="screen__meta">${wholePage
          ? 'Use this if the detected “artboard” is actually a panel or part of a larger screen.'
          : 'Only the inside of the detected artboard will be captured.'}</p>
      </div>`;
  }

  const selected = new Set(state.selectedArtboards);
  const isSingle = state.captureScope === 'single';
  const badge = state.captureScope === 'full'
    ? 'Full canvas'
    : state.captureScope === 'page'
      ? 'Whole page'
      : (isSingle ? 'Single artboard' : `${selected.size} selected`);
  const pickerItems = artboards.map((a) => {
    const input = isSingle
      ? `<input type="radio" name="single-artboard" value="${a.index}" ${state.singleArtboard === a.index ? 'checked' : ''} />`
      : `<input type="checkbox" data-artboard-index="${a.index}" ${selected.has(a.index) ? 'checked' : ''} />`;
    return `
      <label class="artboard-choice">
        ${input}
        <span><strong>${a.index + 1}. ${escapeHtml(a.name)}</strong><small>${a.w && a.h ? `${a.w} × ${a.h}` : 'Artboard'}</small></span>
      </label>`;
  }).join('');
  const pickerText = isSingle
    ? 'Only this one artboard is captured. Its outer canvas label and surrounding Claude canvas are skipped.'
    : 'Only ticked artboards are captured. Canvas background, labels and controls outside them are skipped.';

  return `
    <div class="card scope-card">
      <div class="row row--between">
        <strong>What do you want to capture?</strong>
        <span class="badge badge--neutral" id="scope-count">${badge}</span>
      </div>
      <div class="scope-options" role="radiogroup" aria-label="Capture scope">
        <label class="scope-option">
          <input type="radio" name="capture-scope" value="full" ${state.captureScope === 'full' ? 'checked' : ''} />
          <span><strong>Full canvas</strong><small>Capture all ${artboards.length} artboards</small></span>
        </label>
        <label class="scope-option">
          <input type="radio" name="capture-scope" value="selected" ${state.captureScope === 'selected' ? 'checked' : ''} />
          <span><strong>Selected artboards</strong><small>Tick the artboards you want below</small></span>
        </label>
        <label class="scope-option">
          <input type="radio" name="capture-scope" value="single" ${isSingle ? 'checked' : ''} />
          <span><strong>Single artboard</strong><small>Capture exactly one artboard</small></span>
        </label>
        ${state.probe && state.probe.formato === 'slides' ? '' : `
        <label class="scope-option">
          <input type="radio" name="capture-scope" value="page" ${state.captureScope === 'page' ? 'checked' : ''} />
          <span><strong>Whole page</strong><small>Ignore detected artboards; capture the design frame as one frame</small></span>
        </label>`}
      </div>
      <div class="artboard-picker" id="artboard-picker" ${state.captureScope === 'full' || state.captureScope === 'page' ? 'hidden' : ''}>
        ${pickerItems}
        <p class="screen__meta">${pickerText}</p>
      </div>
    </div>`;
}

// ------------------------------------------------------------- rendering
function btn(label, id, variant = 'primary', extra = '') {
  return `<button type="button" class="btn btn--${variant} btn--full" id="${id}" ${extra}>${escapeHtml(label)}</button>`;
}

function renderBooting() {
  screenEl('booting').innerHTML = `
    <div class="skeleton">
      <div class="skeleton__line"></div><div class="skeleton__line"></div>
      <div class="skeleton__line"></div><div class="skeleton__line"></div>
    </div>`;
}

function renderHome() {
  const p = state.probe;
  let body = '';
  if (p && p.ok) {
    const artboards = probeArtboards();
    const slides = artboards.length || (p.slides > 1 ? p.slides : 1);
    const kind = p.formato === 'artboards' ? 'artboards (canvas screens)'
      : p.formato === 'slides' ? (slides === 1 ? 'slide' : 'slides') : 'page';
    const captureDisabled = artboards.length > 1
      && state.captureScope === 'selected' && state.selectedArtboards.length === 0;
    const detectionBadge = artboards.length
      ? '<span class="badge badge--success">Artboards detected</span>'
      : '<span class="badge badge--neutral">Page fallback</span>';
    const detectionText = artboards.length && state.captureScope === 'page'
      ? 'Whole-page override selected: the detected artboard split will be ignored and the design frame will be captured as one frame. Use this if a detected “artboard” is only a panel or card.'
      : artboards.length
        ? `${slides} ${kind} ready on this tab. Claude2Figma captures the design inside each artboard—not the outer Claude canvas.`
        : 'No separate artboards were detected. Claude2Figma can capture this page as one frame, but it cannot split it into screens yet.';
    body = `
      <h2 class="screen__title">Capture artboards</h2>
      <div class="card">
        <div class="row row--between">
          <strong>${escapeHtml(p.title || 'Untitled deck')}</strong>
          ${detectionBadge}
        </div>
        <p class="screen__meta">${detectionText}</p>
      </div>
      ${renderScopePicker(artboards)}
      ${btn(captureButtonLabel(), 'home-capture', 'primary', captureDisabled ? 'disabled' : '')}`;
  } else {
    const unsupported = p && p.reason === 'unsupported-page';
    const figmaOnly = p && p.reason === 'figma-plugin-only';
    const probeError = p && !figmaOnly && (p.error || p.reason === 'probe-timeout');
    const emptyTitle = figmaOnly
      ? 'Copy this inside Figma'
      : unsupported
        ? 'This page can’t be captured'
        : probeError ? 'Couldn’t inspect this tab' : 'No deck on this tab';
    const emptyBody = figmaOnly
      ? 'This Chrome extension does not connect to Figma. Run Claude2Figma inside this Figma file, choose “Copy Figma canvas”, select the frames, and download or copy the .deck.json. It can then be imported in Figma desktop or under any other Figma login.'
      : unsupported
        ? 'Chrome does not allow extensions to read browser/settings pages. Open a normal web page or your Claude Design file, then reopen Claude2Figma.'
        : probeError
          ? `${escapeHtml(p.error || 'Inspection timed out.')} Reload the tab, wait for the design to finish rendering, then try again.`
          : 'Open a design in Claude Design (or any web page you want to turn into Figma layers), then click capture.';
    body = `
      <h2 class="screen__title">Capture artboards</h2>
      <div class="empty">
        <div class="empty__icon">🖼️</div>
        <p class="empty__title">${emptyTitle}</p>
        <p class="empty__body">${emptyBody}</p>
        <div class="empty__action">${figmaOnly
          ? btn('How to copy this Figma canvas', 'home-figma-howto', 'ghost')
          : btn('Open Claude Design', 'home-open-claude', 'ghost')}</div>
      </div>
      ${unsupported || figmaOnly ? '' : probeError
        ? `${btn('Try inspecting again', 'home-retry-probe')}${btn('Capture this page anyway', 'home-capture', 'ghost')}`
        : btn('Capture this page anyway', 'home-capture')}
      <p class="screen__meta">${figmaOnly
        ? 'No Claude2Figma account, connection, or matching Figma login is required. The .deck.json file is the transfer.'
        : 'Claude2Figma is optimized for Claude Design decks, but it can serialize almost any normal page into editable layers.'}</p>`;
  }
  screenEl('home').innerHTML = body;
}

function renderCapturing(done = 0, total = 0) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 8;
  const label = total > 1 ? `Slide ${Math.max(done, 1)} of ${total}…` : 'Reading layers, text and images…';
  screenEl('capturing').innerHTML = `
    <div class="capturing stack">
      <span class="spinner"></span>
      <h2 class="screen__title">Capturing</h2>
      <p class="screen__meta" id="capturing-label">${escapeHtml(label)}</p>
      <div class="progress"><div class="progress__fill" id="capturing-fill" style="width:${pct}%"></div></div>
      <p class="screen__meta">Decks with many images can take a few seconds. If this popup closes, the finished capture will still be saved under Decks.</p>
    </div>`;
}

function captureWarnings(report) {
  if (!report) return '';
  const warnings = [];
  if (report.iframesBlocked > 0 || report.sealedHosts > 0) {
    const sealed = (report.iframesBlocked || 0) + (report.sealedHosts || 0);
    warnings.push(`${sealed} screen(s) are sealed by the browser (closed frame/shadow) and will import blank. `
      + 'In Claude, open each artboard full-screen with its expand icon ⤢, capture it there, and import those files instead.');
  }
  if (report.imagesFailed > 0) {
    warnings.push(`${report.imagesFailed} image(s) could not be downloaded and will be grey placeholders.`);
  }
  const failedRasterSurfaces = (report.canvasesFailed || 0) + (report.videosFailed || 0);
  if (failedRasterSurfaces > 0) {
    warnings.push(`${failedRasterSurfaces} canvas/video surface(s) could not be read (for example, a cross-origin video without a poster) and will be grey placeholders.`);
  }
  if ((report.nodes || 0) > 0 && report.nodes < 40 && (report.artboardsDetected || 0) >= 2) {
    warnings.push('Very few layers were read for a multi-screen canvas — the screens may not have rendered yet. '
      + 'Scroll/zoom the Claude canvas so every screen is visible once, then capture again.');
  }
  if (!warnings.length) return '';
  return warnings.map((w) => `<div class="toast" style="border-color:var(--warning);color:#f0d9a8">⚠️ ${escapeHtml(w)}</div>`).join('');
}

function renderSuccess() {
  const c = state.lastCapture;
  if (!c) { renderHome(); go('home'); return; }
  const r = c.report;
  const statsLine = r
    ? `<p class="screen__meta">${(r.nodes || 0).toLocaleString()} clean layers`
      + `${r.layersRemoved ? ` · ${r.layersRemoved.toLocaleString()} unnecessary wrappers removed` : ''}`
      + `${r.inferredAutoLayouts ? ` · ${r.inferredAutoLayouts.toLocaleString()} Auto Layout groups recovered` : ''}`
      + `${r.scope === 'single' ? ' · single artboard only'
        : r.scope === 'selected' ? ' · selected artboards only'
        : r.scope === 'page' ? ' · whole-page override' : ''}</p>`
    : '';
  screenEl('success').innerHTML = `
    <div class="success__check">✓</div>
    <h2 class="screen__title">Deck captured</h2>
    <div class="card">
      <div class="row row--between">
        <strong>${escapeHtml(c.title || 'Untitled deck')}</strong>
        <span class="badge badge--neutral">${c.slideCount} ${c.slideCount === 1 ? 'slide' : 'slides'}</span>
      </div>
      <p class="screen__meta">${formatBytes(c.bytes)} ·
      <code>${escapeHtml(slugify(c.title))}.deck.json</code></p>
      ${statsLine}
    </div>
    ${captureWarnings(r)}
    ${c.historySaved === false ? '<div class="toast" style="border-color:var(--warning);color:#f0d9a8">⚠️ This capture could not be kept in Decks history. Download the .deck.json now before closing Claude2Figma.</div>' : ''}
    <p class="screen__subtitle"><strong>Next:</strong> download the file, then in Figma
    run the <em>Claude2Figma</em> plugin and drop it in.</p>
    ${state.toast ? `<div class="toast toast--success">${escapeHtml(state.toast)}</div>` : ''}
    ${btn('Download .deck.json', 'success-download')}
    ${btn('Copy JSON (paste into plugin)', 'success-copy', 'ghost')}
    ${btn('Capture another', 'success-another', 'ghost')}`;
}

async function renderDecks() {
  const history = await loadHistory();
  if (!history.length) {
    screenEl('decks').innerHTML = `
      <h2 class="screen__title">Captured decks</h2>
      <div class="empty">
        <div class="empty__icon">📄</div>
        <p class="empty__title">No decks yet</p>
        <p class="empty__body">Open a deck in Claude Design and capture it from the Home tab.
        Captures are stored only in this browser.</p>
      </div>`;
    return;
  }
  screenEl('decks').innerHTML = `
    <h2 class="screen__title">Captured decks</h2>
    <div class="stack">
      ${history.map((e) => `
        <div class="card">
          <div class="row row--between">
            <strong>${escapeHtml(e.title || 'Untitled deck')}</strong>
            <span class="badge badge--neutral">${e.slideCount} ${e.slideCount === 1 ? 'slide' : 'slides'}</span>
          </div>
          <p class="screen__meta">${relativeTime(e.capturedAt)} · ${formatBytes(e.bytes)}</p>
          <div class="row" style="margin-top:8px">
            <button type="button" class="btn btn--primary btn--small" data-action="download" data-id="${e.id}" ${e.json ? '' : 'disabled'}>Download .deck.json</button>
            <button type="button" class="btn btn--danger btn--small" data-action="delete" data-id="${e.id}">Delete</button>
          </div>
          ${e.json ? '' : '<p class="screen__meta">File too large to keep in history — re-capture to download again.</p>'}
        </div>`).join('')}
    </div>
    <p class="screen__meta">Stored locally in your browser only. Nothing is uploaded anywhere.</p>`;
}

function renderError() {
  screenEl('error').innerHTML = `
    <h2 class="screen__title">Something went wrong</h2>
    <div class="toast toast--danger">${escapeHtml(state.error || 'Unknown error.')}</div>
    ${btn('Try again', 'error-retry')}
    ${btn('Back to Home', 'error-home', 'ghost')}`;
}

function renderHowTo() {
  screenEl('how-to').innerHTML = `
    <h2 class="screen__title">How to use</h2>
    <div class="card">
      <strong>1 · In Chrome</strong>
      <ol class="screen__meta">
        <li>Open your deck in Claude Design.</li>
        <li>Click the Claude2Figma icon and choose <em>Full canvas</em>,
        <em>Selected artboards</em>, <em>Single artboard</em>, or <em>Whole page</em>
        if a detected artboard is really just part of a larger screen.</li>
        <li>Capture, then click <em>Download .deck.json</em>.</li>
      </ol>
    </div>
    <div class="card">
      <strong>Copy a Figma canvas (inside the plugin)</strong>
      <ol class="screen__meta">
        <li>Open the source file in Figma—browser or desktop—and run <em>Plugins → Claude2Figma</em>.</li>
        <li>Choose <em>Copy Figma canvas</em>, then <em>Current selection</em>, <em>Selected frames</em>, <em>Full current page</em>, or <em>All pages</em>.</li>
        <li>Click <em>Copy canvas</em>, then download or copy the <code>.deck.json</code>.</li>
        <li>Open Claude2Figma in the destination file and import/resize that file.</li>
      </ol>
      <p class="screen__meta">No Chrome-extension connection or matching Figma login is needed. If Figma does not list this local development plugin under another account, import the same plugin manifest once there.</p>
    </div>
    <div class="card">
      <strong>2 · In Figma</strong>
      <ol class="screen__meta">
        <li>Plugins → Claude2Figma — Claude Design Importer.</li>
        <li>Drop the <code>.deck.json</code> file (or paste the JSON).</li>
        <li>Check the artboards to import and type an exact size for any of them.</li>
        <li>Click <em>Import deck</em> — each checked screen arrives as a clean,
        editable frame at the size you chose.</li>
      </ol>
    </div>
    ${btn('Open Claude Design', 'howto-open-claude', 'ghost')}`;
}

function renderAll() {
  renderBooting(); renderHome(); renderCapturing();
  renderSuccess(); renderError(); renderHowTo();
  renderDecks();
}

// ------------------------------------------------------------- downloads
function downloadEntry(entry) {
  if (!entry || !entry.json) return;
  const blob = new Blob([entry.json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const filename = `${slugify(entry.title)}.deck.json`;
  if (chrome.downloads && chrome.downloads.download) {
    chrome.downloads.download({ url, filename, saveAs: false }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  } else {
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function copyEntry(entry) {
  if (!entry || !entry.json) return;
  if (entry.bytes > COPY_WARN_BYTES) {
    state.toast = `This deck is ${formatBytes(entry.bytes)} — too big for a reliable clipboard copy. Use the downloaded file instead.`;
    renderSuccess(); return;
  }
  try {
    await navigator.clipboard.writeText(entry.json);
    state.toast = 'Copied. In the Figma plugin, paste into the “Paste JSON” box.';
  } catch (_) {
    state.toast = 'Clipboard copy failed — use the downloaded file instead.';
  }
  renderSuccess();
}

// ---------------------------------------------------------------- actions
function sendMessage(msg, timeoutMs = 0) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish({
        ok: false,
        reason: 'probe-timeout',
        error: `Claude2Figma could not inspect this tab within ${Math.round(timeoutMs / 1000)} seconds.`,
      }), timeoutMs);
    }
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
        else finish(response || { ok: false });
      });
    } catch (e) {
      finish({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

async function refreshProbe() {
  state.probe = await sendMessage({ type: 'probe' }, 25000);
  state.captureScope = 'full';
  const detected = probeArtboards();
  state.selectedArtboards = detected.map((a) => a.index);
  state.singleArtboard = detected.length ? detected[0].index : 0;
  renderHome();
}

async function refreshAndGoHome() {
  go('booting');
  await refreshProbe();
  go('home');
}


async function startCapture() {
  if (state.captureInProgress) return;
  const artboards = probeArtboards();
  let options = { scope: 'full' };
  if (artboards.length && state.captureScope === 'page'
    && !(state.probe && state.probe.formato === 'slides')) {
    options = { scope: 'page' };
  } else if (artboards.length === 1) {
    options = { scope: 'single', selectedIndexes: [artboards[0].index] };
  } else if (artboards.length > 1 && state.captureScope === 'single') {
    options = { scope: 'single', selectedIndexes: [state.singleArtboard] };
  } else if (artboards.length > 1 && state.captureScope === 'selected') {
    options = {
      scope: 'selected',
      selectedIndexes: [...state.selectedArtboards].sort((a, b) => a - b),
    };
  }
  if (['selected', 'single'].includes(options.scope) && options.selectedIndexes.length === 0) {
    state.error = 'Select at least one artboard to capture.';
    renderError(); go('error');
    return;
  }

  const captureId = makeCaptureId();
  let entryTitle = '';
  if (['selected', 'single'].includes(options.scope) && options.selectedIndexes.length === 1) {
    const selected = artboards.find((a) => a.index === options.selectedIndexes[0]);
    if (selected) entryTitle = selected.name;
  }
  options = { ...options, captureId, entryTitle };
  state.captureInProgress = true;
  state.activeCaptureId = captureId;
  state.toast = '';
  renderCapturing(0, options.scope === 'page' ? 0
    : options.scope !== 'full' ? options.selectedIndexes.length : artboards.length);
  go('capturing');
  const result = await sendMessage({ type: 'capture', options });

  if (!result || !result.ok) {
    state.captureInProgress = false;
    state.activeCaptureId = '';
    state.error = (result && result.error) || 'Capture failed.';
    if (result && result.kind === 'slides-mode') {
      state.error += ' Tip: ask Claude to “put all slides on a single page”, then capture again.';
    }
    renderError(); go('error');
    return;
  }

  let slideCount = 1, title = result.title || 'Untitled deck', report = null;
  try {
    const parsed = JSON.parse(result.json);
    slideCount = parsed.slideCount || 1;
    title = parsed.title || title;
    report = parsed.captureReport || null;
    if (options.scope !== 'full' && options.selectedIndexes.length === 1) {
      const selected = artboards.find((a) => a.index === options.selectedIndexes[0]);
      if (selected && selected.name) title = selected.name;
    }
  } catch (_) { /* keep defaults */ }

  const entry = {
    id: result.entryId || result.captureId || captureId,
    title, capturedAt: Date.now(), slideCount, report,
    bytes: new Blob([result.json]).size,
    json: result.json,
  };
  // No auto-download: Chrome's download bubble popping up on every capture
  // was unwanted. The success screen has the download button.
  await finishCapture(entry, result);
}

// Live progress from the injected serializer.
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'capture-progress' && activeScreen === 'capturing') {
    const messageId = message.captureId || (message.payload && message.payload.captureId) || '';
    if (state.activeCaptureId && messageId && messageId !== state.activeCaptureId) return;
    const { done, total } = message.payload || {};
    renderCapturing(done || 0, total || 0);
  }
});

// Capture-scope controls are rendered dynamically inside Home.
document.addEventListener('change', (event) => {
  const input = event.target;
  if (!input) return;
  if (input.name === 'capture-scope') {
    state.captureScope = ['selected', 'single', 'page'].includes(input.value) ? input.value : 'full';
    renderHome();
    return;
  }
  if (input.name === 'single-artboard') {
    state.singleArtboard = Number(input.value);
    const button = document.getElementById('home-capture');
    if (button) {
      button.textContent = captureButtonLabel();
      button.disabled = false;
    }
    const count = document.getElementById('scope-count');
    if (count) count.textContent = 'Single artboard';
    return;
  }
  if (input.matches && input.matches('[data-artboard-index]')) {
    const index = Number(input.dataset.artboardIndex);
    const selected = new Set(state.selectedArtboards);
    if (input.checked) selected.add(index); else selected.delete(index);
    state.selectedArtboards = [...selected].sort((a, b) => a - b);
    const button = document.getElementById('home-capture');
    if (button) {
      button.textContent = captureButtonLabel();
      button.disabled = state.selectedArtboards.length === 0;
    }
    const count = document.getElementById('scope-count');
    if (count) count.textContent = `${state.selectedArtboards.length} selected`;
  }
});

// ---------------------------------------------------------------- wiring
document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;

  if (target.dataset.action === 'download') {
    const history = await loadHistory();
    downloadEntry(history.find((e) => e.id === target.dataset.id));
    return;
  }
  if (target.dataset.action === 'delete') {
    await deleteFromHistory(target.dataset.id);
    renderDecks();
    return;
  }

  switch (target.id) {
    case 'tab-home': await refreshAndGoHome(); break;
    case 'tab-decks': renderDecks(); go('decks'); break;
    case 'tab-how-to': renderHowTo(); go('how-to'); break;
    case 'home-capture': startCapture(); break;
    case 'home-figma-howto': renderHowTo(); go('how-to'); break;
    case 'home-retry-probe': await refreshAndGoHome(); break;
    case 'home-open-claude':
    case 'howto-open-claude':
      chrome.tabs.create({ url: CLAUDE_DESIGN_URL }); break;
    case 'success-download': downloadEntry(state.lastCapture); break;
    case 'success-copy': copyEntry(state.lastCapture); break;
    case 'success-another': await refreshAndGoHome(); break;
    case 'error-retry': startCapture(); break;
    case 'error-home': await refreshAndGoHome(); break;
    default: break;
  }
});

// ------------------------------------------------------------------- boot
(async function boot() {
  renderAll();
  go('booting');
  await refreshProbe();
  go('home');
})();
