// Claude2Figma — page serializer (injected into the design frame)
// v1.3: pierces shadow DOM and same-origin iframes, captures full or
// selected canvas artboards, strips outer artboard shells down to the
// actual screen, collapses duplicate wrappers, and recovers safe Auto
// Layout from flex, one-axis grid, and exact block stacks.
//
// Output format: see shared/SCHEMA.md

(() => {
  'use strict';

  const SCHEMA_VERSION = 1;
  const EXTENSION_VERSION = '1.7.0';
  const DECK_STAGE_SELECTOR = 'deck-stage';
  const STRONG_ARTBOARD_SELECTOR = '[data-dc-artboard], [data-artboard], '
    + '[data-artboard-id], [data-artboard-name], [data-frame-id], [data-frame-name], '
    + '[data-screen-name], [data-testid*="artboard" i], [data-testid*="canvas-board" i]';
  const ARTBOARD_SELECTOR = '[data-label], ' + STRONG_ARTBOARD_SELECTOR;
  let artboardDetectionMethod = 'none';
  const SLIDE_GAP = 80;
  const IMAGE_SCALE_FACTOR = 2;
  const IMAGE_MAX_SIDE = 2048;
  const MAX_CONCURRENT_FETCHES = 6;
  const IMAGE_FETCH_TIMEOUT_MS = 15000;
  const SLIDE_SWAP_TIMEOUT_MS = 3000;
  const SLIDE_POLL_MS = 40;
  const DEEP_WALK_CAP = 20000;

  class DeckStageError extends Error {}

  const newReport = () => ({
    extensionVersion: EXTENSION_VERSION,
    nodes: 0, byType: { FRAME: 0, TEXT: 0, IMAGE: 0, VECTOR: 0 },
    shadowHosts: 0, shadowPierced: 0, sealedHosts: 0,
    iframes: 0, iframesPierced: 0, iframesBlocked: 0,
    canvases: 0, canvasesFailed: 0, videos: 0, videosFailed: 0,
    skippedInvisible: 0, artboardsDetected: 0, mode: 'page',
    frameUrl: '', detectionMethod: 'none',
    scope: 'full', selectedArtboards: 0, contentRootsStripped: 0,
    inferredAutoLayouts: 0, autoLayoutFrames: 0, leafFrames: 0,
  });

  function countNode(ctx, node) {
    if (!ctx.report) return;
    ctx.report.nodes += 1;
    if (ctx.report.byType[node.type] != null) ctx.report.byType[node.type] += 1;
  }

  // ---------------------------------------------------------------- utils
  const parsePx = (v) => {
    const n = parseFloat(v);
    return Number.isNaN(n) ? 0 : n;
  };
  const round2 = (n) => Math.round(n * 100) / 100;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  function isVisible(el) {
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (parseFloat(s.opacity || '1') === 0) return false;
      const clipped = s.overflow === 'hidden' || s.overflowX === 'hidden'
        || s.overflowY === 'hidden'
        || (s.clip && s.clip !== 'auto')
        || (s.clipPath && s.clipPath !== 'none');
      if (clipped && el.getBoundingClientRect) {
        const r = el.getBoundingClientRect();
        // The standard .sr-only/.visually-hidden pattern: a 1×1 clipped box.
        // It is accessibility text, not a visual Figma layer.
        if (r.width <= 1 && r.height <= 1) return false;
        const inset = /^inset\(\s*([0-9.]+)%/.exec(String(s.clipPath || ''));
        if (inset && Number(inset[1]) >= 50) return false;
      }
      return true;
    } catch (_) { return true; }
  }

  // Duck-typed (no instanceof) so it also works for elements inside
  // same-origin iframes, whose HTMLElement is a different realm's class.
  function getEffectiveScale(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (typeof node.offsetWidth === 'number' && node.offsetWidth >= 40) {
        const w = node.getBoundingClientRect().width;
        if (w > 0) {
          const s = w / node.offsetWidth;
          if (Number.isFinite(s) && s > 0) return Math.abs(s - 1) < 0.02 ? 1 : s;
        }
      }
      node = node.parentElement
        || (node.getRootNode && node.getRootNode().host) || null;
    }
    return 1;
  }

  // offsetWidth/Height are layout-space (design) pixels. getBoundingClientRect
  // is viewport-space after a Claude canvas zoom transform. Detection must use
  // design pixels, otherwise a 1440×900 artboard zoomed to 40% looks like a
  // small card and a large dashboard widget can look like a screen.
  function designSizeFor(el, rect) {
    const r = rect || el.getBoundingClientRect();
    const offsetW = typeof el.offsetWidth === 'number' ? el.offsetWidth : 0;
    const offsetH = typeof el.offsetHeight === 'number' ? el.offsetHeight : 0;
    const fallbackScale = getEffectiveScale(el) || 1;
    const scaleX = offsetW >= 40 && r.width > 0 ? r.width / offsetW : fallbackScale;
    const scaleY = offsetH >= 40 && r.height > 0 ? r.height / offsetH : scaleX;
    return {
      w: offsetW > 0 ? offsetW : r.width / (scaleX || 1),
      h: offsetH > 0 ? offsetH : r.height / (scaleY || 1),
      scaleX: scaleX || 1,
      scaleY: scaleY || 1,
    };
  }

  function isDesignCanvasContext(rootDoc) {
    try {
      const host = String((rootDoc.location && rootDoc.location.hostname) || '').toLowerCase();
      if (/(^|\.)claudeusercontent\.com$/.test(host) || /(^|\.)claude\.ai$/.test(host)) return true;
      return !!rootDoc.querySelector(
        'deck-stage, x-dc, [data-dc-artboard], [data-artboard], [data-testid*="artboard" i]');
    } catch (_) { return false; }
  }

  function artboardThresholds(rootDoc) {
    return isDesignCanvasContext(rootDoc)
      ? { minW: 280, minH: 200, minArea: 100000, rootCoverage: 0.12 }
      : { minW: 340, minH: 320, minArea: 260000, rootCoverage: 0.20 };
  }

  // The visual detector only needs to know whether a candidate has enough
  // content. Previously it materialized every descendant and text string for
  // every large wrapper, which could make probing a complex canvas O(n²).
  function cappedContentStats(el) {
    let descendants = 0;
    let textLength = 0;
    try {
      if (el.shadowRoot) descendants = Math.max(descendants, deepQueryAll('*', el).length);
      const doc = el.ownerDocument || document;
      const walker = doc.createTreeWalker(el, 5); // ELEMENT | TEXT
      let steps = 0;
      while (walker.nextNode() && steps < 5000) {
        steps += 1;
        const node = walker.currentNode;
        if (node.nodeType === 1 && descendants < 1000) descendants += 1;
        if (node.nodeType === 3 && textLength < 1000) {
          textLength += String(node.nodeValue || '').trim().length;
        }
        if (descendants >= 24 && textLength >= 100) break;
      }
    } catch (_) {
      try {
        descendants = el.querySelectorAll('*').length;
        textLength = compactElementText(el).length;
      } catch (__) { /* inaccessible subtree */ }
    }
    return { descendants, textLength };
  }

  function measure(el, ctx) {
    const r = el.getBoundingClientRect();
    const d = ctx.discount || 1;
    return {
      x: round2(r.x / d), y: round2(r.y / d),
      w: round2(Math.max(0, r.width / d)), h: round2(Math.max(0, r.height / d)),
    };
  }

  function localScale(el, ctx) {
    return getEffectiveScale(el) / (ctx.discount || 1);
  }

  function baseName(el) {
    const label = el.getAttribute && (el.getAttribute('data-label') || el.getAttribute('aria-label'));
    if (label && label.trim()) return label.trim().slice(0, 60);
    const tag = el.tagName.toLowerCase();
    const cls = (typeof el.className === 'string' ? el.className : '')
      .split(/\s+/).filter(Boolean)[0];
    return cls ? `${tag}.${cls}`.slice(0, 60) : tag;
  }

  function resolveUrl(url, el) {
    try {
      const base = (el && el.ownerDocument && el.ownerDocument.baseURI) || document.baseURI;
      return new URL(url, base).href;
    } catch (_) { return url; }
  }

  // All elements under root, descending into open shadow roots.
  function deepQueryAll(selector, root = document) {
    const out = [];
    let visited = 0;
    (function walk(node) {
      if (!node || visited > DEEP_WALK_CAP) return;
      let found = [];
      try { found = Array.from(node.querySelectorAll ? node.querySelectorAll(selector) : []); } catch (_) { found = []; }
      for (const el of found) out.push(el);
      let all = [];
      try { all = Array.from(node.querySelectorAll ? node.querySelectorAll('*') : []); } catch (_) { all = []; }
      visited += all.length;
      for (const el of all) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    })(root);
    return out;
  }

  // Light-DOM children + open shadow-root children (the missing artboards).
  function childElementsOf(el, ctx) {
    let kids = Array.from(el.children || []);
    const sr = el.shadowRoot;
    if (sr) {
      if (ctx && ctx.report) {
        if (!el.__dbShadowCounted) { ctx.report.shadowHosts += 1; el.__dbShadowCounted = true; }
      }
      // deck-stage's shadow only holds prev/next controls — never content.
      if (el.tagName !== 'DECK-STAGE') {
        const shadowKids = Array.from(sr.children || [])
          .filter((k) => !['STYLE', 'SLOT'].includes(k.tagName));
        if (shadowKids.length && ctx && ctx.report && !el.__dbShadowPierced) {
          ctx.report.shadowPierced += 1; el.__dbShadowPierced = true;
        }
        kids = kids.concat(shadowKids);
      }
    }
    return kids;
  }

  function childContainersOf(el, ctx) {
    const containers = [el];
    const sr = el.shadowRoot;
    if (!sr) return containers;
    if (ctx && ctx.report && !el.__dbShadowCounted) {
      ctx.report.shadowHosts += 1; el.__dbShadowCounted = true;
    }
    if (el.tagName !== 'DECK-STAGE') {
      const shadowKids = Array.from(sr.children || [])
        .filter((k) => !['STYLE', 'SLOT'].includes(k.tagName));
      if (shadowKids.length && ctx && ctx.report && !el.__dbShadowPierced) {
        ctx.report.shadowPierced += 1; el.__dbShadowPierced = true;
      }
      containers.push(sr);
    }
    return containers;
  }

  // ------------------------------------------------------------- gradient
  const KEYWORD_ANGLES = {
    'to top': 0, 'to top right': 45, 'to right top': 45, 'to right': 90,
    'to bottom right': 135, 'to right bottom': 135, 'to bottom': 180,
    'to bottom left': 225, 'to left bottom': 225, 'to left': 270,
    'to top left': 315, 'to left top': 315,
  };

  function splitTopLevel(value, separator = ',') {
    const parts = [];
    let depth = 0, current = '';
    for (const ch of value) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === separator && depth === 0) { parts.push(current); current = ''; }
      else current += ch;
    }
    if (current.trim() !== '') parts.push(current);
    return parts;
  }

  function findMatchingParen(value, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < value.length; i += 1) {
      if (value[i] === '(') depth += 1;
      if (value[i] === ')') { depth -= 1; if (depth === 0) return i; }
    }
    return -1;
  }

  function parseStops(segments) {
    const parsed = segments.map((seg) => {
      const t = seg.trim();
      const m = t.match(/^(.*?)\s+(-?[\d.]+)%$/);
      return m
        ? { color: m[1].trim(), position: clamp(Number(m[2]) / 100, 0, 1) }
        : { color: t, position: null };
    });
    const n = parsed.length;
    return parsed.map((s, i) => ({
      color: s.color,
      position: s.position != null ? s.position : (n === 1 ? 0 : i / (n - 1)),
    }));
  }

  function parseGradient(value) {
    if (!value || value === 'none') return null;
    const trimmed = value.trim();
    const prefix = trimmed.match(/^(linear-gradient|radial-gradient)\(/);
    if (!prefix) return null;
    const open = prefix[0].length - 1;
    const close = findMatchingParen(trimmed, open);
    if (close === -1 || trimmed.slice(close + 1).trim() !== '') return null;
    const segments = splitTopLevel(trimmed.slice(open + 1, close));
    if (!segments.length) return null;

    if (prefix[1] === 'linear-gradient') {
      const first = segments[0].trim();
      const deg = first.match(/^(-?[\d.]+)deg$/);
      const kw = KEYWORD_ANGLES[first.toLowerCase()];
      if (deg) return { type: 'GRADIENT_LINEAR', angle: Number(deg[1]), stops: parseStops(segments.slice(1)) };
      if (kw !== undefined) return { type: 'GRADIENT_LINEAR', angle: kw, stops: parseStops(segments.slice(1)) };
      return { type: 'GRADIENT_LINEAR', angle: 180, stops: parseStops(segments) };
    }
    const first = segments[0].trim();
    const isShape = /\bat\b/i.test(first) || /^(circle|ellipse)\b/i.test(first)
      || /^(closest|farthest)-(side|corner)\b/i.test(first);
    return { type: 'GRADIENT_RADIAL', stops: parseStops(isShape ? segments.slice(1) : segments) };
  }

  // ------------------------------------------------------------- shadows
  function parseBoxShadows(value) {
    if (!value || value === 'none') return [];
    const out = [];
    for (const part of splitTopLevel(value)) {
      const colorMatch = part.match(/rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|#[0-9a-fA-F]{3,8}/);
      const color = colorMatch ? colorMatch[0] : 'rgba(0, 0, 0, 0.25)';
      const rest = part.replace(color, '').trim();
      const inset = /\binset\b/.test(rest);
      const lengths = (rest.replace('inset', '').match(/-?[\d.]+(px)?/g) || []).map(parseFloat);
      if (lengths.length < 2) continue;
      out.push({
        offsetX: lengths[0] || 0, offsetY: lengths[1] || 0,
        blur: Math.max(0, lengths[2] || 0), spread: lengths[3] || 0,
        color, inset,
      });
    }
    return out;
  }

  // ------------------------------------------------------------ auto-layout
  const JUSTIFY = { 'flex-start': 'MIN', start: 'MIN', center: 'CENTER', 'flex-end': 'MAX', end: 'MAX', 'space-between': 'SPACE_BETWEEN' };
  const ALIGN = { 'flex-start': 'MIN', start: 'MIN', center: 'CENTER', 'flex-end': 'MAX', end: 'MAX', stretch: 'MIN', baseline: 'MIN' };
  const NONE_LAYOUT = () => ({
    mode: 'NONE', gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 },
    primaryAlign: 'MIN', counterAlign: 'MIN',
  });

  function countGridTracks(value) {
    if (!value || value === 'none') return 0;
    return String(value).trim().split(/\s+/).filter(Boolean).length;
  }

  function flexToLayout(style, scale) {
    const padding = {
      top: round2(parsePx(style.paddingTop) * scale),
      right: round2(parsePx(style.paddingRight) * scale),
      bottom: round2(parsePx(style.paddingBottom) * scale),
      left: round2(parsePx(style.paddingLeft) * scale),
    };

    // CSS Grid -> Figma Auto Layout only when it is a true one-axis track.
    // A 2-D grid stays absolute in v1; forcing it into one row/column would
    // move the design.
    if (style.display === 'grid' || style.display === 'inline-grid') {
      const columns = countGridTracks(style.gridTemplateColumns);
      const rows = countGridTracks(style.gridTemplateRows);
      if (columns === 1 && rows !== 1) {
        return {
          mode: 'VERTICAL',
          gap: round2(parsePx(style.rowGap !== 'normal' ? style.rowGap : style.gap || '0') * scale),
          padding,
          primaryAlign: JUSTIFY[style.alignContent] || 'MIN',
          counterAlign: ALIGN[style.justifyItems] || 'MIN',
        };
      }
      if (rows === 1 && columns !== 1) {
        return {
          mode: 'HORIZONTAL',
          gap: round2(parsePx(style.columnGap !== 'normal' ? style.columnGap : style.gap || '0') * scale),
          padding,
          primaryAlign: JUSTIFY[style.justifyContent] || 'MIN',
          counterAlign: ALIGN[style.alignItems] || 'MIN',
        };
      }
      return NONE_LAYOUT();
    }

    if (style.display !== 'flex' && style.display !== 'inline-flex') return NONE_LAYOUT();
    const column = (style.flexDirection || 'row').startsWith('column');
    const gapValue = column ? (style.rowGap !== 'normal' ? style.rowGap : style.gap)
                             : (style.columnGap !== 'normal' ? style.columnGap : style.gap);
    const wraps = (style.flexWrap || '').startsWith('wrap');
    const counterGapValue = column
      ? (style.columnGap !== 'normal' ? style.columnGap : style.gap)
      : (style.rowGap !== 'normal' ? style.rowGap : style.gap);
    return {
      mode: column ? 'VERTICAL' : 'HORIZONTAL',
      gap: round2(parsePx(gapValue || '0') * scale),
      padding,
      primaryAlign: JUSTIFY[style.justifyContent] || 'MIN',
      counterAlign: ALIGN[style.alignItems] || 'MIN',
      ...(wraps ? { wrap: true, counterGap: round2(parsePx(counterGapValue || '0') * scale) } : {}),
    };
  }

  // ----------------------------------------------------------------- text
  function readTextStyle(el, ctx, pseudo) {
    const s = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el);
    const scale = localScale(el, ctx);
    const lineHeightPx = s.lineHeight === 'normal' ? 0 : parsePx(s.lineHeight);
    const deco = (s.textDecorationLine || s.textDecoration || '');
    return {
      fontFamily: (s.fontFamily.split(',')[0] || 'Inter').replace(/["']/g, '').trim() || 'Inter',
      fontWeight: parseInt(s.fontWeight, 10) || (s.fontWeight === 'bold' ? 700 : 400),
      italic: s.fontStyle === 'italic' || (s.fontStyle || '').startsWith('oblique'),
      fontSize: round2((parsePx(s.fontSize) || 16) * scale),
      color: s.color || 'rgb(0, 0, 0)',
      letterSpacing: round2((s.letterSpacing === 'normal' ? 0 : parsePx(s.letterSpacing)) * scale),
      ...(lineHeightPx > 0 ? { lineHeight: round2(lineHeightPx * scale) } : {}),
      ...(deco.includes('underline') ? { underline: true } : {}),
      ...(deco.includes('line-through') ? { strikethrough: true } : {}),
      textTransform: s.textTransform || 'none',
    };
  }

  function applyTransform(text, transform) {
    if (transform === 'uppercase') return text.toUpperCase();
    if (transform === 'lowercase') return text.toLowerCase();
    if (transform === 'capitalize') return text.replace(/\b\w/g, (c) => c.toUpperCase());
    return text;
  }

  function collectTextFragments(node, out, ctx) {
    const appendPseudo = (which) => {
      if (!node || node.nodeType !== 1) return;
      const info = pseudoInfo(node, which);
      if (info && info.text) {
        const style = readTextStyle(node, ctx, which);
        out.push({ content: applyTransform(info.text, style.textTransform), ...style });
      }
    };
    appendPseudo('::before');
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        if (!child.textContent) continue;
        const style = readTextStyle(child.parentElement || node, ctx);
        out.push({ content: applyTransform(child.textContent, style.textTransform), ...style });
      } else if (child.nodeType === 1) {
        if (child.tagName === 'BR') {
          out.push({ content: '\n', ...readTextStyle(child.parentElement || node, ctx) });
        } else if (isVisible(child)) {
          collectTextFragments(child, out, ctx);
        }
      }
    }
    appendPseudo('::after');
  }

  function normalizeFragments(fragments) {
    const collapsed = fragments.map((f) =>
      f.content === '\n' ? f : { ...f, content: f.content.replace(/\s+/g, ' ') });
    const isBreak = (f) => f && f.content === '\n';
    const out = [];
    for (let i = 0; i < collapsed.length; i += 1) {
      const frag = collapsed[i];
      if (isBreak(frag)) { out.push(frag); continue; }
      let content = frag.content;
      if (i === 0 || isBreak(collapsed[i - 1])) content = content.replace(/^ /, '');
      if (i === collapsed.length - 1 || isBreak(collapsed[i + 1])) content = content.replace(/ $/, '');
      const prev = out[out.length - 1];
      if (prev && !isBreak(prev) && prev.content.endsWith(' ') && content.startsWith(' ')) {
        content = content.replace(/^ /, '');
      }
      if (content !== '') out.push({ ...frag, content });
    }
    return out;
  }

  function sameStyle(a, b) {
    return a.fontFamily === b.fontFamily && a.fontWeight === b.fontWeight
      && a.italic === b.italic && a.fontSize === b.fontSize && a.color === b.color
      && a.letterSpacing === b.letterSpacing && a.lineHeight === b.lineHeight
      && !!a.underline === !!b.underline && !!a.strikethrough === !!b.strikethrough;
  }

  function mergeRuns(fragments) {
    const runs = [];
    for (const f of fragments) {
      if (!f.content) continue;
      const { textTransform, ...run } = f;
      const last = runs[runs.length - 1];
      if (last && sameStyle(last, run)) last.content += run.content;
      else runs.push({ ...run });
    }
    return runs;
  }

  function readTextAlign(el) {
    const v = getComputedStyle(el).textAlign;
    if (v === 'center') return 'CENTER';
    if (v === 'right' || v === 'end') return 'RIGHT';
    return 'LEFT';
  }

  function countTextLines(el) {
    try {
      const doc = el.ownerDocument || document;
      const range = doc.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
      if (!rects.length) return 1;
      const s = getComputedStyle(el);
      const scale = getEffectiveScale(el);
      const lh = (parsePx(s.lineHeight) || parsePx(s.fontSize) * 1.2 || 16) * scale;
      const tolerance = Math.max(2, lh * 0.5);
      const tops = rects.map((r) => r.top).sort((a, b) => a - b);
      let lines = 1, current = tops[0];
      for (const top of tops) {
        if (top - current > tolerance) { lines += 1; current = top; }
      }
      return lines;
    } catch (_) { return 1; }
  }

  function isFullyTransparent(color) {
    if (!color) return false;
    const c = color.trim();
    if (c === 'transparent') return true;
    if (/\/\s*0(\.0+)?(%)?\s*\)$/.test(c)) return true;          // oklch()/rgb(... / 0)
    const m = c.match(/,\s*0(\.0+)?\s*\)$/);                       // rgba(..., 0)
    return !!m;
  }

  // ----------------------------------------------------------- serializer
  const BLOCK_DISPLAYS = [
    'block', 'flow-root', 'list-item', 'table', 'table-row', 'table-cell',
    'table-row-group', 'table-header-group', 'table-footer-group',
    'table-caption', 'flex', 'grid',
  ];

  function isTextOnly(el) {
    const ownText = String(el.textContent || '').trim();
    if (!ownText) {
      const before = pseudoInfo(el, '::before');
      const after = pseudoInfo(el, '::after');
      if (!((before && before.text) || (after && after.text))) return false;
    }
    const own = getComputedStyle(el).display;
    if (el.children.length > 0 && ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(own)) return false;
    if (el.shadowRoot) return false;
    if (el.querySelector('img, svg, video, canvas, input, textarea, select, button, iframe')) return false;
    for (const d of Array.from(el.querySelectorAll('*'))) {
      const ds = getComputedStyle(d);
      if (BLOCK_DISPLAYS.includes(ds.display)) return false;
      if (ds.position === 'absolute' || ds.position === 'fixed') return false;
    }
    return true;
  }

  function extractBackgroundUrl(value) {
    const m = (value || '').match(/url\((['"]?)(.*?)\1\)/);
    return m ? m[2] : null;
  }

  function parseCornerRadii(style, rect, scale) {
    const one = (v) => {
      const first = (v || '0').split(/\s+/)[0];
      if (first.endsWith('%')) return round2((parseFloat(first) / 100) * Math.min(rect.w, rect.h));
      return round2(parsePx(first) * scale);
    };
    const tl = one(style.borderTopLeftRadius), tr = one(style.borderTopRightRadius);
    const br = one(style.borderBottomRightRadius), bl = one(style.borderBottomLeftRadius);
    if (tl === 0 && tr === 0 && br === 0 && bl === 0) return {};
    if (tl === tr && tr === br && br === bl) return { cornerRadius: tl };
    return { cornerRadii: { tl, tr, br, bl } };
  }

  function unescapeCssString(value) {
    return String(value || '').replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_, esc) => {
      const clean = esc.trim();
      if (/^[0-9a-fA-F]{1,6}$/.test(clean)) {
        try { return String.fromCodePoint(parseInt(clean, 16)); } catch (_) { return ''; }
      }
      return esc;
    });
  }

  function pseudoInfo(el, which) {
    try {
      const style = getComputedStyle(el, which);
      const content = String(style.content || '').trim();
      if (!content || content === 'none' || content === 'normal') return null;
      if (style.display === 'none' || style.visibility === 'hidden') return null;
      if (parseFloat(style.opacity || '1') === 0) return null;
      const urlMatch = /url\((['"]?)(.*?)\1\)/i.exec(content);
      let text = '';
      const tokenPattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|attr\(\s*([_a-zA-Z][-_a-zA-Z0-9]*)[^)]*\)/g;
      let match;
      while ((match = tokenPattern.exec(content))) {
        if (match[1] != null || match[2] != null) {
          text += unescapeCssString(match[1] != null ? match[1] : match[2]);
        } else if (match[3] && el.getAttribute) {
          text += el.getAttribute(match[3]) || '';
        }
      }
      return {
        style,
        text,
        url: urlMatch ? urlMatch[2] : null,
        unsupported: !urlMatch && !text && /counter\s*\(|counters\s*\(/.test(content),
      };
    } catch (_) {
      return null;
    }
  }

  function applyComputedBoxStyle(node, style, scale, sourceEl, ctx) {
    const gradient = parseGradient(style.backgroundImage);
    const bgUrl = gradient ? null : extractBackgroundUrl(style.backgroundImage);
    if (gradient) node.fill = gradient;
    else if (bgUrl) {
      node.fill = { type: 'IMAGE', bytes: '' };
      ctx.imageRefs.push({ node, url: resolveUrl(bgUrl, sourceEl) });
    } else if (style.backgroundColor && !isFullyTransparent(style.backgroundColor)
      && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      node.fill = { type: 'SOLID', color: style.backgroundColor };
    }

    Object.assign(node, parseCornerRadii(style, node.rect, scale));

    const opacity = parseFloat(style.opacity || '1');
    if (opacity < 1) node.opacity = round2(opacity);
    if (style.overflow !== 'visible' || style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      node.clips = true;
    }

    const sides = [
      { style: style.borderTopStyle, width: parsePx(style.borderTopWidth) * scale, color: style.borderTopColor },
      { style: style.borderRightStyle, width: parsePx(style.borderRightWidth) * scale, color: style.borderRightColor },
      { style: style.borderBottomStyle, width: parsePx(style.borderBottomWidth) * scale, color: style.borderBottomColor },
      { style: style.borderLeftStyle, width: parsePx(style.borderLeftWidth) * scale, color: style.borderLeftColor },
    ];
    const weights = sides.map((side) => (side.style !== 'none' && side.width > 0 ? round2(side.width) : 0));
    const maxWeight = Math.max(...weights);
    if (maxWeight > 0) {
      const first = sides[weights.findIndex((w) => w > 0)];
      const uniform = weights.every((w) => w === maxWeight);
      node.stroke = {
        color: first.color, width: maxWeight,
        ...(first.style === 'dashed' || first.style === 'dotted' ? { dashed: true } : {}),
        ...(uniform ? {} : { perSide: { top: weights[0], right: weights[1], bottom: weights[2], left: weights[3] } }),
      };
    }

    const shadows = parseBoxShadows(style.boxShadow);
    if (shadows.length) {
      node.shadows = shadows.map((sh) => ({
        ...sh,
        offsetX: round2(sh.offsetX * scale), offsetY: round2(sh.offsetY * scale),
        blur: round2(sh.blur * scale), spread: round2(sh.spread * scale),
      }));
    }
    return node;
  }

  function pseudoLength(value, basis, scale) {
    const text = String(value || '').trim();
    if (!text || text === 'auto' || text === 'none' || text === 'normal') return null;
    if (text.endsWith('%')) {
      const n = parseFloat(text);
      return Number.isFinite(n) ? basis * n / 100 : null;
    }
    const px = parsePx(text);
    return px ? px * scale : (text === '0' || text === '0px' ? 0 : null);
  }

  function buildPseudoNode(el, which, positioningAncestor, ctx) {
    const info = pseudoInfo(el, which);
    if (!info || info.unsupported) return null;
    const style = info.style;
    const scale = localScale(el, ctx);
    const hostRect = measure(el, ctx);
    const hostStyle = getComputedStyle(el);
    const contentX = hostRect.x + (parsePx(hostStyle.borderLeftWidth) + parsePx(hostStyle.paddingLeft)) * scale;
    const contentY = hostRect.y + (parsePx(hostStyle.borderTopWidth) + parsePx(hostStyle.paddingTop)) * scale;
    const contentW = Math.max(0, hostRect.w
      - (parsePx(hostStyle.borderLeftWidth) + parsePx(hostStyle.paddingLeft)
        + parsePx(hostStyle.borderRightWidth) + parsePx(hostStyle.paddingRight)) * scale);
    const contentH = Math.max(0, hostRect.h
      - (parsePx(hostStyle.borderTopWidth) + parsePx(hostStyle.paddingTop)
        + parsePx(hostStyle.borderBottomWidth) + parsePx(hostStyle.paddingBottom)) * scale);
    const fontSize = Math.max(1, (parsePx(style.fontSize) || 16) * scale);
    const estimatedTextW = info.text ? Math.ceil(info.text.length * fontSize * 0.58) : 0;
    const lineHeightPx = parsePx(style.lineHeight);
    const estimatedTextH = Math.ceil(lineHeightPx ? lineHeightPx * scale : fontSize * 1.25);
    const positioned = style.position === 'absolute' || style.position === 'fixed';
    const cb = positioned && positioningAncestor && positioningAncestor.rect
      ? positioningAncestor.rect : hostRect;
    let w = pseudoLength(style.width, cb.w, scale);
    let h = pseudoLength(style.height, cb.h, scale);
    const left = pseudoLength(style.left, cb.w, scale);
    const right = pseudoLength(style.right, cb.w, scale);
    const top = pseudoLength(style.top, cb.h, scale);
    const bottom = pseudoLength(style.bottom, cb.h, scale);
    if (w == null && left != null && right != null) w = Math.max(0, cb.w - left - right);
    if (h == null && top != null && bottom != null) h = Math.max(0, cb.h - top - bottom);
    if (w == null) w = Math.min(contentW || hostRect.w, info.text ? estimatedTextW : Math.min(24, hostRect.w));
    if (h == null) h = info.text ? estimatedTextH : Math.min(24, hostRect.h);

    let x;
    let y;
    if (positioned) {
      x = left != null ? cb.x + left : (right != null ? cb.x + cb.w - right - w : contentX);
      y = top != null ? cb.y + top : (bottom != null ? cb.y + cb.h - bottom - h : contentY);
    } else if (which === '::before') {
      x = contentX;
      y = contentY;
    } else {
      x = contentX + Math.max(0, contentW - w);
      y = contentY + Math.max(0, contentH - h);
    }
    const rect = { x: round2(x), y: round2(y), w: round2(Math.max(0, w)), h: round2(Math.max(0, h)) };
    if (rect.w === 0 && rect.h === 0) return null;

    let node;
    if (info.url) {
      node = {
        type: 'IMAGE', name: `${baseName(el)} ${which}`, rect,
        fill: { type: 'IMAGE', bytes: '' }, imageScaleMode: 'FIT',
      };
      Object.assign(node, parseCornerRadii(style, rect, scale));
      ctx.imageRefs.push({ node, url: resolveUrl(info.url, el) });
      countNode(ctx, node);
    } else {
      const probe = { type: 'FRAME', name: `${baseName(el)} ${which}`, rect, layout: flexToLayout(style, scale), children: [] };
      applyComputedBoxStyle(probe, style, scale, el, ctx);
      const decorated = !!(probe.fill || probe.stroke || probe.shadows || probe.cornerRadius || probe.cornerRadii);
      const explicitBox = pseudoLength(style.width, cb.w, scale) != null
        || pseudoLength(style.height, cb.h, scale) != null;
      if (info.text && !decorated && !explicitBox) {
        node = makeSyntheticTextNode(el, ctx, info.text, {
          name: info.text.trim().slice(0, 40) || `${baseName(el)} ${which}`,
          pseudo: which, rect, align: 'LEFT',
        });
      } else {
        if (!info.text && !decorated) return null;
        node = probe;
        countNode(ctx, node);
        if (info.text) {
          node.children.push(makeSyntheticTextNode(el, ctx, info.text, {
            name: info.text.trim().slice(0, 40) || `${baseName(el)} ${which} text`,
            pseudo: which, rect, align: 'CENTER', center: true,
          }));
        }
      }
    }
    if (positioned) {
      node.absolute = true;
      const z = parseInt(style.zIndex, 10);
      if (Number.isFinite(z)) node.zIndex = z;
    }
    return node;
  }

  function createContainerNode(el, ctx) {
    const style = getComputedStyle(el);
    const scale = localScale(el, ctx);
    const rect = measure(el, ctx);
    const node = {
      type: 'FRAME', name: baseName(el), rect,
      layout: flexToLayout(style, scale), children: [],
    };
    countNode(ctx, node);

    applyComputedBoxStyle(node, style, scale, el, ctx);
    return node;
  }

  function measureTextElement(el, ctx, lines) {
    const base = measure(el, ctx);
    const style = getComputedStyle(el);
    const scale = localScale(el, ctx);
    const left = (parsePx(style.borderLeftWidth) + parsePx(style.paddingLeft)) * scale;
    const right = (parsePx(style.borderRightWidth) + parsePx(style.paddingRight)) * scale;
    const top = (parsePx(style.borderTopWidth) + parsePx(style.paddingTop)) * scale;
    const bottom = (parsePx(style.borderBottomWidth) + parsePx(style.paddingBottom)) * scale;
    let rect = {
      x: round2(base.x + left), y: round2(base.y + top),
      w: round2(Math.max(0, base.w - left - right)),
      h: round2(Math.max(0, base.h - top - bottom)),
    };
    try {
      const doc = el.ownerDocument || document;
      const range = doc.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (rects.length) {
        const d = ctx.discount || 1;
        const x0 = Math.min(...rects.map((r) => r.x)) / d;
        const y0 = Math.min(...rects.map((r) => r.y)) / d;
        const x1 = Math.max(...rects.map((r) => r.x + r.width)) / d;
        const y1 = Math.max(...rects.map((r) => r.y + r.height)) / d;
        rect.y = round2(y0);
        rect.h = round2(Math.max(0, y1 - y0));
        if (lines <= 1) {
          rect.x = round2(x0);
          rect.w = round2(Math.max(0, x1 - x0));
        }
      }
    } catch (_) { /* keep content box */ }
    if (rect.w <= 0) rect.w = base.w;
    if (rect.h <= 0) rect.h = base.h;
    return rect;
  }

  function buildTextNode(el, ctx) {
    const fragments = [];
    if (el.tagName === 'LI') {
      const ls = getComputedStyle(el).listStyleType;
      if (ls && ls !== 'none') fragments.push({ content: '•  ', ...readTextStyle(el, ctx) });
    }
    collectTextFragments(el, fragments, ctx);
    const runs = mergeRuns(normalizeFragments(fragments));
    const preview = runs.map((r) => r.content).join('').trim().slice(0, 40);
    const lines = countTextLines(el);
    const node = {
      type: 'TEXT',
      name: preview || baseName(el),
      rect: measureTextElement(el, ctx, lines),
      text: { runs, align: readTextAlign(el), lines },
    };
    countNode(ctx, node);
    return node;
  }

  function makeSyntheticTextNode(el, ctx, content, options = {}) {
    const base = measure(el, ctx);
    const style = getComputedStyle(el);
    const scale = localScale(el, ctx);
    const left = (parsePx(style.borderLeftWidth) + parsePx(style.paddingLeft)) * scale;
    const right = (parsePx(style.borderRightWidth) + parsePx(style.paddingRight)) * scale;
    const top = (parsePx(style.borderTopWidth) + parsePx(style.paddingTop)) * scale;
    const runStyle = readTextStyle(el, ctx, options.pseudo || null);
    if (options.color) runStyle.color = options.color;
    if (options.fontSize) runStyle.fontSize = options.fontSize;
    const { textTransform, ...run } = runStyle;
    const lineHeight = Number(run.lineHeight) || Math.max(1, (run.fontSize || 16) * 1.25);
    const lines = Math.max(1, String(content).split('\n').length);
    let rect = {
      x: round2(base.x + left),
      y: round2(base.y + top),
      w: round2(Math.max(0, base.w - left - right)),
      h: round2(Math.min(base.h, lineHeight * lines)),
    };
    if (options.center) {
      rect.y = round2(base.y + Math.max(0, (base.h - rect.h) / 2));
    } else if (options.singleLineCenter && lines === 1) {
      rect.y = round2(base.y + Math.max(0, (base.h - rect.h) / 2));
    }
    if (options.rect) rect = options.rect;
    const node = {
      type: 'TEXT',
      name: options.name || String(content).trim().slice(0, 40) || baseName(el),
      rect,
      text: {
        runs: [{ content: applyTransform(String(content), textTransform), ...run }],
        align: options.align || readTextAlign(el),
        lines,
      },
    };
    countNode(ctx, node);
    return node;
  }

  function buildFormControlNode(el, ctx) {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : tag;
    if (type === 'hidden') return null;
    if (tag === 'input' && type === 'image') {
      const style = getComputedStyle(el);
      const rect = measure(el, ctx);
      const node = {
        type: 'IMAGE', name: el.getAttribute('alt') || 'image button', rect,
        fill: { type: 'IMAGE', bytes: '' }, imageScaleMode: 'FIT',
      };
      Object.assign(node, parseCornerRadii(style, rect, localScale(el, ctx)));
      const src = el.getAttribute('src');
      if (src) ctx.imageRefs.push({ node, url: resolveUrl(src, el) });
      countNode(ctx, node);
      return node;
    }

    const container = createContainerNode(el, ctx);
    container.children = [];
    const style = getComputedStyle(el);
    const placeholder = el.getAttribute ? (el.getAttribute('placeholder') || '') : '';
    let content = '';
    let align;
    let center = false;
    let singleLineCenter = tag !== 'textarea';

    if (tag === 'textarea') {
      content = String(el.value != null ? el.value : (el.textContent || ''));
    } else if (tag === 'select') {
      const options = Array.from(el.options || []);
      if (el.multiple || Number(el.size) > 1) {
        content = options.map((option) => option.text || option.value || '').join('\n');
        singleLineCenter = false;
      } else {
        const selected = options.find((option) => option.selected) || options[el.selectedIndex] || options[0];
        content = selected ? (selected.text || selected.value || '') : '';
      }
    } else if (type === 'checkbox' || type === 'radio') {
      const rect = container.rect;
      if (!container.fill && !container.stroke) {
        container.fill = { type: 'SOLID', color: 'rgb(255, 255, 255)' };
        container.stroke = { color: 'rgb(118, 118, 118)', width: 1 };
      }
      if (type === 'radio' && container.cornerRadius == null && !container.cornerRadii) {
        container.cornerRadius = round2(Math.min(rect.w, rect.h) / 2);
      }
      if (type === 'checkbox' && container.cornerRadius == null && !container.cornerRadii) {
        container.cornerRadius = 2;
      }
      if (el.checked) {
        const accent = style.accentColor && style.accentColor !== 'auto'
          ? style.accentColor : style.color;
        container.children.push(makeSyntheticTextNode(el, ctx, type === 'checkbox' ? '✓' : '●', {
          name: type === 'checkbox' ? 'checkmark' : 'radio dot',
          align: 'CENTER', center: true, color: accent,
          fontSize: round2(Math.max(6, Math.min(rect.w, rect.h) * (type === 'checkbox' ? 0.85 : 0.55))),
        }));
      }
      return container;
    } else if (type === 'submit' || type === 'reset' || type === 'button') {
      content = String(el.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''));
      align = 'CENTER';
      center = true;
    } else if (type === 'file') {
      content = el.files && el.files[0] ? el.files[0].name : 'Choose file';
    } else if (type === 'password') {
      const length = Math.min(32, String(el.value || '').length);
      content = length ? '•'.repeat(length) : '';
    } else if (type === 'color') {
      if (el.value) container.fill = { type: 'SOLID', color: String(el.value) };
      content = '';
    } else {
      content = String(el.value != null ? el.value : '');
    }

    const isPlaceholder = !content && !!placeholder;
    if (isPlaceholder) content = placeholder;
    if (content) {
      container.children.push(makeSyntheticTextNode(el, ctx, content, {
        name: `${tag === 'input' ? type : tag} value`,
        align, center, singleLineCenter,
        pseudo: isPlaceholder ? '::placeholder' : null,
      }));
    }
    if (tag === 'select' && !el.multiple && !(Number(el.size) > 1)) {
      const base = container.rect;
      const fontSize = Math.max(8, (parsePx(style.fontSize) || 14) * localScale(el, ctx));
      container.children.push(makeSyntheticTextNode(el, ctx, '▾', {
        name: 'select chevron', align: 'CENTER', center: true,
        rect: {
          x: round2(base.x + base.w - fontSize * 1.7),
          y: round2(base.y + Math.max(0, (base.h - fontSize * 1.25) / 2)),
          w: round2(fontSize * 1.2), h: round2(fontSize * 1.25),
        },
        fontSize: round2(fontSize),
      }));
    }
    return container;
  }

  function buildVideoNode(el, ctx) {
    const rect = measure(el, ctx);
    const style = getComputedStyle(el);
    const node = {
      type: 'IMAGE', name: el.getAttribute('aria-label') || el.title || 'video', rect,
      fill: { type: 'IMAGE', bytes: '' },
      imageScaleMode: style.objectFit === 'contain' ? 'FIT' : 'FILL',
    };
    Object.assign(node, parseCornerRadii(style, rect, localScale(el, ctx)));
    const opacity = parseFloat(style.opacity || '1');
    if (opacity < 1) node.opacity = round2(opacity);
    countNode(ctx, node);
    if (ctx.report) ctx.report.videos += 1;

    const poster = el.poster || (el.getAttribute && el.getAttribute('poster'));
    if (poster) {
      ctx.imageRefs.push({ node, url: resolveUrl(poster, el) });
      return node;
    }
    try {
      if (Number(el.readyState) >= 2 && el.videoWidth > 0 && el.videoHeight > 0) {
        const doc = el.ownerDocument || document;
        const canvas = doc.createElement('canvas');
        const scale = Math.min(1, 1280 / Math.max(el.videoWidth, el.videoHeight));
        canvas.width = Math.max(1, Math.round(el.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(el.videoHeight * scale));
        const cx = canvas.getContext('2d');
        if (!cx) throw new Error('no 2d context');
        cx.drawImage(el, 0, 0, canvas.width, canvas.height);
        const b64 = (canvas.toDataURL('image/png').split(',')[1] || '');
        if (b64) {
          node.fill.bytes = b64;
          return node;
        }
      }
      throw new Error('video frame unavailable');
    } catch (_) {
      if (ctx.report) ctx.report.videosFailed += 1;
      return node; // grey placeholder is better than deleting the video area
    }
  }

  function buildSvgNode(el, ctx) {
    const rect = measure(el, ctx);
    let html = el.outerHTML;
    const color = getComputedStyle(el).color;
    if (color) html = html.replace(/currentColor/gi, color);
    if (!/xmlns=/.test(html)) html = html.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    if (!/\swidth=/.test(html) && rect.w > 0) html = html.replace('<svg', `<svg width="${rect.w}" height="${rect.h}"`);
    const node = { type: 'VECTOR', name: baseName(el), rect, svg: html };
    countNode(ctx, node);
    return node;
  }

  function buildCanvasNode(el, ctx) {
    const rect = measure(el, ctx);
    const style = getComputedStyle(el);
    const node = {
      type: 'IMAGE', name: baseName(el), rect,
      fill: { type: 'IMAGE', bytes: '' }, imageScaleMode: 'FILL',
    };
    Object.assign(node, parseCornerRadii(style, rect, localScale(el, ctx)));
    countNode(ctx, node);
    if (ctx.report) ctx.report.canvases += 1;
    try {
      const dataUrl = el.toDataURL('image/png');
      const b64 = (dataUrl.split(',')[1] || '');
      if (b64) node.fill.bytes = b64;
      else if (ctx.report) ctx.report.canvasesFailed += 1;
    } catch (_) {
      if (ctx.report) ctx.report.canvasesFailed += 1; // tainted canvas
    }
    return node;
  }

  function scaleTree(n, k) {
    n.rect = {
      x: round2(n.rect.x * k), y: round2(n.rect.y * k),
      w: round2(n.rect.w * k), h: round2(n.rect.h * k),
    };
    if (n.cornerRadius) n.cornerRadius = round2(n.cornerRadius * k);
    if (n.cornerRadii) {
      for (const key of ['tl', 'tr', 'br', 'bl']) n.cornerRadii[key] = round2((n.cornerRadii[key] || 0) * k);
    }
    if (n.stroke) {
      n.stroke.width = round2((n.stroke.width || 0) * k);
      if (n.stroke.perSide) {
        for (const key of ['top', 'right', 'bottom', 'left']) {
          n.stroke.perSide[key] = round2((n.stroke.perSide[key] || 0) * k);
        }
      }
    }
    if (n.shadows) {
      for (const sh of n.shadows) {
        sh.offsetX = round2(sh.offsetX * k); sh.offsetY = round2(sh.offsetY * k);
        sh.blur = round2(sh.blur * k); sh.spread = round2(sh.spread * k);
      }
    }
    if (n.layout) {
      n.layout.gap = round2((n.layout.gap || 0) * k);
      if (n.layout.counterGap) n.layout.counterGap = round2(n.layout.counterGap * k);
      if (n.layout.padding) {
        for (const key of ['top', 'right', 'bottom', 'left']) {
          n.layout.padding[key] = round2((n.layout.padding[key] || 0) * k);
        }
      }
    }
    if (n.text) {
      for (const r of n.text.runs || []) {
        r.fontSize = round2((r.fontSize || 16) * k);
        r.letterSpacing = round2((r.letterSpacing || 0) * k);
        if (r.lineHeight) r.lineHeight = round2(r.lineHeight * k);
      }
    }
    for (const c of n.children || []) scaleTree(c, k);
  }

  function translate(node, dx, dy) {
    node.rect = { ...node.rect, x: round2(node.rect.x + dx), y: round2(node.rect.y + dy) };
    for (const c of node.children || []) translate(c, dx, dy);
  }

  // Same-origin / srcdoc / blob iframes can be read like any other element.
  function buildIframeNode(el, ctx) {
    if (ctx.report) ctx.report.iframes += 1;
    const rect = measure(el, ctx);
    const style = getComputedStyle(el);
    let doc = null;
    try { doc = el.contentDocument; } catch (_) { doc = null; }

    if (!doc || !doc.body || !doc.body.children.length) {
      if (ctx.report) ctx.report.iframesBlocked += 1;
      const shell = {
        type: 'FRAME', name: (el.getAttribute('data-label') || el.title || 'iframe (blocked)')
          + ' — content sealed by browser',
        rect, layout: NONE_LAYOUT(), children: [], clips: true,
        fill: { type: 'SOLID', color: 'rgb(255, 255, 255)' },
      };
      countNode(ctx, shell);
      return shell;
    }

    const innerCtx = { ...ctx, discount: getEffectiveScale(doc.body) };
    const innerRoot = serializeElement(doc.body, innerCtx);
    const innerW = innerRoot.rect.w || rect.w || 1;
    const k = rect.w > 0 ? rect.w / innerW : 1;
    translate(innerRoot, -innerRoot.rect.x, -innerRoot.rect.y);
    if (Math.abs(k - 1) > 0.001) scaleTree(innerRoot, k);
    translate(innerRoot, rect.x, rect.y);
    // An iframe is a viewport: preserve its exact box and clip scrolled-away
    // document content instead of expanding the exported frame to the full
    // inner document height.
    innerRoot.rect = { ...rect };
    innerRoot.clips = true;
    const label = el.getAttribute('data-label') || el.title;
    if (label) innerRoot.name = label.slice(0, 60);
    Object.assign(innerRoot, parseCornerRadii(style, rect, localScale(el, ctx)));
    if (ctx.report) ctx.report.iframesPierced += 1;
    return innerRoot;
  }

  function buildNodeForElement(el, ctx) {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'link', 'meta', 'noscript', 'template', 'slot'].includes(tag)) return null;
    if (tag === 'svg') return buildSvgNode(el, ctx);
    if (tag === 'canvas') return buildCanvasNode(el, ctx);
    if (tag === 'video') return buildVideoNode(el, ctx);
    if (tag === 'iframe') return buildIframeNode(el, ctx);
    if (['input', 'textarea', 'select'].includes(tag)) return buildFormControlNode(el, ctx);

    if (tag === 'img') {
      const style = getComputedStyle(el);
      const rect = measure(el, ctx);
      const node = {
        type: 'IMAGE', name: el.getAttribute('alt') || baseName(el), rect,
        fill: { type: 'IMAGE', bytes: '' },
        imageScaleMode: style.objectFit === 'contain' ? 'FIT' : 'FILL',
      };
      Object.assign(node, parseCornerRadii(style, rect, localScale(el, ctx)));
      const src = el.currentSrc || el.getAttribute('src');
      if (src) ctx.imageRefs.push({ node, url: resolveUrl(src, el) });
      const opacity = parseFloat(style.opacity || '1');
      if (opacity < 1) node.opacity = round2(opacity);
      countNode(ctx, node);
      return node;
    }

    const style = getComputedStyle(el);
    const gradient = parseGradient(style.backgroundImage);
    const bgUrl = gradient ? null : extractBackgroundUrl(style.backgroundImage);
    if (bgUrl && el.children.length === 0 && !el.shadowRoot && !(el.textContent || '').trim()) {
      const rect = measure(el, ctx);
      const node = {
        type: 'IMAGE', name: baseName(el), rect,
        fill: { type: 'IMAGE', bytes: '' }, imageScaleMode: 'FILL',
      };
      Object.assign(node, parseCornerRadii(style, rect, localScale(el, ctx)));
      ctx.imageRefs.push({ node, url: resolveUrl(bgUrl, el) });
      countNode(ctx, node);
      return node;
    }

    if (!bgUrl && isTextOnly(el)) {
      const textNode = buildTextNode(el, ctx);
      if (!textNode.text.runs.length) return null;
      const container = createContainerNode(el, ctx);
      const decorated = container.fill || container.stroke || container.shadows
        || container.cornerRadius || container.cornerRadii;
      if (!decorated) return textNode;
      if (container.fill && (container.fill.type === 'GRADIENT_LINEAR' || container.fill.type === 'GRADIENT_RADIAL')
        && textNode.text.runs.every((r) => isFullyTransparent(r.color))) {
        textNode.fill = container.fill;
        delete container.fill;
        if (!container.stroke && !container.shadows && !container.cornerRadius && !container.cornerRadii) {
          return textNode;
        }
      }
      container.children = [textNode];
      return container;
    }

    // Custom element with a CLOSED shadow root and no light children:
    // the browser gives us no way in. Count it so the user sees why.
    if (tag.includes('-') && !el.shadowRoot && el.children.length === 0
      && !(el.textContent || '').trim()) {
      const r = el.getBoundingClientRect();
      if (r.width >= 100 && r.height >= 100 && ctx.report) ctx.report.sealedHosts += 1;
    }

    return createContainerNode(el, ctx);
  }

  function walkChildren(parentEl, positioningAncestor, targetChildren, ctx) {
    let parentDisplay = '';
    try { parentDisplay = getComputedStyle(parentEl).display || ''; } catch (_) { parentDisplay = ''; }
    const parentIsFlex = parentDisplay === 'flex' || parentDisplay === 'inline-flex';

    const appendLooseText = (raw) => {
      const content = (raw.textContent || '').replace(/\s+/g, ' ').trim();
      if (!content) return;
      let rect = { x: 0, y: 0, w: 0, h: 0 };
      try {
        const doc = parentEl.ownerDocument || document;
        const range = doc.createRange();
        range.selectNodeContents(raw);
        const r = range.getBoundingClientRect();
        const d = ctx.discount || 1;
        rect = { x: round2(r.x / d), y: round2(r.y / d), w: round2(r.width / d), h: round2(r.height / d) };
      } catch (_) { /* keep zero rect */ }
      if (rect.w === 0) return;
      const styleEl = (raw.parentNode && raw.parentNode.nodeType === 1) ? raw.parentNode : parentEl;
      const style = readTextStyle(styleEl, ctx);
      const { textTransform, ...runStyle } = style;
      const loose = {
        type: 'TEXT', name: content.slice(0, 40), rect,
        text: {
          runs: [{ content: applyTransform(content, textTransform), ...runStyle }],
          align: readTextAlign(styleEl), lines: 1,
        },
      };
      countNode(ctx, loose);
      targetChildren.push(loose);
    };

    const appendElement = (child) => {
      if (child.tagName === 'BR' || child.tagName === 'SLOT' || child.tagName === 'STYLE') return;
      if (!isVisible(child)) {
        if (ctx.report) ctx.report.skippedInvisible += 1;
        return;
      }
      const node = buildNodeForElement(child, ctx);
      if (!node) return;
      if (node.rect.w === 0 && node.rect.h === 0 && node.type !== 'TEXT') {
        if (node.type === 'FRAME') {
          walkChildren(child, positioningAncestor, targetChildren, ctx);
        }
        return;
      }

      const style = getComputedStyle(child);
      const isPositioned = style.position === 'absolute' || style.position === 'fixed';
      const establishes = ['relative', 'absolute', 'fixed', 'sticky'].includes(style.position)
        || style.transform !== 'none';
      if (isPositioned) {
        node.absolute = true;
        const z = parseInt(style.zIndex, 10);
        if (!Number.isNaN(z)) node.zIndex = z;
      } else if (parentIsFlex) {
        const grow = parseFloat(style.flexGrow || '0');
        if (Number.isFinite(grow) && grow > 0) node.flexGrow = round2(grow);
      }

      const destination = isPositioned ? positioningAncestor.children : targetChildren;
      destination.push(node);

      if (node.type === 'FRAME' && (!node.children || node.children.length === 0)) {
        node.children = node.children || [];
        // Iframe/form/video nodes come back pre-built; never re-walk them.
        if (!['IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'VIDEO'].includes(child.tagName)) {
          walkChildren(child, establishes ? node : positioningAncestor, node.children, ctx);
        }
      }
    };

    const appendPseudo = (which) => {
      const node = buildPseudoNode(parentEl, which, positioningAncestor, ctx);
      if (!node) return;
      if (node.absolute && positioningAncestor && positioningAncestor.children) {
        positioningAncestor.children.push(node);
        positioningAncestor.clips = false;
      } else {
        targetChildren.push(node);
      }
    };
    appendPseudo('::before');

    // One pass in rendered DOM order, across light DOM and an open shadow
    // root. Array.sort is stable, so equal z-indexes retain this order.
    for (const container of childContainersOf(parentEl, ctx)) {
      for (const raw of Array.from(container.childNodes || [])) {
        if (raw.nodeType === 3) appendLooseText(raw);
        else if (raw.nodeType === 1) appendElement(raw);
      }
    }
    appendPseudo('::after');

    targetChildren.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
  }

  function serializeElement(root, ctx) {
    const rootNode = createContainerNode(root, ctx);
    rootNode.children = [];
    walkChildren(root, rootNode, rootNode.children, ctx);
    return rootNode;
  }

  // --------------------------------------------------------------- images
  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function looksLikeSvg(blob) {
    if ((blob.type || '').includes('svg')) return true;
    try {
      const head = await blob.slice(0, 128).text();
      return /^\s*(<\?xml|<!doctype svg|<svg)/i.test(head);
    } catch (_) { return false; }
  }

  async function rasterizeSvg(blob, displayed) {
    const href = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('svg load timed out')), 10000);
        img.onload = () => { clearTimeout(timer); resolve(); };
        img.onerror = () => { clearTimeout(timer); reject(new Error('svg failed to load')); };
        img.src = href;
      });
      const w = clamp(Math.round((displayed.w || 1) * IMAGE_SCALE_FACTOR), 1, IMAGE_MAX_SIDE);
      const h = clamp(Math.round((displayed.h || 1) * IMAGE_SCALE_FACTOR), 1, IMAGE_MAX_SIDE);
      const canvas = new OffscreenCanvas(w, h);
      const cx = canvas.getContext('2d');
      if (!cx) return null;
      cx.drawImage(img, 0, 0, w, h);
      return await canvas.convertToBlob({ type: 'image/png' });
    } catch (_) { return null; } finally { URL.revokeObjectURL(href); }
  }

  async function downscale(blob, displayed) {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return blob;
    if (await looksLikeSvg(blob)) return (await rasterizeSvg(blob, displayed)) || blob;
    let bitmap;
    try { bitmap = await createImageBitmap(blob); } catch (_) { return blob; }
    try {
      const scale = Math.min(1,
        ((displayed.w || bitmap.width) * IMAGE_SCALE_FACTOR) / bitmap.width,
        IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      if (scale >= 1) return blob;
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const cx = canvas.getContext('2d');
      if (!cx) return blob;
      cx.drawImage(bitmap, 0, 0, w, h);
      const out = (blob.type || '').includes('jpeg')
        ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
        : await canvas.convertToBlob({ type: 'image/png' });
      return out && out.size < blob.size ? out : blob;
    } catch (_) { return blob; } finally { if (bitmap.close) bitmap.close(); }
  }

  async function fetchBlobWithTimeout(url) {
    if (typeof AbortController === 'undefined') {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.blob();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: 'include', signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.blob();
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveImageBytes(imageRefs) {
    const byUrl = new Map();
    for (const ref of imageRefs) {
      if (!byUrl.has(ref.url)) byUrl.set(ref.url, []);
      byUrl.get(ref.url).push(ref);
    }
    const urls = Array.from(byUrl.keys());
    let index = 0, fetched = 0, failed = 0;

    async function worker() {
      while (index < urls.length) {
        const url = urls[index]; index += 1;
        const refs = byUrl.get(url) || [];
        try {
          const displayed = refs.reduce(
            (m, r) => ({ w: Math.max(m.w, r.node.rect.w || 0), h: Math.max(m.h, r.node.rect.h || 0) }),
            { w: 0, h: 0 });
          const blob = await fetchBlobWithTimeout(url);
          const finalBlob = await downscale(blob, displayed);
          const base64 = bufferToBase64(await finalBlob.arrayBuffer());
          for (const ref of refs) {
            if (ref.node.fill && ref.node.fill.type === 'IMAGE') ref.node.fill.bytes = base64;
          }
          fetched += refs.length;
        } catch (_) { failed += refs.length; }
      }
    }

    await Promise.all(Array.from(
      { length: Math.min(MAX_CONCURRENT_FETCHES, urls.length) }, () => worker()));
    return { fetched, failed };
  }

  // ------------------------------------------------------------ deck-stage
  function findControl(shadow, aria, cls, titlePrefix) {
    const el = shadow.querySelector(`[aria-label="${aria}"]`)
      || shadow.querySelector(cls)
      || shadow.querySelector(`[title^="${titlePrefix}"]`);
    return el && typeof el.click === 'function' ? el : null;
  }

  function readStage(stage) {
    const slides = Array.from(stage.children).filter((e) => e.tagName === 'SECTION');
    if (!slides.length) return null;
    const sr = stage.shadowRoot;
    if (!sr) return { slides, next: null, reset: null };
    return {
      slides,
      next: findControl(sr, 'Next slide', '.btn.next', 'Next'),
      reset: findControl(sr, 'Reset to first slide', '.btn.reset', 'Reset'),
    };
  }

  function visibleSlide(slides) {
    return slides.find((s) => {
      if (!isVisible(s)) return false;
      const r = s.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) || null;
  }

  async function waitForSwap(slides, previous) {
    const deadline = Date.now() + SLIDE_SWAP_TIMEOUT_MS;
    for (;;) {
      const current = visibleSlide(slides);
      if (current && current !== previous) return current;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, SLIDE_POLL_MS));
    }
  }

  function fitScale(stage, slide) {
    const designW = Number(stage.designWidth) || Number(stage.getAttribute('width')) || 0;
    if (!designW) return getEffectiveScale(slide);
    const onScreen = slide.getBoundingClientRect().width;
    if (!onScreen) return 1;
    const s = onScreen / designW;
    return Math.abs(s - 1) < 0.02 ? 1 : s;
  }

  function assembleDeck(slides) {
    let y = 0, maxW = 0;
    for (const s of slides) {
      translate(s, -s.rect.x, -s.rect.y + y);
      y += s.rect.h + SLIDE_GAP;
      maxW = Math.max(maxW, s.rect.w);
    }
    if (slides.length === 1) return slides[0];
    const box = { x: 0, y: 0, w: Math.max(1, maxW), h: Math.max(1, y - SLIDE_GAP) };
    return { type: 'FRAME', name: 'Deck', role: 'deck', rect: box, children: slides };
  }

  async function captureDeckStage(stage, stageInfo, ctx, onProgress, captureOptions) {
    const { slides: slideEls, next, reset } = stageInfo;
    const total = slideEls.length;
    const wanted = new Set(captureOptions && captureOptions.scope !== 'full'
      ? captureOptions.selectedIndexes.filter((i) => i >= 0 && i < total)
      : slideEls.map((_, i) => i));
    const wantedTotal = Math.max(1, wanted.size);
    if (captureOptions && captureOptions.scope !== 'full' && wanted.size === 0) {
      throw new DeckStageError('The selected slide is no longer available. Re-open Claude2Figma and choose it again.');
    }
    if (ctx.report) ctx.report.selectedArtboards = wanted.size;

    if (!next || !reset) {
      const indexed = slideEls.map((s, i) => ({ s, i, readable: s.getBoundingClientRect().width > 0 }));
      const chosen = indexed.filter(({ i }) => wanted.has(i));
      if (!chosen.length || chosen.some(({ readable }) => !readable)
        || (captureOptions.scope === 'full' && indexed.some(({ readable }) => !readable))) {
        throw new DeckStageError(
          'Could not step through the slides (navigation controls not found). '
          + 'Ask Claude to put every slide on a single page, then capture again.');
      }
      const nodes = chosen.map(({ s, i }, done) => {
        const n = serializeElement(s, { ...ctx, discount: fitScale(stage, s) });
        n.role = 'slide';
        n.name = s.getAttribute('data-label') || `Slide ${i + 1}`;
        onProgress(done + 1, wantedTotal);
        return n;
      });
      return assembleDeck(nodes);
    }

    const initial = visibleSlide(slideEls);
    const initialIndex = initial ? slideEls.indexOf(initial) : 0;
    reset.click();
    if (initialIndex !== 0) {
      const back = await waitForSwap(slideEls, initial);
      if (back !== slideEls[0]) throw new DeckStageError('The deck did not return to the first slide.');
    }

    const captured = [];
    for (let i = 0; i < total; i += 1) {
      const current = visibleSlide(slideEls);
      if (!current) throw new DeckStageError(`No visible slide at position ${i + 1} of ${total}.`);
      if (wanted.has(i)) {
        await new Promise((r) => setTimeout(r, 120));
        const node = serializeElement(current, { ...ctx, discount: fitScale(stage, current) });
        node.role = 'slide';
        node.name = current.getAttribute('data-label') || `Slide ${i + 1}`;
        captured.push(node);
        onProgress(captured.length, wantedTotal);
      }
      if (i === total - 1) break;
      next.click();
      if (!(await waitForSwap(slideEls, current))) {
        throw new DeckStageError(`The deck stopped responding at slide ${i + 1} of ${total}.`);
      }
    }

    if (initialIndex !== total - 1) {
      reset.click();
      for (let i = 0; i < initialIndex; i += 1) next.click();
    }
    return assembleDeck(captured);
  }

  // ------------------------------------------------------ artboard canvas
  // Claude "canvas" files: several big labelled screens on one page.
  // Each becomes its own slide (= its own top-level frame in Figma).
  function compactElementText(el) {
    return String((el && (el.innerText || el.textContent)) || '')
      .replace(/\s+/g, ' ').trim();
  }

  function artboardDescriptor(el) {
    if (!el) return '';
    const cls = typeof el.className === 'string' ? el.className : '';
    const testId = el.getAttribute ? (el.getAttribute('data-testid') || '') : '';
    return `${el.tagName || ''} ${el.id || ''} ${cls} ${testId}`.toLowerCase();
  }

  function artboardNameFor(el, fallback) {
    if (el && el.getAttribute) {
      for (const attr of ['data-label', 'data-artboard-name', 'data-frame-name',
        'data-screen-name', 'aria-label', 'title']) {
        const value = String(el.getAttribute(attr) || '').trim();
        if (value) return value.slice(0, 80);
      }
    }
    try {
      const prevText = compactElementText(el.previousElementSibling);
      if (prevText.length >= 3 && prevText.length <= 80) return prevText;
      const hostRect = el.getBoundingClientRect();
      const label = deepQueryAll('h1,h2,h3,h4,h5,h6,p,div,span', el).find((node) => {
        if (node.children.length) return false;
        const text = compactElementText(node);
        if (text.length < 3 || text.length > 80) return false;
        const r = node.getBoundingClientRect();
        return r.y <= hostRect.y + Math.max(56, hostRect.height * 0.16);
      });
      if (label) return compactElementText(label).slice(0, 80);
    } catch (_) { /* use fallback */ }
    return fallback;
  }

  function findVisualArtboards(root = document) {
    const rootDoc = root.nodeType === 9 ? root : (root.ownerDocument || document);
    const view = rootDoc.defaultView || window;
    const viewportW = Math.max(1, view.innerWidth || rootDoc.documentElement.clientWidth || 1);
    const viewportH = Math.max(1, view.innerHeight || rootDoc.documentElement.clientHeight || 1);
    const thresholds = artboardThresholds(rootDoc);
    const rootDesignW = Math.max(
      viewportW,
      Number((rootDoc.body && rootDoc.body.scrollWidth) || 0),
      Number((rootDoc.documentElement && rootDoc.documentElement.scrollWidth) || 0));
    const rootDesignH = Math.max(
      viewportH,
      Number((rootDoc.body && rootDoc.body.scrollHeight) || 0),
      Number((rootDoc.documentElement && rootDoc.documentElement.scrollHeight) || 0));
    const rootDesignArea = Math.max(1, rootDesignW * rootDesignH);
    const groups = new Map();
    const styleCache = new WeakMap();
    const styleOf = (el) => {
      if (!el) return {};
      if (!styleCache.has(el)) {
        try {
          const ownerView = el.ownerDocument && el.ownerDocument.defaultView;
          styleCache.set(el, (ownerView && ownerView.getComputedStyle
            ? ownerView.getComputedStyle(el) : getComputedStyle(el)));
        } catch (_) { styleCache.set(el, {}); }
      }
      return styleCache.get(el);
    };
    const isTransparent = (color) => !color || color === 'transparent'
      || /rgba?\([^)]*,\s*0(?:\.0+)?\s*\)/.test(color) || /\/\s*0(?:\.0+)?\s*\)/.test(color);
    const readingSort = (a, b) => (Math.abs(a.r.y - b.r.y) > 40 ? a.r.y - b.r.y : a.r.x - b.r.x);

    for (const el of deepQueryAll('*', root)) {
      if (!el || !el.getBoundingClientRect || !el.tagName) continue;
      if (['HTML', 'BODY', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT',
        'HEADER', 'NAV', 'ASIDE', 'FOOTER'].includes(el.tagName)) continue;
      const parent = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
      if (!parent || parent === rootDoc.documentElement) continue;
      let r;
      try { r = el.getBoundingClientRect(); } catch (_) { continue; }
      const design = designSizeFor(el, r);
      // Screen-sized in *design* pixels. This intentionally excludes normal
      // dashboard/pricing/content cards on ordinary web pages; whole-page
      // capture (including the popup's Whole page override) handles those.
      // A large iframe is a separate document/screen, so it uses a lower
      // size floor than an ordinary DOM card.
      const minW = el.tagName === 'IFRAME' ? Math.min(thresholds.minW, 300) : thresholds.minW;
      const minH = el.tagName === 'IFRAME' ? Math.min(thresholds.minH, 200) : thresholds.minH;
      const minArea = el.tagName === 'IFRAME' ? Math.min(thresholds.minArea, 120000) : thresholds.minArea;
      if (design.w < minW || design.h < minH || design.w * design.h < minArea) continue;
      if (r.width < 40 || r.height < 40) continue;
      if (r.width > viewportW * 0.995 && r.height > viewportH * 0.99
        && design.w * design.h > rootDesignArea * 0.92) continue;
      if (!isVisible(el)) continue;
      const style = styleOf(el);
      if (style.position === 'fixed' || style.position === 'sticky') continue;
      const role = el.getAttribute ? (el.getAttribute('role') || '') : '';
      if (['navigation', 'banner', 'contentinfo', 'toolbar'].includes(role)) continue;

      const { descendants, textLength } = cappedContentStats(el);
      if (el.tagName !== 'IFRAME'
        && !(descendants >= 20 || (descendants >= 10 && textLength >= 60) || textLength >= 160)) continue;

      const parentStyle = styleOf(parent);
      const parentDesc = artboardDescriptor(parent);
      const desc = artboardDescriptor(el);
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
    return best ? best.items.map((c) => c.el) : [];
  }

  function findArtboards(root = document) {
    const rootDoc = root.nodeType === 9 ? root : (root.ownerDocument || document);
    const thresholds = artboardThresholds(rootDoc);
    const contains = (a, b) => a.r.x <= b.r.x + 2 && a.r.y <= b.r.y + 2
      && a.r.x + a.r.width >= b.r.x + b.r.width - 2
      && a.r.y + a.r.height >= b.r.y + b.r.height - 2;
    const outermost = (items) => {
      // Drop a canvas host that contains 2+ candidates, then keep only the
      // outermost candidate at each location.
      let level = items.filter((c) =>
        items.filter((o) => o !== c && contains(c, o)).length < 2);
      level = level.filter((c) => !level.some((o) => o !== c && contains(o, c)));
      // Reading order: top-to-bottom rows, left-to-right.
      return level.sort((a, b) => (Math.abs(a.r.y - b.r.y) > 40 ? a.r.y - b.r.y : a.r.x - b.r.x));
    };
    const collect = (selector) => deepQueryAll(selector, root)
      .map((el) => {
        let r;
        try { r = el.getBoundingClientRect(); } catch (_) { return null; }
        return { el, r, design: designSizeFor(el, r) };
      })
      .filter(Boolean)
      .filter(({ el, r }) => r.width >= 40 && r.height >= 40 && isVisible(el));

    // Strong, purpose-built artboard attributes are authoritative. Generic
    // [data-label] is deliberately *not*: web apps commonly label individual
    // panels/components, and treating every labelled 140×100 box as a screen
    // discarded the rest of the page.
    const strong = outermost(collect(STRONG_ARTBOARD_SELECTOR)
      .filter(({ design }) => design.w >= 140 && design.h >= 100
        && design.w * design.h >= 14000));
    if (strong.length) {
      artboardDetectionMethod = 'labelled';
      return strong.map((c) => c.el);
    }

    const weak = outermost(collect('[data-label]')
      .filter(({ design }) => design.w >= thresholds.minW
        && design.h >= thresholds.minH
        && design.w * design.h >= thresholds.minArea));
    if (weak.length >= 2) {
      artboardDetectionMethod = 'labelled';
      return weak.map((c) => c.el);
    }
    if (weak.length === 1) {
      const only = weak[0];
      const view = rootDoc.defaultView || window;
      const rootW = Math.max(
        Number(view.innerWidth || 0),
        Number((rootDoc.body && rootDoc.body.scrollWidth) || 0),
        Number((rootDoc.documentElement && rootDoc.documentElement.scrollWidth) || 0));
      const rootH = Math.max(
        Number(view.innerHeight || 0),
        Number((rootDoc.body && rootDoc.body.scrollHeight) || 0),
        Number((rootDoc.documentElement && rootDoc.documentElement.scrollHeight) || 0));
      const rootArea = Math.max(1, rootW * rootH);
      const descriptor = artboardDescriptor(only.el);
      const coversRoot = (only.design.w * only.design.h) / rootArea >= 0.35;
      const screenNamed = /(artboard|screen|slide|canvas|frame)/.test(descriptor);
      if (coversRoot || screenNamed) {
        artboardDetectionMethod = 'labelled';
        return [only.el];
      }
    }

    const visual = findVisualArtboards(root);
    artboardDetectionMethod = visual.length ? 'visual' : 'none';
    return visual;
  }

  function findNestedIframeArtboards() {
    const frames = deepQueryAll('iframe')
      .map((el) => {
        let area = 0;
        try { const r = el.getBoundingClientRect(); area = r.width * r.height; } catch (_) { area = 0; }
        return { el, area };
      })
      .filter(({ area }) => area > 0)
      .sort((a, b) => b.area - a.area);
    for (const { el } of frames.slice(0, 5)) {
      let doc = null;
      try { doc = el.contentDocument; } catch (_) { doc = null; }
      if (!doc || !doc.body || !doc.body.children.length) continue;
      const boards = findArtboards(doc);
      if (boards.length) {
        artboardDetectionMethod += '+iframe';
        return boards;
      }
    }
    artboardDetectionMethod = 'none';
    return [];
  }

  // The element carrying data-label is often the canvas *host*: artboard
  // label/frame chrome around the actual screen. When one descendant covers
  // most of the host and contains nearly all descendants, capture that
  // descendant instead, so the Figma slide is the screen itself. If a full-
  // size duplicate is found, leave the host in place here—the tree cleaner
  // merges it while preserving whichever layer owns bg/border/shadow.
  function findArtboardContentRoot(host) {
    if (!host || host.tagName === 'IFRAME') return host;
    let hostRect;
    try { hostRect = host.getBoundingClientRect(); } catch (_) { return host; }
    if (!hostRect || hostRect.width < 40 || hostRect.height < 40) return host;
    const all = deepQueryAll('*', host).filter((el) => el !== host && isVisible(el));
    if (all.length < 3) return host;

    const iframe = all.find((el) => {
      if (el.tagName !== 'IFRAME') return false;
      const r = el.getBoundingClientRect();
      return r.width >= hostRect.width * 0.9 && r.height >= hostRect.height * 0.55
        && (r.width * r.height) >= (hostRect.width * hostRect.height) * 0.5;
    });
    if (iframe) return iframe;

    const candidates = [];
    for (const el of all) {
      if (['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'SLOT', 'BUTTON'].includes(el.tagName)) continue;
      let r;
      try { r = el.getBoundingClientRect(); } catch (_) { continue; }
      const widthRatio = r.width / hostRect.width;
      const heightRatio = r.height / hostRect.height;
      // A label strip can sit above/beside the screen, but an actual screen
      // should still span nearly the full host on at least one axis.
      if (!((widthRatio >= 0.88 && heightRatio >= 0.62)
        || (heightRatio >= 0.88 && widthRatio >= 0.62))) continue;
      if (r.x < hostRect.x - 4 || r.y < hostRect.y - 4
        || r.x + r.width > hostRect.x + hostRect.width + 4
        || r.y + r.height > hostRect.y + hostRect.height + 4) continue;
      const coverage = (r.width * r.height) / (hostRect.width * hostRect.height);
      if (coverage < 0.58 || coverage > 1.03) continue;
      candidates.push({ el, coverage });
    }
    candidates.sort((a, b) => b.coverage - a.coverage);

    let best = null;
    for (const candidate of candidates.slice(0, 10)) {
      let share = 0;
      try { share = deepQueryAll('*', candidate.el).length / Math.max(1, all.length); } catch (_) { share = 0; }
      if (share < 0.78) continue;
      const cls = typeof candidate.el.className === 'string' ? candidate.el.className : '';
      const descriptor = `${candidate.el.tagName} ${candidate.el.id || ''} ${cls} ${candidate.el.getAttribute('data-label') || ''}`.toLowerCase();
      let score = share * 2 + candidate.coverage;
      if (/(artboard|screen|canvas|stage|preview|viewport|content|frame)/.test(descriptor)) score += 0.18;
      if (/(toolbar|header|label|controls|chrome)/.test(descriptor)) score -= 0.5;
      if (!best || score > best.score) best = { ...candidate, share, score };
    }
    return best && best.coverage <= 0.985 ? best.el : host;
  }

  function serializeArtboard(el, ctx) {
    const contentRoot = findArtboardContentRoot(el);
    if (contentRoot !== el && ctx.report) ctx.report.contentRootsStripped += 1;
    if (contentRoot.tagName === 'IFRAME') {
      return buildIframeNode(contentRoot, { ...ctx, discount: getEffectiveScale(el) });
    }
    return serializeElement(contentRoot, { ...ctx, discount: getEffectiveScale(contentRoot) });
  }

  function captureArtboards(artboards, ctx, onProgress, captureOptions) {
    const entries = artboards.map((el, originalIndex) => ({ el, originalIndex }))
      .filter(({ originalIndex }) => !captureOptions || captureOptions.scope === 'full'
        || captureOptions.selectedIndexes.includes(originalIndex));
    if (!entries.length) return null;
    if (ctx.report) ctx.report.selectedArtboards = entries.length;
    const slides = entries.map(({ el, originalIndex }, done) => {
      const node = el.tagName === 'IFRAME'
        ? buildIframeNode(el, { ...ctx, discount: getEffectiveScale(el) })
        : serializeArtboard(el, ctx);
      node.role = 'slide';
      node.clips = true;
      node.name = artboardNameFor(el, `Screen ${originalIndex + 1}`).slice(0, 60);
      onProgress(done + 1, entries.length);
      return node;
    });
    return assembleDeck(slides);
  }

  function countSlides(root) {
    if (root.role === 'deck') return (root.children || []).filter((c) => c.role === 'slide').length || 1;
    return 1;
  }


  // ------------------------------------------------------- layer cleanup
  // Web pages are full of wrapper <div>s that do nothing visually. In Figma
  // they become pointless nested frames. This pass removes them while
  // keeping every visible layer and position. Anything decorated (fill,
  // stroke, shadow, radius, opacity, clipping) or structural is kept.
  function hasDecoration(n) {
    return !!(n.fill || n.stroke || (n.shadows && n.shadows.length)
      || n.cornerRadius || n.cornerRadii);
  }

  function isPlainWrapper(n) {
    return n.type === 'FRAME' && !n.role && !hasDecoration(n)
      && (n.opacity == null || n.opacity === 1) && !n.clips;
  }

  function isDecorationFreeWrapper(n) {
    return n.type === 'FRAME' && !n.role && !hasDecoration(n)
      && (n.opacity == null || n.opacity === 1);
  }

  function sameRect(a, b) {
    return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1
      && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;
  }

  function childrenWithin(frame) {
    const b = descendantBounds(frame);
    if (!b) return true;
    return b.minX >= frame.rect.x - 1 && b.minY >= frame.rect.y - 1
      && b.maxX <= frame.rect.x + frame.rect.w + 1
      && b.maxY <= frame.rect.y + frame.rect.h + 1;
  }

  function sameFill(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === 'SOLID') return a.color === b.color;
    if (a.type === 'IMAGE') return (a.bytes || '') === (b.bytes || '');
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function sameStroke(a, b) {
    if (!a || !b || a.color !== b.color || a.width !== b.width
      || !!a.dashed !== !!b.dashed) return false;
    return JSON.stringify(a.perSide || null) === JSON.stringify(b.perSide || null);
  }

  function cornerSignature(n) {
    if (n.cornerRadius != null) return `r:${n.cornerRadius}`;
    if (n.cornerRadii) return `r:${n.cornerRadii.tl},${n.cornerRadii.tr},${n.cornerRadii.br},${n.cornerRadii.bl}`;
    return '';
  }

  // Outer artboard host + identical inner screen is the most common source
  // of duplicate frames. Merge them only when their visual properties do
  // not conflict; the surviving node inherits role/name/clip/positioning
  // from the outer node and content/layout from the inner node.
  function mergeSingleChildFrame(frame) {
    if (!frame || frame.type !== 'FRAME' || !frame.children || frame.children.length !== 1) return null;
    const only = frame.children[0];
    if (!only || only.type !== 'FRAME' || !sameRect(frame.rect, only.rect)) return null;
    const pad = (frame.layout && frame.layout.padding) || {};
    if (frame.layout && frame.layout.mode !== 'NONE'
      && ['top', 'right', 'bottom', 'left'].some((k) => Math.abs(pad[k] || 0) > 1)) return null;
    if (frame.fill && only.fill && !sameFill(frame.fill, only.fill)) return null;
    if (frame.stroke && only.stroke && !sameStroke(frame.stroke, only.stroke)) return null;
    const fc = cornerSignature(frame), oc = cornerSignature(only);
    if (fc && oc && fc !== oc) return null;
    // With two painted backgrounds, corners must already agree: the inner
    // fill determines the visible silhouette unless the outer frame clips.
    if (frame.fill && only.fill && fc !== oc && !frame.clips) return null;
    const hadOnlyFill = !!only.fill;

    if (!only.fill && frame.fill) only.fill = frame.fill;
    if (!only.stroke && frame.stroke) only.stroke = frame.stroke;
    // Only inherit an outer radius when it supplied the background shape or
    // was an actual clipping boundary; a transparent non-clipping wrapper's
    // radius does not round a square child in CSS.
    if (!oc && fc && (!hadOnlyFill || frame.clips)) {
      if (frame.cornerRadius != null) only.cornerRadius = frame.cornerRadius;
      if (frame.cornerRadii) only.cornerRadii = frame.cornerRadii;
    }
    const shadows = [...(frame.shadows || []), ...(only.shadows || [])];
    if (shadows.length) only.shadows = shadows;
    if (frame.opacity != null && only.opacity != null) only.opacity = round2(frame.opacity * only.opacity);
    else if (frame.opacity != null) only.opacity = frame.opacity;
    only.clips = !!(frame.clips || only.clips);
    if (frame.absolute) only.absolute = true; else delete only.absolute;
    if (frame.zIndex != null) only.zIndex = frame.zIndex; else delete only.zIndex;
    if (frame.role) {
      only.role = frame.role;
      only.name = frame.name || only.name;
      only.clips = true;
    } else if (frame.name && /^(div|span|section|main)(\.|$)/.test(only.name || '')) {
      only.name = frame.name;
    }
    return only;
  }

  function pruneTree(node, parentMode = 'NONE') {
    if (!node.children) return node;
    const mode = (node.layout && node.layout.mode) || 'NONE';
    const out = [];
    for (const child of node.children) {
      const p = pruneTree(child, mode);
      const kids = p.children || [];
      if (p.type === 'FRAME' && !p.role && kids.length === 0 && !hasDecoration(p)) {
        continue; // invisible empty
      }

      const merged = mergeSingleChildFrame(p);
      if (merged) { out.push(merged); continue; }

      const visuallyFree = isPlainWrapper(p)
        || (isDecorationFreeWrapper(p) && (!p.clips || childrenWithin(p)));
      if (visuallyFree && kids.length > 0) {
        const wrapperMode = (p.layout && p.layout.mode) || 'NONE';
        if (kids.length === 1) {
          const only = kids[0];
          if (mode === 'NONE' || (sameRect(p.rect, only.rect) && !p.absolute)) {
            if (p.zIndex != null && only.zIndex == null) only.zIndex = p.zIndex;
            if (p.absolute && only.absolute == null) only.absolute = p.absolute;
            out.push(only);
            continue;
          }
        } else if (wrapperMode === 'NONE' && mode === 'NONE' && !p.absolute) {
          out.push(...kids);
          continue;
        }
      }
      out.push(p);
    }
    node.children = out;
    return mergeSingleChildFrame(node) || node;
  }

  function deviation(values) {
    return values.length ? Math.max(...values) - Math.min(...values) : 0;
  }

  function inferredLayoutCandidate(node, kids, vertical) {
    const primaryStart = (c) => vertical ? c.rect.y : c.rect.x;
    const primarySize = (c) => vertical ? c.rect.h : c.rect.w;
    const crossStart = (c) => vertical ? c.rect.x : c.rect.y;
    const crossSize = (c) => vertical ? c.rect.w : c.rect.h;
    const nodePrimaryStart = vertical ? node.rect.y : node.rect.x;
    const nodePrimarySize = vertical ? node.rect.h : node.rect.w;
    const nodeCrossStart = vertical ? node.rect.x : node.rect.y;
    const nodeCrossSize = vertical ? node.rect.w : node.rect.h;

    const gaps = [];
    for (let i = 1; i < kids.length; i += 1) {
      const prev = kids[i - 1], next = kids[i];
      const gap = primaryStart(next) - (primaryStart(prev) + primarySize(prev));
      if (gap < -1) return null;
      gaps.push(Math.max(0, gap));
    }
    if (deviation(gaps) > 2) return null;

    const alignValues = {
      MIN: kids.map((c) => crossStart(c) - nodeCrossStart),
      CENTER: kids.map((c) => (crossStart(c) + crossSize(c) / 2) - nodeCrossStart),
      MAX: kids.map((c) => (nodeCrossStart + nodeCrossSize) - (crossStart(c) + crossSize(c))),
    };
    const counterAlign = ['MIN', 'CENTER', 'MAX'].find((a) => deviation(alignValues[a]) <= 2);
    if (!counterAlign) return null;

    const first = kids[0], last = kids[kids.length - 1];
    const primaryBefore = primaryStart(first) - nodePrimaryStart;
    const primaryAfter = (nodePrimaryStart + nodePrimarySize) - (primaryStart(last) + primarySize(last));
    const maxCross = Math.max(...kids.map(crossSize));
    let crossBefore, crossAfter;
    const avg = (vals) => vals.reduce((a, b) => a + b, 0) / vals.length;
    if (counterAlign === 'MIN') {
      crossBefore = avg(alignValues.MIN);
      crossAfter = nodeCrossSize - crossBefore - maxCross;
    } else if (counterAlign === 'MAX') {
      crossAfter = avg(alignValues.MAX);
      crossBefore = nodeCrossSize - crossAfter - maxCross;
    } else {
      crossBefore = crossAfter = (nodeCrossSize - maxCross) / 2;
    }
    if ([primaryBefore, primaryAfter, crossBefore, crossAfter].some((v) => v < -1)) return null;
    const clean = (v) => round2(Math.max(0, v));
    return {
      mode: vertical ? 'VERTICAL' : 'HORIZONTAL',
      gap: clean(gaps.length ? avg(gaps) : 0),
      padding: vertical
        ? { top: clean(primaryBefore), right: clean(crossAfter), bottom: clean(primaryAfter), left: clean(crossBefore) }
        : { top: clean(crossBefore), right: clean(primaryAfter), bottom: clean(crossAfter), left: clean(primaryBefore) },
      primaryAlign: 'MIN',
      counterAlign,
    };
  }

  // Recover Auto Layout for normal block stacks only when Figma's single
  // uniform gap can reproduce them without moving layers. Deliberately
  // strict: no overlap, one shared cross alignment, one shared gap, DOM
  // order already visual order, and exactly one plausible axis.
  function inferAutoLayouts(node, report) {
    for (const child of node.children || []) inferAutoLayouts(child, report);
    if (!node || node.type !== 'FRAME' || node.role === 'deck') return;
    if (node.layout && node.layout.mode !== 'NONE') return;
    const kids = node.children || [];
    if (kids.length < 2) return;
    if (kids.some((c) => c.absolute || c.zIndex != null || !c.rect || c.rect.w <= 0 || c.rect.h <= 0)) return;
    const vertical = inferredLayoutCandidate(node, kids, true);
    const horizontal = inferredLayoutCandidate(node, kids, false);
    if (!!vertical === !!horizontal) return;
    node.layout = vertical || horizontal;
    if (report) report.inferredAutoLayouts += 1;
  }

  function descendantBounds(node) {
    let bounds = null;
    (function walk(n) {
      for (const c of n.children || []) {
        const r = c.rect;
        if (r && (r.w > 0 || r.h > 0)) {
          bounds = bounds || { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h };
          bounds.minX = Math.min(bounds.minX, r.x);
          bounds.minY = Math.min(bounds.minY, r.y);
          bounds.maxX = Math.max(bounds.maxX, r.x + r.w);
          bounds.maxY = Math.max(bounds.maxY, r.y + r.h);
        }
        walk(c);
      }
    })(node);
    return bounds;
  }

  // Top-level slides/pages keep the exact CSS box that was measured.
  // Descendants that overflow (common with clipped artboards, decorative
  // blobs and scroll regions) must not inflate the Figma frame size.
  function fitFrameToContent(frame) {
    frame.rect.w = Math.max(1, Math.round(frame.rect.w));
    frame.rect.h = Math.max(1, Math.round(frame.rect.h));
    frame.clips = true;
  }

  function normalizeCapturedTree(tree) {
    if (tree.role === 'deck') {
      for (const slide of tree.children || []) fitFrameToContent(slide);
    } else {
      translate(tree, -tree.rect.x, -tree.rect.y);
      fitFrameToContent(tree);
    }
  }

  function countTree(node) {
    const byType = { FRAME: 0, TEXT: 0, IMAGE: 0, VECTOR: 0 };
    let total = 0, autoLayoutFrames = 0, leafFrames = 0;
    (function walk(n) {
      total += 1;
      if (byType[n.type] != null) byType[n.type] += 1;
      if (n.type === 'FRAME' && n.layout && n.layout.mode !== 'NONE') autoLayoutFrames += 1;
      if (n.type === 'FRAME' && !n.role && !(n.children || []).length) leafFrames += 1;
      for (const c of n.children || []) walk(c);
    })(node);
    return { total, byType, autoLayoutFrames, leafFrames };
  }

  // ------------------------------------------------------------------ run
  function sanitizeCaptureOptions(raw) {
    const captureId = raw && typeof raw.captureId === 'string'
      && /^[A-Za-z0-9._:-]{8,128}$/.test(raw.captureId) ? raw.captureId : '';
    if (raw && raw.scope === 'page') return { scope: 'page', captureId };
    if (!raw || !['selected', 'single'].includes(raw.scope)) return { scope: 'full', captureId };
    const selectedIndexes = [...new Set(
      (Array.isArray(raw.selectedIndexes) ? raw.selectedIndexes : [])
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < 10000),
    )].sort((a, b) => a - b);
    return raw.scope === 'single'
      ? { scope: 'single', selectedIndexes: selectedIndexes.slice(0, 1), captureId }
      : { scope: 'selected', selectedIndexes, captureId };
  }

  function readCaptureOptions() {
    let raw = null;
    try {
      raw = globalThis.__CLAUDE2FIGMA_CAPTURE_OPTIONS__ || null;
      delete globalThis.__CLAUDE2FIGMA_CAPTURE_OPTIONS__;
    } catch (_) { raw = null; }
    if (!raw && document.documentElement) {
      const attr = document.documentElement.getAttribute('data-claude2figma-capture-options');
      if (attr) { try { raw = JSON.parse(attr); } catch (_) { raw = null; } }
    }
    if (document.documentElement) {
      document.documentElement.removeAttribute('data-claude2figma-capture-options');
    }
    return sanitizeCaptureOptions(raw);
  }

  async function buildTree(ctx, onProgress) {
    const captureOptions = readCaptureOptions();
    ctx.captureOptions = captureOptions;
    if (ctx.report) {
      ctx.report.scope = captureOptions.scope;
      if (captureOptions.captureId) ctx.report.captureId = captureOptions.captureId;
      ctx.report.selectedArtboards = ['selected', 'single'].includes(captureOptions.scope)
        ? captureOptions.selectedIndexes.length : 0;
    }
    const wholePage = captureOptions.scope === 'page';
    const stage = wholePage ? null : (document.querySelector(DECK_STAGE_SELECTOR)
      || deepQueryAll(DECK_STAGE_SELECTOR)[0] || null);
    if (stage) {
      const info = readStage(stage);
      if (info) {
        ctx.report.mode = 'slides';
        ctx.report.detectionMethod = 'deck-stage';
        return captureDeckStage(stage, info, ctx, onProgress, captureOptions);
      }
    }

    let artboards = wholePage ? [] : findArtboards();
    if (!wholePage && !artboards.length) artboards = findNestedIframeArtboards();
    if (ctx.report) ctx.report.detectionMethod = artboardDetectionMethod;
    if (artboards.length >= 2) {
      ctx.report.mode = 'artboards';
      ctx.report.artboardsDetected = artboards.length;
      const selectedTree = captureArtboards(artboards, ctx, onProgress, captureOptions);
      if (selectedTree) return selectedTree;
      if (captureOptions.scope !== 'full') {
        throw new Error('The chosen artboard is no longer available. Re-open Claude2Figma and choose it again.');
      }
    }
    if (artboards.length === 1) {
      ctx.report.mode = 'artboards';
      ctx.report.artboardsDetected = 1;
      const el = artboards[0];
      const node = el.tagName === 'IFRAME'
        ? buildIframeNode(el, { ...ctx, discount: getEffectiveScale(el) })
        : serializeArtboard(el, ctx);
      node.role = 'slide';
      node.name = artboardNameFor(el, document.title || 'Screen').trim().slice(0, 60);
      translate(node, -node.rect.x, -node.rect.y);
      onProgress(1, 1);
      return node;
    }

    ctx.report.mode = 'page';
    const anchor = document.querySelector('section.slide, .frame > section, main, [data-label]');
    const discount = anchor ? getEffectiveScale(anchor) : getEffectiveScale(document.body);
    const root = serializeElement(document.body, { ...ctx, discount });
    root.role = 'page';
    root.name = (document.title || 'Page').slice(0, 60);
    translate(root, -root.rect.x, -root.rect.y);
    if (root.rect.w < 1 || root.rect.h < 1) {
      throw new Error('Nothing visible to capture on this page.');
    }
    onProgress(1, 1);
    return root;
  }

  async function run() {
    let ctx = { imageRefs: [], discount: 1, report: newReport() };
    try {
      ctx.report.frameUrl = String(location.href || '');
      let tree = await buildTree(ctx, (done, total) => {
        try {
          chrome.runtime.sendMessage({
            type: 'capture-progress',
            captureId: (ctx.captureOptions && ctx.captureOptions.captureId) || '',
            payload: { done, total },
          });
        } catch (_) { /* popup may be closed */ }
      });
      // Clean layer tree + exact frame sizes (the report then recounts
      // what will actually land in Figma, not what was read from the DOM).
      const createdNodes = ctx.report.nodes;
      tree = pruneTree(tree);
      inferAutoLayouts(tree, ctx.report);
      normalizeCapturedTree(tree);
      const recount = countTree(tree);
      ctx.report.layersRemoved = Math.max(0, createdNodes - recount.total);
      ctx.report.nodes = recount.total;
      ctx.report.byType = recount.byType;
      ctx.report.autoLayoutFrames = recount.autoLayoutFrames;
      ctx.report.leafFrames = recount.leafFrames;
      const stats = await resolveImageBytes(ctx.imageRefs);
      ctx.report.imagesFetched = stats.fetched;
      ctx.report.imagesFailed = stats.failed;
      const payload = {
        schema: 'claude2figma',
        schemaVersion: SCHEMA_VERSION,
        title: document.title || '',
        sourceUrl: location.href,
        capturedAt: new Date().toISOString(),
        slideCount: countSlides(tree),
        captureReport: ctx.report,
        root: tree,
      };
      const captureId = (ctx.captureOptions && ctx.captureOptions.captureId) || '';
      chrome.runtime.sendMessage({
        type: 'capture-result',
        captureId,
        payload: { ok: true, json: JSON.stringify(payload), title: payload.title, stats, captureId },
      });
    } catch (error) {
      let captureId = (ctx.captureOptions && ctx.captureOptions.captureId) || '';
      if (!captureId) {
        try {
          const raw = globalThis.__CLAUDE2FIGMA_CAPTURE_OPTIONS__
            || JSON.parse(document.documentElement.getAttribute('data-claude2figma-capture-options') || 'null');
          captureId = sanitizeCaptureOptions(raw).captureId || '';
        } catch (_) { captureId = ''; }
      }
      chrome.runtime.sendMessage({
        type: 'capture-result',
        captureId,
        payload: error instanceof DeckStageError
          ? { ok: false, error: error.message, kind: 'slides-mode', captureId }
          : { ok: false, error: 'Capture failed: ' + String(error && error.message ? error.message : error), captureId },
      });
    }
  }

  run();
})();
