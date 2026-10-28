// Claude2Figma — Figma plugin (sandbox)
// Rebuilds a captured .deck.json as native, editable Figma layers.
// Fully offline: images arrive base64-inlined in the file, fonts are the
// ones already available in Figma. No network, no account, no limits.
//
// File format: see shared/SCHEMA.md

'use strict';

figma.showUI(__html__, { width: 380, height: 640, themeColors: true });

const PLUGIN_VERSION = '1.7.0';

// ================================================================= color
const NAMED_COLORS = {
  black: [0, 0, 0, 1], white: [255, 255, 255, 1], red: [255, 0, 0, 1],
  green: [0, 128, 0, 1], blue: [0, 0, 255, 1], yellow: [255, 255, 0, 1],
  orange: [255, 165, 0, 1], purple: [128, 0, 128, 1], pink: [255, 192, 203, 1],
  gray: [128, 128, 128, 1], grey: [128, 128, 128, 1], silver: [192, 192, 192, 1],
  transparent: [0, 0, 0, 0],
};

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return s === 0 ? [l, l, l] : [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

// --- wide-gamut CSS colors (Claude designs lean on oklch heavily; Chrome
// returns computed colors in the authored space, so rgb()/hex is not enough)
function srgbEncode(c) {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function oklabToRgb(L, a, b, alpha) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  return {
    r: srgbEncode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: srgbEncode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: srgbEncode(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    a: alpha,
  };
}

function labToRgb(Lpct, a, b, alpha) {
  const fy = (Lpct + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const finv = (t) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  const X = finv(fx) * 0.95047, Y = finv(fy), Z = finv(fz) * 1.08883; // D65
  return {
    r: srgbEncode(3.2406 * X - 1.5372 * Y - 0.4986 * Z),
    g: srgbEncode(-0.9689 * X + 1.8758 * Y + 0.0415 * Z),
    b: srgbEncode(0.0557 * X - 0.2040 * Y + 1.0570 * Z),
    a: alpha,
  };
}

function splitColorArgs(inner) {
  // Split "a b c / alpha" (or comma syntax) into components + alpha.
  const [main, alphaRaw] = inner.split('/');
  const parts = main.trim().split(/[\s,]+/).filter(Boolean);
  let alpha = 1;
  if (alphaRaw != null && alphaRaw.trim() !== '') {
    const t = alphaRaw.trim();
    alpha = t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t);
  } else if (parts.length > 3) {
    const t = parts.pop();
    alpha = t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t);
  }
  return { parts, alpha: isNaN(alpha) ? 1 : Math.min(1, Math.max(0, alpha)) };
}

function hueToDeg(token) {
  if (token.endsWith('turn')) return parseFloat(token) * 360;
  if (token.endsWith('rad')) return (parseFloat(token) * 180) / Math.PI;
  if (token.endsWith('grad')) return parseFloat(token) * 0.9;
  return parseFloat(token);
}

function parseColorMix(v) {
  const open = v.indexOf('(');
  const inner = v.slice(open + 1, v.lastIndexOf(')'));
  const segments = [];
  let depth = 0, current = '';
  for (const ch of inner) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { segments.push(current); current = ''; }
    else current += ch;
  }
  if (current.trim()) segments.push(current);
  const colorSegs = segments.filter((s) => !/^\s*in\b/.test(s)).map((s) => s.trim());
  if (colorSegs.length < 2) return null;
  const parsed = colorSegs.slice(0, 2).map((seg) => {
    const pm = seg.match(/(-?[\d.]+)%\s*$/);
    const pct = pm ? parseFloat(pm[1]) : null;
    const color = parseColor(pm ? seg.slice(0, pm.index).trim() : seg);
    return { color, pct };
  });
  if (!parsed[0].color || !parsed[1].color) return null;
  let [w1, w2] = [parsed[0].pct, parsed[1].pct];
  if (w1 == null && w2 == null) { w1 = 50; w2 = 50; }
  else if (w1 == null) w1 = 100 - w2;
  else if (w2 == null) w2 = 100 - w1;
  const total = (w1 + w2) || 100;
  const c1 = parsed[0].color, c2 = parsed[1].color;
  const mix = (x, y) => (x * w1 + y * w2) / total;
  return { r: mix(c1.r, c2.r), g: mix(c1.g, c2.g), b: mix(c1.b, c2.b), a: mix(c1.a, c2.a) };
}

// CSS color string -> { r, g, b, a } with 0..1 channels, or null.
function parseColor(input) {
  if (!input || typeof input !== 'string') return null;
  const v = input.trim().toLowerCase();

  if (NAMED_COLORS[v]) {
    const [r, g, b, a] = NAMED_COLORS[v];
    return { r: r / 255, g: g / 255, b: b / 255, a };
  }
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }

  if (v.startsWith('color-mix(')) return parseColorMix(v);

  const fn = v.match(/^([a-z-]+)\((.*)\)$/s);
  if (!fn) return null;
  const name = fn[1];

  if (name === 'rgb' || name === 'rgba' || name === 'hsl' || name === 'hsla') {
    const { parts, alpha } = splitColorArgs(fn[2]);
    if (parts.length < 3) return null;
    if (name.startsWith('rgb')) {
      const chan = (s) => (s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s) / 255);
      return { r: chan(parts[0]), g: chan(parts[1]), b: chan(parts[2]), a: alpha };
    }
    const [r, g, b] = hslToRgb(hueToDeg(parts[0]),
      parseFloat(parts[1]) / 100, parseFloat(parts[2]) / 100);
    return { r, g, b, a: alpha };
  }

  if (name === 'hwb') {
    const { parts, alpha } = splitColorArgs(fn[2]);
    if (parts.length < 3) return null;
    const [pr, pg, pb] = hslToRgb(hueToDeg(parts[0]), 1, 0.5);
    const w = parseFloat(parts[1]) / 100, bl = parseFloat(parts[2]) / 100;
    const sum = w + bl >= 1 ? w + bl : 1;
    const f = (c) => (w + bl >= 1 ? w / sum : c * (1 - w - bl) + w);
    return { r: f(pr), g: f(pg), b: f(pb), a: alpha };
  }

  if (name === 'oklch' || name === 'oklab') {
    const { parts, alpha } = splitColorArgs(fn[2]);
    if (parts.length < 3) return null;
    const L = parts[0].endsWith('%') ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]);
    if (name === 'oklab') {
      return oklabToRgb(L, parseFloat(parts[1]), parseFloat(parts[2]), alpha);
    }
    const C = parseFloat(parts[1]);
    const H = (hueToDeg(parts[2]) * Math.PI) / 180;
    return oklabToRgb(L, C * Math.cos(H), C * Math.sin(H), alpha);
  }

  if (name === 'lab' || name === 'lch') {
    const { parts, alpha } = splitColorArgs(fn[2]);
    if (parts.length < 3) return null;
    const L = parseFloat(parts[0]);
    if (name === 'lab') return labToRgb(L, parseFloat(parts[1]), parseFloat(parts[2]), alpha);
    const C = parseFloat(parts[1]);
    const H = (hueToDeg(parts[2]) * Math.PI) / 180;
    return labToRgb(L, C * Math.cos(H), C * Math.sin(H), alpha);
  }

  if (name === 'color') {
    // color(display-p3 r g b / a) etc. — approximated as sRGB channels.
    const tokens = fn[2].trim().split(/\s+/);
    const nums = tokens.slice(1).join(' ');
    const { parts, alpha } = splitColorArgs(nums);
    if (parts.length < 3) return null;
    const clamp01 = (s) => Math.min(1, Math.max(0, parseFloat(s)));
    return { r: clamp01(parts[0]), g: clamp01(parts[1]), b: clamp01(parts[2]), a: alpha };
  }

  return null;
}

function solidPaint(colorString) {
  const c = parseColor(colorString);
  if (!c) return null;
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
}

// CSS linear-gradient angle (0 = to top, 180 = to bottom) -> Figma transform.
function linearGradientTransform(angleDeg) {
  const rad = ((angleDeg || 180) * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  return [
    [dx, dy, 0.5 - 0.5 * dx - 0.5 * dy],
    [-dy, dx, 0.5 + 0.5 * dy - 0.5 * dx],
  ];
}

function gradientPaint(fill) {
  const stops = (fill.stops || [])
    .map((s) => {
      const c = parseColor(s.color);
      if (!c) return null;
      return {
        position: Math.min(1, Math.max(0, s.position || 0)),
        color: { r: c.r, g: c.g, b: c.b, a: c.a },
      };
    })
    .filter(Boolean);
  if (stops.length < 2) return stops.length === 1
    ? { type: 'SOLID', color: { r: stops[0].color.r, g: stops[0].color.g, b: stops[0].color.b }, opacity: stops[0].color.a }
    : null;
  if (fill.type === 'GRADIENT_LINEAR') {
    return {
      type: 'GRADIENT_LINEAR', gradientStops: stops,
      gradientTransform: linearGradientTransform(fill.angle),
    };
  }
  return {
    type: 'GRADIENT_RADIAL', gradientStops: stops,
    gradientTransform: [[1, 0, 0], [0, 1, 0]],
  };
}

// ================================================================ base64
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i += 1) table[B64.charCodeAt(i)] = i;
  return table;
})();

function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return new Uint8Array(0);
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4) - padding);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_LOOKUP[clean.charCodeAt(i)];
    const c1 = B64_LOOKUP[clean.charCodeAt(i + 1)];
    const c2 = clean[i + 2] === '=' ? 0 : B64_LOOKUP[clean.charCodeAt(i + 2)];
    const c3 = clean[i + 3] === '=' ? 0 : B64_LOOKUP[clean.charCodeAt(i + 3)];
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < out.length) { out[o] = (triple >> 16) & 255; o += 1; }
    if (o < out.length) { out[o] = (triple >> 8) & 255; o += 1; }
    if (o < out.length) { out[o] = triple & 255; o += 1; }
  }
  return out;
}

// ================================================================= fonts
const GENERIC_FAMILIES = {
  'sans-serif': 'Inter', 'system-ui': 'Inter', '-apple-system': 'Inter',
  'ui-sans-serif': 'Inter', serif: 'Playfair Display', 'ui-serif': 'Playfair Display',
  monospace: 'Roboto Mono', 'ui-monospace': 'Roboto Mono',
  'Segoe UI': 'Inter', roboto: 'Roboto', 'Helvetica neue': 'Inter',
  Helvetica: 'Inter', Arial: 'Inter',
};

const WEIGHT_STYLES = [
  [100, ['Thin']], [200, ['ExtraLight', 'Extra Light']],
  [300, ['Light']], [400, ['Regular']],
  [500, ['Medium']], [600, ['SemiBold', 'Semi Bold']],
  [700, ['Bold']], [800, ['ExtraBold', 'Extra Bold']],
  [900, ['Black', 'Heavy']],
];

