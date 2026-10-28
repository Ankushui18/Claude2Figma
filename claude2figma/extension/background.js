// Claude2Figma — background service worker
// Local-only: finds the frame that holds the design, injects the serializer,
// and hands the captured JSON back to the popup. No network calls, ever.

const CLAUDE_DESIGN_URL = 'https://claude.ai/design';
const CLAUDE_FRAME_FRAGMENT = 'claudeusercontent.com';
const CAPTURE_TIMEOUT_MS = 180000;

// NOTE: no onInstalled handler. Earlier versions auto-opened claude.ai/design
// in a new tab on install — an unwanted popup tab (which then showed
// Claude's own plan modal). The extension now never opens anything by itself.

// Runs inside the target frame (serialized by chrome.scripting). Keep it
// self-contained: it cannot reference anything from this file.
function probeDeckInPage() {
  const visible = (el) => {
    try {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden'
        && parseFloat(s.opacity || '1') !== 0;
    } catch (_) { return true; }
  };
  const compactText = (el) => String((el && (el.innerText || el.textContent)) || '')
    .replace(/\s+/g, ' ').trim();
  const descriptorOf = (el) => {
    if (!el) return '';
    const cls = typeof el.className === 'string' ? el.className : '';
    return `${el.tagName || ''} ${el.id || ''} ${cls} ${el.getAttribute ? (el.getAttribute('data-testid') || '') : ''}`.toLowerCase();
  };
  const nameFor = (el, fallbackName) => {
    const attrs = ['data-label', 'data-artboard-name', 'data-frame-name',
      'data-screen-name', 'aria-label', 'title'];
    if (el && el.getAttribute) {
      for (const attr of attrs) {
        const value = String(el.getAttribute(attr) || '').trim();
        if (value) return value.slice(0, 80);
      }
    }
    try {
      const prevText = compactText(el.previousElementSibling);
      if (prevText.length >= 3 && prevText.length <= 80) return prevText;
      const hostRect = el.getBoundingClientRect();
      const label = Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,span'))
        .find((node) => {
          if (node.children.length) return false;
          const text = compactText(node);
          if (text.length < 3 || text.length > 80) return false;
          const r = node.getBoundingClientRect();
          return r.y <= hostRect.y + Math.max(56, hostRect.height * 0.16);
        });
      if (label) return compactText(label).slice(0, 80);
    } catch (_) { /* fallback below */ }
    return fallbackName;
  };
  const detailsFor = (el, index, fallbackName) => {
    const r = el.getBoundingClientRect();
    // offsetWidth/Height are layout (design) pixels before the canvas zoom
    // transform is applied, which is the size users recognize.
    const w = (typeof el.offsetWidth === 'number' && el.offsetWidth > 0) ? el.offsetWidth : r.width;
    const h = (typeof el.offsetHeight === 'number' && el.offsetHeight > 0) ? el.offsetHeight : r.height;
    return {
      index,
      name: nameFor(el, fallbackName),
      w: Math.max(0, Math.round(w || 0)),
      h: Math.max(0, Math.round(h || 0)),
      tag: el.tagName || '',
      src: el.tagName === 'IFRAME'
        ? String((el.getAttribute && el.getAttribute('src')) || el.src || '') : '',
    };
  };
  const metrics = () => {
    let elements = 0;
    try { elements = document.getElementsByTagName('*').length; } catch (_) { elements = 0; }
    return {
      elements,
      viewportW: Math.round(window.innerWidth || 0),
      viewportH: Math.round(window.innerHeight || 0),
    };
  };

  const stage = document.querySelector('deck-stage');
  if (stage) {
    const sections = Array.from(stage.children).filter((e) => e.tagName === 'SECTION');
    const artboards = sections.map((s, i) => detailsFor(s, i, `Slide ${i + 1}`));
    return {
      formato: 'slides',
      slides: sections.length,
      rotulos: artboards.map((a) => a.name),
      artboards,
      detection: 'deck-stage',
      metrics: metrics(),
    };
  }

  // Canvas screens can live inside open shadow roots, so probing must use
  // the same deep search as capture; otherwise the popup cannot list them.
  const deepAll = (selector, root = document) => {
    const out = [];
    let visited = 0;
    const walk = (node) => {
      if (!node || visited > 20000 || !node.querySelectorAll) return;
      try {
        out.push(...node.querySelectorAll(selector));
        const all = node.querySelectorAll('*');
        visited += all.length;
        for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
      } catch (_) { /* ignore inaccessible fragments */ }
    };
    walk(root);
    return [...new Set(out)];
  };
  const contains = (a, b) => a.r.x <= b.r.x + 2 && a.r.y <= b.r.y + 2
    && a.r.x + a.r.width >= b.r.x + b.r.width - 2
    && a.r.y + a.r.height >= b.r.y + b.r.height - 2;
  const readingSort = (a, b) => (Math.abs(a.r.y - b.r.y) > 40 ? a.r.y - b.r.y : a.r.x - b.r.x);
  const outermost = (items) => {
    let level = items.filter((c) => items.filter((o) => o !== c && contains(c, o)).length < 2);
    level = level.filter((c) => !level.some((o) => o !== c && contains(o, c)));
    return level.sort(readingSort);
  };
  const designSizeFor = (el, rect) => {
    const r = rect || el.getBoundingClientRect();
    const offsetW = typeof el.offsetWidth === 'number' ? el.offsetWidth : 0;
    const offsetH = typeof el.offsetHeight === 'number' ? el.offsetHeight : 0;
    let scale = 1;
    let node = el;
    while (node && node.nodeType === 1) {
      if (typeof node.offsetWidth === 'number' && node.offsetWidth >= 40) {
        const w = node.getBoundingClientRect().width;
        if (w > 0) { scale = w / node.offsetWidth; break; }
      }
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    const scaleX = offsetW >= 40 && r.width > 0 ? r.width / offsetW : scale;
    const scaleY = offsetH >= 40 && r.height > 0 ? r.height / offsetH : scaleX;
    return {
      w: offsetW > 0 ? offsetW : r.width / (scaleX || 1),
      h: offsetH > 0 ? offsetH : r.height / (scaleY || 1),
    };
  };
  const canvasContext = (() => {
    try {
      const host = String(location.hostname || '').toLowerCase();
      return /(^|\.)claudeusercontent\.com$/.test(host)
        || /(^|\.)claude\.ai$/.test(host)
        || !!document.querySelector('deck-stage, x-dc, [data-dc-artboard], [data-artboard], [data-testid*="artboard" i]');
    } catch (_) { return false; }
  })();
  const thresholds = canvasContext
    ? { minW: 280, minH: 200, minArea: 100000, rootCoverage: 0.12 }
    : { minW: 340, minH: 320, minArea: 260000, rootCoverage: 0.20 };
  const cappedContentStats = (el) => {
    let descendants = 0, textLength = 0;
    try {
      if (el.shadowRoot) descendants = Math.max(descendants, deepAll('*', el).length);
      const walker = document.createTreeWalker(el, 5); // ELEMENT | TEXT
      let steps = 0;
      while (walker.nextNode() && steps < 5000) {
        steps += 1;
        const node = walker.currentNode;
        if (node.nodeType === 1 && descendants < 1000) descendants += 1;
        if (node.nodeType === 3 && textLength < 1000) textLength += String(node.nodeValue || '').trim().length;
        if (descendants >= 24 && textLength >= 100) break;
      }
    } catch (_) {
      try {
        descendants = el.querySelectorAll('*').length;
        textLength = compactText(el).length;
      } catch (__) { /* inaccessible subtree */ }
    }
    return { descendants, textLength };
  };
  const collectExplicit = (selector) => deepAll(selector)
    .map((el) => {
      let r;
      try { r = el.getBoundingClientRect(); } catch (_) { return null; }
      return { el, r, design: designSizeFor(el, r) };
    })
    .filter(Boolean)
    .filter(({ el, r }) => r.width >= 40 && r.height >= 40 && visible(el));

  const strongSelector = '[data-dc-artboard], [data-artboard], '
    + '[data-artboard-id], [data-artboard-name], [data-frame-id], [data-frame-name], '
    + '[data-screen-name], [data-testid*="artboard" i], [data-testid*="canvas-board" i]';
  const strong = outermost(collectExplicit(strongSelector)
    .filter(({ design }) => design.w >= 140 && design.h >= 100
      && design.w * design.h >= 14000));
  let explicit = strong;
  if (!explicit.length) {
    const weak = outermost(collectExplicit('[data-label]')
      .filter(({ design }) => design.w >= thresholds.minW
        && design.h >= thresholds.minH
        && design.w * design.h >= thresholds.minArea));
    if (weak.length >= 2) {
      explicit = weak;
    } else if (weak.length === 1) {
      const only = weak[0];
      const rootW = Math.max(
        Number(window.innerWidth || 0),
        Number((document.body && document.body.scrollWidth) || 0),
        Number((document.documentElement && document.documentElement.scrollWidth) || 0));
      const rootH = Math.max(
        Number(window.innerHeight || 0),
        Number((document.body && document.body.scrollHeight) || 0),
        Number((document.documentElement && document.documentElement.scrollHeight) || 0));
      const coversRoot = (only.design.w * only.design.h) / Math.max(1, rootW * rootH) >= 0.35;
      if (coversRoot || /(artboard|screen|slide|canvas|frame)/.test(descriptorOf(only.el))) {
        explicit = weak;
      }
    }
  }
  if (explicit.length >= 1) {
    const artboards = explicit.map((c, i) => detailsFor(c.el, i, `Artboard ${i + 1}`));
    return {
      formato: 'artboards',
      slides: artboards.length,
      rotulos: artboards.map((a) => a.name),
      artboards,
      detection: 'labelled',
      metrics: metrics(),
    };
  }

  // Newer Claude canvas documents do not always mark screens with
  // data-label. Fall back to repeated, large sibling boards in a grid/flex
  // canvas (the structure visible in the user's Varis Studio screenshot).
  const visualBoards = () => {
    const viewportW = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportH = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const rootDesignW = Math.max(viewportW,
      Number((document.body && document.body.scrollWidth) || 0),
      Number((document.documentElement && document.documentElement.scrollWidth) || 0));
    const rootDesignH = Math.max(viewportH,
      Number((document.body && document.body.scrollHeight) || 0),
      Number((document.documentElement && document.documentElement.scrollHeight) || 0));
    const rootDesignArea = Math.max(1, rootDesignW * rootDesignH);
    const groups = new Map();
    const styleCache = new WeakMap();
    const styleOf = (el) => {
      if (!el) return {};
      if (!styleCache.has(el)) {
        try { styleCache.set(el, getComputedStyle(el)); } catch (_) { styleCache.set(el, {}); }
      }
      return styleCache.get(el);
    };
    const isTransparent = (color) => !color || color === 'transparent'
      || /rgba?\([^)]*,\s*0(?:\.0+)?\s*\)/.test(color) || /\/\s*0(?:\.0+)?\s*\)/.test(color);

    for (const el of deepAll('*')) {
      if (!el || !el.getBoundingClientRect || !el.tagName) continue;
      if (['HTML', 'BODY', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT',
        'HEADER', 'NAV', 'ASIDE', 'FOOTER'].includes(el.tagName)) continue;
      const parent = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
      if (!parent || parent === document.documentElement) continue;
      let r;
      try { r = el.getBoundingClientRect(); } catch (_) { continue; }
      const design = designSizeFor(el, r);
      const minW = el.tagName === 'IFRAME' ? Math.min(thresholds.minW, 300) : thresholds.minW;
      const minH = el.tagName === 'IFRAME' ? Math.min(thresholds.minH, 200) : thresholds.minH;
      const minArea = el.tagName === 'IFRAME' ? Math.min(thresholds.minArea, 120000) : thresholds.minArea;
      if (design.w < minW || design.h < minH || design.w * design.h < minArea) continue;
      if (r.width < 40 || r.height < 40) continue;
      if (r.width > viewportW * 0.995 && r.height > viewportH * 0.99
        && design.w * design.h > rootDesignArea * 0.92) continue;
      if (!visible(el)) continue;
      const style = styleOf(el);
      if (style.position === 'fixed' || style.position === 'sticky') continue;
      const role = el.getAttribute ? (el.getAttribute('role') || '') : '';
      if (['navigation', 'banner', 'contentinfo', 'toolbar'].includes(role)) continue;

      const { descendants, textLength } = cappedContentStats(el);
      if (el.tagName !== 'IFRAME'
        && !(descendants >= 20 || (descendants >= 10 && textLength >= 60) || textLength >= 160)) continue;

      const parentStyle = styleOf(parent);
      const parentDesc = descriptorOf(parent);
      const desc = descriptorOf(el);
      const parentCanvasLike = ['grid', 'inline-grid'].includes(parentStyle.display)
        || ((parentStyle.display === 'flex' || parentStyle.display === 'inline-flex')
          && String(parentStyle.flexWrap || '').startsWith('wrap'))
        || /(canvas|artboards?|boards?|screens?|gallery|grid)/.test(parentDesc);
      const visual = !isTransparent(style.backgroundColor)
        || parseFloat(style.borderTopWidth || '0') > 0
        || parseFloat(style.borderLeftWidth || '0') > 0
        || (style.boxShadow && style.boxShadow !== 'none')
        || (style.overflow && style.overflow !== 'visible');
      const boardLike = visual || el.tagName === 'IFRAME'
        || ['SECTION', 'ARTICLE'].includes(el.tagName)
        || /(artboard|screen|board|canvas|frame)/.test(desc);
      if (!boardLike && !parentCanvasLike) continue;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push({ el, r, design, parentCanvasLike, boardLike });
    }

    let best = null;
    for (const [parent, group] of groups) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => (b.design.w * b.design.h) - (a.design.w * a.design.h));
      const kept = [];
      for (const item of sorted) {
        const overlaps = kept.some((other) => {
          const x = Math.max(0, Math.min(item.r.x + item.r.width, other.r.x + other.r.width)
            - Math.max(item.r.x, other.r.x));
          const y = Math.max(0, Math.min(item.r.y + item.r.height, other.r.y + other.r.height)
            - Math.max(item.r.y, other.r.y));
          return (x * y) / Math.min(item.r.width * item.r.height, other.r.width * other.r.height) > 0.25;
        });
        if (!overlaps) kept.push(item);
      }
      if (kept.length < 2) continue;
      let parentArea = rootDesignArea;
      try {
        const pr = parent.getBoundingClientRect();
        const parentDesign = designSizeFor(parent, pr);
        if (parentDesign.w * parentDesign.h > 0) parentArea = parentDesign.w * parentDesign.h;
      } catch (_) { /* root fallback */ }
      const totalDesignArea = kept.reduce((sum, c) => sum + c.design.w * c.design.h, 0);
      const coverage = totalDesignArea / parentArea;
      if (coverage < 0.22) continue;
      if (totalDesignArea / rootDesignArea < thresholds.rootCoverage) continue;
      const semanticCount = kept.filter((c) => c.boardLike || c.parentCanvasLike).length;
      const score = kept.length * 100 + coverage * 100 + semanticCount * 5;
      if (!best || score > best.score) best = { items: kept.sort(readingSort), score };
    }
    return best ? best.items : [];
  };

  const visual = visualBoards();
  if (visual.length >= 2) {
    const artboards = visual.map((c, i) => detailsFor(c.el, i, `Artboard ${i + 1}`));
    return {
      formato: 'artboards',
      slides: artboards.length,
      rotulos: artboards.map((a) => a.name),
      artboards,
      detection: 'visual',
      metrics: metrics(),
    };
  }

  if (document.body && document.body.children.length > 0) {
    const page = detailsFor(document.body, 0, document.title || 'Page');
    return {
      formato: 'pagina-unica', slides: 1, rotulos: [page.name],
      artboards: [], page, detection: 'page', metrics: metrics(),
    };
  }
  return { formato: 'vazio', slides: 0, rotulos: [], artboards: [], detection: 'none', metrics: metrics() };
}

