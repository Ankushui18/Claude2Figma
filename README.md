<p align="center">
  <img src="claude2figma/brand/logo.svg" width="104" alt="Claude2Figma logo">
</p>

# Claude2Figma — Claude Design & Figma canvas copy → Figma, with no paid anything

A **100% free, local-only** alternative to paid "Claude Design to Figma"
importers. It does the same job — capture a deck in Claude Design and rebuild
it in Figma as **native, editable layers** — with everything the paid tools
gate behind a subscription **removed**. The Figma plugin can also copy a
**Figma canvas by itself**—in Figma browser or desktop—into the same
`.deck.json` format, then import that copy into another Figma page/file at a
different artboard size. The Chrome extension never connects to Figma:

**Current release: v1.7.0.**

| Paid original | Claude2Figma |
|---|---|
| Email login (6-digit code) required | **No account at all** |
| Decks uploaded to their server | **Nothing leaves your machine** — the deck is a local `.deck.json` file |
| ~5 imports/month free, then paywall | **Unlimited captures & imports** |
| Over quota → only a 3-slide sample imports | **Always the whole deck** |
| Pro plan US$ 4.80–9/month (Stripe) | **Free. There is no plan.** |
| Telemetry events sent to their API | **Zero network calls** (Figma manifest even declares `networkAccess: none`) |
| Works only on Claude decks | Optimized for Claude Design, but can capture **any web page** |

## How it works

```
 Claude Design (Chrome tab)                  Figma canvas (browser/desktop)
        │  extension → Capture deck          │  plugin → Copy Figma canvas
        │                                    │  (no Chrome connection)
        └───────────────┬──────────────────┘
                        ▼
                 my-design.deck.json
        layers + text runs + images (base64) + SVGs in one local file
                        │
                        │  Figma plugin → Import to Figma → choose sizes
                        ▼
 Figma: one editable frame per artboard — real text, images, vectors,
 gradients, strokes, shadows, corner radii, and Auto Layout.
```

There is intentionally **no backend and no Chrome↔Figma bridge**. The file
*is* the transfer, which is exactly why there is nothing to charge for,
rate-limit, log into, or match between Figma accounts.

What gets converted:

- **Frames** with solid / image / linear & radial gradient fills
- **Text** with per-run fonts, weights, italics, sizes, colors, letter-spacing,
  line-height, underline/strikethrough, alignment — including gradient text
- **Images** (`<img>`, CSS backgrounds), downscaled to ≤2× displayed size and
  embedded in the file; `object-fit` respected
- **Inline SVGs** → real Figma vectors (`createNodeFromSvg`)
- **Borders** (uniform, per-side, dashed), **box-shadows** (incl. inset),
  **border-radius** (incl. per-corner & %), opacity, clipping, z-order
- **CSS flex → Figma auto-layout** (direction, gap, padding, alignment,
  wrapping, flex-grow, and text that HUGs/FILLs instead of being forced Fixed)
- **Multi-slide decks**: Claude's slide player is stepped through automatically
  and every slide is captured at design resolution (preview zoom divided out)
- **Canvas files (v1.1)**: multi-screen Claude canvases are detected and each
  artboard becomes its own Figma frame; screens isolated in **shadow DOM or
  nested iframes are read through**, `<canvas>` elements are rasterized, and
  oklch/lab/color-mix colors are converted — with a capture report in the
  popup so a blank import can never fail silently again. The background now
  probes and ranks **every frame** so it does not mistake Claude's editor
  shell for the design; repeated large screens without labels are also found
  by a visual sibling-board detector
- **Clean output, no noise (v1.2)**: do-nothing wrapper `<div>`s are pruned
  at capture *and* import time, so Figma layers stay shallow; every slide
  frame is sized exactly to its design and clipped like an artboard. The
  extension/plugin open no tabs, fire no toast notifications, and never
  auto-download — the success screen has the one download button
- **Artboard-only capture + cleaner layers (v1.3)**: choose **Full canvas**,
  **Selected artboards**, or **Single artboard** in Chrome. When Claude nests a real screen inside
  a larger labelled artboard host, Claude2Figma captures the inside screen and
  skips the surrounding canvas label/chrome. Duplicate same-size outer/inner
  screens are merged, clipping wrappers that clip nothing are dissolved, and
  leaf color/image boxes become rectangles instead of pointless frames.
  One-axis CSS Grid and exact uniform block stacks are also recovered as Auto
  Layout; an absolute badge no longer disables layout for the whole card.