function styleCandidates(weight, italic) {
  const w = WEIGHT_STYLES.reduce((best, cur) =>
    (Math.abs(cur[0] - weight) < Math.abs(best[0] - weight) ? cur : best), WEIGHT_STYLES[3]);
  const names = [];
  for (const base of w[1]) {
    if (italic) names.push(base === 'Regular' ? 'Italic' : `${base} Italic`);
    names.push(base);
  }
  if (italic && !names.includes('Italic')) names.push('Italic');
  names.push('Regular');
  return [...new Set(names)];
}

const fontCache = new Map(); // "family|weight|italic" -> FontName | null

async function resolveFont(familyRaw, weight, italic, report) {
  const family = (GENERIC_FAMILIES[(familyRaw || '').toLowerCase()] || familyRaw || 'Inter').trim();
  const key = `${family}|${weight}|${italic ? 1 : 0}`;
  if (fontCache.has(key)) return fontCache.get(key);

  const familiesToTry = [...new Set([family, 'Inter', 'Roboto'])];
  for (const fam of familiesToTry) {
    for (const style of styleCandidates(weight, italic)) {
      const candidate = { family: fam, style };
      try {
        await figma.loadFontAsync(candidate);
        fontCache.set(key, candidate);
        if (fam !== family && report) report.missingFonts.add(family);
        return candidate;
      } catch (_) { /* try next candidate */ }
    }
  }
  fontCache.set(key, null);
  if (report) report.missingFonts.add(family);
  return null;
}

async function preloadFonts(root, report) {
  const combos = new Map();
  (function walk(node) {
    if (node.type === 'TEXT' && node.text) {
      for (const run of node.text.runs || []) {
        combos.set(`${run.fontFamily}|${run.fontWeight}|${run.italic ? 1 : 0}`, run);
      }
    }
    for (const child of node.children || []) walk(child);
  })(root);
  await Promise.all([...combos.values()].map((run) =>
    resolveFont(run.fontFamily, run.fontWeight || 400, !!run.italic, report)));
  // Inter Regular is the ultimate fallback and must be loaded.
  try { await figma.loadFontAsync({ family: 'Inter', style: 'Regular' }); } catch (_) { /* noop */ }
}

// =============================================================== builders
function applyFill(figmaNode, node, report) {
  const fill = node.fill;
  if (!fill) { figmaNode.fills = []; return; }
  if (fill.type === 'SOLID') {
    const paint = solidPaint(fill.color);
    figmaNode.fills = paint ? [paint] : [];
  } else if (fill.type === 'GRADIENT_LINEAR' || fill.type === 'GRADIENT_RADIAL') {
    const paint = gradientPaint(fill);
    figmaNode.fills = paint ? [paint] : [];
  } else if (fill.type === 'IMAGE') {
    const bytes = base64ToBytes(fill.bytes);
    if (bytes.length) {
      try {
        const image = figma.createImage(bytes);
        figmaNode.fills = [{
          type: 'IMAGE', imageHash: image.hash,
          scaleMode: node.imageScaleMode === 'FIT' ? 'FIT' : 'FILL',
        }];
        return;
      } catch (_) { /* fall through to placeholder */ }
    }
    report.failedImages += 1;
    figmaNode.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.88 }, opacity: 1 }];
  }
}

function applyStroke(figmaNode, node) {
  if (!node.stroke) return;
  const paint = solidPaint(node.stroke.color);
  if (!paint) return;
  figmaNode.strokes = [paint];
  figmaNode.strokeWeight = Math.max(0.1, node.stroke.width || 1);
  try { figmaNode.strokeAlign = 'INSIDE'; } catch (_) { /* noop */ }
  if (node.stroke.perSide) {
    const p = node.stroke.perSide;
    try {
      figmaNode.strokeTopWeight = p.top || 0;
      figmaNode.strokeRightWeight = p.right || 0;
      figmaNode.strokeBottomWeight = p.bottom || 0;
      figmaNode.strokeLeftWeight = p.left || 0;
    } catch (_) { /* uniform weight remains */ }
  }
  if (node.stroke.dashed) {
    const w = node.stroke.width || 1;
    try { figmaNode.dashPattern = [Math.max(4, w * 3), Math.max(3, w * 2)]; } catch (_) { /* noop */ }
  }
}

function applyEffects(figmaNode, node) {
  if (!node.shadows || !node.shadows.length) return;
  figmaNode.effects = node.shadows.map((sh) => {
    const c = parseColor(sh.color) || { r: 0, g: 0, b: 0, a: 0.25 };
    return {
      type: sh.inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: { r: c.r, g: c.g, b: c.b, a: c.a },
      offset: { x: sh.offsetX || 0, y: sh.offsetY || 0 },
      radius: Math.max(0, sh.blur || 0),
      spread: sh.spread || 0,
      visible: true,
      blendMode: 'NORMAL',
    };
  });
}

function applyCorners(figmaNode, node) {
  try {
    if (node.cornerRadii) {
      figmaNode.topLeftRadius = node.cornerRadii.tl || 0;
      figmaNode.topRightRadius = node.cornerRadii.tr || 0;
      figmaNode.bottomRightRadius = node.cornerRadii.br || 0;
      figmaNode.bottomLeftRadius = node.cornerRadii.bl || 0;
    } else if (node.cornerRadius != null) {
      figmaNode.cornerRadius = node.cornerRadius;
    }
  } catch (_) { /* node type may not support corners */ }
}

function safeResize(figmaNode, w, h) {
  try { figmaNode.resize(Math.max(0.01, w || 0.01), Math.max(0.01, h || 0.01)); } catch (_) { /* noop */ }
}

const importState = { cancelled: false, done: 0, total: 0 };

function reportProgress() {
  figma.ui.postMessage({
    type: 'progress', done: importState.done, total: importState.total,
  });
}

async function buildTextNode(node, report) {
  const text = figma.createText();
  text.name = node.name || 'Text';
  const runs = (node.text && node.text.runs) || [];

  const fallbackFont = { family: 'Inter', style: 'Regular' };
  text.fontName = (runs.length && await resolveFont(
    runs[0].fontFamily, runs[0].fontWeight || 400, !!runs[0].italic, report)) || fallbackFont;

  text.characters = runs.map((r) => r.content).join('');

  let offset = 0;
  for (const run of runs) {
    const start = offset;
    const end = offset + run.content.length;
    offset = end;
    if (start === end) continue;
    const font = await resolveFont(run.fontFamily, run.fontWeight || 400, !!run.italic, report);
    try { if (font) text.setRangeFontName(start, end, font); } catch (_) { /* noop */ }
    try { text.setRangeFontSize(start, end, Math.max(1, run.fontSize || 16)); } catch (_) { /* noop */ }
    if (!node.fill) {
      const paint = solidPaint(run.color);
      if (paint) { try { text.setRangeFills(start, end, [paint]); } catch (_) { /* noop */ } }
    }
    if (run.letterSpacing) {
      try {
        text.setRangeLetterSpacing(start, end, { value: run.letterSpacing, unit: 'PIXELS' });
      } catch (_) { /* noop */ }
    }
    if (run.lineHeight) {
      try {
        text.setRangeLineHeight(start, end, { value: run.lineHeight, unit: 'PIXELS' });
      } catch (_) { /* noop */ }
    }
    if (run.underline) {
      try { text.setRangeTextDecoration(start, end, 'UNDERLINE'); } catch (_) { /* noop */ }
    } else if (run.strikethrough) {
      try { text.setRangeTextDecoration(start, end, 'STRIKETHROUGH'); } catch (_) { /* noop */ }
    }
  }

  // Gradient text (CSS background-clip: text): one paint for the whole node.
  if (node.fill) {
    const paint = node.fill.type === 'SOLID' ? solidPaint(node.fill.color) : gradientPaint(node.fill);
    if (paint) text.fills = [paint];
  }

  const align = (node.text && node.text.align) || 'LEFT';
  text.textAlignHorizontal = ['LEFT', 'CENTER', 'RIGHT'].includes(align) ? align : 'LEFT';

  const lines = (node.text && node.text.lines) || 1;
  if (lines <= 1) {
    // Hug content: browser/Figma font metrics differ slightly; a fixed-width
    // single-line box would wrap or clip unpredictably.
    try { text.textAutoResize = 'WIDTH_AND_HEIGHT'; } catch (_) { /* noop */ }
  } else {
    try { text.textAutoResize = 'HEIGHT'; } catch (_) { /* noop */ }
    safeResize(text, node.rect.w, node.rect.h);
  }
  if (node.opacity != null) text.opacity = node.opacity;
  return text;
}

function buildImageNode(node, report) {
  const rect = figma.createRectangle();
  rect.name = node.name || 'Image';
  safeResize(rect, node.rect.w, node.rect.h);
  applyFill(rect, node, report);
  applyStroke(rect, node);
  applyEffects(rect, node);
  applyCorners(rect, node);
  if (node.opacity != null) rect.opacity = node.opacity;
  return rect;
}

function buildVectorNode(node, report) {
  try {
    const svgNode = figma.createNodeFromSvg(node.svg);
    svgNode.name = node.name || 'Vector';
    if (node.rect.w > 0 && svgNode.width > 0) {
      const scale = node.rect.w / svgNode.width;
      if (Math.abs(scale - 1) > 0.001) {
        if (typeof svgNode.rescale === 'function') svgNode.rescale(scale);
        else safeResize(svgNode, node.rect.w, node.rect.h);
      }
    }
    return svgNode;
  } catch (_) {
    report.failedVectors += 1;
    const placeholder = figma.createRectangle();
    placeholder.name = `${node.name || 'Vector'} (could not parse SVG)`;
    safeResize(placeholder, node.rect.w, node.rect.h);
    placeholder.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.8, b: 0.9 }, opacity: 1 }];
    return placeholder;
  }
}

