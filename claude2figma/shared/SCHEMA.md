# Claude2Figma deck-file schema (`.deck.json`)

The Chrome extension and the Figma plugin communicate through one local JSON
file. No server is involved: the extension serializes a web page (optimized for
Claude Design decks) into this format, or the Figma plugin serializes the
current Figma canvas from native layers into the same format. The user
downloads/copies the JSON, and the plugin rebuilds it as native Figma layers.

> **Schema id:** new exports always write `"schema": "claude2figma"`.
> Files captured before the project rename carry `"schema": "deckbridge"` —
> importers accept **both**, so existing captures keep working unchanged.

## Envelope

```jsonc
{
  "schema": "claude2figma",
  "schemaVersion": 1,
  "title": "My pitch deck",          // tab / document title
  "sourceUrl": "https://…",          // where it was captured (may be "")
  "capturedAt": "2026-10-27T10:00:00.000Z",
  "slideCount": 5,                   // 1 for single-page captures
  "captureReport": {                 // diagnostics (plugin ignores it)
    "mode": "slides" | "artboards" | "page",
    "scope": "full" | "selected" | "single" | "selection" | "checklist" |
             "current-page" | "all-pages", // web-capture or standalone Figma-export scope
    "artboardsDetected": 6, "selectedArtboards": 2,
    "detectionMethod": "visual",     // deck-stage | labelled | visual | page | figma-plugin
    "frameUrl": "https://…",         // document that actually held the design
    "contentRootsStripped": 1,       // outer host -> inside-screen captures
    "layersRemoved": 180, "inferredAutoLayouts": 12,
    "nodes": 1240, "byType": { "FRAME": 800, "TEXT": 300, "IMAGE": 120, "VECTOR": 20 },
    "shadowPierced": 6, "iframesPierced": 0, "iframesBlocked": 0,
    "sealedHosts": 0, "imagesFailed": 0 /* … */
  },
  "root": { /* Node */ }
}
```

If the capture came from a multi-artboard Claude Design canvas or the
Figma plugin's **Copy Figma canvas** exporter, `root` is a `FRAME` with
`role: "deck"` whose children are the artboards (`role: "slide"`).
Figma-canvas exports set `captureReport.detectionMethod: "figma-plugin"` and
`captureReport.frameUrl: "figma-plugin://current-file"`. The plugin turns
every slide into a top-level Figma frame. A single-artboard capture has a
single `FRAME` root with `role: "slide"`; a whole-page capture has one
`FRAME` root with `role: "page"`. Separate cross-origin iframe artboards are
assembled by the extension worker and use
`captureReport.detectionMethod: "multi-frame-iframes"` without changing the
node schema.

## Node

All coordinates are CSS pixels in **design space** (any on-screen preview
scaling Claude applies is divided out during capture). `rect` values are
absolute within the root; the plugin converts them to parent-relative
positions while rebuilding.

```jsonc
{
  "type": "FRAME" | "TEXT" | "IMAGE" | "VECTOR",
  "name": "section.hero",                       // best-effort layer name
  "role": "deck" | "slide" | "page",            // optional, structural nodes only
  "rect": { "x": 0, "y": 0, "w": 1280, "h": 720 },
  "zIndex": 2,                                  // optional, positioned nodes
  "absolute": true,                             // optional: CSS absolute/fixed
  "flexGrow": 1,                                // optional: direct CSS flex item

  // FRAME -------------------------------------------------------------
  "layout": {                                   // CSS flex / 1-axis grid / exact stack
    "mode": "NONE" | "HORIZONTAL" | "VERTICAL",
    "gap": 16,
    "counterGap": 8,                            // optional, wrapped rows/columns
    "wrap": true,                               // optional CSS flex-wrap
    "padding": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
    "primaryAlign": "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN",
    "counterAlign": "MIN" | "CENTER" | "MAX"
  },
  "children": [ /* Node… */ ],

  // Paint / effects (FRAME, IMAGE, sometimes TEXT) ---------------------
  "fill":
    | { "type": "SOLID", "color": "rgba(30, 30, 30, 1)" }
    | { "type": "IMAGE", "bytes": "<base64>" }  // bytes may be "" if fetch failed
    | { "type": "GRADIENT_LINEAR", "angle": 180,
        "stops": [ { "color": "#fff", "position": 0 }, … ] }
    | { "type": "GRADIENT_RADIAL",
        "stops": [ { "color": "#fff", "position": 0 }, … ] },
  "imageScaleMode": "FILL" | "FIT",             // from CSS object-fit
  "stroke": {
    "color": "rgb(56, 56, 56)", "width": 1,
    "dashed": true,                             // optional
    "perSide": { "top": 1, "right": 0, "bottom": 0, "left": 0 }  // optional
  },
  "shadows": [ { "offsetX": 0, "offsetY": 8, "blur": 24, "spread": 0,
                  "color": "rgba(0,0,0,0.15)", "inset": false } ],
  "cornerRadius": 16,                           // uniform…
  "cornerRadii": { "tl": 16, "tr": 16, "br": 0, "bl": 0 },  // …or per corner
  "opacity": 0.9,
  "clips": true,                                // CSS overflow ≠ visible

  // TEXT ---------------------------------------------------------------
  "text": {
    "runs": [ {
      "content": "Hello ",
      "fontFamily": "Inter", "fontWeight": 600, "italic": false,
      "fontSize": 48, "color": "rgb(242, 242, 242)",
      "letterSpacing": 0,                       // px
      "lineHeight": 56,                         // px, optional
      "underline": false, "strikethrough": false
    } ],
    "align": "LEFT" | "CENTER" | "RIGHT",
    "lines": 2
  },

  // VECTOR -------------------------------------------------------------
  "svg": "<svg …>…</svg>"
}
```

## Notes / deliberate approximations

- Colors are CSS strings (`rgb()`, `rgba()`, hex, `hsl()`); the plugin parses
  them so neither the extension nor the native Figma exporter needs separate
  import-side color math.
- Images are inlined as base64 *in the file* (web captures are downscaled to
  ≤ 2× displayed size; Figma exports embed the original image bytes returned
  by the Plugin API). Nothing is fetched at import time.
- CSS `linear-gradient` angle follows CSS convention (0° = to top,
  180° = to bottom). Gradient geometry is approximated onto Figma's
  `gradientTransform` (CSS "magic corners" length rules are not reproduced).
- Box-shadow blur is mapped 1:1 to Figma's effect radius (visually close,
  not pixel-identical).
- Rotations (`transform: rotate()`), two-dimensional grid layouts, backdrop
  filters, blend modes, and list markers beyond a simple `•` are not captured
  in v1 — see the README roadmap. One-axis grid tracks map to Auto Layout.