- **Wrapper-free artboards (plugin v1.4.1)**: before building layers, the
  Figma plugin repeatedly flattens redundant pass-through frames inside each
  artboard. It now removes sole/inset page shells, generic HTML layout
  wrappers, absolute overlay wrappers, transparent/no-op decorations,
  radius-only frames, rounded image wrappers, and full-size background
  shells (transferring their background to the artboard). In Auto Layout
  parents it promotes content only where exact coordinates can be preserved
  without shifting other flow layers. Painted cards, real clipping frames,
  meaningful Auto Layout groups, and other visible containers are kept.
- **Standalone Figma canvas copy (no connection)**: in Figma browser or
  desktop, run Claude2Figma and choose **Copy Figma canvas**. The plugin itself
  lists the native frames and exports **Full current page**, **Selected
  frames**, **Current selection**, or **All pages** to `.deck.json`; the user
  can then download/copy that file or immediately import a resized copy.
  There is no Enable/Connect step and the Chrome extension is not involved.
  Because the transfer is just a local file, the source and destination can
  use different Figma logins or browser vs. desktop. Native text, fills,
  image bytes, strokes, effects, corner radii, Auto Layout, sections,
  vectors, and unsupported-widget PNG fallbacks are written to the same
  `.deck.json` format.
- **Capture reliability and sizing fixes (v1.6.0)**: artboards keep their
  measured design dimensions and clip overflowing descendants instead of
  growing to fit them. Generic card/component grids are treated much more
  cautiously, so ordinary page sections are less likely to be split into
  false artboards, and **Whole page** is available whenever a detected split
  is wrong. Captures run and persist in the background — closing the popup
  no longer loses a finished capture, and a second capture on the same tab is
  blocked while one is already running. If each canvas screen is a separate
  cross-origin `<iframe>`, the worker captures those browser frames and
  assembles one deck for Full, Selected, and Single scopes. The serializer
  also preserves live form values/placeholders (passwords only as bullets),
  selected options, checked checkbox/radio states, table-cell structure,
  common pseudo-element text/shapes, canvas pixels, and video poster/current
  frames, while excluding screen-reader-only clipped text.

### Why two parts — can't the Chrome extension do it alone?

Short answer: **Figma does not allow a Chrome extension to read/build the
canvas alone — for anyone.** There is no such thing as a "Figma browser
extension". Claude2Figma therefore keeps the jobs separate and does **not**
connect Chrome to Figma: the extension captures Claude/web pages, while the
plugin imports those files and can also read/export a Figma canvas itself
through Figma's Plugin API:

- A **Chrome extension** can read web pages open in Chrome (that's how it
  reads your Claude design). It has **no way to create or edit layers inside
  a Figma file** — the Figma canvas is not HTML you can script against.
- The only supported way to *build* real Figma layers (frames, editable
  text, fonts, auto-layout…) is Figma's official **Plugin API**
  (`figma.createFrame()`, `figma.createText()`…), which runs only inside a
  **plugin**. Figma plugins *are* Figma's extension system.
- Figma's REST API can't help either: it can read/export files, not create
  frames in them.
- The only "extension-only" trick would be auto-pasting a flattened
  SVG/screenshot into your Figma tab — text would stop being text and
  everything would be one dead picture. That's exactly what we're avoiding.

So the split is forced by the platforms, but they are independent:
**extension = eyes for Claude/web pages, plugin = eyes + hands inside
Figma.** There is no paired session, account link, or requirement for the
browser and desktop Figma logins to match. Export a `.deck.json` from the
source and import it wherever you need it. Once imported via manifest, the
plugin is one click under the **Plugins** menu—no need to touch its files
again. If Figma does not list a local development plugin under another
account, import the same manifest there once; that is a Figma plugin
installation step, not a Claude2Figma login.

## Install (2 minutes, no build step)

Everything is plain JS/HTML/CSS — no npm, no bundler, no TypeScript compile
to run either part. (`npm install` exists only for the optional headless
test suite and icon rebuilds.)