async function probeFrame(tabId, frame) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frame.frameId] },
      func: probeDeckInPage,
    });
    const deck = injection && injection.result;
    return deck ? {
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      frameUrl: frame.url || '',
      deck,
    } : null;
  } catch (_) {
    return null;
  }
}

function frameProbeScore(candidate, tab) {
  if (!candidate || !candidate.deck) return -10000;
  const { deck, frameId, frameUrl } = candidate;
  const slides = Number(deck.slides) || 0;
  if ((deck.formato === 'slides' || deck.formato === 'artboards') && slides >= 1) {
    const detection = String(deck.detection || '');
    let score = detection === 'deck-stage' ? 12000
      : detection === 'labelled' ? 11000
      : detection === 'visual' ? 7000
      : 6000;
    score += slides * 100;
    if (String(frameUrl || '').toLowerCase().includes(CLAUDE_FRAME_FRAGMENT)) score += 500;
    if (frameId !== 0) score += 250;
    const tabUrl = String((tab && tab.url) || '').toLowerCase();
    // Claude's top frame is its editor shell. It should not beat a real
    // labelled/visual design document in a child frame merely because the
    // shell contains large panels.
    if (frameId === 0 && (tabUrl.includes('claude.ai/design') || tabUrl.includes('claudeusercontent.com'))) {
      score -= 1800;
    }
    return score;
  }
  if (deck.formato !== 'pagina-unica') return -1000;

  const elements = deck.metrics ? Number(deck.metrics.elements) || 0 : 0;
  let score = 100 + Math.min(400, elements / 12);
  const url = String(frameUrl || '').toLowerCase();
  const tabUrl = String((tab && tab.url) || '').toLowerCase();
  const isClaudeDesignTab = tabUrl.includes('claude.ai/design') || tabUrl.includes('claudeusercontent.com');
  if (url.includes(CLAUDE_FRAME_FRAGMENT)) score += 700;
  if (/(artifact|preview|canvas|embed|sandbox|usercontent)/.test(url)) score += 300;
  if (frameId !== 0) score += 250;
  // On Claude Design, frame 0 is normally the editor shell. A substantial
  // child frame is the design document even if no labelled boards were found.
  if (isClaudeDesignTab && frameId !== 0 && elements >= 50) score += 1000;
  return score;
}