function unwrapSingleChildSvg(parent, svgFrame, autoFlow) {
  if (!parent || !svgFrame || svgFrame.type !== 'FRAME' || svgFrame.clipsContent) return svgFrame;
  if ((svgFrame.fills && svgFrame.fills.length)
    || (svgFrame.strokes && svgFrame.strokes.length)
    || (svgFrame.effects && svgFrame.effects.length)) return svgFrame;
  if (typeof svgFrame.remove !== 'function'
    || (typeof parent.insertChild !== 'function' && typeof parent.appendChild !== 'function')) {
    return svgFrame;
  }
  const inner = svgFrame.children && svgFrame.children.length === 1 ? svgFrame.children[0] : null;
  const allowed = ['VECTOR', 'BOOLEAN_OPERATION', 'GROUP', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE'];
  if (!inner || !allowed.includes(inner.type)) return svgFrame;
  try {
    const index = Array.isArray(parent.children) ? parent.children.indexOf(svgFrame) : -1;
    const x = (svgFrame.x || 0) + (inner.x || 0);
    const y = (svgFrame.y || 0) + (inner.y || 0);
    const horizontalSizing = svgFrame.layoutSizingHorizontal;
    const verticalSizing = svgFrame.layoutSizingVertical;
    const positioning = svgFrame.layoutPositioning;
    if (index >= 0 && typeof parent.insertChild === 'function') parent.insertChild(index, inner);
    else parent.appendChild(inner);
    inner.name = svgFrame.name;
    if (autoFlow) {
      try {
        if (horizontalSizing) inner.layoutSizingHorizontal = horizontalSizing;
        if (verticalSizing) inner.layoutSizingVertical = verticalSizing;
      } catch (_) { /* keep defaults */ }
    } else {
      if (positioning) { try { inner.layoutPositioning = positioning; } catch (_) { /* noop */ } }
      inner.x = x;
      inner.y = y;
    }
    svgFrame.remove();
    return inner;
  } catch (_) {
    return svgFrame;
  }
}

function buildLeafFrameNode(node, report) {
  const shape = figma.createRectangle();
  shape.name = node.name || 'Rectangle';
  safeResize(shape, node.rect.w, node.rect.h);
  applyFill(shape, node, report);
  applyStroke(shape, node);
  applyEffects(shape, node);
  applyCorners(shape, node);
  if (node.opacity != null) shape.opacity = node.opacity;
  return shape;
}

function autoLayoutContentExtent(node) {
  const layout = node.layout || {};
  if (node.type !== 'FRAME' || layout.wrap
    || (layout.mode !== 'HORIZONTAL' && layout.mode !== 'VERTICAL')) return null;
  const flow = (node.children || []).filter((c) => !c.absolute && c.rect);
  if (!flow.length) return null;
  const pad = layout.padding || {};
  const vertical = layout.mode === 'VERTICAL';
  const primarySizes = flow.map((c) => vertical ? c.rect.h || 0 : c.rect.w || 0);
  const crossSizes = flow.map((c) => vertical ? c.rect.w || 0 : c.rect.h || 0);
  const primary = (vertical ? (pad.top || 0) + (pad.bottom || 0) : (pad.left || 0) + (pad.right || 0))
    + primarySizes.reduce((a, b) => a + b, 0) + (layout.gap || 0) * Math.max(0, flow.length - 1);
  const cross = (vertical ? (pad.left || 0) + (pad.right || 0) : (pad.top || 0) + (pad.bottom || 0))
    + Math.max(...crossSizes);
  return vertical ? { w: cross, h: primary } : { w: primary, h: cross };
}

async function buildFrameNode(node, report) {
  if (!node.role && !(node.children || []).length) return buildLeafFrameNode(node, report);
  const frame = figma.createFrame();
  frame.name = node.name || 'Frame';
  safeResize(frame, node.rect.w, node.rect.h);
  applyFill(frame, node, report);
  applyStroke(frame, node);
  applyEffects(frame, node);
  applyCorners(frame, node);
  if (node.opacity != null) frame.opacity = node.opacity;
  frame.clipsContent = !!node.clips;

  const layout = node.layout || { mode: 'NONE' };
  const useAutoLayout = layout.mode === 'HORIZONTAL' || layout.mode === 'VERTICAL';
  if (useAutoLayout) {
    frame.layoutMode = layout.mode;
    try {
      frame.layoutWrap = layout.wrap ? 'WRAP' : 'NO_WRAP';
      if (layout.wrap) frame.counterAxisSpacing = layout.counterGap || 0;
      frame.primaryAxisSizingMode = 'FIXED';
      frame.counterAxisSizingMode = 'FIXED';
      frame.itemSpacing = layout.gap || 0;
      frame.paddingTop = layout.padding ? layout.padding.top || 0 : 0;
      frame.paddingRight = layout.padding ? layout.padding.right || 0 : 0;
      frame.paddingBottom = layout.padding ? layout.padding.bottom || 0 : 0;
      frame.paddingLeft = layout.padding ? layout.padding.left || 0 : 0;
      frame.primaryAxisAlignItems = layout.primaryAlign || 'MIN';
      frame.counterAxisAlignItems = layout.counterAlign || 'MIN';
    } catch (_) { /* partial auto-layout is still fine */ }
    safeResize(frame, node.rect.w, node.rect.h);
  }

  for (const child of node.children || []) {
    if (importState.cancelled) break;
    let childNode = await buildNode(child, report);
    if (!childNode) continue;
    frame.appendChild(childNode);
    if (useAutoLayout && !child.absolute) {
      const pad = layout.padding || {};
      const contentW = Math.max(0, (node.rect.w || 0) - (pad.left || 0) - (pad.right || 0));
      const contentH = Math.max(0, (node.rect.h || 0) - (pad.top || 0) - (pad.bottom || 0));
      let horizontalSizing = 'FIXED';
      let verticalSizing = 'FIXED';
      if (child.type === 'TEXT') {
        const lines = (child.text && child.text.lines) || 1;
        if (lines <= 1) {
          horizontalSizing = 'HUG';
          verticalSizing = 'HUG';
        } else {
          horizontalSizing = contentW > 0 && (child.rect.w || 0) >= contentW * 0.85 ? 'FILL' : 'FIXED';
          verticalSizing = 'HUG';
        }
      } else {
        if (layout.mode === 'VERTICAL' && contentW > 0 && (child.rect.w || 0) >= contentW - 1) {
          horizontalSizing = 'FILL';
        }
        if (layout.mode === 'HORIZONTAL' && contentH > 0 && (child.rect.h || 0) >= contentH - 1) {
          verticalSizing = 'FILL';
        }
        const extent = autoLayoutContentExtent(child);
        if (extent) {
          if (horizontalSizing !== 'FILL' && Math.abs(extent.w - (child.rect.w || 0)) <= 2) {
            horizontalSizing = 'HUG';
          }
          if (verticalSizing !== 'FILL' && Math.abs(extent.h - (child.rect.h || 0)) <= 2) {
            verticalSizing = 'HUG';
          }
        }
      }
      if (Number(child.flexGrow) > 0) {
        if (layout.mode === 'HORIZONTAL') horizontalSizing = 'FILL';
        if (layout.mode === 'VERTICAL') verticalSizing = 'FILL';
      }
      try {
        childNode.layoutSizingHorizontal = horizontalSizing;
        childNode.layoutSizingVertical = verticalSizing;
      } catch (_) { /* older API / unsupported node type */ }
      if (horizontalSizing === 'FIXED' && verticalSizing === 'FIXED') {
        safeResize(childNode, child.rect.w, child.rect.h);
      } else if (horizontalSizing === 'FIXED') {
        safeResize(childNode, child.rect.w, childNode.height || child.rect.h);
      } else if (verticalSizing === 'FIXED') {
        safeResize(childNode, childNode.width || child.rect.w, child.rect.h);
      }
    } else {
      if (useAutoLayout && child.absolute) {
        try { childNode.layoutPositioning = 'ABSOLUTE'; } catch (_) { /* noop */ }
      }
      childNode.x = (child.rect.x || 0) - (node.rect.x || 0);
      childNode.y = (child.rect.y || 0) - (node.rect.y || 0);
    }
    if (child.type === 'VECTOR') {
      childNode = unwrapSingleChildSvg(frame, childNode, useAutoLayout && !child.absolute);
    }
  }
  return frame;
}

async function buildNode(node, report) {
  if (!node || importState.cancelled) return null;
  importState.done += 1;
  if (importState.done % 25 === 0) reportProgress();

  switch (node.type) {
    case 'TEXT': return buildTextNode(node, report);
    case 'IMAGE': return buildImageNode(node, report);
    case 'VECTOR': return buildVectorNode(node, report);
    case 'FRAME': return buildFrameNode(node, report);
    default: return null;
  }
}

function countNodes(node) {
  let n = 1;
  for (const child of node.children || []) n += countNodes(child);
  return n;
}

// ------------------------------------------------------------ layer cleanup
// The extension prunes at capture time; the plugin runs a stronger final
// cleanup here so current and older .deck.json files import without
// pointless wrapper frames inside their artboards.
const round2 = (n) => Math.round(n * 100) / 100;

function colorAlpha(value) {
  const parsed = parseColor(value);
  return parsed && typeof parsed.a === 'number' ? parsed.a : 1;
}

function fillIsInvisible(fill) {
  if (!fill) return true;
  if (fill.type === 'SOLID') return colorAlpha(fill.color) <= 0.001;
  if (fill.type === 'GRADIENT_LINEAR' || fill.type === 'GRADIENT_RADIAL') {
    return Array.isArray(fill.stops) && fill.stops.length > 0
      && fill.stops.every((stop) => colorAlpha(stop && stop.color) <= 0.001);
  }
  return false;
}

function fillIsOpaque(fill) {
  if (!fill || fillIsInvisible(fill)) return false;
  if (fill.type === 'SOLID') return colorAlpha(fill.color) >= 0.999;
  if (fill.type === 'GRADIENT_LINEAR' || fill.type === 'GRADIENT_RADIAL') {
    return Array.isArray(fill.stops) && fill.stops.length > 0
      && fill.stops.every((stop) => colorAlpha(stop && stop.color) >= 0.999);
  }
  // Image bytes may contain transparent pixels, so never assume opacity.
  return false;
}

function strokeIsInvisible(stroke) {
  if (!stroke) return true;
  if (colorAlpha(stroke.color) <= 0.001) return true;
  const widths = stroke.perSide
    ? Object.values(stroke.perSide)
    : [stroke.width == null ? 1 : stroke.width];
  return widths.length > 0 && widths.every((width) => Math.abs(Number(width) || 0) <= 0.001);
}

function shadowIsInvisible(shadow) {
  if (!shadow) return true;
  if (colorAlpha(shadow.color) <= 0.001) return true;
  return [shadow.offsetX, shadow.offsetY, shadow.blur, shadow.spread]
    .every((value) => Math.abs(Number(value) || 0) <= 0.001);
}

function visibleShadows(n) {
  return Array.isArray(n && n.shadows)
    ? n.shadows.filter((shadow) => !shadowIsInvisible(shadow))
    : [];
}

function cornerRadiiOf(n) {
  if (n && n.cornerRadii) {
    return {
      tl: Number(n.cornerRadii.tl) || 0,
      tr: Number(n.cornerRadii.tr) || 0,
      br: Number(n.cornerRadii.br) || 0,
      bl: Number(n.cornerRadii.bl) || 0,
    };
  }
  const radius = n && n.cornerRadius != null ? Number(n.cornerRadius) || 0 : 0;
  return { tl: radius, tr: radius, br: radius, bl: radius };
}

function hasCornerRadius(n) {
  return Object.values(cornerRadiiOf(n)).some((radius) => radius > 0.001);
}

function nodeOpacity(n) {
  const opacity = Number(n && n.opacity);
  return Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
}

function hasVisibleSurface(n) {
  return !!(!fillIsInvisible(n.fill) || !strokeIsInvisible(n.stroke)
    || visibleShadows(n).length);
}

// A corner radius by itself paints nothing. It only matters when the frame
// also has a visible surface or clips its children, so it must not cause an
// otherwise transparent HTML wrapper to survive as a Figma frame.
function hasDecoration(n) {
  return hasVisibleSurface(n);
}

function normalizeNoopDecorations(n) {
  if (!n || n.type !== 'FRAME') return;
  if (fillIsInvisible(n.fill)) delete n.fill;
  if (strokeIsInvisible(n.stroke)) delete n.stroke;
  if (Array.isArray(n.shadows)) {
    const shadows = visibleShadows(n);
    if (shadows.length) n.shadows = shadows;
    else delete n.shadows;
  }
  if (!hasCornerRadius(n)) {
    delete n.cornerRadius;
    delete n.cornerRadii;
  }
  if (nodeOpacity(n) >= 0.999) delete n.opacity;
}

function isGenericWrapperName(name) {
  const value = String(name || '').trim();
  if (!value) return true;
  return /^(div|span|section|main|article|aside|header|footer|nav|ul|ol|li|body|html)(\.|$)/.test(value)
    || /^(frame|group|wrapper|container)$/i.test(value);
}

function isDecorationFreeWrapper(n) {
  return n.type === 'FRAME' && !n.role && !hasVisibleSurface(n)
    && nodeOpacity(n) >= 0.999;
}

function isPlainWrapper(n) {
  return isDecorationFreeWrapper(n) && !n.clips;
}

function isVisuallyFreeWrapper(n) {
  return isDecorationFreeWrapper(n) && (!n.clips || childrenWithin(n));
}

function sameRect(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1
    && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;
}

function shadowExtentRect(node) {
  const rect = node.rect;
  let minX = rect.x, minY = rect.y;
  let maxX = rect.x + rect.w, maxY = rect.y + rect.h;
  for (const shadow of visibleShadows(node)) {
    if (shadow.inset) continue;
    const blur = Math.max(0, Number(shadow.blur) || 0);
    const spread = Math.max(0, Number(shadow.spread) || 0);
    const offsetX = Number(shadow.offsetX) || 0;
    const offsetY = Number(shadow.offsetY) || 0;
    minX = Math.min(minX, rect.x + offsetX - blur - spread);
    minY = Math.min(minY, rect.y + offsetY - blur - spread);
    maxX = Math.max(maxX, rect.x + rect.w + offsetX + blur + spread);
    maxY = Math.max(maxY, rect.y + rect.h + offsetY + blur + spread);
  }
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

function collectDescendantRects(node, out = []) {
  for (const child of node.children || []) {
    const rect = child.rect;
    if (rect && (rect.w > 0 || rect.h > 0)) out.push(shadowExtentRect(child));
    collectDescendantRects(child, out);
  }
  return out;
}

function descendantBounds(node) {
  const rects = collectDescendantRects(node);
  if (!rects.length) return null;
  return {
    minX: Math.min(...rects.map((r) => r.x)),
    minY: Math.min(...rects.map((r) => r.y)),
    maxX: Math.max(...rects.map((r) => r.x + r.w)),
    maxY: Math.max(...rects.map((r) => r.y + r.h)),
  };
}

function pointWithinRoundedRect(x, y, rect, radii) {
  const tolerance = 1;
  if (x < rect.x - tolerance || y < rect.y - tolerance
    || x > rect.x + rect.w + tolerance || y > rect.y + rect.h + tolerance) return false;
  const cap = (radius) => Math.max(0, Math.min(radius || 0, rect.w / 2, rect.h / 2));
  const corners = [
    { radius: cap(radii.tl), cx: rect.x + cap(radii.tl), cy: rect.y + cap(radii.tl), test: x < rect.x + cap(radii.tl) && y < rect.y + cap(radii.tl) },
    { radius: cap(radii.tr), cx: rect.x + rect.w - cap(radii.tr), cy: rect.y + cap(radii.tr), test: x > rect.x + rect.w - cap(radii.tr) && y < rect.y + cap(radii.tr) },
    { radius: cap(radii.br), cx: rect.x + rect.w - cap(radii.br), cy: rect.y + rect.h - cap(radii.br), test: x > rect.x + rect.w - cap(radii.br) && y > rect.y + rect.h - cap(radii.br) },
    { radius: cap(radii.bl), cx: rect.x + cap(radii.bl), cy: rect.y + rect.h - cap(radii.bl), test: x < rect.x + cap(radii.bl) && y > rect.y + rect.h - cap(radii.bl) },
  ];
  return corners.every(({ radius, cx, cy, test }) => !test
    || Math.hypot(x - cx, y - cy) <= radius + tolerance);
}

function rectWithinRoundedRect(rect, frame) {
  const radii = cornerRadiiOf(frame);
  const points = [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x + rect.w, rect.y + rect.h],
    [rect.x, rect.y + rect.h],
  ];
  return points.every(([x, y]) => pointWithinRoundedRect(x, y, frame.rect, radii));
}

function childrenWithin(frame) {
  return collectDescendantRects(frame)
    .every((rect) => rectWithinRoundedRect(rect, frame));
}

function sameColor(a, b) {
  const ca = parseColor(a), cb = parseColor(b);
  if (!ca || !cb) return a === b;
  return ['r', 'g', 'b', 'a'].every((key) => Math.abs(ca[key] - cb[key]) <= 1 / 255);
}

function sameFill(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'SOLID') return sameColor(a.color, b.color);
  if (a.type === 'IMAGE') return (a.bytes || '') === (b.bytes || '');
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameStroke(a, b) {
  if (!a || !b || !sameColor(a.color, b.color)
    || Math.abs((Number(a.width) || 0) - (Number(b.width) || 0)) > 0.01
    || !!a.dashed !== !!b.dashed) return false;
  return JSON.stringify(a.perSide || null) === JSON.stringify(b.perSide || null);
}

function cornerSignature(n) {
  if (!hasCornerRadius(n)) return '';
  const radii = cornerRadiiOf(n);
  return `r:${radii.tl},${radii.tr},${radii.br},${radii.bl}`;
}

function transferCorners(target, source) {
  delete target.cornerRadius;
  delete target.cornerRadii;
  if (source.cornerRadii) target.cornerRadii = { ...source.cornerRadii };
  else if (source.cornerRadius != null) target.cornerRadius = source.cornerRadius;
}

// Merge an outer artboard host into an identical inner screen when their
// visual properties don't conflict. This is the duplicate "artboard inside
// an artboard" frame users were seeing in the Layers panel.
function mergeSingleChildFrame(frame) {
  if (!frame || frame.type !== 'FRAME' || frame.role === 'deck'
    || !frame.children || frame.children.length !== 1) return null;
  const only = frame.children[0];
  if (!only || only.type !== 'FRAME' || !sameRect(frame.rect, only.rect)) return null;
  normalizeNoopDecorations(frame);
  normalizeNoopDecorations(only);
  const pad = (frame.layout && frame.layout.padding) || {};
  if (frame.layout && frame.layout.mode !== 'NONE' && !only.absolute
    && ['top', 'right', 'bottom', 'left'].some((k) => Math.abs(pad[k] || 0) > 1)) return null;

  const frameFill = !fillIsInvisible(frame.fill) ? frame.fill : null;
  const onlyFill = !fillIsInvisible(only.fill) ? only.fill : null;
  // A fully opaque inner background completely hides a different outer
  // background at the same rect; a translucent inner background does not.
  if (frameFill && onlyFill && !sameFill(frameFill, onlyFill) && !fillIsOpaque(onlyFill)) return null;
  if (frame.stroke && only.stroke && !sameStroke(frame.stroke, only.stroke)) return null;

  const fc = cornerSignature(frame), oc = cornerSignature(only);
  let adoptOuterCorners = false;
  if (fc !== oc) {
    if (frame.clips) {
      // The outer rounded clip is the visible silhouette. It can replace
      // the inner radius only when there is no inner stroke whose own
      // clipped geometry would need to be preserved separately.
      if (only.stroke) return null;
      adoptOuterCorners = !!fc;
    } else if (frameFill && onlyFill) {
      return null;
    } else if (fc && oc && hasVisibleSurface(frame)) {
      return null;
    }
  }
  const hadOnlyFill = !!onlyFill;

  if (!onlyFill && frameFill) {
    only.fill = frameFill;
    if (frame.imageScaleMode) only.imageScaleMode = frame.imageScaleMode;
  }
  if (!only.stroke && frame.stroke) only.stroke = frame.stroke;
  if (adoptOuterCorners) {
    transferCorners(only, frame);
  } else if (!oc && fc && (!hadOnlyFill || frame.clips)) {
    // Only inherit an outer radius when it supplied the background shape
    // or was an actual clipping boundary; a transparent non-clipping
    // wrapper's radius does not round a square child in CSS.
    transferCorners(only, frame);
  }
  const shadows = [...visibleShadows(frame), ...visibleShadows(only)];
  if (shadows.length) only.shadows = shadows;
  else delete only.shadows;
  const opacity = round2(nodeOpacity(frame) * nodeOpacity(only));
  if (opacity >= 0.999) delete only.opacity;
  else only.opacity = opacity;
  only.clips = !!(frame.clips || only.clips);
  if (frame.absolute) only.absolute = true; else delete only.absolute;
  if (frame.zIndex != null) only.zIndex = frame.zIndex; else delete only.zIndex;
  if (frame.flexGrow != null && only.flexGrow == null) only.flexGrow = frame.flexGrow;
  if (frame.role) {
    only.role = frame.role;
    only.name = frame.name || only.name;
    only.clips = true;
  } else if (frame.name && isGenericWrapperName(only.name)) {
    only.name = frame.name;
  }
  return only;
}

// Decide whether a wrapper's children can be promoted into the parent
// without moving any surviving layer. JSON rects are absolute, so a
// non-Auto-Layout parent can host them directly. In an Auto Layout parent,
// promoted children are made absolute when removing the wrapper cannot
// change the positions of the remaining flow siblings.
function wrapperPromotionPlan(parent, wrapper, siblings) {
  const kids = wrapper.children || [];
  if (!kids.length) return null;
  const parentMode = (parent.layout && parent.layout.mode) || 'NONE';
  if (parentMode === 'NONE') return { markAbsolute: false };
  if (wrapper.absolute) return { markAbsolute: true };

  if (kids.length === 1 && sameRect(wrapper.rect, kids[0].rect)) {
    return { markAbsolute: false, singleSameRect: true };
  }
  const flow = siblings.filter((child) => !child.absolute);
  const flowIndex = flow.indexOf(wrapper);
  if (flowIndex < 0) return { markAbsolute: true };
  if (flow.length <= 1) return { markAbsolute: true };

  const primaryAlign = (parent.layout && parent.layout.primaryAlign) || 'MIN';
  if (flowIndex === flow.length - 1 && primaryAlign === 'MIN') {
    return { markAbsolute: true };
  }
  if (flowIndex === 0 && primaryAlign === 'MAX'
    && !(parent.layout && parent.layout.wrap)) {
    return { markAbsolute: true };
  }
  return null;
}

function promoteWrapperChildren(wrapper, plan) {
  const kids = wrapper.children || [];
  if (plan.markAbsolute) {
    for (const kid of kids) kid.absolute = true;
  }
  if (kids.length === 1) {
    const only = kids[0];
    if (wrapper.zIndex != null && only.zIndex == null) only.zIndex = wrapper.zIndex;
    if (wrapper.flexGrow != null && only.flexGrow == null) only.flexGrow = wrapper.flexGrow;
  }
  return kids;
}

function visuallyFreePromotionPlan(parent, wrapper, siblings) {
  if (!isVisuallyFreeWrapper(wrapper)) return null;
  const plan = wrapperPromotionPlan(parent, wrapper, siblings);
  if (!plan) return null;
  const parentMode = (parent.layout && parent.layout.mode) || 'NONE';
  const wrapperMode = (wrapper.layout && wrapper.layout.mode) || 'NONE';
  const kids = wrapper.children || [];
  // Do not flatten every meaningful named Auto Layout group just because
  // it is transparent. Generated pass-through wrappers (generic HTML
  // names, a sole child, or an absolute overlay) are the redundant frames
  // users see inside imported artboards.
  if (parentMode === 'NONE' && wrapperMode !== 'NONE' && kids.length > 1
    && siblings.length > 1 && !wrapper.absolute
    && !isGenericWrapperName(wrapper.name)) {
    return null;
  }
  return plan;
}

// A decorated frame that exactly covers its parent and sits behind all
// other retained siblings is often just the artboard background wrapper.
// Transfer that surface to the parent and promote its content, instead of
// creating "artboard > background wrapper > real content".
function dissolveFullBleedWrapper(parent, wrapper, siblings, out) {
  if (!parent || parent.role === 'deck'
    || !wrapper || wrapper.type !== 'FRAME' || wrapper.role) return false;
  if (!(wrapper.children || []).length || out.length) return false;
  if (!sameRect(parent.rect, wrapper.rect) || nodeOpacity(wrapper) < 0.999) return false;

  const plan = wrapperPromotionPlan(parent, wrapper, siblings);
  if (!plan) return false;

  const parentFill = !fillIsInvisible(parent.fill) ? parent.fill : null;
  const wrapperFill = !fillIsInvisible(wrapper.fill) ? wrapper.fill : null;
  let replacementFill = null;
  if (wrapperFill) {
    if (!parentFill || sameFill(parentFill, wrapperFill) || fillIsOpaque(wrapperFill)) {
      replacementFill = wrapperFill;
    } else {
      return false;
    }
  }

  const parentStroke = !strokeIsInvisible(parent.stroke) ? parent.stroke : null;
  const wrapperStroke = !strokeIsInvisible(wrapper.stroke) ? wrapper.stroke : null;
  if (wrapperStroke && parentStroke && !sameStroke(wrapperStroke, parentStroke)) return false;

  const wrapperShadows = visibleShadows(wrapper);
  if (wrapperShadows.length && siblings.length > 1
    && JSON.stringify(wrapperShadows) !== JSON.stringify(visibleShadows(parent))) {
    // Moving an effect to the parent would make it apply to siblings too.
    return false;
  }

  const parentCorners = cornerSignature(parent);
  const wrapperCorners = cornerSignature(wrapper);
  if (parentCorners !== wrapperCorners) {
    const wrapperShapeCanReplaceParent = !!replacementFill
      || (!parentFill && !parentStroke);
    if (!wrapperShapeCanReplaceParent) return false;
  }
  if (wrapper.clips && !parent.clips && !parent.role && !childrenWithin(parent)) {
    return false;
  }

  if (replacementFill) {
    parent.fill = replacementFill;
    if (wrapperFill && wrapperFill.type === 'IMAGE' && wrapper.imageScaleMode) {
      parent.imageScaleMode = wrapper.imageScaleMode;
    }
  }
  if (wrapperStroke && !parentStroke) parent.stroke = wrapperStroke;
  const shadows = [...visibleShadows(parent), ...wrapperShadows];
  if (shadows.length) parent.shadows = shadows;
  if (wrapperCorners && parentCorners !== wrapperCorners) transferCorners(parent, wrapper);
  if (wrapper.clips) parent.clips = true;
  out.push(...promoteWrapperChildren(wrapper, plan));
  return true;
}

function combineCornerRadii(target, source) {
  const current = cornerRadiiOf(target);
  const incoming = cornerRadiiOf(source);
  const combined = {
    tl: Math.max(current.tl, incoming.tl),
    tr: Math.max(current.tr, incoming.tr),
    br: Math.max(current.br, incoming.br),
    bl: Math.max(current.bl, incoming.bl),
  };
  delete target.cornerRadius;
  delete target.cornerRadii;
  if (!Object.values(combined).some((radius) => radius > 0.001)) return;
  if (Object.values(combined).every((radius) => Math.abs(radius - combined.tl) <= 0.001)) {
    target.cornerRadius = combined.tl;
  } else {
    target.cornerRadii = combined;
  }
}

// A rounded overflow-hidden div around one same-size image is a very
// common HTML wrapper. The image rectangle itself can carry the effective
// radius (the stricter of its own radius and the clipping wrapper), so
// the extra frame is not needed in Figma.
function singleImageClipPromotionPlan(parent, wrapper, siblings) {
  if (!isDecorationFreeWrapper(wrapper) || !wrapper.clips) return null;
  const kids = wrapper.children || [];
  if (kids.length !== 1) return null;
  const image = kids[0];
  if (!image || image.type !== 'IMAGE' || visibleShadows(image).length
    || !sameRect(wrapper.rect, image.rect)) return null;
  return wrapperPromotionPlan(parent, wrapper, siblings);
}

function pruneTreePass(node) {
  if (!node || typeof node !== 'object') return node;
  normalizeNoopDecorations(node);
  if (!Array.isArray(node.children)) return node;

  const candidates = [];
  for (const child of node.children) {
    const pruned = pruneTreePass(child);
    normalizeNoopDecorations(pruned);
    const kids = pruned.children || [];
    if (pruned.type === 'FRAME' && !pruned.role && kids.length === 0
      && !hasVisibleSurface(pruned)) {
      continue;
    }
    candidates.push(mergeSingleChildFrame(pruned) || pruned);
  }

  node.children = candidates;
  const mergedNode = mergeSingleChildFrame(node);
  if (mergedNode) return mergedNode;

  const out = [];
  for (const candidate of candidates) {
    if (dissolveFullBleedWrapper(node, candidate, candidates, out)) continue;
    let plan = visuallyFreePromotionPlan(node, candidate, candidates);
    let transferImageClip = false;
    if (!plan) {
      plan = singleImageClipPromotionPlan(node, candidate, candidates);
      transferImageClip = !!plan;
    }
    if (plan) {
      if (transferImageClip) combineCornerRadii(candidate.children[0], candidate);
      out.push(...promoteWrapperChildren(candidate, plan));
      continue;
    }
    out.push(candidate);
  }
  node.children = out;
  return mergeSingleChildFrame(node) || node;
}

// Run to a fixed point: dissolving one wrapper commonly exposes a second
// full-size/only-child wrapper underneath it. Every successful pass must
// reduce the node count, so this cannot loop indefinitely.
function pruneTree(node) {
  let current = node;
  for (let pass = 0; pass < 20; pass += 1) {
    const before = countNodes(current);
    current = pruneTreePass(current);
    if (countNodes(current) >= before) break;
  }
  return current;
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
  if (report) report.inferredAutoLayouts = (report.inferredAutoLayouts || 0) + 1;
}



// ------------------------------------------------------------ import sizing
// The user can pick a target artboard size in the plugin window before
// importing; canvas artboards often have mixed sizes, or a design captured
// at 1440px wide needs to land at 1920, 390, etc. Scaling happens on the
// JSON tree (before building), so positions, fonts, strokes, paddings,
// radii and shadows all scale together — never just the outer frame.
function translateTree(n, dx, dy) {
  n.rect = { ...n.rect, x: (n.rect.x || 0) + dx, y: (n.rect.y || 0) + dy };
  for (const c of n.children || []) translateTree(c, dx, dy);
}

function scaleSlideTree(n, kx, ky) {
  const avg = (kx + ky) / 2;
  n.rect = {
    x: n.rect.x * kx, y: n.rect.y * ky,
    w: n.rect.w * kx, h: n.rect.h * ky,
  };
  if (n.cornerRadius) n.cornerRadius *= avg;
  if (n.cornerRadii) {
    for (const key of ['tl', 'tr', 'br', 'bl']) n.cornerRadii[key] = (n.cornerRadii[key] || 0) * avg;
  }
  if (n.stroke) {
    n.stroke.width = (n.stroke.width || 0) * avg;
    if (n.stroke.perSide) {
      n.stroke.perSide.top = (n.stroke.perSide.top || 0) * ky;
      n.stroke.perSide.bottom = (n.stroke.perSide.bottom || 0) * ky;
      n.stroke.perSide.left = (n.stroke.perSide.left || 0) * kx;
      n.stroke.perSide.right = (n.stroke.perSide.right || 0) * kx;
    }
  }
  if (n.shadows) {
    for (const sh of n.shadows) {
      sh.offsetX *= kx; sh.offsetY *= ky; sh.blur *= avg; sh.spread *= avg;
    }
  }
  if (n.layout) {
    n.layout.gap = (n.layout.gap || 0) * (n.layout.mode === 'VERTICAL' ? ky : kx);
    if (n.layout.counterGap) {
      n.layout.counterGap *= (n.layout.mode === 'VERTICAL' ? kx : ky);
    }
    if (n.layout.padding) {
      n.layout.padding.top = (n.layout.padding.top || 0) * ky;
      n.layout.padding.bottom = (n.layout.padding.bottom || 0) * ky;
      n.layout.padding.left = (n.layout.padding.left || 0) * kx;
      n.layout.padding.right = (n.layout.padding.right || 0) * kx;
    }
  }
  if (n.text) {
    for (const r of n.text.runs || []) {
      // Figma text cannot stretch non-uniformly; size follows height,
      // tracking follows width. Uniform fits make kx === ky anyway.
      r.fontSize = (r.fontSize || 16) * ky;
      r.letterSpacing = (r.letterSpacing || 0) * kx;
      if (r.lineHeight) r.lineHeight = r.lineHeight * ky;
    }
  }
  for (const c of n.children || []) scaleSlideTree(c, kx, ky);
}

// options: { fit: 'original'|'width'|'fit'|'fill'|'stretch',
//            targetW, targetH }
// Returns { frameW, frameH, scale } and rewrites slideNode in place so its
// rect is exactly the frame that will be created in Figma.
function applySizeOption(slideNode, options) {
  const origW = slideNode.rect && slideNode.rect.w;
  const origH = slideNode.rect && slideNode.rect.h;
  const original = { frameW: origW, frameH: origH, scale: 1 };
  if (!options || !options.fit || options.fit === 'original') return original;
  if (slideNode.type !== 'FRAME' || !(origW > 0) || !(origH > 0)) return original;
  const targetW = Math.min(10000, Math.max(16, Number(options.targetW) || origW));
  const targetH = Math.min(10000, Math.max(16, Number(options.targetH) || origH));

  translateTree(slideNode, -(slideNode.rect.x || 0), -(slideNode.rect.y || 0));

  let kx, ky, frameW, frameH;
  switch (options.fit) {
    case 'width': {
      kx = ky = targetW / origW;
      frameW = targetW;
      frameH = Math.round(origH * ky);
      break;
    }
    case 'fit': {
      kx = ky = Math.min(targetW / origW, targetH / origH);
      frameW = Math.round(targetW);
      frameH = Math.round(targetH);
      break;
    }
    case 'fill': {
      kx = ky = Math.max(targetW / origW, targetH / origH);
      frameW = Math.round(targetW);
      frameH = Math.round(targetH);
      break;
    }
    case 'stretch': {
      kx = targetW / origW;
      ky = targetH / origH;
      frameW = Math.round(targetW);
      frameH = Math.round(targetH);
      break;
    }
    default:
      return original;
  }

  scaleSlideTree(slideNode, kx, ky);

  if (options.fit === 'fit' || options.fit === 'fill') {
    // Center the scaled design inside the exact-size frame
    // (fit: empty margin; fill: symmetric crop via frame clipping).
    const dx = (frameW - origW * kx) / 2;
    const dy = (frameH - origH * ky) / 2;
    for (const child of slideNode.children || []) translateTree(child, dx, dy);
    slideNode.rect.w = frameW;
    slideNode.rect.h = frameH;
  } else {
    slideNode.rect.w = frameW;
    slideNode.rect.h = frameH;
  }
  return { frameW, frameH, scale: kx, scaleY: ky, fit: options.fit };
}

// Import options are normally one global setting, but the plugin UI may
// attach an override per artboard because a Claude canvas often mixes
// desktop, tablet and mobile frames. Old messages without `slides` keep
// using the backwards-compatible global object.
function sizeOptionForSlide(options, index) {
  if (options && Array.isArray(options.slides) && options.slides[index]) {
    return options.slides[index];
  }
  return options;
}

// ================================================================= import
function validateDeck(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('That file is not valid JSON.');
  // Accept the current schema id and the legacy one used by pre-rename builds.
  if (payload.schema && payload.schema !== 'claude2figma' && payload.schema !== 'deckbridge') {
    throw new Error('This JSON was not captured by Claude2Figma. Use the Claude2Figma Chrome extension to capture your deck.');
  }
  if (!payload.root || !payload.root.rect) {
    throw new Error('Deck file is missing its layer tree (root). Re-capture the deck and try again.');
  }
  if (payload.schemaVersion && payload.schemaVersion > 1) {
    throw new Error(`Deck file schema v${payload.schemaVersion} is newer than this plugin (v1). Update the plugin.`);
  }
}

function slideNodesOf(root) {
  if (root.role === 'deck') {
    const slides = (root.children || []).filter((c) => c.role === 'slide');
    if (slides.length) return slides;
    return root.children || [root];
  }
  return [root];
}

function findStartPosition(firstSlide) {
  const page = figma.currentPage;
  let maxRight = null;
  let minTop = null;
  for (const child of page.children) {
    const right = child.x + child.width;
    if (maxRight === null || right > maxRight) maxRight = right;
    if (minTop === null || child.y < minTop) minTop = child.y;
  }
  if (maxRight !== null) return { x: maxRight + 200, y: minTop || 0 };
  const center = figma.viewport.center;
  return {
    x: Math.round(center.x - (firstSlide.rect.w || 0) / 2),
    y: Math.round(center.y - (firstSlide.rect.h || 0) / 2),
  };
}

async function importDeck(payload, options) {
  validateDeck(payload);
  const report = {
    missingFonts: new Set(), failedImages: 0, failedVectors: 0,
    inferredAutoLayouts: 0, layersRemoved: 0,
  };
  const beforeCleanup = countNodes(payload.root);
  payload.root = pruneTree(payload.root); // drop do-nothing wrappers
  inferAutoLayouts(payload.root, report);
  report.layersRemoved = Math.max(0, beforeCleanup - countNodes(payload.root));

  const allSlides = slideNodesOf(payload.root);
  const selectedSlides = allSlides
    .map((slideNode, originalIndex) => ({
      slideNode,
      originalIndex,
      option: sizeOptionForSlide(options, originalIndex),
    }))
    .filter(({ option }) => !option || option.enabled !== false);
  if (!selectedSlides.length) {
    throw new Error('Select at least one artboard to import.');
  }

  importState.cancelled = false;
  importState.done = 0;
  importState.total = selectedSlides.reduce((sum, s) => sum + countNodes(s.slideNode), 0);
  reportProgress();

  await preloadFonts(payload.root, report);

  const start = findStartPosition(selectedSlides[0].slideNode);
  const created = [];
  const frameSizes = [];
  let y = start.y;

  for (let j = 0; j < selectedSlides.length; j += 1) {
    if (importState.cancelled) break;
    const { slideNode, originalIndex, option } = selectedSlides[j];
    figma.ui.postMessage({
      type: 'status',
      message: selectedSlides.length > 1
        ? `Building artboard ${j + 1} of ${selectedSlides.length}…`
        : 'Building layers…',
    });
    const appliedSize = applySizeOption(slideNode, option);
    const built = await buildNode(slideNode, report);
    if (!built) continue;
    built.name = slideNode.name || (allSlides.length > 1 ? `Slide ${originalIndex + 1}` : (payload.title || 'Imported page'));
    // The top-level frame IS the design: exact captured size, clipped
    // like an artboard.
    if (built.type === 'FRAME') {
      try { built.clipsContent = true; } catch (_) { /* noop */ }
      safeResize(built,
        Math.max(1, Math.round(slideNode.rect.w || built.width)),
        Math.max(1, Math.round(slideNode.rect.h || built.height)));
    }
    figma.currentPage.appendChild(built);
    built.x = start.x;
    built.y = y;
    y += built.height + 100;
    created.push(built);
    frameSizes.push({
      name: built.name,
      width: Math.round(built.width || appliedSize.frameW || 0),
      height: Math.round(built.height || appliedSize.frameH || 0),
      scale: Math.round((appliedSize.scale || 1) * 100),
    });
    reportProgress();
  }

  if (created.length) {
    figma.currentPage.selection = created;
    figma.viewport.scrollAndZoomIntoView(created);
  }

  const result = {
    type: 'result',
    cancelled: importState.cancelled,
    slides: created.length,
    nodes: importState.done,
    missingFonts: [...report.missingFonts],
    failedImages: report.failedImages,
    failedVectors: report.failedVectors,
    inferredAutoLayouts: report.inferredAutoLayouts,
    layersRemoved: report.layersRemoved,
    frameSizes,
  };
  figma.ui.postMessage(result);
  // Deliberately no figma.notify(): results show inside the plugin window;
  // an extra toast popup on every import is unwanted noise.
}

// --------------------------------------------------------- Figma exporter
// The reverse of importDeck(): walk native Figma nodes through the Plugin
// API and emit the same .deck.json schema. This is how a Figma canvas is
// copied: Chrome cannot read Figma's WebGL canvas, but a plugin can.
const FIGMA_EXPORT_VERSION = PLUGIN_VERSION;
const FIGMA_ARTBOARD_TYPES = ['FRAME', 'COMPONENT', 'COMPONENT_SET'];
const FIGMA_VECTOR_TYPES = ['VECTOR', 'BOOLEAN_OPERATION', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR'];

function slugifyForFile(value) {
  const slug = String(value || 'figma-canvas').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'figma-canvas';
}

function bytesToBase64(bytes) {
  if (!bytes || !bytes.length) return '';
  if (typeof figma.base64Encode === 'function') {
    try { return figma.base64Encode(bytes); } catch (_) { /* manual fallback */ }
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64[(triple >> 18) & 63];
    out += B64[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(triple >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[triple & 63] : '=';
  }
  return out;
}

function cssColorFromFigma(color, alpha = 1) {
  if (!color) return 'rgba(0, 0, 0, 1)';
  const channel = (v) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 255);
  const a = Math.round(Math.min(1, Math.max(0, Number(alpha == null ? 1 : alpha))) * 1000) / 1000;
  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${a})`;
}

function firstVisiblePaint(paints) {
  if (!Array.isArray(paints)) return null;
  return paints.find((paint) => paint && paint.visible !== false) || null;
}

async function figmaPaintToSchemaFill(paint, ctx) {
  if (!paint) return null;
  const opacity = typeof paint.opacity === 'number' ? paint.opacity : 1;
  if (paint.type === 'SOLID') {
    return { type: 'SOLID', color: cssColorFromFigma(paint.color, opacity) };
  }
  if (paint.type === 'IMAGE') {
    let bytes = '';
    const hash = paint.imageHash || '';
    if (hash) {
      if (!ctx.imageCache.has(hash)) {
        ctx.imageCache.set(hash, (async () => {
          try {
            const image = typeof figma.getImageByHash === 'function' ? figma.getImageByHash(hash) : null;
            if (image && typeof image.getBytesAsync === 'function') {
              return bytesToBase64(await image.getBytesAsync());
            }
          } catch (_) { /* placeholder on import */ }
          return '';
        })());
      }
      bytes = await ctx.imageCache.get(hash);
    }
    return { type: 'IMAGE', bytes };
  }
  if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') {
    const stops = (paint.gradientStops || []).map((stop) => ({
      color: cssColorFromFigma(stop.color, (stop.color ? stop.color.a : 1) * opacity),
      position: typeof stop.position === 'number' ? stop.position : 0,
    }));
    if (paint.type === 'GRADIENT_RADIAL') return { type: 'GRADIENT_RADIAL', stops };
    let angle = 180;
    try {
      const t = paint.gradientTransform;
      const dx = Number(t && t[0] && t[0][0]) || 0;
      const dy = Number(t && t[1] && t[1][0]) || 0;
      if (dx || dy) angle = Math.atan2(dx, -dy) * 180 / Math.PI;
    } catch (_) { /* default */ }
    return { type: 'GRADIENT_LINEAR', angle: Math.round(angle * 10) / 10, stops };
  }
  return null;
}

function figmaStrokeToSchema(node) {
  const paint = firstVisiblePaint(node.strokes);
  if (!paint || paint.type !== 'SOLID') return null;
  const width = typeof node.strokeWeight === 'number' ? node.strokeWeight : 1;
  const out = {
    color: cssColorFromFigma(paint.color, typeof paint.opacity === 'number' ? paint.opacity : 1),
    width: Math.max(0.1, width),
  };
  const sides = {
    top: node.strokeTopWeight, right: node.strokeRightWeight,
    bottom: node.strokeBottomWeight, left: node.strokeLeftWeight,
  };
  if (Object.values(sides).every((v) => typeof v === 'number')
    && !Object.values(sides).every((v) => v === sides.top)) {
    out.perSide = sides;
    out.width = Math.max(0.1, ...Object.values(sides), width);
  }
  if (Array.isArray(node.dashPattern) && node.dashPattern.length) out.dashed = true;
  return out;
}

function figmaEffectsToSchema(node) {
  if (!Array.isArray(node.effects)) return [];
  return node.effects
    .filter((effect) => effect && effect.visible !== false
      && (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW'))
    .map((effect) => ({
      offsetX: effect.offset ? Number(effect.offset.x) || 0 : 0,
      offsetY: effect.offset ? Number(effect.offset.y) || 0 : 0,
      blur: Math.max(0, Number(effect.radius) || 0),
      spread: Number(effect.spread) || 0,
      color: cssColorFromFigma(effect.color, effect.color ? effect.color.a : 0.25),
      inset: effect.type === 'INNER_SHADOW',
    }));
}

function applyFigmaCorners(node, out) {
  const individual = {
    tl: node.topLeftRadius, tr: node.topRightRadius,
    br: node.bottomRightRadius, bl: node.bottomLeftRadius,
  };
  if (Object.values(individual).every((v) => typeof v === 'number')
    && Object.values(individual).some((v) => v > 0)
    && !Object.values(individual).every((v) => v === individual.tl)) {
    out.cornerRadii = individual;
  } else if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
    out.cornerRadius = node.cornerRadius;
  } else if (typeof individual.tl === 'number' && individual.tl > 0) {
    out.cornerRadius = individual.tl;
  }
}

function figmaLayoutToSchema(node) {
  if (node.layoutMode !== 'HORIZONTAL' && node.layoutMode !== 'VERTICAL') {
    return { mode: 'NONE', gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, primaryAlign: 'MIN', counterAlign: 'MIN' };
  }
  const align = (value) => (['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'].includes(value) ? value : 'MIN');
  const out = {
    mode: node.layoutMode,
    gap: typeof node.itemSpacing === 'number' ? node.itemSpacing : 0,
    padding: {
      top: Number(node.paddingTop) || 0,
      right: Number(node.paddingRight) || 0,
      bottom: Number(node.paddingBottom) || 0,
      left: Number(node.paddingLeft) || 0,
    },
    primaryAlign: align(node.primaryAxisAlignItems),
    counterAlign: align(node.counterAxisAlignItems),
  };
  if (node.layoutWrap === 'WRAP') {
    out.wrap = true;
    out.counterGap = typeof node.counterAxisSpacing === 'number' ? node.counterAxisSpacing : 0;
  }
  return out;
}

function figmaBBox(node) {
  const box = node && node.absoluteBoundingBox;
  if (box && typeof box.width === 'number' && typeof box.height === 'number') {
    return { x: Number(box.x) || 0, y: Number(box.y) || 0, w: box.width, h: box.height };
  }
  return {
    x: Number(node && node.x) || 0,
    y: Number(node && node.y) || 0,
    w: Math.max(0, Number(node && node.width) || 0),
    h: Math.max(0, Number(node && node.height) || 0),
  };
}

function relativeRect(node, origin) {
  const box = figmaBBox(node);
  return {
    x: round2(box.x - origin.x), y: round2(box.y - origin.y),
    w: round2(Math.max(0, box.w)), h: round2(Math.max(0, box.h)),
  };
}

function fontMetricsFromStyle(styleName) {
  const style = String(styleName || 'Regular');
  const lower = style.toLowerCase();
  let weight = 400;
  if (/thin/.test(lower)) weight = 100;
  else if (/extra\s?light/.test(lower)) weight = 200;
  else if (/light/.test(lower)) weight = 300;
  else if (/medium/.test(lower)) weight = 500;
  else if (/semi\s?bold|demi/.test(lower)) weight = 600;
  else if (/extra\s?bold/.test(lower)) weight = 800;
  else if (/black|heavy/.test(lower)) weight = 900;
  else if (/bold/.test(lower)) weight = 700;
  return { weight, italic: /italic|oblique/.test(lower) };
}

function figmaMeasureToPx(measure, fontSize) {
  if (typeof measure === 'number') return measure;
  if (!measure || typeof measure.value !== 'number') return 0;
  return measure.unit === 'PERCENT' ? measure.value / 100 * fontSize : measure.value;
}

async function serializeFigmaText(node, rect, ctx) {
  let segments = [];
  try {
    if (typeof node.getStyledTextSegments === 'function') {
      segments = node.getStyledTextSegments([
        'fontName', 'fontSize', 'fills', 'letterSpacing', 'lineHeight', 'textDecoration', 'fontStyle',
      ]) || [];
    }
  } catch (_) { segments = []; }
  if (!segments.length) {
    segments = [{
      characters: node.characters || '', fontName: node.fontName,
      fontSize: node.fontSize, fills: node.fills,
      letterSpacing: node.letterSpacing, lineHeight: node.lineHeight,
      textDecoration: node.textDecoration, fontStyle: node.fontStyle,
    }];
  }
  const runs = segments.filter((segment) => segment && segment.characters).map((segment) => {
    const font = segment.fontName && typeof segment.fontName === 'object'
      ? segment.fontName : { family: 'Inter', style: 'Regular' };
    const metrics = fontMetricsFromStyle(font.style);
    const paint = firstVisiblePaint(segment.fills) || firstVisiblePaint(node.fills);
    const fontSize = typeof segment.fontSize === 'number' ? segment.fontSize : 16;
    const lineHeight = figmaMeasureToPx(segment.lineHeight, fontSize);
    const run = {
      content: segment.characters,
      fontFamily: font.family || 'Inter',
      fontWeight: metrics.weight,
      italic: metrics.italic || segment.fontStyle === 'ITALIC',
      fontSize,
      color: paint && paint.type === 'SOLID'
        ? cssColorFromFigma(paint.color, typeof paint.opacity === 'number' ? paint.opacity : 1)
        : 'rgb(0, 0, 0)',
      letterSpacing: figmaMeasureToPx(segment.letterSpacing, fontSize),
    };
    if (lineHeight > 0) run.lineHeight = lineHeight;
    if (segment.textDecoration === 'UNDERLINE') run.underline = true;
    if (segment.textDecoration === 'STRIKETHROUGH') run.strikethrough = true;
    return run;
  });
  const out = {
    type: 'TEXT', name: node.name || 'Text', rect,
    text: {
      runs,
      align: ['LEFT', 'CENTER', 'RIGHT'].includes(node.textAlignHorizontal)
        ? node.textAlignHorizontal : 'LEFT',
      lines: 1,
    },
  };
  const firstRun = runs[0] || { fontSize: 16 };
  const linePx = firstRun.lineHeight || firstRun.fontSize * 1.2;
  const explicitLines = String(node.characters || '').split('\n').length;
  out.text.lines = node.textAutoResize === 'WIDTH_AND_HEIGHT'
    ? explicitLines
    : Math.max(explicitLines, Math.max(1, Math.round(rect.h / Math.max(1, linePx))));
  const fillPaint = firstVisiblePaint(node.fills);
  if (fillPaint && fillPaint.type !== 'SOLID') {
    const fill = await figmaPaintToSchemaFill(fillPaint, ctx);
    if (fill) out.fill = fill;
  }
  if (typeof node.opacity === 'number' && node.opacity < 1) out.opacity = node.opacity;
  return out;
}

async function exportFigmaNodeSvg(node) {
  if (!node || typeof node.exportAsync !== 'function') return '';
  try {
    const result = await node.exportAsync({ format: 'SVG_STRING' });
    if (typeof result === 'string') return result;
    if (result && typeof result.length === 'number') {
      let text = '';
      for (let i = 0; i < result.length; i += 8192) {
        text += String.fromCharCode.apply(null, Array.from(result.slice(i, i + 8192)));
      }
      return text;
    }
  } catch (_) { /* raster fallback below */ }
  return '';
}

async function serializeFigmaNode(node, origin, ctx, parentLayoutMode, force = false) {
  if (!node || node.type === 'SLICE') return null;
  if (!force && node.visible === false) return null;
  ctx.count += 1;
  if (ctx.count % 100 === 0) {
    figma.ui.postMessage({ type: 'figma-export-status', message: `Reading Figma layers… ${ctx.count.toLocaleString()}` });
  }
  const rect = relativeRect(node, origin);
  if (node.type === 'TEXT') {
    const text = await serializeFigmaText(node, rect, ctx);
    if (node.layoutPositioning === 'ABSOLUTE') text.absolute = true;
    return text;
  }

  if (FIGMA_VECTOR_TYPES.includes(node.type)) {
    const svg = await exportFigmaNodeSvg(node);
    if (svg) {
      const vector = { type: 'VECTOR', name: node.name || 'Vector', rect, svg };
      if (typeof node.opacity === 'number' && node.opacity < 1) vector.opacity = node.opacity;
      if (node.layoutPositioning === 'ABSOLUTE') vector.absolute = true;
      return vector;
    }
  }

  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const fillPaint = firstVisiblePaint(node.fills);
  const fill = fillPaint ? await figmaPaintToSchemaFill(fillPaint, ctx) : null;

  // Image-filled leaves and unsupported visual widgets become image nodes.
  if (!hasChildren && fill && fill.type === 'IMAGE') {
    const image = {
      type: 'IMAGE', name: node.name || 'Image', rect, fill,
      imageScaleMode: fillPaint.scaleMode === 'FIT' ? 'FIT' : 'FILL',
    };
    const stroke = figmaStrokeToSchema(node);
    if (stroke) image.stroke = stroke;
    const shadows = figmaEffectsToSchema(node);
    if (shadows.length) image.shadows = shadows;
    applyFigmaCorners(node, image);
    if (typeof node.opacity === 'number' && node.opacity < 1) image.opacity = node.opacity;
    if (node.layoutPositioning === 'ABSOLUTE') image.absolute = true;
    return image;
  }

  const unsupportedLeaf = !hasChildren
    && !['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'SECTION', 'RECTANGLE'].includes(node.type);
  if (unsupportedLeaf && typeof node.exportAsync === 'function') {
    try {
      const png = await node.exportAsync({ format: 'PNG' });
      if (png && png.length) {
        return {
          type: 'IMAGE', name: node.name || node.type, rect,
          fill: { type: 'IMAGE', bytes: bytesToBase64(png) }, imageScaleMode: 'FILL',
        };
      }
    } catch (_) { /* continue as an empty frame placeholder */ }
  }

  const out = {
    type: 'FRAME', name: node.name || node.type || 'Frame', rect,
    layout: figmaLayoutToSchema(node), children: [],
  };
  if (fill) out.fill = fill;
  const stroke = figmaStrokeToSchema(node);
  if (stroke) out.stroke = stroke;
  const shadows = figmaEffectsToSchema(node);
  if (shadows.length) out.shadows = shadows;
  applyFigmaCorners(node, out);
  if (typeof node.opacity === 'number' && node.opacity < 1) out.opacity = node.opacity;
  if (node.clipsContent) out.clips = true;
  if (node.layoutPositioning === 'ABSOLUTE') out.absolute = true;
  if (parentLayoutMode === 'HORIZONTAL' && node.layoutSizingHorizontal === 'FILL') out.flexGrow = 1;
  if (parentLayoutMode === 'VERTICAL' && node.layoutSizingVertical === 'FILL') out.flexGrow = 1;

  const childMode = out.layout ? out.layout.mode : 'NONE';
  for (const child of node.children || []) {
    try {
      const serialized = await serializeFigmaNode(child, origin, ctx, childMode, false);
      if (serialized) out.children.push(serialized);
    } catch (_) {
      // A locked/library child that cannot be read should not lose the
      // complete canvas copy; other layers still export.
    }
  }
  return out;
}

function unionBBox(nodes) {
  const boxes = (nodes || []).filter((node) => node && node.visible !== false).map(figmaBBox)
    .filter((box) => box.w > 0 || box.h > 0);
  if (!boxes.length) return { x: 0, y: 0, w: 1, h: 1 };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

async function serializeFigmaSlideTarget(target, ctx) {
  let slide;
  if (target.kind === 'page') {
    const nodes = (target.page.children || []).filter((node) => node && node.visible !== false && node.type !== 'SLICE');
    const origin = unionBBox(nodes);
    slide = {
      type: 'FRAME', name: target.name, role: 'slide',
      rect: { x: 0, y: 0, w: round2(origin.w), h: round2(origin.h) },
      layout: { mode: 'NONE', gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, primaryAlign: 'MIN', counterAlign: 'MIN' },
      children: [], clips: true,
    };
    for (const node of nodes) {
      const serialized = await serializeFigmaNode(node, origin, ctx, 'NONE', false);
      if (serialized) slide.children.push(serialized);
    }
    return slide;
  }

  const node = target.node;
  const origin = figmaBBox(node);
  const serialized = await serializeFigmaNode(node, origin, ctx, 'NONE', true);
  if (!serialized) return null;
  if (serialized.type === 'FRAME') {
    slide = serialized;
  } else {
    slide = {
      type: 'FRAME', name: target.name, role: 'slide',
      rect: { x: 0, y: 0, w: Math.max(1, serialized.rect.w), h: Math.max(1, serialized.rect.h) },
      layout: { mode: 'NONE', gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, primaryAlign: 'MIN', counterAlign: 'MIN' },
      children: [serialized], clips: true,
    };
  }
  slide.role = 'slide';
  slide.name = target.name || slide.name || 'Figma artboard';
  slide.rect.x = 0;
  slide.rect.y = 0;
  slide.clips = true;
  return slide;
}

async function ensureAllFigmaPagesLoaded() {
  if (typeof figma.loadAllPagesAsync === 'function') {
    try { await figma.loadAllPagesAsync(); } catch (_) { /* current page still works */ }
  }
}

function figmaPages() {
  const pages = figma.root && Array.isArray(figma.root.children)
    ? figma.root.children.filter((node) => node && node.type === 'PAGE')
    : [];
  return pages.length ? pages : [figma.currentPage];
}

function figmaPageTargets(page) {
  const targets = [];
  for (const child of page.children || []) {
    if (!child || child.visible === false) continue;
    if (child.type === 'SECTION') {
      const frames = (child.children || []).filter((node) => node && node.visible !== false
        && FIGMA_ARTBOARD_TYPES.includes(node.type));
      if (frames.length) {
        for (const frame of frames) targets.push({ kind: 'node', id: frame.id, node: frame, page, name: frame.name || 'Artboard' });
      } else {
        targets.push({ kind: 'node', id: child.id, node: child, page, name: child.name || 'Section' });
      }
    } else if (FIGMA_ARTBOARD_TYPES.includes(child.type)) {
      targets.push({ kind: 'node', id: child.id, node: child, page, name: child.name || 'Artboard' });
    }
  }
  if (!targets.length && (page.children || []).some((node) => node && node.visible !== false && node.type !== 'SLICE')) {
    const box = unionBBox(page.children || []);
    targets.push({
      kind: 'page', id: `page:${page.id}`, page,
      name: `${page.name || 'Page'} — entire page`,
      summaryBox: box,
    });
  }
  return targets;
}

function figmaTargetSummary(target) {
  const box = target.kind === 'page' ? (target.summaryBox || unionBBox(target.page.children || [])) : figmaBBox(target.node);
  return {
    id: target.id,
    name: target.name,
    type: target.kind === 'page' ? 'PAGE' : target.node.type,
    pageId: target.page ? target.page.id : '',
    pageName: target.page ? (target.page.name || 'Page') : '',
    w: Math.round(box.w || 0),
    h: Math.round(box.h || 0),
  };
}

async function listFigmaCanvas() {
  await ensureAllFigmaPagesLoaded();
  const pages = figmaPages().map((page) => ({
    id: page.id,
    name: page.name || 'Page',
    frames: figmaPageTargets(page).map(figmaTargetSummary),
  }));
  const selection = (figma.currentPage.selection || [])
        .filter((node) => node && node.visible !== false)
    .map((node) => figmaTargetSummary({ kind: 'node', id: node.id, node, page: figma.currentPage, name: node.name || node.type }));
  figma.ui.postMessage({
    type: 'figma-canvas',
    pages,
    selection,
    currentPageId: figma.currentPage ? figma.currentPage.id : '',
  });
}

function isDescendantOf(node, ancestor) {
  let current = node && node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

async function resolveFigmaExportTargets(options) {
  const scope = options && options.scope;
  await ensureAllFigmaPagesLoaded();
  const pages = figmaPages();
  if (scope === 'selection') {
    const selected = [...(figma.currentPage.selection || [])]
      .filter((node) => node && node.visible !== false && node.type !== 'SLICE');
    const roots = selected.filter((node) => !selected.some((other) => other !== node && isDescendantOf(node, other)));
    return roots.map((node) => ({ kind: 'node', id: node.id, node, page: figma.currentPage, name: node.name || node.type }));
  }
  if (scope === 'checklist') {
    const wanted = new Set(Array.isArray(options.frameIds) ? options.frameIds : []);
    const targets = [];
    for (const page of pages) {
      for (const target of figmaPageTargets(page)) {
        if (wanted.has(target.id)) targets.push(target);
      }
    }
    return targets;
  }
  if (scope === 'all-pages') {
    const targets = [];
    for (const page of pages) {
      for (const target of figmaPageTargets(page)) {
        targets.push(pages.length > 1
          ? { ...target, name: `${page.name || 'Page'} / ${target.name}` }
          : target);
      }
    }
    return targets;
  }
  return figmaPageTargets(figma.currentPage);
}

async function exportFigmaCanvas(options) {
  const targets = await resolveFigmaExportTargets(options || {});
  if (!targets.length) {
    throw new Error(options && options.scope === 'selection'
      ? 'Select at least one frame/layer on the Figma canvas first.'
      : 'No Figma frames were found for that copy option.');
  }
  const ctx = { imageCache: new Map(), count: 0 };
  const slides = [];
  for (let i = 0; i < targets.length; i += 1) {
    figma.ui.postMessage({
      type: 'figma-export-status',
      message: `Copying Figma artboard ${i + 1} of ${targets.length}: ${targets[i].name}`,
    });
    const slide = await serializeFigmaSlideTarget(targets[i], ctx);
    if (slide) slides.push(slide);
  }
  if (!slides.length) throw new Error('Nothing readable was found in the selected Figma canvas.');

  let root;
  if (slides.length === 1) {
    root = slides[0];
  } else {
    let y = 0, maxW = 0;
    for (const slide of slides) {
      translateTree(slide, -slide.rect.x, -slide.rect.y + y);
      y += slide.rect.h + 80;
      maxW = Math.max(maxW, slide.rect.w);
    }
    root = {
      type: 'FRAME', name: 'Figma canvas copy', role: 'deck',
      rect: { x: 0, y: 0, w: Math.max(1, maxW), h: Math.max(1, y - 80) },
      children: slides,
    };
  }

  const byType = { FRAME: 0, TEXT: 0, IMAGE: 0, VECTOR: 0 };
  (function count(node) {
    if (byType[node.type] != null) byType[node.type] += 1;
    for (const child of node.children || []) count(child);
  })(root);
  const rootName = figma.root && figma.root.name && figma.root.name !== 'Document'
    ? figma.root.name : 'Figma canvas copy';
  const payload = {
    schema: 'claude2figma',
    schemaVersion: 1,
    title: rootName,
    sourceUrl: '',
    capturedAt: new Date().toISOString(),
    slideCount: slides.length,
    captureReport: {
      extensionVersion: FIGMA_EXPORT_VERSION,
      nodes: countNodes(root), byType,
      mode: slides.length > 1 ? 'artboards' : 'page',
      scope: options && options.scope ? options.scope : 'current-page',
      artboardsDetected: slides.length,
      selectedArtboards: slides.length,
      detectionMethod: 'figma-plugin',
      frameUrl: 'figma-plugin://current-file',
    },
    root,
  };
  const json = JSON.stringify(payload);
  figma.ui.postMessage({
    type: 'figma-export',
    json,
    filename: `${slugifyForFile(rootName)}.deck.json`,
    slides: slides.length,
    nodes: countNodes(root),
    frames: slides.map((slide) => ({
      name: slide.name,
      width: Math.round(slide.rect.w || 0),
      height: Math.round(slide.rect.h || 0),
    })),
  });
}

// ==================================================================== ui
figma.ui.onmessage = async (msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'cancel') {
    importState.cancelled = true;
    return;
  }
  if (msg.type === 'get-import-prefs') {
    // Remembered size choices: keeps repeat imports down to drop → Import.
    let prefs = null;
    try {
      if (figma.clientStorage && figma.clientStorage.getAsync) {
        prefs = await figma.clientStorage.getAsync('importPrefs');
      }
    } catch (_) { prefs = null; }
    figma.ui.postMessage({ type: 'import-prefs', prefs: prefs || null });
    return;
  }
  if (msg.type === 'save-import-prefs') {
    try {
      if (figma.clientStorage && figma.clientStorage.setAsync) {
        await figma.clientStorage.setAsync('importPrefs', msg.prefs || null);
      }
    } catch (_) { /* storage unavailable — preferences simply not remembered */ }
    return;
  }
  if (msg.type === 'get-figma-canvas') {
    try {
      await listFigmaCanvas();
    } catch (error) {
      figma.ui.postMessage({
        type: 'figma-export-error',
        message: String(error && error.message ? error.message : error),
      });
    }
    return;
  }
  if (msg.type === 'export-figma-canvas') {
    try {
      await exportFigmaCanvas(msg.options || {});
    } catch (error) {
      figma.ui.postMessage({
        type: 'figma-export-error',
        message: String(error && error.message ? error.message : error),
      });
    }
    return;
  }
  if (msg.type === 'import') {
    try {
      await importDeck(msg.payload, msg.options);
    } catch (error) {
      figma.ui.postMessage({
        type: 'error',
        message: String(error && error.message ? error.message : error),
      });
    }
  }
};