### 1 · Chrome extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the **`claude2figma/extension/`** folder
4. Pin the Claude2Figma icon

### 2 · Figma plugin

1. In Figma desktop (or figma.com): menu **Plugins → Development → Import plugin from manifest…**
2. Select **`claude2figma/figma-plugin/manifest.json`**
3. Run it from **Plugins → Development → Claude2Figma**

> The manifest `id` is a placeholder for local development — that's fine for
> personal/team use via "Import plugin from manifest". If you later publish to
> Figma Community, Figma assigns the real id.

## Use it

### A · Claude Design → Figma

1. Open your deck in **Claude Design** (`claude.ai/design`).
2. Click the Claude2Figma icon. It lists the canvas artboards it found; choose
   **Full canvas** to capture every screen, **Selected artboards** to tick
   multiple screens, **Single artboard** to choose exactly one, or **Whole
   page** to ignore a mistaken artboard split. Capture → **Download
   .deck.json** (recent captures also stay under the popup's **Decks** tab,
   stored only in your browser). Only the inside of the checked artboards is
   serialized in the first three modes.
3. In Figma, open the Claude2Figma plugin and **drop the file** (or use
   *Copy JSON* in the extension + paste for small decks). Once the file is
   loaded, the plugin shows the **artboard sizes detected on the canvas**
   (e.g. `1440 × 900 · ×4`, `390 × 844 · ×2`) and two levels of size control:
   - **Global size for all artboards** — Original, Desktop 1920×1080 /
     1600×900 / 1440×900, MacBook 1512×982, Laptop 1366×768, iPad 834×1194, iPhone
     390×844, Android 360×800, Slide 1280×720, Instagram 1080×1080, Story
     1080×1920, A4, or a **custom** W×H. Popular Original / 1920 / 1600 / 1440 /
     Mobile choices also appear as one-click shortcuts.
   - **Individual artboard sizes** — every detected screen gets its own row,
     including when there is only one. Uncheck a row to skip that artboard in
     Figma. Each row has always-visible **target width × height** fields:
     type `1440 × 900`, `390 × 844`, or any other size and that artboard is
     created at exactly that Figma frame size. Presets fill the same fields,
     and *Use global setting* remains available for bulk sizing.
   - **Fit modes:** *Fit inside* is the default for typed W×H (whole design
     visible, frame exactly that size), plus *Match width* (height follows),
     *Fill frame* (crop overflow), or *Stretch* (may distort). Each row previews
     `1440 × 900 → 1920 × 1200 · scale 133%` before you commit. The whole
     layer tree scales together — fonts, paddings, strokes, radii, shadows —
     not just the outer frame.
4. Click **Import deck**. Slides land beside your existing work at their
   selected sizes, and the result screen lists the exact size created for
   every frame, along with any substituted fonts or failed images.

### B · Figma canvas → another Figma file/page size (plugin only)

1. Open the source design in **Figma**, in either the browser or desktop app.
2. Run **Plugins → Claude2Figma** and choose **Copy Figma canvas**. No
   Chrome extension, Enable button, connection, or matching account is needed.
3. In the plugin, choose:
   - **Current selection** — whatever frames/layers are selected in Figma
   - **Selected frames** — tick any frames from the grouped page checklist
   - **Full current page** — all top-level frames on the current page
   - **All pages** — all top-level frames in the file
4. Click **Copy canvas**, then **Download .deck.json** (or **Copy JSON**).
   To resize a copy in the same file immediately, use **Import this copy
   into this file** instead.
5. Open the destination Figma file/page—browser or desktop, same or a
   different Figma login—run Claude2Figma → **Import to Figma**, drop/paste the
   copy, choose Original / 1920 / 1600 / 1440 / mobile / custom artboard
   sizes, then import.

> Nothing is paired or synced between accounts. The `.deck.json` file is the
> portable transfer, so different browser/desktop Figma logins are fine. The
> destination only needs Claude2Figma available as a plugin to import the file.

## Test without Claude

- **Plugin only:** import `claude2figma/sample/sample-deck.deck.json` — a
  2-slide deck exercising text runs, gradients, shadows, auto-layout, a raster
  image and an SVG.