async function findBestFrame(tab) {
  const fallback = { frameId: 0, frameUrl: (tab && tab.url) || '', deck: null };
  if (!tab || tab.id == null) return fallback;
  let frames = [fallback];
  try {
    const all = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    if (Array.isArray(all) && all.length) frames = all;
  } catch (_) { /* main-frame fallback */ }

  const unique = [];
  const seen = new Set();
  for (const frame of frames) {
    if (!frame || !Number.isInteger(frame.frameId) || seen.has(frame.frameId)) continue;
    seen.add(frame.frameId);
    unique.push({ frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: frame.url || '' });
  }
  if (!seen.has(0)) unique.unshift(fallback);
  const urlPriority = (frame) => {
    const url = String(frame.url || '').toLowerCase();
    if (url.includes(CLAUDE_FRAME_FRAGMENT)) return 0;
    if (/(artifact|preview|canvas|embed|sandbox)/.test(url)) return 1;
    if (frame.frameId === 0) return 2;
    return 3;
  };
  unique.sort((a, b) => urlPriority(a) - urlPriority(b));
  const candidates = await Promise.all(unique.slice(0, 32).map((frame) => probeFrame(tab.id, frame)));
  const valid = candidates.filter(Boolean);
  if (!valid.length) return fallback;
  valid.sort((a, b) => frameProbeScore(b, tab) - frameProbeScore(a, tab));
  valid[0].candidates = valid;
  return valid[0];
}

function isFigmaEditorUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || '');
    return /(^|\.)figma\.com$/i.test(url.hostname)
      && /^\/(design|file)\//.test(url.pathname);
  } catch (_) {
    return false;
  }
}

const FIGMA_PLUGIN_ONLY_MESSAGE = 'Figma canvas copy is handled inside the Claude2Figma Figma plugin, not by the Chrome extension. '
  + 'In Figma, run Claude2Figma, choose “Copy Figma canvas”, select what to copy, and download or copy the .deck.json. '
  + 'That file can be imported under any Figma browser or desktop login; the Chrome extension does not connect to Figma.';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function probeActiveTab() {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return { ok: false };
  if (!/^https?:/.test(tab.url || '')) return { ok: false, reason: 'unsupported-page' };
  const title = (tab.title || '').trim();
  if (isFigmaEditorUrl(tab.url)) {
    return {
      ok: false, title, url: tab.url, isFigma: true,
      reason: 'figma-plugin-only', detection: 'figma-plugin-only',
    };
  }
  const best = await findBestFrame(tab);
  const deck = best.deck || { formato: 'pagina-unica', slides: 1, artboards: [] };
  if (deck.formato === 'vazio') return { ok: false, title, frameId: best.frameId, frameUrl: best.frameUrl };
  return {
    ok: true,
    title,
    url: tab.url,
    frameId: best.frameId,
    frameUrl: best.frameUrl,
    isClaudeFrame: best.frameId !== 0 || String(best.frameUrl || '').includes(CLAUDE_FRAME_FRAGMENT),
    ...deck,
  };
}

