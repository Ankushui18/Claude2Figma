"use strict";
(() => {
  // src/content/resample.ts
  var FATOR_NITIDEZ = 1;
  function tamanhoAlvo(o) {
    const fator = o.fator ?? FATOR_NITIDEZ;
    if (o.naturalW <= 0 || o.naturalH <= 0) return { w: 0, h: 0 };
    if (o.exibidoW <= 0 || o.exibidoH <= 0) return { w: o.naturalW, h: o.naturalH };
    const escala = Math.min(
      1,
      Math.max(o.exibidoW * fator / o.naturalW, o.exibidoH * fator / o.naturalH)
    );
    return {
      w: Math.max(1, Math.round(o.naturalW * escala)),
      h: Math.max(1, Math.round(o.naturalH * escala))
    };
  }
  function pareceSvg(tipo, primeirosBytes2) {
    if (tipo.includes("svg")) return true;
    return /^\s*(<\?xml|<!doctype svg|<svg)/i.test(primeirosBytes2);
  }
  function tamanhoAlvoVetor(exibido, fator = FATOR_NITIDEZ) {
    return {
      w: Math.max(1, Math.round((exibido.w || 1) * fator)),
      h: Math.max(1, Math.round((exibido.h || 1) * fator))
    };
  }
  async function rasterizarVetor(blob, alvo) {
    if (typeof Image !== "function" || typeof URL?.createObjectURL !== "function") return null;
    const href = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("svg n\xE3o carregou"));
        img.src = href;
      });
      const canvas = new OffscreenCanvas(alvo.w, alvo.h);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, alvo.w, alvo.h);
      return await canvas.convertToBlob({ type: "image/png" });
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(href);
    }
  }
  function temTransparencia(dados) {
    for (let i = 3; i < dados.length; i += 4) {
      if (dados[i] < 255) return true;
    }
    return false;
  }
  async function reamostrar(blob, exibido) {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
      return blob;
    }
    if (pareceSvg(blob.type ?? "", await primeirosBytes(blob))) {
      const png = await rasterizarVetor(blob, tamanhoAlvoVetor(exibido));
      return png ?? blob;
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      return blob;
    }
    try {
      const alvo = tamanhoAlvo({
        naturalW: bitmap.width,
        naturalH: bitmap.height,
        exibidoW: exibido.w,
        exibidoH: exibido.h
      });
      if (alvo.w >= bitmap.width && alvo.h >= bitmap.height) return blob;
      const canvas = new OffscreenCanvas(alvo.w, alvo.h);
      const ctx = canvas.getContext("2d");
      if (!ctx) return blob;
      ctx.drawImage(bitmap, 0, 0, alvo.w, alvo.h);
      const transparente = temTransparencia(ctx.getImageData(0, 0, alvo.w, alvo.h).data);
      const saida = transparente ? await canvas.convertToBlob({ type: "image/png" }) : await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
      return saida.size < blob.size ? saida : blob;
    } catch {
      return blob;
    } finally {
      bitmap.close?.();
    }
  }
  function maiorExibido(nos) {
    return nos.reduce(
      (maior, n) => ({ w: Math.max(maior.w, n.rect?.w ?? 0), h: Math.max(maior.h, n.rect?.h ?? 0) }),
      { w: 0, h: 0 }
    );
  }
  async function primeirosBytes(blob) {
    try {
      const pedaco = typeof blob.slice === "function" ? blob.slice(0, 128) : blob;
      return await pedaco.text();
    } catch {
      return "";
    }
  }

  // src/content/images.ts
  var MAX_CONCURRENT_FETCHES = 6;
  async function resolveImageBytes(imageRefs) {
    let fetched = 0;
    let failed = 0;
    const refsByUrl = /* @__PURE__ */ new Map();
    for (const ref of imageRefs) {
      const group = refsByUrl.get(ref.url);
      if (group) {
        group.push(ref);
      } else {
        refsByUrl.set(ref.url, [ref]);
      }
    }
    const urls = Array.from(refsByUrl.keys());
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < urls.length) {
        const url = urls[nextIndex];
        nextIndex += 1;
        const refs = refsByUrl.get(url) ?? [];
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const exibido = maiorExibido(refs.map((r) => r.node));
          const bruto = typeof response.blob === "function" ? await response.blob() : null;
          const buffer = bruto ? await (await reamostrar(bruto, exibido)).arrayBuffer() : await response.arrayBuffer();
          const base64 = arrayBufferToBase64(buffer);
          for (const ref of refs) {
            if (ref.node.fill?.type === "IMAGE") {
              ref.node.fill.bytes = base64;
            }
          }
          fetched += refs.length;
        } catch {
          failed += refs.length;
        }
      }
    }
    const workerCount = Math.min(MAX_CONCURRENT_FETCHES, urls.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { fetched, failed };
  }
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  // src/content/autoLayout.ts
  var JUSTIFY_MAP = {
    "flex-start": "MIN",
    start: "MIN",
    center: "CENTER",
    "flex-end": "MAX",
    end: "MAX",
    "space-between": "SPACE_BETWEEN"
  };
  var ALIGN_MAP = {
    "flex-start": "MIN",
    start: "MIN",
    center: "CENTER",
    "flex-end": "MAX",
    end: "MAX",
    stretch: "MIN"
  };
  function cssFlexToAutoLayout(input) {
    if (input.display !== "flex") {
      return {
        mode: "NONE",
        gap: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        primaryAlign: "MIN",
        counterAlign: "MIN"
      };
    }
    const mode = input.flexDirection.startsWith("column") ? "VERTICAL" : "HORIZONTAL";
    return {
      mode,
      gap: input.gap,
      padding: {
        top: input.paddingTop,
        right: input.paddingRight,
        bottom: input.paddingBottom,
        left: input.paddingLeft
      },
      primaryAlign: JUSTIFY_MAP[input.justifyContent] ?? "MIN",
      counterAlign: ALIGN_MAP[input.alignItems] ?? "MIN"
    };
  }

  // src/content/textRuns.ts
  function sameStyle(a, b) {
    return a.fontFamily === b.fontFamily && a.fontWeight === b.fontWeight && a.italic === b.italic && a.fontSize === b.fontSize && a.color === b.color && a.letterSpacing === b.letterSpacing && a.lineHeight === b.lineHeight;
  }
  function splitIntoRuns(fragments) {
    const runs = [];
    for (const fragment of fragments) {
      if (fragment.content === "") continue;
      const last = runs[runs.length - 1];
      if (last && sameStyle(last, fragment)) {
        last.content += fragment.content;
      } else {
        runs.push({ ...fragment });
      }
    }
    return runs;
  }

  // src/content/gradient.ts
  var KEYWORD_ANGLES = {
    "to top": 0,
    "to top right": 45,
    "to right top": 45,
    "to right": 90,
    "to bottom right": 135,
    "to right bottom": 135,
    "to bottom": 180,
    "to bottom left": 225,
    "to left bottom": 225,
    "to left": 270,
    "to top left": 315,
    "to left top": 315
  };
  function parseGradient(value) {
    const trimmed = value.trim();
    const prefixMatch = trimmed.match(/^(linear-gradient|radial-gradient)\(/);
    if (!prefixMatch) return null;
    const isLinear = prefixMatch[1] === "linear-gradient";
    const openParenIndex = prefixMatch[0].length - 1;
    const closeParenIndex = findMatchingParen(trimmed, openParenIndex);
    if (closeParenIndex === -1) return null;
    const remainder = trimmed.slice(closeParenIndex + 1).trim();
    if (remainder !== "") return null;
    const inner = trimmed.slice(openParenIndex + 1, closeParenIndex);
    const segments = splitTopLevel(inner);
    if (segments.length === 0) return null;
    if (isLinear) {
      const first2 = segments[0].trim();
      const angleFromDeg = first2.match(/^(-?[\d.]+)deg$/);
      const angleFromKeyword = KEYWORD_ANGLES[first2.toLowerCase()];
      let angle;
      let stopSegments2;
      if (angleFromDeg) {
        angle = Number(angleFromDeg[1]);
        stopSegments2 = segments.slice(1);
      } else if (angleFromKeyword !== void 0) {
        angle = angleFromKeyword;
        stopSegments2 = segments.slice(1);
      } else {
        angle = 180;
        stopSegments2 = segments;
      }
      return { type: "GRADIENT_LINEAR", angle, stops: parseStops(stopSegments2) };
    }
    const first = segments[0].trim();
    const looksLikeShapeOrPosition = /\bat\b/i.test(first) || /^(circle|ellipse)\b/i.test(first) || /^(closest-side|closest-corner|farthest-side|farthest-corner)\b/i.test(first) || /^\d+(\.\d+)?(px|%|em|rem)(\s+\d+(\.\d+)?(px|%|em|rem))?$/i.test(first);
    const stopSegments = looksLikeShapeOrPosition ? segments.slice(1) : segments;
    return { type: "GRADIENT_RADIAL", stops: parseStops(stopSegments) };
  }
  function findMatchingParen(value, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < value.length; i++) {
      if (value[i] === "(") depth += 1;
      if (value[i] === ")") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
  function parseStops(segments) {
    const withPositions = segments.map((seg) => {
      const trimmed = seg.trim();
      const match = trimmed.match(/^(.*)\s+(-?[\d.]+)%$/);
      if (match) {
        return { color: match[1].trim(), position: Number(match[2]) / 100 };
      }
      return { color: trimmed, position: null };
    });
    const count = withPositions.length;
    return withPositions.map((stop, i) => ({
      color: stop.color,
      position: stop.position ?? (count === 1 ? 0 : i / (count - 1))
    }));
  }
  function splitTopLevel(value) {
    const parts = [];
    let depth = 0;
    let current = "";
    for (const char of value) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    if (current.trim() !== "") parts.push(current);
    return parts;
  }

  // src/content/shadow.ts
  function parseBoxShadow(value) {
    if (!value || value === "none") return null;
    const firstLayer = splitTopLevel2(value)[0];
    if (!firstLayer || firstLayer.trim() === "") return null;
    const inset = /\binset\b/i.test(firstLayer);
    const withoutInset = firstLayer.replace(/\binset\b/i, "").trim();
    const colorMatch = withoutInset.match(/rgba?\([^)]*\)|hsla?\([^)]*\)/);
    const color = colorMatch ? colorMatch[0] : "rgb(0, 0, 0)";
    const lengthsPart = colorMatch ? withoutInset.replace(colorMatch[0], "") : withoutInset;
    const lengths = lengthsPart.trim().split(/\s+/).filter(Boolean).map((token) => parseFloat(token));
    const [offsetX = 0, offsetY = 0, blur = 0, spread = 0] = lengths;
    return { color, offsetX, offsetY, blur, spread, inset };
  }
  function splitTopLevel2(value) {
    const parts = [];
    let depth = 0;
    let current = "";
    for (const char of value) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    if (current.trim() !== "") parts.push(current);
    return parts;
  }

  // src/content/gradientText.ts
  function totalmenteTransparente(cor) {
    if (cor === "transparent") return true;
    const m = /^rgba?\(([^)]*)\)$/.exec(cor.trim());
    if (!m) return false;
    const partes = m[1].split(",").map((v) => v.trim());
    return partes.length === 4 && parseFloat(partes[3]) === 0;
  }
  function textoInvisivel(n) {
    const runs = n.text?.runs ?? [];
    return n.type === "TEXT" && runs.length > 0 && runs.every((r) => totalmenteTransparente(r.color));
  }
  function moverGradienteParaTexto(node) {
    const filhos = node.children ?? [];
    const ehGradiente = node.fill?.type === "GRADIENT_LINEAR" || node.fill?.type === "GRADIENT_RADIAL";
    if (ehGradiente && filhos.length === 1 && textoInvisivel(filhos[0])) {
      filhos[0].fill = node.fill;
      delete node.fill;
    }
    for (const c of filhos) moverGradienteParaTexto(c);
  }

  // src/content/serializer.ts
  function medir(el, ctx) {
    const r = ctx.measure(el);
    const d = ctx.descontar ?? 1;
    if (d === 1) return r;
    return { x: r.x / d, y: r.y / d, w: r.w / d, h: r.h / d };
  }
  function escalaDe(el, ctx) {
    return getEffectiveScale(el) / (ctx.descontar ?? 1);
  }
  function serializeElement(root, ctx) {
    const rootNode = createContainerNode(root, ctx);
    rootNode.children = rootNode.children ?? [];
    walkChildren(root, rootNode, rootNode.children, ctx);
    moverGradienteParaTexto(rootNode);
    return rootNode;
  }
  function walkChildren(parentEl, positioningAncestor, targetChildren, ctx) {
    for (const child of Array.from(parentEl.children)) {
      if (child.tagName.toLowerCase() === "br") continue;
      if (!isVisible(child)) continue;
      const node = buildNodeForElement(child, ctx);
      if (!node) continue;
      const style = getComputedStyle(child);
      const isPositioned = style.position === "absolute" || style.position === "fixed";
      const establishesContext = ["relative", "absolute", "fixed", "sticky"].includes(style.position);
      if (isPositioned) {
        const z = parseInt(style.zIndex, 10);
        if (!Number.isNaN(z)) node.zIndex = z;
      }
      const destination = isPositioned ? positioningAncestor.children : targetChildren;
      destination.push(node);
      if (isPositioned && positioningAncestor.layout && positioningAncestor.layout.mode !== "NONE") {
        positioningAncestor.layout = { ...positioningAncestor.layout, mode: "NONE" };
      }
      if (node.type === "FRAME") {
        node.children = node.children ?? [];
        if (node.children.length === 0) {
          const nextAncestor = establishesContext ? node : positioningAncestor;
          walkChildren(child, nextAncestor, node.children, ctx);
        }
      }
    }
    for (const raw of Array.from(parentEl.childNodes)) {
      if (raw.nodeType !== 3) continue;
      const content = (raw.textContent ?? "").replace(/\s+/g, " ").trim();
      if (content === "") continue;
      targetChildren.push(buildLooseTextNode(raw, parentEl, content, ctx));
    }
    targetChildren.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  }
  function isVisible(el) {
    const style = getComputedStyle(el);
    if (style.display === "none") return false;
    if (style.visibility === "hidden") return false;
    if (parseFloat(style.opacity || "1") === 0) return false;
    return true;
  }
  function parsePx(value) {
    const n = parseFloat(value);
    return Number.isNaN(n) ? 0 : n;
  }
  function getEffectiveScale(el) {
    let node = el;
    while (node) {
      if (node instanceof HTMLElement && node.offsetWidth >= 40) {
        const rectWidth = node.getBoundingClientRect().width;
        if (rectWidth > 0) {
          const s = rectWidth / node.offsetWidth;
          if (Number.isFinite(s) && s > 0) {
            return Math.abs(s - 1) < 0.02 ? 1 : s;
          }
        }
      }
      node = node.parentElement;
    }
    return 1;
  }
  function buildNodeForElement(el, ctx) {
    const tag = el.tagName.toLowerCase();
    if (tag === "svg") {
      return { type: "VECTOR", rect: medir(el, ctx), svg: el.outerHTML };
    }
    if (tag === "img") {
      const node = { type: "IMAGE", rect: medir(el, ctx), fill: { type: "IMAGE", bytes: "" } };
      const src = el.getAttribute("src");
      if (src) ctx.imageRefs.push({ node, url: src });
      return node;
    }
    const style = getComputedStyle(el);
    const gradient = parseGradient(style.backgroundImage);
    const backgroundUrl = gradient ? null : extractBackgroundImageUrl(style.backgroundImage);
    if (backgroundUrl && el.children.length === 0) {
      const node = { type: "IMAGE", rect: medir(el, ctx), fill: { type: "IMAGE", bytes: "" } };
      ctx.imageRefs.push({ node, url: backgroundUrl });
      return node;
    }
    if (!backgroundUrl && isTextOnly(el)) {
      const textNode = buildTextNode(el, ctx);
      const container = createContainerNode(el, ctx);
      const decorated = container.fill !== void 0 || container.stroke !== void 0 || container.shadow !== void 0 || container.cornerRadius !== void 0;
      if (!decorated) return textNode;
      container.children = [textNode];
      return container;
    }
    return createContainerNode(el, ctx);
  }
  var BLOCK_DISPLAYS = ["block", "flow-root", "list-item", "table", "flex", "grid"];
  function isTextOnly(el) {
    if ((el.textContent ?? "").trim() === "") return false;
    const ownDisplay = getComputedStyle(el).display;
    if (el.children.length > 0 && ["flex", "inline-flex", "grid", "inline-grid"].includes(ownDisplay)) {
      return false;
    }
    if (el.querySelector("img, svg")) return false;
    for (const descendant of Array.from(el.querySelectorAll("*"))) {
      const descStyle = getComputedStyle(descendant);
      if (BLOCK_DISPLAYS.includes(descStyle.display)) return false;
      if (descStyle.position === "absolute" || descStyle.position === "fixed") return false;
    }
    return true;
  }
  function extractBackgroundImageUrl(value) {
    const match = value.match(/url\((['"]?)(.*?)\1\)/);
    return match ? match[2] : null;
  }
  function createContainerNode(el, ctx) {
    const style = getComputedStyle(el);
    const scale = escalaDe(el, ctx);
    const layout = cssFlexToAutoLayout({
      display: style.display,
      flexDirection: style.flexDirection,
      gap: parsePx(style.gap || style.rowGap || "0") * scale,
      paddingTop: parsePx(style.paddingTop) * scale,
      paddingRight: parsePx(style.paddingRight) * scale,
      paddingBottom: parsePx(style.paddingBottom) * scale,
      paddingLeft: parsePx(style.paddingLeft) * scale,
      justifyContent: style.justifyContent,
      alignItems: style.alignItems
    });
    const node = { type: "FRAME", rect: medir(el, ctx), layout, children: [] };
    const gradient = parseGradient(style.backgroundImage);
    const backgroundUrl = gradient ? null : extractBackgroundImageUrl(style.backgroundImage);
    if (gradient) {
      node.fill = gradient;
    } else if (backgroundUrl) {
      node.fill = { type: "IMAGE", bytes: "" };
      ctx.imageRefs.push({ node, url: backgroundUrl });
    } else {
      const bg = style.backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        node.fill = { type: "SOLID", color: bg };
      }
    }
    const radius = parsePx(style.borderRadius) * scale;
    if (radius > 0) node.cornerRadius = radius;
    const opacity = parseFloat(style.opacity || "1");
    if (opacity < 1) node.opacity = opacity;
    if (style.overflow !== "visible") node.clips = true;
    const sides = [
      { style: style.borderTopStyle, width: parsePx(style.borderTopWidth) * scale, color: style.borderTopColor },
      { style: style.borderRightStyle, width: parsePx(style.borderRightWidth) * scale, color: style.borderRightColor },
      { style: style.borderBottomStyle, width: parsePx(style.borderBottomWidth) * scale, color: style.borderBottomColor },
      { style: style.borderLeftStyle, width: parsePx(style.borderLeftWidth) * scale, color: style.borderLeftColor }
    ];
    const weights = sides.map((s) => s.style !== "none" && s.width > 0 ? s.width : 0);
    const maxWeight = Math.max(...weights);
    if (maxWeight > 0) {
      const firstActive = sides[weights.findIndex((w) => w > 0)];
      const uniform = weights.every((w) => w === maxWeight);
      const dashed = firstActive.style === "dashed" || firstActive.style === "dotted";
      node.stroke = {
        color: firstActive.color,
        width: maxWeight,
        ...dashed ? { dashed: true } : {},
        ...uniform ? {} : { perSide: { top: weights[0], right: weights[1], bottom: weights[2], left: weights[3] } }
      };
    }
    const shadow = parseBoxShadow(style.boxShadow);
    if (shadow) {
      node.shadow = {
        ...shadow,
        offsetX: shadow.offsetX * scale,
        offsetY: shadow.offsetY * scale,
        blur: shadow.blur * scale,
        spread: shadow.spread * scale
      };
    }
    return node;
  }
  function buildTextNode(el, ctx) {
    const fragments = [];
    collectTextFragments(el, fragments, ctx);
    return {
      type: "TEXT",
      rect: medir(el, ctx),
      text: {
        runs: splitIntoRuns(normalizeFragments(fragments)),
        align: readTextAlign(el),
        lines: countTextLines(el)
      }
    };
  }
  function buildLooseTextNode(textNode, parentEl, content, ctx) {
    let rect;
    try {
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const r = range.getBoundingClientRect();
      const d = ctx.descontar ?? 1;
      rect = { x: r.x / d, y: r.y / d, w: r.width / d, h: r.height / d };
    } catch {
      rect = { x: 0, y: 0, w: 0, h: 0 };
    }
    const style = readTextStyle(parentEl, ctx);
    return {
      type: "TEXT",
      rect,
      text: { runs: [{ content, ...style }], align: readTextAlign(parentEl), lines: 1 }
    };
  }
  function countTextLines(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects());
      if (rects.length === 0) return 1;
      const style = getComputedStyle(el);
      const scale = getEffectiveScale(el);
      const lineHeight = (parsePx(style.lineHeight) || parsePx(style.fontSize) * 1.2 || 16) * scale;
      const tolerance = Math.max(2, lineHeight * 0.5);
      const tops = rects.map((r) => r.top).sort((a, b) => a - b);
      let lines = 1;
      let currentLineTop = tops[0];
      for (const top of tops) {
        if (top - currentLineTop > tolerance) {
          lines += 1;
          currentLineTop = top;
        }
      }
      return lines;
    } catch {
      return 1;
    }
  }
  function normalizeFragments(fragments) {
    const collapsed = fragments.map(
      (frag) => frag.content === "\n" ? frag : { ...frag, content: frag.content.replace(/\s+/g, " ") }
    );
    const isBreak = (frag) => frag?.content === "\n";
    const out = [];
    for (let i = 0; i < collapsed.length; i++) {
      const frag = collapsed[i];
      if (isBreak(frag)) {
        out.push(frag);
        continue;
      }
      let content = frag.content;
      if (i === 0 || isBreak(collapsed[i - 1])) content = content.replace(/^ /, "");
      if (i === collapsed.length - 1 || isBreak(collapsed[i + 1])) content = content.replace(/ $/, "");
      const prev = out[out.length - 1];
      if (prev && !isBreak(prev) && prev.content.endsWith(" ") && content.startsWith(" ")) {
        content = content.replace(/^ /, "");
      }
      if (content === "") continue;
      out.push({ ...frag, content });
    }
    return out;
  }
  function readTextAlign(el) {
    const value = getComputedStyle(el).textAlign;
    if (value === "center") return "CENTER";
    if (value === "right" || value === "end") return "RIGHT";
    return "LEFT";
  }
  function collectTextFragments(node, out, ctx) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const content = child.textContent ?? "";
        if (content === "") continue;
        const parentEl = child.parentElement ?? node;
        out.push({ content, ...readTextStyle(parentEl, ctx) });
      } else if (child.nodeType === 1) {
        if (child.tagName.toLowerCase() === "br") {
          const parentEl = child.parentElement ?? node;
          out.push({ content: "\n", ...readTextStyle(parentEl, ctx) });
          continue;
        }
        collectTextFragments(child, out, ctx);
      }
    }
  }
  function readTextStyle(el, ctx) {
    const style = getComputedStyle(el);
    const scale = escalaDe(el, ctx);
    const lineHeightPx = style.lineHeight === "normal" ? 0 : parsePx(style.lineHeight);
    return {
      fontFamily: style.fontFamily.split(",")[0].replace(/["']/g, "").trim() || "Inter",
      fontWeight: parseInt(style.fontWeight, 10) || 400,
      italic: style.fontStyle === "italic",
      fontSize: (parsePx(style.fontSize) || 16) * scale,
      color: style.color || "#000000",
      letterSpacing: (style.letterSpacing === "normal" ? 0 : parsePx(style.letterSpacing)) * scale,
      ...lineHeightPx > 0 ? { lineHeight: lineHeightPx * scale } : {}
    };
  }

  // src/content/sondaDeck.ts
  var SELETOR_DECK_STAGE = "deck-stage";

  // src/content/deckStage.ts
  var TROCA_TIMEOUT_MS = 2e3;
  var POLL_MS = 40;
  var GAP = 80;
  function acharDeckStage(doc) {
    return doc.querySelector(SELETOR_DECK_STAGE);
  }
  function acharControle(sr, aria, classe, title) {
    const alvo = sr.querySelector(`[aria-label="${aria}"]`) ?? sr.querySelector(classe) ?? sr.querySelector(`[title^="${title}"]`);
    return alvo && typeof alvo.click === "function" ? alvo : null;
  }
  function lerPalco(stage) {
    const sr = stage.shadowRoot;
    if (!sr) {
      return {
        motivo: "sem-shadow-root",
        detalhe: `<${stage.tagName.toLowerCase()}> sem shadowRoot acess\xEDvel (fechado, ou o componente n\xE3o subiu). filhos=${stage.children.length}`
      };
    }
    const slides = Array.from(stage.children).filter((e) => e.tagName === "SECTION");
    if (slides.length === 0) {
      const tags = Array.from(stage.children).map((e) => e.tagName.toLowerCase());
      return { motivo: "sem-sections", detalhe: `nenhum <section> em <deck-stage>. filhos: ${tags.join(", ") || "(nenhum)"}` };
    }
    const next = acharControle(sr, "Next slide", ".btn.next", "Next");
    const reset = acharControle(sr, "Reset to first slide", ".btn.reset", "Reset");
    if (!next || !reset) {
      const candidatos = Array.from(sr.querySelectorAll("button, [role=button], [aria-label]")).slice(0, 25).map((b) => `${b.tagName.toLowerCase()}[aria=${b.getAttribute("aria-label")}|cls=${b.className}|title=${b.getAttribute("title")}]`);
      return {
        motivo: "sem-controles",
        detalhe: `next=${!!next} reset=${!!reset}; ${slides.length} slides; candidatos no shadow (${candidatos.length}): ${candidatos.join(" ") || "(nenhum)"}`
      };
    }
    return { slides, next, reset };
  }
  function ehFalha(r) {
    return "motivo" in r;
  }
  function slideVisivel(slides) {
    return slides.find((s) => {
      if (!isVisible(s)) return false;
      const r = s.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) ?? null;
  }
  async function esperarTroca(slides, anterior) {
    const limite = Date.now() + TROCA_TIMEOUT_MS;
    for (; ; ) {
      const atual = slideVisivel(slides);
      if (atual && atual !== anterior) return atual;
      if (Date.now() >= limite) return null;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
  function transladar(node, dx, dy) {
    node.rect = { ...node.rect, x: node.rect.x + dx, y: node.rect.y + dy };
    for (const c of node.children ?? []) transladar(c, dx, dy);
  }
  function montarDeck(slides) {
    let y = 0;
    let larguraMax = 0;
    for (const s of slides) {
      transladar(s, -s.rect.x, -s.rect.y + y);
      y += s.rect.h + GAP;
      larguraMax = Math.max(larguraMax, s.rect.w);
    }
    const altura = Math.max(1, y - GAP);
    const caixa = { x: 0, y: 0, w: Math.max(1, larguraMax), h: altura };
    for (const s of slides) s.role = "slide";
    if (slides.length === 1) return slides[0];
    return {
      type: "FRAME",
      rect: { ...caixa },
      children: [{ type: "FRAME", role: "deck", rect: { ...caixa }, children: slides }]
    };
  }
  var DeckStageError = class extends Error {
  };
  async function capturarDeckStage(palco, serializar, aoProgredir) {
    const total = palco.slides.length;
    const inicial = slideVisivel(palco.slides);
    const indiceInicial = inicial ? palco.slides.indexOf(inicial) : 0;
    palco.reset.click();
    if (indiceInicial !== 0) {
      const voltou = await esperarTroca(palco.slides, inicial);
      if (voltou !== palco.slides[0]) {
        throw new DeckStageError("O deck n\xE3o voltou para o primeiro slide.");
      }
    }
    const capturados = [];
    for (let i = 0; i < total; i += 1) {
      const atual = slideVisivel(palco.slides);
      if (!atual) throw new DeckStageError(`Nenhum slide vis\xEDvel na posi\xE7\xE3o ${i + 1} de ${total}.`);
      capturados.push(serializar(atual));
      aoProgredir?.(i + 1, total);
      if (i === total - 1) break;
      palco.next.click();
      const proximo = await esperarTroca(palco.slides, atual);
      if (!proximo) {
        throw new DeckStageError(`O deck parou no slide ${i + 1} de ${total} \u2014 o avan\xE7o n\xE3o respondeu.`);
      }
    }
    if (capturados.length !== total) {
      throw new DeckStageError(`Capturei ${capturados.length} de ${total} slides.`);
    }
    if (indiceInicial !== total - 1) {
      palco.reset.click();
      for (let i = 0; i < indiceInicial; i += 1) palco.next.click();
    }
    return montarDeck(capturados);
  }
  function escalaDeAjuste(stage, slide) {
    const larguraDesign = Number(stage.designWidth) || Number(stage.getAttribute("width")) || 0;
    if (!Number.isFinite(larguraDesign) || larguraDesign <= 0) return 1;
    const naTela = slide.getBoundingClientRect().width;
    if (!Number.isFinite(naTela) || naTela <= 0) return 1;
    const s = naTela / larguraDesign;
    return Math.abs(s - 1) < 0.02 ? 1 : s;
  }

  // src/content/arvore.ts
  async function montarArvore(doc, deps) {
    const { measure: measure2, imageRefs, aoProgredir } = deps;
    const serializar = deps.serializar ?? ((el, descontar) => serializeElement(el, { measure: measure2, imageRefs, descontar }));
    const stage = acharDeckStage(doc);
    if (!stage) {
      const slide = doc.querySelector("section.slide, .frame > section, [data-label]");
      const descontar = slide ? getEffectiveScale(slide) : 1;
      return serializar(doc.body, descontar);
    }
    const palco = lerPalco(stage);
    if (ehFalha(palco)) {
      console.error(`[claude-import] deck-stage ileg\xEDvel (${palco.motivo}): ${palco.detalhe}`);
      console.error(`[claude-import] frame: ${location.href}`);
      throw new DeckStageError(
        `Modo de slides: ${palco.motivo}. Detalhe no console deste frame. Pe\xE7a ao Claude para colocar todos os slides numa p\xE1gina s\xF3 e capture de novo.`
      );
    }
    try {
      return await capturarDeckStage(
        palco,
        (slide) => serializar(slide, escalaDeAjuste(stage, slide)),
        aoProgredir
      );
    } catch (erro) {
      console.error(`[claude-import] falha ao percorrer os slides: ${String(erro)}`);
      console.error(`[claude-import] frame: ${location.href}; ${palco.slides.length} sections`);
      throw erro;
    }
  }

  // src/content/inject.ts
  function measure(el) {
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  }
  async function run() {
    try {
      const imageRefs = [];
      const tree = await montarArvore(document, {
        measure,
        imageRefs,
        aoProgredir: (feitos, total) => chrome.runtime.sendMessage({ type: "capture-progress", payload: { feitos, total } })
      });
      await resolveImageBytes(imageRefs);
      const json = JSON.stringify(tree);
      const urls = new Set(imageRefs.map((r) => r.url));
      const bytesDeImagem = imageRefs.reduce(
        (soma, r) => soma + (r.node.fill?.type === "IMAGE" ? r.node.fill.bytes?.length ?? 0 : 0),
        0
      );
      const distintos = /* @__PURE__ */ new Map();
      for (const r of imageRefs) {
        if (r.node.fill?.type === "IMAGE") distintos.set(r.url, r.node.fill.bytes?.length ?? 0);
      }
      const bytesUnicos = Array.from(distintos.values()).reduce((a, b) => a + b, 0);
      const kb = (n) => `${Math.round(n / 1024)} KB`;
      console.log(
        `[claude-import] payload ${kb(json.length)} | imagens ${kb(bytesDeImagem)} em ${imageRefs.length} n\xF3s, ${urls.size} URLs distintas ocupando ${kb(bytesUnicos)} | geometria ~${kb(json.length - bytesDeImagem)} | economia poss\xEDvel deduplicando: ${kb(bytesDeImagem - bytesUnicos)}`
      );
      chrome.runtime.sendMessage({
        type: "capture-result",
        payload: { ok: true, json }
      });
    } catch (error) {
      chrome.runtime.sendMessage({
        type: "capture-result",
        payload: error instanceof DeckStageError ? { ok: false, error: error.message, kind: "slides-mode" } : { ok: false, error: `Falha ao capturar: ${String(error)}` }
      });
    }
  }
  run();
})();