- **Full loop:** serve or open `claude2figma/test/test-page.html` in Chrome,
  capture it with
  the extension ("Capture this page anyway"), import the result in Figma.
- **Headless tests:** run the whole suite at once:

  ```sh
  node claude2figma/test/run-all.js
  ```

  It covers layer-tree pruning, text Auto Layout sizing, selected/full
  capture, exact W×H UI, shadow/iframe piercing, standalone native Figma
  export, the absence of a Chrome↔Figma bridge, and the Figma builder.
  Five of the tests (popup & plugin-UI) additionally need jsdom — run
  `npm install` once (dev dependencies only, nothing to do with the
  extension/plugin); without it the runner simply reports them as
  skipped. Every test can still be run individually, e.g.
  `node claude2figma/test/prune-test.js`.

## Project layout

```
.
├─ README.md             you are here
├─ LICENSE               MIT
├─ package.json          dev tooling only (tests + icon rebuilds)
└─ claude2figma/
   ├─ extension/            Chrome MV3 extension (load unpacked as-is)
   │  ├─ manifest.json
   │  ├─ background.js      finds design frames; Claude/web capture + assembly
   │  ├─ inject.js          DOM → deck JSON serializer (the web capture engine)
   │  ├─ popup.html/css/js  capture UI — warm Claude-style design language
   │  └─ icons/             generated from brand/logo.svg (npm run icons)
   ├─ figma-plugin/         Figma plugin — native Figma UI tokens (import as-is)
   │  ├─ manifest.json      networkAccess: none — structurally offline
   │  ├─ code.js            deck JSON ↔ Figma layers (import + native canvas copy)
   │  └─ ui.html            import/resize UI + Copy Figma canvas UI
   ├─ brand/logo.svg        the Claude2Figma mark (coral C → layer stack)
   ├─ shared/SCHEMA.md      the .deck.json format both sides speak
   ├─ sample/               ready-to-import sample deck
   └─ test/                 test page + headless tests + run-all runner
```

## Known limitations (v1)

CSS is a full rendering engine and Figma isn't; a few things are approximated
or skipped — the same is true of the paid tools:

- `transform: rotate()` / skew, two-dimensional grid layouts (one-axis grid
  is mapped to Auto Layout), blend modes, filters, `backdrop-filter`, masks,
  and animations are not captured (rotated elements use their bounding box).
- Gradient geometry follows CSS angles but not exact "magic corner" lengths;
  shadow blur maps 1:1 to Figma's radius.
- Fonts must exist in Figma (or be installed) — missing families fall back to
  Inter and are listed after import. Claude's proprietary *Anthropic Sans*
  will typically substitute.
- Videos become a static poster/current-frame image, not a playable video.
  Form controls are visual Figma layers, not interactive controls; password
  values are deliberately exported only as mask bullets.
- Separate cross-origin `<iframe>` artboards are captured by the extension
  worker, but a cross-origin iframe embedded *inside* another captured screen
  (or a closed shadow root) cannot be read by page JavaScript and is reported
  as blocked rather than silently invented.
- Cross-origin images that block CORS in the page become grey placeholders
  (counted in the result). Images inside Claude decks are same-frame and fine.
- If Claude's slide player controls can't be found, the extension asks you to
  have Claude lay all slides out on one page, which always works.

Good next features if you extend it: rotation support, full 2-D CSS grid
mapping, `border-image`/mask approximations, and multiple box-shadow ordering.

## Publishing (optional)

- **Chrome Web Store:** zip the *contents* of `claude2figma/extension/`:

  ```sh
  (cd claude2figma/extension && zip -r ../../claude2figma-extension.zip .)
  ```

  Fill in the privacy section honestly: *no data collected, nothing sold* —
  the code backs that up.
- **Figma Community:** submit via a Figma org with the contents of
  `claude2figma/figma-plugin/`; replace the placeholder manifest id with the
  assigned one.

## A note on originality

This is an independent implementation written for this project: same *idea*
(capture page → JSON → rebuild in Figma), new code, new name, and crucially a
different architecture — **file-based and local**, instead of an account +
server + subscription. It doesn't talk to, patch, or bypass anyone else's
service, so it can't be paywalled out from under you later. Keep the branding
your own if you publish it.

## License

Use it, fork it, ship it. Keeping it free is the whole point.