const HISTORY_KEY = 'deckHistory';
const HISTORY_LIMIT = 20;
const HISTORY_MAX_BYTES = 150 * 1024 * 1024;
const CAPTURE_SESSIONS_KEY = 'deckCaptureSessions';
const pendingCaptures = new Map();
let captureSeq = 0;

function validCaptureId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(value)
    ? value : '';
}

function makeCaptureId() {
  captureSeq += 1;
  return `capture-${Date.now()}-${captureSeq}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeEntryTitle(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100);
}

async function storageGet(keys) {
  try {
    if (!chrome.storage || !chrome.storage.local) return {};
    return (await chrome.storage.local.get(keys)) || {};
  } catch (_) { return {}; }
}

async function storageSet(values) {
  try {
    if (!chrome.storage || !chrome.storage.local) return false;
    await chrome.storage.local.set(values);
    return true;
  } catch (_) { return false; }
}

function byteLength(text) {
  const value = String(text || '');
  try { return new TextEncoder().encode(value).length; } catch (_) { return value.length; }
}

async function readCaptureSessions() {
  const data = await storageGet(CAPTURE_SESSIONS_KEY);
  const sessions = data[CAPTURE_SESSIONS_KEY];
  return sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : {};
}

async function writeCaptureSession(captureId, patch) {
  if (!captureId) return;
  const sessions = await readCaptureSessions();
  sessions[captureId] = { ...(sessions[captureId] || {}), ...patch, captureId };
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = Object.values(sessions)
    .filter((session) => Number(session.updatedAt || session.startedAt || Date.now()) >= cutoff)
    .sort((a, b) => Number(b.updatedAt || b.startedAt || 0) - Number(a.updatedAt || a.startedAt || 0))
    .slice(0, 50);
  const pruned = {};
  for (const session of recent) pruned[session.captureId] = session;
  await storageSet({ [CAPTURE_SESSIONS_KEY]: pruned });
}

async function findRunningCapture(tabId, exceptCaptureId) {
  for (const pending of pendingCaptures.values()) {
    if (pending.meta && pending.meta.tabId === tabId && pending.meta.captureId !== exceptCaptureId) {
      return pending.meta;
    }
  }
  const sessions = await readCaptureSessions();
  const now = Date.now();
  return Object.values(sessions).find((session) => session
    && session.captureId !== exceptCaptureId
    && session.tabId === tabId
    && session.status === 'running'
    && now - Number(session.startedAt || now) < CAPTURE_TIMEOUT_MS + 30000) || null;
}

function historyEntryFromResult(result, meta) {
  if (!result || !result.ok || typeof result.json !== 'string' || !result.json) return null;
  let parsed = null;
  try { parsed = JSON.parse(result.json); } catch (_) { return null; }
  const slideCount = Number((parsed && parsed.slideCount) || result.slideCount) || 1;
  let title = sanitizeEntryTitle((meta && meta.entryTitle) || '');
  if (!title && slideCount === 1 && parsed.root && parsed.root.role === 'slide') {
    title = sanitizeEntryTitle(parsed.root.name || '');
  }
  if (!title) {
    title = sanitizeEntryTitle((parsed && parsed.title) || result.title
      || (meta && meta.tabTitle) || 'Untitled deck');
  }
  return {
    id: (meta && meta.captureId) || validCaptureId(result.captureId) || makeCaptureId(),
    title: title || 'Untitled deck',
    capturedAt: Date.now(),
    slideCount,
    report: (parsed && parsed.captureReport) || null,
    bytes: byteLength(result.json),
    json: result.json,
  };
}

async function persistCaptureResult(result, meta) {
  const entry = historyEntryFromResult(result, meta || {});
  if (!entry) return { saved: false, entry: null };
  const data = await storageGet(HISTORY_KEY);
  const existing = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  const already = existing.find((item) => item && item.id === entry.id);
  if (already) return { saved: true, entry: already };

  const history = [entry, ...existing.filter((item) => item && item.id !== entry.id)]
    .slice(0, HISTORY_LIMIT);
  while (history.length > 1
    && history.reduce((sum, item) => sum + (Number(item.bytes) || byteLength(item.json || '')), 0)
      > HISTORY_MAX_BYTES) {
    history.pop();
  }

  let saved = await storageSet({ [HISTORY_KEY]: history });
  if (!saved) saved = await storageSet({ [HISTORY_KEY]: [entry] });
  if (!saved) {
    // Keep a visible placeholder rather than making the capture disappear
    // without explanation. The still-open popup can still download it now.
    await storageSet({ [HISTORY_KEY]: [{ ...entry, json: null }] });
  }
  await writeCaptureSession(entry.id, {
    status: saved ? 'complete' : 'complete-unsaved',
    entryId: entry.id,
    completedAt: Date.now(),
    updatedAt: Date.now(),
  });
  return { saved, entry };
}

async function enrichAndPersistCapture(result, meta) {
  if (!result || !result.ok) {
    if (meta && meta.captureId) {
      await writeCaptureSession(meta.captureId, {
        status: 'error',
        error: String((result && result.error) || 'Capture failed.').slice(0, 500),
        completedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return result;
  }
  if (meta && meta.suppressHistory) {
    await writeCaptureSession(meta.captureId, {
      status: 'complete', completedAt: Date.now(), updatedAt: Date.now(),
    });
    return {
      ...result,
      captureId: meta.captureId || '',
      entryId: '',
      historySaved: false,
      suppressedHistory: true,
    };
  }
  const persisted = await persistCaptureResult(result, meta || {});
  return {
    ...result,
    captureId: (meta && meta.captureId) || (persisted.entry && persisted.entry.id) || '',
    entryId: persisted.entry ? persisted.entry.id : '',
    historySaved: persisted.saved,
  };
}

async function handleCaptureResult(message, sender) {
  const payload = (message && message.payload) || {};
  const captureId = validCaptureId((message && message.captureId) || payload.captureId);
  let pending = captureId ? pendingCaptures.get(captureId) : null;
  if (!pending && pendingCaptures.size === 1) {
    pending = pendingCaptures.values().next().value; // legacy serializer result
  }
  if (!pending && sender && sender.tab && sender.tab.id != null) {
    pending = [...pendingCaptures.values()]
      .find((item) => item.meta && item.meta.tabId === sender.tab.id) || null;
  }

  let meta = pending ? pending.meta : null;
  if (!meta && captureId) {
    const sessions = await readCaptureSessions();
    meta = sessions[captureId] || null;
  }
  if (!meta) {
    meta = {
      captureId: captureId || makeCaptureId(),
      tabId: sender && sender.tab ? sender.tab.id : null,
      tabTitle: sender && sender.tab ? sender.tab.title : '',
    };
  }

  // Persist *in the service worker* before resolving the popup's request.
  // If the user clicked away and Chrome destroyed the popup, the completed
  // deck is still waiting in Decks when Claude2Figma is reopened. This also
  // handles a service-worker restart: the result message wakes the worker,
  // and the stored session identifies the capture even though the original
  // in-memory Promise is gone.
  let enriched = payload;
  if (payload && payload.ok) enriched = await enrichAndPersistCapture(payload, meta);
  else if (meta.captureId) {
    await writeCaptureSession(meta.captureId, {
      status: 'error',
      error: String((payload && payload.error) || 'Capture failed.').slice(0, 500),
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  if (pending) {
    pendingCaptures.delete(pending.meta.captureId);
    clearTimeout(pending.timer);
    pending.resolve(enriched);
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === 'capture-result') {
    void handleCaptureResult(message, sender);
  }
});

function sanitizeCaptureOptions(options, captureIdOverride) {
  const captureId = validCaptureId(captureIdOverride || (options && options.captureId));
  if (options && options.scope === 'page') return { scope: 'page', captureId };
  if (!options || !['selected', 'single'].includes(options.scope)) return { scope: 'full', captureId };
  const selectedIndexes = [...new Set(
    (Array.isArray(options.selectedIndexes) ? options.selectedIndexes : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < 10000),
  )].sort((a, b) => a - b);
  if (options.scope === 'single') {
    return { scope: 'single', selectedIndexes: selectedIndexes.slice(0, 1), captureId };
  }
  return { scope: 'selected', selectedIndexes, captureId };
}

async function captureFrameWithSerializer(tab, frameId, captureOptions, meta) {
  const captureId = meta.captureId;
  const resultPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCaptures.delete(captureId);
      void writeCaptureSession(captureId, {
        status: 'error', error: 'Capture timed out.', updatedAt: Date.now(),
      });
      resolve({
        ok: false, captureId,
        error: 'Capture timed out. The deck may be very large — try again, or split it into smaller decks.',
      });
    }, CAPTURE_TIMEOUT_MS);
    pendingCaptures.set(captureId, { resolve, timer, meta });
  });

  try {
    // Pass scope through both the content-script global and the DOM. The DOM
    // attribute is the reliable cross-world fallback; inject.js removes it.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      func: (serialized) => {
        try { globalThis.__CLAUDE2FIGMA_CAPTURE_OPTIONS__ = JSON.parse(serialized); } catch (_) { /* DOM fallback below */ }
        if (document.documentElement) {
          document.documentElement.setAttribute('data-claude2figma-capture-options', serialized);
        }
      },
      args: [JSON.stringify(captureOptions)],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      files: ['inject.js'],
    });
  } catch (e) {
    const pending = pendingCaptures.get(captureId);
    if (pending) { clearTimeout(pending.timer); pendingCaptures.delete(captureId); }
    const message = 'Could not access this page. Reload the tab and try again. ('
      + String(e && e.message ? e.message : e) + ')';
    await writeCaptureSession(captureId, {
      status: 'error', error: message.slice(0, 500), updatedAt: Date.now(),
    });
    return { ok: false, captureId, error: message };
  }

  const result = await resultPromise;
  if (result && result.ok && !result.title && tab.title) result.title = tab.title;
  return result || { ok: false, captureId, error: 'Capture failed for an unknown reason.' };
}

function translateDeckTree(node, dx, dy) {
  if (!node || !node.rect) return;
  node.rect = {
    ...node.rect,
    x: Math.round((Number(node.rect.x) + dx) * 100) / 100,
    y: Math.round((Number(node.rect.y) + dy) * 100) / 100,
  };
  for (const child of node.children || []) translateDeckTree(child, dx, dy);
}

function firstDeckText(node) {
  if (!node) return '';
  if (node.type === 'TEXT' && node.text && Array.isArray(node.text.runs)) {
    const text = node.text.runs.map((run) => run.content || '').join(' ').trim();
    if (text) return text.slice(0, 80);
  }
  for (const child of node.children || []) {
    const found = firstDeckText(child);
    if (found) return found;
  }
  return '';
}

// A Claude canvas may place every screen in its own cross-origin iframe.
// Page JavaScript in the top frame cannot read those documents (it only
// produced blank shells), but the extension service worker can inject the
// serializer into each browser frame and assemble one deck here.
function iframeArtboardPlan(bestFrame, captureOptions, tab) {
  if (!bestFrame || !bestFrame.deck || bestFrame.deck.formato !== 'artboards') return null;
  if (captureOptions.scope === 'page') return null;
  const all = Array.isArray(bestFrame.deck.artboards) ? bestFrame.deck.artboards : [];
  const wanted = captureOptions.scope === 'full'
    ? all.map((_, i) => i)
    : (captureOptions.selectedIndexes || []);
  const entries = wanted
    .map((index) => ({ index, artboard: all.find((a) => Number(a.index) === Number(index)) || all[index] }))
    .filter((entry) => entry.artboard);
  if (!entries.length || entries.some(({ artboard }) => artboard.tag !== 'IFRAME')) return null;

  const directChildren = (bestFrame.candidates || [])
    .filter((candidate) => candidate && candidate.frameId !== bestFrame.frameId
      && candidate.parentFrameId === bestFrame.frameId
      && candidate.deck && candidate.deck.formato !== 'vazio')
    .sort((a, b) => a.frameId - b.frameId);
  if (!directChildren.length) return null;

  const used = new Set();
  const normalizeUrl = (raw) => {
    try {
      const url = new URL(raw || '', (tab && tab.url) || undefined);
      url.hash = '';
      return url.href;
    } catch (_) { return String(raw || ''); }
  };
  const planned = entries.map((entry) => {
    const wantedUrl = normalizeUrl(entry.artboard.src);
    let candidate = directChildren.find((item) => !used.has(item.frameId)
      && wantedUrl && normalizeUrl(item.frameUrl) === wantedUrl) || null;
    if (!candidate) {
      // Selected/Single entries are subsets, so fall back by the artboard's
      // original ordinal rather than its position in the subset. Otherwise
      // choosing only artboard 3 could silently capture artboard 1.
      const ordinalCandidate = directChildren[Number(entry.index)];
      candidate = ordinalCandidate && !used.has(ordinalCandidate.frameId)
        ? ordinalCandidate
        : (directChildren.find((item) => !used.has(item.frameId)) || null);
    }
    if (candidate) used.add(candidate.frameId);
    return { ...entry, candidate };
  });
  return planned.every((item) => item.candidate) ? planned : null;
}

async function captureIframeArtboards(tab, plan, captureOptions, parentMeta) {
  const slides = [];
  const reports = [];
  for (const item of plan) {
    const subCaptureId = `${parentMeta.captureId}-frame-${item.index}`;
    const subMeta = {
      captureId: subCaptureId,
      parentCaptureId: parentMeta.captureId,
      tabId: tab.id,
      tabTitle: tab.title || '',
      tabUrl: tab.url || '',
      source: 'web-subframe',
      scope: 'full',
      frameId: item.candidate.frameId,
      suppressHistory: true,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
    };
    await writeCaptureSession(subCaptureId, subMeta);
    const result = await captureFrameWithSerializer(
      tab, item.candidate.frameId, { scope: 'full', captureId: subCaptureId }, subMeta);
    if (!result || !result.ok) {
      return {
        ok: false, captureId: parentMeta.captureId,
        error: `Could not capture artboard “${item.artboard.name || item.index + 1}” `
          + `in its separate frame. ${(result && result.error) || ''}`.trim(),
      };
    }
    let payload;
    try { payload = JSON.parse(result.json); } catch (_) {
      return {
        ok: false, captureId: parentMeta.captureId,
        error: `Artboard “${item.artboard.name || item.index + 1}” returned invalid capture data.`,
      };
    }
    if (payload.captureReport) reports.push(payload.captureReport);
    const rootWasDeck = payload.root && payload.root.role === 'deck';
    const childSlides = rootWasDeck
      ? (payload.root.children || []).filter((child) => child && child.rect)
      : [payload.root].filter(Boolean);
    for (const slide of childSlides) {
      const sourceRole = slide.role;
      slide.role = 'slide';
      slide.clips = true;
      if (!rootWasDeck && sourceRole === 'page'
        && Number(item.artboard.w) > 0 && Number(item.artboard.h) > 0) {
        slide.rect = { ...slide.rect, w: Number(item.artboard.w), h: Number(item.artboard.h) };
      }
      if (childSlides.length === 1) {
        const topName = String(item.artboard.name || '').trim();
        const genericTop = !topName || /^Artboard \d+$/i.test(topName) || /^Screen \d+$/i.test(topName);
        slide.name = (genericTop
          ? (firstDeckText(slide) || payload.title || topName || `Screen ${item.index + 1}`)
          : topName).slice(0, 80);
      }
      slides.push(slide);
    }
  }
  if (!slides.length) {
    return { ok: false, captureId: parentMeta.captureId, error: 'No iframe artboards could be captured.' };
  }

  let y = 0;
  let maxW = 1;
  for (const slide of slides) {
    translateDeckTree(slide, -slide.rect.x, -slide.rect.y + y);
    y += Math.max(1, Number(slide.rect.h) || 1) + 80;
    maxW = Math.max(maxW, Number(slide.rect.w) || 1);
  }
  const numericFields = [
    'nodes', 'shadowHosts', 'shadowPierced', 'sealedHosts', 'iframes',
    'iframesPierced', 'iframesBlocked', 'canvases', 'canvasesFailed',
    'videos', 'videosFailed',
    'skippedInvisible', 'contentRootsStripped', 'inferredAutoLayouts',
    'autoLayoutFrames', 'leafFrames', 'layersRemoved', 'imagesFetched', 'imagesFailed',
  ];
  const report = {
    extensionVersion: (reports[0] && reports[0].extensionVersion) || '1.7.0',
    nodes: 1,
    byType: { FRAME: 1, TEXT: 0, IMAGE: 0, VECTOR: 0 },
    artboardsDetected: plan.length,
    mode: 'artboards',
    frameUrl: tab.url || '',
    detectionMethod: 'multi-frame-iframes',
    scope: captureOptions.scope,
    selectedArtboards: plan.length,
    captureId: parentMeta.captureId,
    framesCaptured: plan.length,
  };
  for (const field of numericFields) report[field] = field === 'nodes' ? 1 : 0;
  for (const item of reports) {
    for (const field of numericFields) report[field] += Number(item[field]) || 0;
    for (const type of Object.keys(report.byType)) {
      report.byType[type] += Number(item.byType && item.byType[type]) || 0;
    }
  }
  const root = slides.length === 1 ? slides[0] : {
    type: 'FRAME', name: 'Deck', role: 'deck',
    rect: { x: 0, y: 0, w: maxW, h: Math.max(1, y - 80) },
    children: slides,
  };
  const payload = {
    schema: 'claude2figma',
    schemaVersion: 1,
    title: tab.title || '',
    sourceUrl: tab.url || '',
    capturedAt: new Date().toISOString(),
    slideCount: slides.length,
    captureReport: report,
    root,
  };
  return {
    ok: true, captureId: parentMeta.captureId,
    json: JSON.stringify(payload), title: payload.title,
    slideCount: slides.length, nodes: report.nodes,
  };
}

async function captureActiveTab(rawOptions) {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return { ok: false, error: 'No active tab found.' };
  if (!/^https?:/.test(tab.url || '')) {
    return { ok: false, error: 'This page cannot be captured. Open your deck in Claude Design (or any normal web page) and try again.' };
  }
  const captureId = validCaptureId(rawOptions && rawOptions.captureId) || makeCaptureId();
  if (isFigmaEditorUrl(tab.url)) {
    return { ok: false, captureId, error: FIGMA_PLUGIN_ONLY_MESSAGE };
  }
  const running = await findRunningCapture(tab.id, captureId);
  if (running) {
    return {
      ok: false, captureId,
      error: 'A capture is already running for this tab. Wait for it to finish — if the popup closed, reopen Claude2Figma and check the Decks tab.',
    };
  }
  const commonMeta = {
    captureId,
    tabId: tab.id,
    tabTitle: tab.title || '',
    tabUrl: tab.url || '',
    entryTitle: sanitizeEntryTitle(rawOptions && rawOptions.entryTitle),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: 'running',
  };

  const bestFrame = await findBestFrame(tab);
  const frameId = bestFrame.frameId;
  const captureOptions = sanitizeCaptureOptions(rawOptions, captureId);
  if (['selected', 'single'].includes(captureOptions.scope)
    && captureOptions.selectedIndexes.length === 0) {
    return { ok: false, captureId, error: 'Select at least one artboard to capture.' };
  }
  const meta = { ...commonMeta, source: 'web', scope: captureOptions.scope, frameId };
  await writeCaptureSession(captureId, meta);

  const multiFramePlan = iframeArtboardPlan(bestFrame, captureOptions, tab);
  if (multiFramePlan) {
    const assembled = await captureIframeArtboards(tab, multiFramePlan, captureOptions, meta);
    return enrichAndPersistCapture(assembled, meta);
  }

  return captureFrameWithSerializer(tab, frameId, captureOptions, meta);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return undefined;
  if (message.type === 'probe') {
    probeActiveTab().then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === 'capture') {
    captureActiveTab(message.options)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: 'Capture failed: ' + String(e && e.message ? e.message : e) }));
    return true;
  }
  return undefined;
});
