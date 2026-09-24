import { isFlat } from "./curve";
      const RAW_DEFAULTS = {
        raw_wb_kelvin: 5500,
        raw_wb_tint: 0,
        raw_nr_lum: 0,
        raw_nr_chroma: 0,
        raw_lens_on: 0,
      };
      const RAW_KEYS = Object.keys(RAW_DEFAULTS);
// Passed via data attributes to avoid define:vars TS serialization issues
      const imageId = window.__EDITOR_DATA__.imageId;
      const sourceUrl = window.__EDITOR_DATA__.sourceUrl;
      const initialParams = window.__EDITOR_DATA__.initialParams;
      const hasExistingEdit = window.__EDITOR_DATA__.hasExistingEdit;
      const rawPreviewEnabled = window.__EDITOR_DATA__.rawPreviewEnabled;

      // DEBUG: visible diagnostic overlay


      // ---- Canvas 2D editor ----
      // Phase A: live preview via CSS filter on a Canvas 2D context.
      // Phase B-ready: Save sends params + crop to server which renders
      // at full resolution with sharp and writes the JPG to /uploads/edits/{id}/.
      // The original file is NEVER touched.
      const statusEl = document.getElementById('status');
      // RAW defaults — hardcoded here (not via define:vars, to avoid TS transpilation issues)


      const btnSave = document.getElementById('btn-save');
      const btnRevert = document.getElementById('btn-revert');
      const btnReset = document.getElementById('btn-reset');

      // ---- Canvas setup with optional WebGL2 GPU pipeline ----
      // We must grab the right context type BEFORE any other code touches
      // the canvas — a canvas can hold only ONE rendering context. The
      // previous integration attempt failed because the live #preview canvas
      // had already been touched by a 2D getContext() call (or had its
      // framebuffer dimensions changed via CSS resize) before WebGL2 was
      // allocated, producing a black-output framebuffer. The fix: clone
      // the canvas, replace it in the DOM, and grab the context on the
      // fresh clone.
      const _origCanvas = document.getElementById('preview');
      const canvas = _origCanvas.cloneNode(false);
      _origCanvas.parentNode.replaceChild(canvas, _origCanvas);

      let ctx = null;
      let webglPipeline = null;
      let useWebGL = false;

      // Probe WebGL2 first.
      const _gl2 = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: true, premultipliedAlpha: false,
      });

      if (_gl2) {
        // WebGL2 is available. Pipeline will be lazily loaded on first draw.
        useWebGL = true;
      } else {
        // Fall back to 2D context.
        ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) {
          statusEl.textContent = 'Canvas 2D not supported in this browser.';
          statusEl.classList.add('error');
          throw new Error('no 2d ctx');
        }
        ctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in ctx) {
          ctx.imageSmoothingQuality = 'high';
        }
      }

      // ---- Lazy WebGL pipeline loader ----
      // Loaded on first WebGL draw. The pipeline module is served from
      // /_webgl-pipeline.js (bundled from src/lib/editor-gl.ts). We use
      // dynamic import + blob URL so the bundle is fetched once and
      // cached by the browser.
      let _drawPipelineLoading = null;
      async function loadWebGLPipeline() {
        if (webglPipeline !== null && webglPipeline !== false) return webglPipeline;
        if (!_drawPipelineLoading) {
          _drawPipelineLoading = (async () => {
            try {
              const res = await fetch('/_webgl-pipeline.js');
              if (!res.ok) throw new Error('pipeline not served');
              const code = await res.text();
              const blob = new Blob([code], { type: 'application/javascript' });
              const url = URL.createObjectURL(blob);
              const mod = await import(/* @vite-ignore */ url);
              if (typeof mod.createWebGLPipeline !== 'function') throw new Error('bad module');
              const p = mod.createWebGLPipeline();
              if (!p || !p.init(canvas)) throw new Error('init returned false');
              return p;
            } catch (e) {
              console.warn('WebGL pipeline load failed:', e);
              return false;
            }
          })();
        }
        const result = await _drawPipelineLoading;
        webglPipeline = result;
        (window as any)._webgl = webglPipeline;  // expose for curve tool, histogram, etc.
      (window as any).state = state;  // expose for preset save/load + CDP inspection
      (window as any).draw = draw;
      (window as any).scheduleDraw = (typeof scheduleDraw === 'function') ? scheduleDraw : draw;
        return webglPipeline;
      }

      const state = { ...initialParams };
      // Lookup from LUT id → parsed { size, data: Uint8Array }
      const lutCache = new Map();
      let activeLut = null;  // { size, data } once loaded; null = no LUT pass
      const sourceImage = new Image();
      sourceImage.crossOrigin = 'anonymous';
      // Apply CSS preview approximation for RAW sliders that have no
      // direct JPEG equivalent (denoise blur, lens brightness lift).
      // Helper is defined later in the script — wrap in DOMContentLoaded.
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          if (typeof applyRawPreviewFx === 'function') applyRawPreviewFx();
        });
      }

      // iOS Safari / WKWebView silently ignores ctx.filter on canvas
      // drawImage in many versions. Toggle the live-preview pipeline
      // accordingly so the sliders actually respond on iPhone. Desktop
      // and Chromium Android keep the fast GPU filter path.
      const isIOS = (typeof navigator !== 'undefined') && (
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      );

      function setStatus(msg, isErr) {
        statusEl.textContent = msg;
        statusEl.classList.toggle('error', !!isErr);
        statusEl.classList.toggle('ok', !isErr);
      }

      function computeFilters(opts) {
        const s = state;
        // Allow caller to override temp/tint for RAW preview approximation
        const previewTemp = (opts && opts.temp != null) ? opts.temp : s.temp;
        const previewTint = (opts && opts.tint != null) ? opts.tint : s.tint;
        const f = [];
        // Exposure (-200..200) — divide by 100 = stops. Only push if non-zero;
        // neutral (1.000) still triggers a GPU filter pass which can introduce
        // sub-LSB rounding over many passes.
        const exposureStops = s.exposure / 100;
        const expBrightness = Math.pow(2, exposureStops);  // 1 at 0, ~0.25..4 otherwise
        if (s.exposure !== 0) f.push('brightness(' + expBrightness.toFixed(3) + ')');
        // Contrast (-100..100) — 0 = neutral, +/- = contrast change. Skip if 0.
        if (s.contrast !== 0) f.push('contrast(' + (100 + s.contrast) + '%)');
        // Saturation (-100..100) — skip if 0.
        if (s.saturation !== 0) f.push('saturate(' + (100 + s.saturation) + '%)');
        // Brightness (-100..100) additive on top of exposure. Skip if 0.
        if (s.brightness !== 0) f.push('brightness(' + (100 + s.brightness) + '%)');
        // WB Temp (-100..100): warmer (positive) = sepia-ish; cooler = hue-rotate -ve
        if (previewTemp > 0) f.push('sepia(' + Math.min(100, previewTemp * 40) + '%)');
        else if (previewTemp < 0) f.push('hue-rotate(' + Math.max(-180, previewTemp * 30) + 'deg)');
        // Tint (-100..100): green vs magenta
        if (previewTint > 0) f.push('hue-rotate(' + Math.min(90, previewTint * 30) + 'deg)');
        // Shadows/Highlights/Whites/Blacks: stacked contrast tweak (rough)
        const shadowBoost = s.shadows / 100;       // negative darkens, positive lifts
        const highlightCut = s.highlights / 100;   // negative darkens, positive lifts
        if (s.shadows !== 0 || s.highlights !== 0) {
          // Approximate via a contrast/brightness combo
          const tones = (highlightCut - shadowBoost) * 0.2;
          f.push('contrast(' + (100 + tones * 20) + '%)');
          f.push('brightness(' + (100 + (shadowBoost + highlightCut) * 8) + '%)');
        }
        if (s.whites !== 0 || s.blacks !== 0) {
          // Endpoints — push contrast + slight brightness
          const ends = (s.whites - s.blacks) / 100;
          f.push('contrast(' + (100 + ends * 12) + '%)');
        }
        // Sharpen is now handled OUTSIDE the CSS filter chain via Canvas 2D
        // unsharp-mask in getSharpenedSource(). See below.
        return f.join(' ');
      }

      // ---- Unsharp mask via Canvas 2D ----
      // The previous SVG feConvolveMatrix approach broke (the rendered result
      // was going pure black). This is the textbook unsharp-mask recipe:
      //   1. Render source to off-screen canvas
      //   2. Apply Gaussian blur to a copy -> blurredData
      //   3. For each pixel: out = clamp( src + (src - blurred) * amount )
      // amount is 0..1 derived from slider 0..100. At amount=0 we just
      // return sourceImage (no extra work). Result: brightening of edges,
      // never pure-black. Cached so we only re-blur when amount changes.
      const _sharpenCanvas = document.createElement('canvas');
      const _sharpenCtx = _sharpenCanvas.getContext('2d');
      let _sharpenCacheKey = -1;
      let _sharpenCacheCanvas = null;

      // rAF coalescing. Slider 'input' events fire 60+ times per second.
      // Running draw() on every event oversubscribes the pipeline (especially
      // the 250ms LUT pass on a 4K source). ScheduleDraw() collapses multiple
      // events within a single animation frame to one draw call.
      let _drawScheduled = false;
      function scheduleDraw() {
        if (_drawScheduled) return;
        _drawScheduled = true;
        requestAnimationFrame(() => {
          _drawScheduled = false;
          draw();
        });
      }

      function getSharpenedSource(amount) {
        if (!sourceImage.complete || !sourceImage.naturalWidth) return sourceImage;
        if (amount <= 0) return sourceImage;
        if (amount === _sharpenCacheKey && _sharpenCacheCanvas) return _sharpenCacheCanvas;

        const w = canvas.width;
        const h = canvas.height;
        _sharpenCanvas.width = w;
        _sharpenCanvas.height = h;

        // 1. Draw sharp source
        _sharpenCtx.clearRect(0, 0, w, h);
        _sharpenCtx.drawImage(sourceImage, 0, 0, w, h);
        const sharpImg = _sharpenCtx.getImageData(0, 0, w, h);

        // 2. Blur via a per-pixel 3x3 box blur (two passes — horizontal +
        //    vertical — approximate a Gaussian sigma ≈ 1.2px). Required
        //    because ctx.filter = 'blur(1.2px)' silently fails on iOS
        //    Safari / WKWebView (same root cause as the live-preview
        //    slider bug). On desktop this is slightly slower than the
        //    native CSS blur but visually indistinguishable.
        const sw = sharpImg.width, sh = sharpImg.height;
        const sd = sharpImg.data;
        const tmp = new Uint8ClampedArray(sd.length);
        // Horizontal pass: 3-tap box into tmp
        for (let y = 0; y < sh; y++) {
          const row = y * sw * 4;
          for (let x = 0; x < sw; x++) {
            const i = row + x * 4;
            let r = 0, g = 0, b = 0, c = 0;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= sw) continue;
              const ni = row + nx * 4;
              r += sd[ni]; g += sd[ni + 1]; b += sd[ni + 2]; c++;
            }
            tmp[i] = r / c; tmp[i + 1] = g / c; tmp[i + 2] = b / c; tmp[i + 3] = sd[i + 3];
          }
        }
        // Vertical pass: 3-tap box into a SEPARATE buffer so the original
        // pixel data in sharpImg.data stays intact for the unsharp-mask
        // subtraction below. (Earlier this wrote back into sharpImg.data,
        // which clobbered the original and produced a blurred output
        // instead of sharpened.)
        const blur = new Uint8ClampedArray(sd.length);
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            const i = (y * sw + x) * 4;
            let r = 0, g = 0, b = 0, c = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const ny = y + dy;
              if (ny < 0 || ny >= sh) continue;
              const ni = (ny * sw + x) * 4;
              r += tmp[ni]; g += tmp[ni + 1]; b += tmp[ni + 2]; c++;
            }
            blur[i] = r / c; blur[i + 1] = g / c; blur[i + 2] = b / c; blur[i + 3] = tmp[i + 3];
          }
        }

        // 3. Unsharp mask: out = src + (src - blur) * amount
        const k = amount / 100;  // 0..1
        for (let i = 0; i < sd.length; i += 4) {
          const dr = sd[i]   - blur[i];
          const dg = sd[i+1] - blur[i + 1];
          const db = sd[i + 2] - blur[i + 2];
          let r = sd[i]   + dr * k;
          let g = sd[i+1] + dg * k;
          let b = sd[i+2] + db * k;
          if (r < 0) r = 0; else if (r > 255) r = 255;
          if (g < 0) g = 0; else if (g > 255) g = 255;
          if (b < 0) b = 0; else if (b > 255) b = 255;
          sd[i] = r; sd[i+1] = g; sd[i+2] = b;
        }
        _sharpenCtx.putImageData(sharpImg, 0, 0);
        _sharpenCacheKey = amount;
        _sharpenCacheCanvas = _sharpenCanvas;
        return _sharpenCanvas;
      }

      // Invalidate sharpen cache when source image changes
      const _origSourceAssign = sourceImage.src;
      sourceImage.addEventListener('load', () => {
        _sharpenCacheKey = -1;
        _sharpenCacheCanvas = null;
      });

      // Apply vignette overlay opacity (separate from canvas filter — vignette is a DOM overlay)
      const vignetteEl = document.getElementById('vignette-overlay');
      function applyVignetteOverlay() {
        // In WebGL mode the shader handles vignette accurately (matching
        // server-side save), so the DOM overlay stays hidden. In legacy
        // (iOS) mode the DOM overlay is the preview.
        if (useWebGL) { vignetteEl.style.opacity = '0'; return; }
        const v = Number(state.vignette) || 0;
        if (v <= 0) { vignetteEl.style.opacity = '0'; return; }
        // 0..100 → 0..0.85 opacity
        const o = Math.max(0.05, Math.min(0.85, v / 100 * 0.85));
        vignetteEl.style.opacity = String(o);
      }
      window.applyVignetteOverlay = applyVignetteOverlay;

      // Sharpen is now handled via getSharpenedSource() below — unsharp-mask
      // in plain Canvas 2D pixel ops, no SVG filter dependency.

      // Maximum canvas backing buffer dimension. We render at NATIVE source
      // resolution always — never downsample at the canvas blit stage, because
      // browser drawImage's bilinear downsample loses detail before CSS gets
      // a chance to do its high-quality GPU downsample for display. The
      // browser's CSS compositor is much better at the final downsample than
      // canvas drawImage is at mid-res resampling.
      //
      // Trade-off: the per-pixel pipeline (sharpen + LUT) runs at native res.
      // For a 6000x4000 source that's ~24M pixels; desktop CPU handles the
      // slider pass at ~200-500ms/frame, sharpen cache first build at ~1-2s,
      // trilinear LUT apply at ~500-800ms. iOS Safari at native res = ~1-2s
      // per slider touch — sluggish but functional. The fast path skips all
      // of this for the 'just looking' case.
      const MAX_CANVAS_DIM = 16384;  // effectively no cap; covers any sane camera

      // Zoom state. 'fit' = current behaviour (backing matches display size,
      // no jaggies). 100/200/400 = backing = source * (zoom/100), CSS-sized
      // the same, canvas positioned absolutely with pan offsets for panning.
      // Persisted per-image via URL hash (#z=fit or #z=100 etc.).
      let zoomMode = 'fit';
      let panX = 0, panY = 0;
      const ZOOM_STORAGE_KEY = 'snappydo:zoom:';

      function loadZoomFromHash() {
        try {
          const m = location.hash.match(/z=(fit|100|200|400)/);
          if (m) return m[1];
          const saved = localStorage.getItem(ZOOM_STORAGE_KEY + imageId);
          if (saved && ['fit', '100', '200', '400'].includes(saved)) return saved;
        } catch (e) { /* localStorage may be blocked */ }
        return 'fit';
      }
      function saveZoom(mode) {
        try { localStorage.setItem(ZOOM_STORAGE_KEY + imageId, mode); } catch (e) {}
        // Also reflect in URL hash so it's shareable / survives reload.
        if (mode === 'fit') {
          history.replaceState(null, '', location.pathname);
        } else {
          history.replaceState(null, '', location.pathname + '#z=' + mode);
        }
      }

      function setZoom(mode, opts) {
        if (!['fit', '100', '200', '400'].includes(mode)) return;
        zoomMode = mode;
        saveZoom(mode);
        // Reset pan when switching modes (zoom-to-fit starts centred).
        panX = 0; panY = 0;
        // Update toolbar active state
        document.querySelectorAll('.zoom-controls button').forEach(b => {
          b.classList.toggle('active', b.dataset.zoom === mode);
        });
        // Toggle canvas-wrap zoomed class so CSS positions the canvas absolutely.
        const wrap = document.getElementById('canvas-wrap');
        if (wrap) wrap.classList.toggle('zoomed', mode !== 'fit');
        fitCanvasToArea();
        draw();
        if (!opts || !opts.silent) {
          const ztxt = mode === 'fit' ? 'fit-to-screen' : mode + '%';
          setStatus('Zoom: ' + ztxt + '.');
        }
      }

      function fitCanvasToArea() {
        const area = document.querySelector('.canvas-area');
;
        const aw = area ? area.clientWidth : window.innerWidth;
        const ah = area ? area.clientHeight : window.innerHeight;
        if (!sourceImage.width) return;

        let bw, bh;
        if (zoomMode === 'fit') {
          // Fit-to-viewport (default). Backing = display size, no CSS-stage
          // scale, no aliasing (commit 0dfc143).
          const dispScale = Math.min(aw / sourceImage.width, ah / sourceImage.height, 1);
          bw = Math.max(1, Math.round(sourceImage.width * dispScale));
          bh = Math.max(1, Math.round(sourceImage.height * dispScale));
          canvas.width = bw;
          canvas.height = bh;
          canvas.style.width = bw + 'px';
          canvas.style.height = bh + 'px';
          canvas.style.transform = '';
          canvas.style.position = '';
        } else {
          // Zoom mode. KEY PERFORMANCE FIX: backing buffer stays at SOURCE
          // resolution, CSS transform: scale(z) applies the visual zoom.
          // Pipeline (drawImage, sharpen, sliders, LUT) processes the same
          // pixel count at all zoom levels — sliders stay as responsive as
          // at 100%. CSS upscale is GPU bilinear interpolation: smooth
          // (upsampling doesn't alias, only downsampling does).
          bw = sourceImage.width;
          bh = sourceImage.height;
          canvas.width = bw;
          canvas.height = bh;
          canvas.style.width = bw + 'px';
          canvas.style.height = bh + 'px';
          const z = parseInt(zoomMode, 10) / 100;
          // Pan offsets are in CSS pixels (after the transform). Centring
          // on first zoom-in positions the source at the centre of the
          // viewport at this zoom level.
          if (panX === 0 && panY === 0) {
            const visW = bw * z;
            const visH = bh * z;
            panX = Math.round((aw - visW) / 2);
            panY = Math.round((ah - visH) / 2);
          }
          // Clamp pan so canvas doesn't slide entirely off-screen.
          const visW = bw * z;
          const visH = bh * z;
          panX = Math.max(Math.min(panX, 32), Math.min(aw - visW - 32, 0));
          panY = Math.max(Math.min(panY, 32), Math.min(ah - visH - 32, 0));
          canvas.style.transformOrigin = '0 0';
          canvas.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + z + ')';
        }
        // Hint the canvas blit / CSS scale to use the highest-quality resampler.
        // Skip when ctx is null (WebGL path owns the canvas).
        if (ctx && ctx.imageSmoothingQuality !== undefined) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
        }
      }

      // Apply LUT in pixel space (RGBA buffer in place). Shared by
      // desktop (post-ctx.filter) and iOS (per-pixel pipeline).
      //
      // Trilinear interpolation: for each input RGB, float-coords into the
      // 3D LUT cube, sample 8 corner cells, blend by (1-dx)(1-dy)(1-dz)
      // weights. Smooth gradients across the cube instead of nearest-cell
      // stair-stepping. Costs ~8x the memory reads but output stays in 8-bit
      // (final `.5 | 0` quantize). For 4K canvas = ~88M lookups, ~250ms on
      // desktop, ~1s on iOS Safari — acceptable.
      function applyLutToRgba(lut, data, mix) {
        const size = lut.size;
        const lutData = lut.data;
        const fs = size - 1;
        // 256 / (size-1) maps uint8 [0..255] to float [0..size-1].
        const inv = fs / 255;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          // Float position in cube space
          const rf = r * inv;
          const gf = g * inv;
          const bf = b * inv;
          // Lower cube corner
          const r0 = rf | 0, g0 = gf | 0, b0 = bf | 0;
          const r1 = Math.min(size - 1, r0 + 1);
          const g1 = Math.min(size - 1, g0 + 1);
          const b1 = Math.min(size - 1, b0 + 1);
          // Sub-cell interpolation weights
          const dr = rf - r0;
          const dg = gf - g0;
          const db = bf - b0;
          // Sample 8 corners (still 8-bit values). Index = ((b*size+g)*size+r)*3.
          const i000 = ((b0 * size + g0) * size + r0) * 3;
          const i100 = ((b0 * size + g0) * size + r1) * 3;
          const i010 = ((b0 * size + g1) * size + r0) * 3;
          const i110 = ((b0 * size + g1) * size + r1) * 3;
          const i001 = ((b1 * size + g0) * size + r0) * 3;
          const i101 = ((b1 * size + g0) * size + r1) * 3;
          const i011 = ((b1 * size + g1) * size + r0) * 3;
          const i111 = ((b1 * size + g1) * size + r1) * 3;
          // Trilinear blend (lerp each channel independently)
          const w000 = (1 - dr) * (1 - dg) * (1 - db);
          const w100 = dr       * (1 - dg) * (1 - db);
          const w010 = (1 - dr) * dg       * (1 - db);
          const w110 = dr       * dg       * (1 - db);
          const w001 = (1 - dr) * (1 - dg) * db;
          const w101 = dr       * (1 - dg) * db;
          const w011 = (1 - dr) * dg       * db;
          const w111 = dr       * dg       * db;
          // Float output (still uint8-channel-space, no quantize yet)
          const ro = lutData[i000]     * w000 + lutData[i100]     * w100 +
                     lutData[i010]     * w010 + lutData[i110]     * w110 +
                     lutData[i001]     * w001 + lutData[i101]     * w101 +
                     lutData[i011]     * w011 + lutData[i111]     * w111;
          const go = lutData[i000 + 1] * w000 + lutData[i100 + 1] * w100 +
                     lutData[i010 + 1] * w010 + lutData[i110 + 1] * w110 +
                     lutData[i001 + 1] * w001 + lutData[i101 + 1] * w101 +
                     lutData[i011 + 1] * w011 + lutData[i111 + 1] * w111;
          const bo = lutData[i000 + 2] * w000 + lutData[i100 + 2] * w100 +
                     lutData[i010 + 2] * w010 + lutData[i110 + 2] * w110 +
                     lutData[i001 + 2] * w001 + lutData[i101 + 2] * w101 +
                     lutData[i011 + 2] * w011 + lutData[i111 + 2] * w111;
          // Mix with original at slider intensity
          const imix = 1 - mix;
          data[i]     = (r * imix + ro * mix + 0.5) | 0;
          data[i + 1] = (g * imix + go * mix + 0.5) | 0;
          data[i + 2] = (b * imix + bo * mix + 0.5) | 0;
        }
      }

      // ---- Web Worker for LUT pass ----
      // The trilinear LUT pass is ~250ms on a 4K source (15.8M pixels x 8
      // cube corners). Running it on the main thread blocks input. Move it
      // to a worker — main thread stays responsive, worker crunches pixels
      // in the background. The bytes move via Transferable (no clone).
      let lutWorker = null;
      let lutWorkerToken = 0; // incremented per request, used to discard stale results
      let lutWorkerResolve = null;
      function ensureLutWorker() {
        if (lutWorker) return lutWorker;
        const code = `
          let lutData = null;
          let lutSize = 0;
          self.onmessage = (e) => {
            const msg = e.data;
            if (msg.kind === 'lut') {
              lutData = msg.data;
              lutSize = msg.size;
              return;
            }            if (msg.kind === 'apply') {
              if (!lutData) { self.postMessage({ kind: 'done', token: msg.token, error: 'no LUT' }); return; }
              const data = msg.data;
              const size = lutSize;
              const fs = size - 1;
              const inv = fs / 255;
              const mix = msg.mix;
              const imix = 1 - mix;
              for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i + 1], b = data[i + 2];
                const rf = r * inv, gf = g * inv, bf = b * inv;
                const r0 = rf | 0, g0 = gf | 0, b0 = bf | 0;
                const r1 = Math.min(size - 1, r0 + 1);
                const g1 = Math.min(size - 1, g0 + 1);
                const b1 = Math.min(size - 1, b0 + 1);
                const dr = rf - r0, dg = gf - g0, db = bf - b0;
                const i000 = ((b0 * size + g0) * size + r0) * 3;
                const i100 = ((b0 * size + g0) * size + r1) * 3;
                const i010 = ((b0 * size + g1) * size + r0) * 3;
                const i110 = ((b0 * size + g1) * size + r1) * 3;
                const i001 = ((b1 * size + g0) * size + r0) * 3;
                const i101 = ((b1 * size + g0) * size + r1) * 3;
                const i011 = ((b1 * size + g1) * size + r0) * 3;
                const i111 = ((b1 * size + g1) * size + r1) * 3;
                const w000 = (1 - dr) * (1 - dg) * (1 - db);
                const w100 = dr       * (1 - dg) * (1 - db);
                const w010 = (1 - dr) * dg       * (1 - db);
                const w110 = dr       * dg       * (1 - db);
                const w001 = (1 - dr) * (1 - dg) * db;
                const w101 = dr       * (1 - dg) * db;
                const w011 = (1 - dr) * dg       * db;
                const w111 = dr       * dg       * db;
                const ro = lutData[i000]     * w000 + lutData[i100]     * w100 +
                           lutData[i010]     * w010 + lutData[i110]     * w110 +
                           lutData[i001]     * w001 + lutData[i101]     * w101 +
                           lutData[i011]     * w011 + lutData[i111]     * w111;
                const go = lutData[i000 + 1] * w000 + lutData[i100 + 1] * w100 +
                           lutData[i010 + 1] * w010 + lutData[i110 + 1] * w110 +
                           lutData[i001 + 1] * w001 + lutData[i101 + 1] * w101 +
                           lutData[i011 + 1] * w011 + lutData[i111 + 1] * w111;
                const bo = lutData[i000 + 2] * w000 + lutData[i100 + 2] * w100 +
                           lutData[i010 + 2] * w010 + lutData[i110 + 2] * w110 +
                           lutData[i001 + 2] * w001 + lutData[i101 + 2] * w101 +
                           lutData[i011 + 2] * w011 + lutData[i111 + 2] * w111;
                data[i]     = (r * imix + ro * mix + 0.5) | 0;
                data[i + 1] = (g * imix + go * mix + 0.5) | 0;
                data[i + 2] = (b * imix + bo * mix + 0.5) | 0;
              }
              self.postMessage({ kind: 'done', token: msg.token, data }, [data.buffer]);
            }
          };
        `;
        const blob = new Blob([code], { type: 'application/javascript' });
        lutWorker = new Worker(URL.createObjectURL(blob));
        lutWorker.onmessage = (e) => {
          const msg = e.data;
          if (msg.token !== lutWorkerToken) return; // stale
          if (lutWorkerResolve) {
            const resolve = lutWorkerResolve;
            lutWorkerResolve = null;
            if (msg.error) resolve(null);
            else resolve(new ImageData(msg.data, canvas.width, canvas.height));
          }
        };
        if (activeLut) {
          lutWorker.postMessage({ kind: 'lut', data: activeLut.data, size: activeLut.size });
        }
        return lutWorker;
      }
      function applyLutToRgbaAsync(imgData, mix) {
        return new Promise((resolve) => {
          // Lazy worker init. The worker is created on first LUT use and
          // reused for all subsequent renders.
          const w = ensureLutWorker();
          lutWorkerToken++;
          lutWorkerResolve = resolve;
          // Send a copy of the buffer so the main-thread ImageData stays
          // intact (we want main to be free to do other things while the
          // worker crunches). Buffer is transferred back after worker is
          // done with it.
          const buf = new Uint8ClampedArray(imgData.data);
          w.postMessage({ kind: 'apply', token: lutWorkerToken, data: buf, mix }, [buf.buffer]);
        });
      }

            // Per-pixel slider pass for iOS / WKWebView. Mirrors computeFilters()
      // semantics: exposure = multiplicative, brightness = multiplicative
      // additional, contrast = pivot at 128, saturation = luma lerp, temp/tint
      // = RGB shifts approximating sepia/hue-rotate.
      function applySlidersToRgba(data, s) {
        if (s.exposure === 0 && s.contrast === 0 && s.brightness === 0 &&
            s.saturation === 0 && s.temp === 0 && s.tint === 0) {
          return;  // fast path: nothing to do
        }
        const expBrightness = Math.pow(2, s.exposure / 100);
        const cMult = (100 + s.contrast) / 100;
        const satMult = (100 + s.saturation) / 100;
        const addBright = (100 + s.brightness) / 100;
        const tempShift = s.temp * 0.30;  // ±30 RGB units
        const tintShift = s.tint * 0.20;  // ±20 RGB units
        for (let i = 0; i < data.length; i += 4) {
          let r = data[i];
          let g = data[i + 1];
          let b = data[i + 2];
          if (s.exposure !== 0) {
            r *= expBrightness;
            g *= expBrightness;
            b *= expBrightness;
          }
          if (s.brightness !== 0) {
            r *= addBright;
            g *= addBright;
            b *= addBright;
          }
          if (s.contrast !== 0) {
            r = (r - 128) * cMult + 128;
            g = (g - 128) * cMult + 128;
            b = (b - 128) * cMult + 128;
          }
          if (s.saturation !== 0) {
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            r = luma + (r - luma) * satMult;
            g = luma + (g - luma) * satMult;
            b = luma + (b - luma) * satMult;
          }
          if (s.temp !== 0) {
            r += tempShift;
            g += tempShift * 0.33;
            b -= tempShift;
          }
          if (s.tint !== 0) {
            r += tintShift;
            g -= tintShift;
          }
          data[i]     = r < 0 ? 0 : r > 255 ? 255 : r | 0;
          data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g | 0;
          data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b | 0;
        }
      }

      // ---- Legacy 2D pipeline (preserved for fallback and iOS) ----
      function drawLegacy() {
        if (!sourceImage.complete || !sourceImage.naturalWidth) return;
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // For RAW images, translate raw_wb_kelvin/raw_wb_tint into legacy
        // temp/tint for live preview feedback. Mirrors drawWebGL().
        let previewTemp = state.temp;
        let previewTint = state.tint;
        if (isRawAtRuntime && state.raw_wb_kelvin != null) {
          const deltaK = (state.raw_wb_kelvin - 5500) / 20;
          previewTemp = Math.max(-100, Math.min(100, deltaK));
          previewTint = state.raw_wb_tint != null ? state.raw_wb_tint : 0;
        }
        // Compare mode: show original, no crop mask, no filter
        if (comparing) {
          ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
          ctx.restore();
          return;
        }
        // Apply crop via clip if set
        if (state.crop) {
          const c = state.crop;
          const cx = c.x * canvas.width, cy = c.y * canvas.height;
          const cw = c.w * canvas.width, ch = c.h * canvas.height;
          // Dim outside-crop area
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(0, 0, canvas.width, cy);                   // top
          ctx.fillRect(0, cy, cx, ch);                            // left
          ctx.fillRect(cx + cw, cy, canvas.width - cx - cw, ch); // right
          ctx.fillRect(0, cy + ch, canvas.width, canvas.height); // bottom
          // Draw image inside crop
          ctx.beginPath();
          ctx.rect(cx, cy, cw, ch);
          ctx.clip();
        }
        // === Pipeline ===
        // First, decide what we need:
        //  - noLut / noSharpen / noSliders → fast path: just draw the source
        //    image directly with no filter chain and no JS pixel passes.
        //    This is the "just looking at the image" case and needs to be
        //    pixel-perfect against the source bytes.
        //  - Otherwise: GPU ctx.filter for sliders (desktop) or per-pixel JS
        //    for iOS, then apply LUT separately after.
        const hasSliderWork = isIOS && (
          state.exposure !== 0 || state.contrast !== 0 || state.brightness !== 0 ||
          state.saturation !== 0 || previewTemp !== 0 || previewTint !== 0
        );
        const hasSharpen = state.sharpen > 0;
        const hasLut = !!(activeLut && state.lut_id && state.lut_intensity > 0);
        const hasFilterWork = !isIOS && computeFilters({ temp: previewTemp, tint: previewTint }) !== '';
        const needsPixelPass = hasSliderWork || hasLut;
        const needsFullPipeline = hasSharpen || needsPixelPass || hasFilterWork;

        if (!needsFullPipeline) {
          // Fast path: identity transform, just blit source.
          ctx.filter = 'none';
          ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
        } else if (isIOS) {
          // iOS: per-pixel JS pass for sliders (since ctx.filter doesn't work
          // on canvas drawImage in WKWebView). Sharpen is also JS-only.
          ctx.filter = 'none';
          const drawSource = hasSharpen ? getSharpenedSource(state.sharpen) : sourceImage;
          ctx.drawImage(drawSource, 0, 0, canvas.width, canvas.height);
          if (needsPixelPass) {
            try {
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const data = imgData.data;
              if (hasSliderWork) applySlidersToRgba(data, { ...state, temp: previewTemp, tint: previewTint });
              if (hasLut) {
                const mix = Math.max(0, Math.min(1, state.lut_intensity / 100));
                applyLutToRgba(activeLut, data, mix);
              }
              ctx.putImageData(imgData, 0, 0);
            } catch (e) {
              console.warn('iOS pixel pass failed:', e);
            }
          }
        } else {
          // Desktop / Chromium: ctx.filter (GPU) for sliders + JS LUT after.
          const filters = computeFilters({ temp: previewTemp, tint: previewTint });
          ctx.filter = filters;
          const drawSource = hasSharpen ? getSharpenedSource(state.sharpen) : sourceImage;
          ctx.drawImage(drawSource, 0, 0, canvas.width, canvas.height);
          ctx.filter = 'none';
          if (hasLut) {
            try {
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const mix = Math.max(0, Math.min(1, state.lut_intensity / 100));
              // Offload to worker. Main thread stays responsive while the
              // worker processes pixels. Race-safe: stale tokens are
              // discarded by the worker.
              applyLutToRgbaAsync(imgData, mix).then((result) => {
                if (result) ctx.putImageData(result, 0, 0);
              });
            } catch (e) {
              console.warn('LUT pass failed:', e);
            }
          }
        }
        ctx.restore();
        // Crop border
        if (state.crop) {
          const c = state.crop;
          const cx = c.x * canvas.width, cy = c.y * canvas.height;
          const cw = c.w * canvas.width, ch = c.h * canvas.height;
          ctx.strokeStyle = '#fafafa';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(cx, cy, cw, ch);
          // Resize handles (4 corners)
          const h = 12;
          ctx.fillStyle = '#fafafa';
          [[cx,cy],[cx+cw,cy],[cx,cy+ch],[cx+cw,cy+ch]].forEach(([x,y]) => {
            ctx.fillRect(x - h/2, y - h/2, h, h);
          });
        }
      
      }

      // ---- WebGL GPU pipeline (new) ----
      // Lazy source upload + LUT upload + uniform state update + render.
      // Returns true on success, false if WebGL pipeline unavailable.
      let _webglSourceRef = null;
      let _webglSourceUploaded = false;
      let _webglLutRef = null;
      async function drawWebGL() {
        if (!useWebGL) return false;
        if (webglPipeline === null || webglPipeline === false) {
          if (webglPipeline === null) {
            const p = await loadWebGLPipeline();
            if (!p) {; return false; }
            webglPipeline = p;
          } else {
            return false;
          }
        }
        if (!sourceImage.complete || !sourceImage.naturalWidth) {; return false; }

        // Re-upload source if the image changed
        if (_webglSourceRef !== sourceImage.src) {
          _webglSourceUploaded = false;
          _webglSourceRef = sourceImage.src;
        }
        if (!_webglSourceUploaded) {
          webglPipeline.setSource(sourceImage);
          _webglSourceUploaded = true;
        }

        // Compare mode: show the original by pushing a neutral state to the
        // GPU. Source passes through unchanged. Bypass LUT too.
        if (comparing) {
          webglPipeline.updateState({
            exposure: 0, contrast: 0, brightness: 0,
            saturation: 0, temp: 0, tint: 0,
            sharpen: 0, lut_id: 0, lut_intensity: 0,
            vignette: 0, highlights: 0, shadows: 0,
            whites: 0, blacks: 0,
            straighten: 0, cropX: 0, cropY: 0, cropW: 0, cropH: 0,
            dehaze: 0,
            lens_corrections: { enabled: false, remove_baseline_exposure: 0, chromatic_aberration: 0, chromatic_aberration_x: 0, chromatic_aberration_y: 0 },
            calibration: { shadow_tint: 0, saturation: 0 },
          });
          // Neutralise the per-effect setters too (grain, split toning, HSL, CG, curves)
          webglPipeline.setGrain({ amount: 0, size: 25 });
          webglPipeline.setSplitToning({ shadows_hue: 0, shadows_saturation: 0, highlights_hue: 0, highlights_saturation: 0, balance: 0 });
          webglPipeline.setHsl({}, null);
          // Identity curves = linear pass-through
          webglPipeline.setCurves({
            rgb: [[0, 0], [255, 255]],
            r: [[0, 0], [255, 255]],
            g: [[0, 0], [255, 255]],
            b: [[0, 0], [255, 255]],
          });
          webglPipeline.render();
          return true;
        }

        // Re-upload LUT if the active LUT changed
        if (activeLut && _webglLutRef !== activeLut) {
          webglPipeline.setLut(activeLut);
          _webglLutRef = activeLut;
        }

        // For RAW images, translate raw_wb_kelvin/raw_wb_tint into the
        // JPEG's temp/tint for live preview feedback. The actual full
        // WB shift is applied at save time via darktable-cli's XMP
        // (camera-baseline temperature + colorbalance module). This
        // approximation gives the user visual feedback that the
        // slider is doing something.
        //   - K=5500 → temp_preview = 0 (neutral)
        //   - K=7500 → temp_preview = +100 (max warm in legacy slider)
        //   - K=3500 → temp_preview = -100 (max cool)
        //   - deltaK per unit of temp = 20K
        let previewTemp = state.temp;
        let previewTint = state.tint;
        if (isRawAtRuntime && state.raw_wb_kelvin != null) {
          const deltaK = (state.raw_wb_kelvin - 5500) / 20;
          previewTemp = Math.max(-100, Math.min(100, deltaK));
          previewTint = state.raw_wb_tint != null ? state.raw_wb_tint : 0;
        }

        // Push current state to GPU
        webglPipeline.updateState({
          exposure: state.exposure,
          contrast: state.contrast,
          brightness: state.brightness,
          saturation: state.saturation,
          temp: previewTemp,
          tint: previewTint,
          sharpen: state.sharpen,
          lut_intensity: state.lut_intensity,
          vignette: state.vignette,
          highlights: state.highlights,
          shadows: state.shadows,
          whites: state.whites,
          blacks: state.blacks,
          dehaze: (state as any).dehaze ?? 0,
          lens_corrections: (state as any).lens_corrections ?? {
            enabled: false, remove_baseline_exposure: 0,
            chromatic_aberration: 0, chromatic_aberration_x: 0, chromatic_aberration_y: 0,
          },
          calibration: (state as any).calibration ?? { shadow_tint: 0, saturation: 0 },
          straighten: (state as any).straighten ?? 0,
          cropX: (state as any).crop?.x ?? 0,
          cropY: (state as any).crop?.y ?? 0,
          cropW: (state as any).crop?.w ?? 0,
          cropH: (state as any).crop?.h ?? 0,
        });
        
        // Apply tone curve
        webglPipeline.setCurves({
          rgb: _cvData.rgb,
          r: _cvData.r,
          g: _cvData.g,
          b: _cvData.b,
        });

        // Build HSL + Color Grading state from UI
        const RANGES = ['red','orange','yellow','green','aqua','blue','purple','magenta'];
        const hslData: Record<string, {h:number; s:number; l:number}> = {};
        for (const range of RANGES) {
          const key = 'hsl_' + range;
          hslData[key] = {
            h: (state as any)[key]?.h ?? 0,
            s: (state as any)[key]?.s ?? 0,
            l: (state as any)[key]?.l ?? 0,
          };
        }
        const colorGrading = {
          shadows_colour: (state as any).cg_shadows_colour ?? [0, 0, 0],
          midtones_colour: (state as any).cg_midtones_colour ?? [0, 0, 0],
          highlights_colour: (state as any).cg_highlights_colour ?? [0, 0, 0],
          global_colour: (state as any).cg_global_colour ?? [0, 0, 0],
          shadows_intensity: (state as any).cg_shadows_intensity ?? 0,
          midtones_intensity: (state as any).cg_midtones_intensity ?? 0,
          highlights_intensity: (state as any).cg_highlights_intensity ?? 0,
          global_intensity: (state as any).cg_global_intensity ?? 0,
          mode: ((state as any).cg_mode as 'saturation' | 'luminance') ?? 'saturation',
        };
        webglPipeline.setHsl(hslData, colorGrading);

        // Split Toning
        webglPipeline.setSplitToning({
          shadows_hue: (state as any).st_shadows_hue ?? 0,
          shadows_saturation: (state as any).st_shadows_saturation ?? 0,
          highlights_hue: (state as any).st_highlights_hue ?? 0,
          highlights_saturation: (state as any).st_highlights_saturation ?? 0,
          balance: (state as any).st_balance ?? 0,
        });

        // Grain
        webglPipeline.setGrain({
          amount: (state as any).grain_amount ?? 0,
          size: (state as any).grain_size ?? 25,
        });

webglPipeline.render();
        return true;
      }

      // Call updateCropDims after drawing
      try { if ((window as any).updateCropDims) (window as any).updateCropDims(); } catch(e) {}

      // Crop overlay rendered as DOM (4 dim rects + border + corner handles).
      // WebGL can't draw 2D context ops, so we use absolutely-positioned divs
      // overlaid on the canvas instead. This works in both WebGL and legacy modes.
      function drawCropOverlayDom() {
        let overlay = document.getElementById('crop-overlay');
        if (!overlay) {
          // Fallback: create one (shouldn't happen since HTML has it)
          overlay = document.createElement('div');
          overlay.id = 'crop-overlay';
          overlay.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:4;';
          canvas.parentNode.appendChild(overlay);
        }
        overlay.innerHTML = '';
        if (!state.crop) return;
        const c = state.crop;
        const cw = canvas.clientWidth, ch = canvas.clientHeight;
        const x = c.x * cw, y = c.y * ch, w = c.w * cw, h = c.h * ch;
        const dim = 'position:absolute;background:rgba(0,0,0,0.55);';
        overlay.appendChild(Object.assign(document.createElement('div'), { style: dim + 'left:0;top:0;width:' + cw + 'px;height:' + y + 'px;' }));
        overlay.appendChild(Object.assign(document.createElement('div'), { style: dim + 'left:0;top:' + y + 'px;width:' + x + 'px;height:' + h + 'px;' }));
        overlay.appendChild(Object.assign(document.createElement('div'), { style: dim + 'left:' + (x + w) + 'px;top:' + y + 'px;width:' + (cw - x - w) + 'px;height:' + h + 'px;' }));
        overlay.appendChild(Object.assign(document.createElement('div'), { style: dim + 'left:0;top:' + (y + h) + 'px;width:' + cw + 'px;height:' + (ch - y - h) + 'px;' }));
        overlay.appendChild(Object.assign(document.createElement('div'), { style: 'position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;border:1.5px solid #fafafa;box-sizing:border-box;' }));
        const hs = 12;
        const handleStyle = 'position:absolute;background:#fafafa;width:' + hs + 'px;height:' + hs + 'px;';
        [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([hx,hy]) => {
          const d = document.createElement('div');
          d.style.cssText = handleStyle + 'left:' + (hx - hs/2) + 'px;top:' + (hy - hs/2) + 'px;';
          overlay.appendChild(d);
        });
      }

      // Apply CSS preview approximation for RAW sliders that have no
      // direct JPEG equivalent. Called from the slider input handler.
      // - Denoise: canvas filter:blur() proportional to (lum+chroma)/200.
      // - Lens:    canvas filter:brightness() slight lift (simulates the
      //            corner-brightening from vignetting correction).
      // Both filters reset to 'none' when sliders are 0/unchecked.
      function applyRawPreviewFx() {
        if (!canvas) return;
        const lum = Number(state.raw_nr_lum) || 0;
        const chr = Number(state.raw_nr_chroma) || 0;
        const lens = !!state.raw_lens_on;
        const blurPx = ((lum + chr) / 200) * 2.5;  // up to 2.5px at full sliders
        const filt = [];
        if (blurPx > 0.05) filt.push('blur(' + blurPx.toFixed(2) + 'px)');
        if (lens) filt.push('brightness(1.03)');
        canvas.style.filter = filt.length ? filt.join(' ') : '';
        // Update lens badge
        const badge = document.getElementById('lens-corrections-badge');
        if (badge) badge.style.display = lens ? 'inline-block' : 'none';
      }

            // ---- Unified draw dispatcher ----
      function draw() {

        if (!sourceImage.complete || !sourceImage.naturalWidth) return;
        if (useWebGL) {
          drawWebGL();
          applyVignetteOverlay();
          drawCropOverlayDom();
          try { if ((window as any).updateCropDims) (window as any).updateCropDims(); } catch(e) {}
          return;
        }
        drawLegacy();
        try { if ((window as any).updateCropDims) (window as any).updateCropDims(); } catch(e) {}
      }


      // Flag set by Save / Revert so onload can wipe the local overlay state
      // and present the saved result cleanly. Without this, the crop dim mask,
      // crop border/handles, and #vignette-overlay DOM element all stay on the
      // canvas and look like a "vignetted box at the centre" sitting on top
      // of the (correctly baked) saved image.
      let _resetOnLoad = false;
      const SLIDER_KEYS = ['exposure','contrast','brightness','highlights','shadows','whites','blacks','saturation','temp','tint','sharpen','vignette','lut_intensity','cg_shadows_intensity','cg_midtones_intensity','cg_highlights_intensity','cg_global_intensity', ...RAW_KEYS];
      // ---- History Panel (Lightroom-style non-destructive) ----
      // _history: array of snapshots; _historyIndex points to current position.
      // Clicking an entry jumps to that state. Ctrl+Z = undo, Ctrl+Shift+Z = redo.
      const MAX_HISTORY = 50;
      let _history: { ts: number; label: string; snapshot: Record<string, any> }[] = [];
      let _historyIndex = -1;
      let _ignoreHistory = false; // used when applying history entries or batch ops

      function _keyLabel(key: string, v: any): string {
        const labels: Record<string, string> = {
          exposure: 'Exposure', contrast: 'Contrast', brightness: 'Brightness',
          highlights: 'Highlights', shadows: 'Shadows', whites: 'Whites', blacks: 'Blacks',
          saturation: 'Saturation', temp: 'Temperature', tint: 'Tint',
          sharpen: 'Sharpen', vignette: 'Vignette', dehaze: 'Dehaze',
          lut_intensity: 'LUT Intensity',
          st_shadows_hue: 'ST Shadows Hue', st_shadows_saturation: 'ST Shadows Sat',
          st_highlights_hue: 'ST Highlights Hue', st_highlights_saturation: 'ST Highlights Sat',
          st_balance: 'ST Balance',
          grain_amount: 'Grain Amount', grain_size: 'Grain Size',
          straighten: 'Straighten',
        };
        if (key.startsWith('hsl_')) return (key.replace('hsl_', 'HSL ').replace(/_/g, ' ').replace('h ', ' Hue ').replace('s ', ' Sat ').replace('l ', ' Lit ')).trim();
        if (key.startsWith('cg_')) return 'CG ' + key.replace('cg_', '').replace(/_/g, ' ');
        return (labels[key] || key) + ' ' + (typeof v === 'number' ? v : '');
      }

      function pushHistory(label: string, snapshot: Record<string, any>) {
        if (_ignoreHistory) return;
        // Deduplicate: if last entry has same snapshot, skip
        if (_historyIndex >= 0) {
          const last = _history[_historyIndex];
          let same = true;
          for (const k of Object.keys(snapshot)) {
            if (JSON.stringify(last.snapshot[k]) !== JSON.stringify(snapshot[k])) { same = false; break; }
          }
          if (same) return;
        }
        // Drop any entries after current index (we're branching)
        _history = _history.slice(0, _historyIndex + 1);
        _history.push({ ts: Date.now(), label, snapshot: JSON.parse(JSON.stringify(snapshot)) });
        if (_history.length > MAX_HISTORY) _history.shift();
        _historyIndex = _history.length - 1;
        renderHistoryPanel();
      }

      function undo() {
        if (_historyIndex <= 0) return;
        _historyIndex--;
        _applyHistoryEntry(_historyIndex);
      }

      function redo() {
        if (_historyIndex >= _history.length - 1) return;
        _historyIndex++;
        _applyHistoryEntry(_historyIndex);
      }

      function _applyHistoryEntry(idx: number) {
        const entry = _history[idx];
        if (!entry) return;
        _ignoreHistory = true;
        const snap = entry.snapshot;
        for (const k of SLIDER_KEYS) {
          if (snap[k] !== undefined) {
            state[k] = snap[k];
            const wrap = document.querySelector('.slider[data-key= + k + ]');
            if (wrap) {
              const inp = wrap.querySelector('input');
              const valEl = wrap.querySelector('.val');
              if (inp) inp.value = String(snap[k]);
              if (valEl) valEl.textContent = String(snap[k]);
            }
          }
        }
        // Crop
        if (snap.crop !== undefined) {
          state.crop = snap.crop;
          if (snap.crop) {
            const c = snap.crop;
            cropBox = {
              x: c.x * canvas.width, y: c.y * canvas.height,
              w: c.w * canvas.width, h: c.h * canvas.height,
            };
          } else {
            cropBox = null;
          }
        }
        _ignoreHistory = false;
        renderHistoryPanel();
        draw();
      }

      function renderHistoryPanel() {
        const panel = document.getElementById('history-list');
        if (!panel) return;
        panel.innerHTML = '';
        const start = Math.max(0, _historyIndex - 14);
        const visible = _history.slice(start, start + 20);
        visible.forEach((entry, i) => {
          const globalIdx = start + i;
          const div = document.createElement('div');
          div.className = 'hist-entry' + (globalIdx === _historyIndex ? ' active' : '');
          const t = new Date(entry.ts);
          const timeStr = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          div.innerHTML = '<span class=hist-time>' + timeStr + '</span><span class=hist-label>' + entry.label + '</span>';
          div.addEventListener('click', () => {
            _historyIndex = globalIdx;
            _applyHistoryEntry(globalIdx);
          });
          panel.appendChild(div);
        });
        const undoBtn = document.getElementById('btn-history-undo') as HTMLButtonElement;
        const redoBtn = document.getElementById('btn-history-redo') as HTMLButtonElement;
        if (undoBtn) undoBtn.disabled = _historyIndex <= 0;
        if (redoBtn) redoBtn.disabled = _historyIndex >= _history.length - 1;
      }

      // ---- Auto Tone: Lightroom-style one-click histogram analysis ----
      async function autoTone() {
        if (!useWebGL || !webglPipeline || !sourceImage.complete) {
          // Fallback: just set exposure to +0.5 and call it a day
          setSliderValue('exposure', 15);
          setSliderValue('contrast', 10);
          setSliderValue('highlights', -20);
          setSliderValue('shadows', 20);
          draw();
          return;
        }
        // Capture a tiny downsampled histogram via readPixels
        try {
          const size = 64;
          const offscreen = document.createElement('canvas');
          offscreen.width = size; offscreen.height = size;
          const octx = offscreen.getContext('2d');
          if (!octx) return;
          octx.drawImage(sourceImage, 0, 0, size, size);
          const imgData = octx.getImageData(0, 0, size, size);
          const data = imgData.data;

          // Compute per-channel histograms (256 buckets)
          const histR = new Uint32Array(256);
          const histG = new Uint32Array(256);
          const histB = new Uint32Array(256);
          for (let i = 0; i < data.length; i += 4) {
            histR[data[i]]++;
            histG[data[i+1]]++;
            histB[data[i+2]]++;
          }
          const total = size * size;
          // Find 0.5% and 99.5% percentiles
          function percentile(hist: Uint32Array, pct: number): number {
            let acc = 0;
            const target = total * pct;
            for (let v = 0; v < 256; v++) {
              acc += hist[v];
              if (acc >= target) return v;
            }
            return 255;
          }
          const loR = percentile(histR, 0.005), hiR = percentile(histR, 0.995);
          const loG = percentile(histG, 0.005), hiG = percentile(histG, 0.995);
          const loB = percentile(histB, 0.005), hiB = percentile(histB, 0.995);
          const lo = Math.min(loR, loG, loB) / 255;
          const hi = Math.max(hiR, hiG, hiB) / 255;

          // Exposure: shift to fill the range
          // target range is [0,1], current is [lo, hi]
          // exposure correction = -log2((lo+hi)/2) in stops... simpler:
          // map the histogram to fill 0..1 by setting black+white points
          const blackClip = 0.005;
          const whiteClip = 0.005;
          // Find black point (where cumulative reaches blackClip) and white point
          function findPoint(hist: Uint32Array, clip: number): number {
            let acc = 0;
            for (let v = 0; v < 256; v++) {
              acc += hist[v];
              if (acc >= total * clip) return v;
            }
            return 255;
          }
          const blackR = findPoint(histR, blackClip);
          const blackG = findPoint(histG, blackClip);
          const blackB = findPoint(histB, blackClip);
          const whiteR = percentile(histR, 1 - whiteClip);
          const whiteG = percentile(histG, 1 - whiteClip);
          const whiteB = percentile(histB, 1 - whiteClip);

          // Average black and white
          const avgBlack = (blackR + blackG + blackB) / 3;
          const avgWhite = (whiteR + whiteG + whiteB) / 3;

          // Exposure: map mid-grey to 0.45 (neutral), shift = -((avgBlack + avgWhite)/2 - 128)
          const midRange = (avgWhite - avgBlack) / 255;
          const targetMid = 0.45;
          // ev = log2(targetMid / (midRange * 0.5 + (1-midRange)*actualMid))
          // Simplified: use a linear mapping
          // exposure = -(avgBlack/255) * 100 (push blacks up)
          // Actually let's use a simpler practical approach
          const exposure = Math.round(((128 - avgBlack) / 128) * 50);
          const exposureVal = Math.max(-200, Math.min(200, exposure));

          // Contrast: spread the range (target range 0.08..0.92)
          const targetRange = 0.84;
          const actualRange = (avgWhite - avgBlack) / 255;
          const contrastVal = Math.round((targetRange / actualRange - 1) * 50);
          const contrastAdjust = Math.max(-50, Math.min(50, contrastVal));

          // Highlights: pull back if whites are clipping
          const highlightsVal = avgWhite > 230 ? Math.round(-(avgWhite - 230) * 1.5) : 0;
          const highlightsAdjust = Math.max(-100, Math.min(100, highlightsVal));

          // Shadows: lift if blacks are crushed
          const shadowsVal = avgBlack < 15 ? Math.round((15 - avgBlack) * 2) : 0;
          const shadowsAdjust = Math.max(-100, Math.min(100, shadowsVal));

          _ignoreHistory = true;
          setSliderValue('exposure', exposureVal);
          setSliderValue('contrast', contrastAdjust);
          setSliderValue('highlights', highlightsAdjust);
          setSliderValue('shadows', shadowsAdjust);
          state.exposure = exposureVal;
          state.contrast = contrastAdjust;
          state.highlights = highlightsAdjust;
          state.shadows = shadowsAdjust;
          _ignoreHistory = false;
          pushHistory('Auto Tone', state);
          draw();
        } catch (e) {
          console.warn('autoTone failed:', e);
        }
      }


      // ============= RAW preview-render fetch (feature-gated) =============
      // On slider-release, ask the server to render the RAW via darktable-cli
      // with the current XMP params. The server caches by hash, so revisits are
      // instant. Only active when SNAPPYDO_RAW_PREVIEW_RENDER=1 AND isRawAtRuntime.
      let _rawPreviewTimer = null;
      let _rawPreviewInFlight = null;
      let _lastRawPreviewHash = null;
      function scheduleRawPreviewFetch(_reason) {
        if (!rawPreviewEnabled || !isRawAtRuntime) return;
        if (_rawPreviewTimer) clearTimeout(_rawPreviewTimer);
        _rawPreviewTimer = setTimeout(fetchRawPreview, 300);
      }
      async function fetchRawPreview() {
        if (!rawPreviewEnabled || !isRawAtRuntime) return;
        const body = {
          kelvin: Number(state.raw_wb_kelvin) || 5500,
          tint: Number(state.raw_wb_tint) || 0,
          lens_on: !!state.raw_lens_on,
          nr_lum: Number(state.raw_nr_lum) || 0,
          nr_chroma: Number(state.raw_nr_chroma) || 0,
        };
        const hashKey = JSON.stringify(body);
        if (hashKey === _lastRawPreviewHash) return; // no-op
        _lastRawPreviewHash = hashKey;
        if (_rawPreviewInFlight) { try { _rawPreviewInFlight.abort(); } catch {} }
        const ctrl = new AbortController();
        _rawPreviewInFlight = ctrl;
        setStatus('RAW preview rendering…');
        try {
          const r = await fetch('/api/images/' + imageId + '/preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            setStatus('RAW preview failed: ' + (err.error || r.statusText), true);
            return;
          }
          const data = await r.json();
          // Swap source image to the cached preview, then redraw.
          // Appending ?v=<hash> forces a cache-bust even if URL params are stable.
          const url = data.url + (data.url.includes('?') ? '&' : '?') + 'v=' + data.hash;
          sourceImage.src = url;
          setStatus('RAW preview ' + (data.cached ? 'loaded from cache.' : 'rendered.'));
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          setStatus('RAW preview error: ' + (e && e.message ? e.message : e), true);
        }
      }
      const isRawAtRuntime = document.getElementById('section-raw') !== null;
      // On RAW images the Color section's Temp/Tint sliders are overridden by
      // the RAW WB controls (raw_wb_kelvin/raw_wb_tint). Hide them so the user
      // is not confused by sliders that appear to do nothing.
      if (isRawAtRuntime) {
        document.querySelectorAll('.color-wb').forEach((el) => ((el as HTMLElement).style.display = 'none'));
      }
      function resetAllStateAndUi() {
        for (const k of SLIDER_KEYS) state[k] = 0;
        state.crop = null;
        cropBox = null;
        currentAspect = null;
        document.querySelectorAll('.slider').forEach((wrap) => {
          const input = wrap.querySelector('input');
          const valEl = wrap.querySelector('.val');
          if (input) input.value = 0;
          if (valEl) valEl.textContent = '0';
        });
        document.querySelectorAll('[data-aspect]').forEach((b) => b.classList.remove('active'));
      }

      sourceImage.onload = () => {
        fitCanvasToArea();
        _sharpenCacheKey = -1; // invalidate any stale sharpen cache
        if (_resetOnLoad) {
          _resetOnLoad = false;
          resetAllStateAndUi();
        }
        applyVignetteOverlay();
        draw();
        // Display-only canvas. Source is loaded, single high-quality
        // downsample happens at the drawImage stage. CSS shows canvas 1:1.
        // Saved edits remain at full source resolution via the server-side
        // render path.
        const zoomTxt = zoomMode === 'fit' ? '' : ' (' + zoomMode + '%)';
        setStatus('Loaded ' + sourceImage.width + 'x' + sourceImage.height + ', display ' + canvas.width + 'x' + canvas.height + zoomTxt + '.');
      };
      sourceImage.onerror = () => setStatus('Image load failed.', true);
      sourceImage.src = sourceUrl;

      // ---- Zoom controls ----
      // Restore zoom from URL hash / localStorage on load.
      zoomMode = loadZoomFromHash();
      // Reflect zoom state in toolbar UI after DOM is ready.
      setZoom(zoomMode, { silent: true });

      document.querySelectorAll('.zoom-controls button').forEach(btn => {
        btn.addEventListener('click', () => setZoom(btn.dataset.zoom));
      });

      // Ctrl/⌘ + wheel: cycle through zoom levels.
      const ZOOM_ORDER = ['fit', '100', '200', '400'];
      const areaEl = document.querySelector('.canvas-area');
      if (areaEl) {
        areaEl.addEventListener('wheel', (e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          let idx = ZOOM_ORDER.indexOf(zoomMode);
          if (idx < 0) idx = 0;
          if (e.deltaY < 0) idx = Math.min(idx + 1, ZOOM_ORDER.length - 1);
          else idx = Math.max(idx - 1, 0);
          setZoom(ZOOM_ORDER[idx]);
        }, { passive: false });
      }

      // Click-and-drag pan when zoomed past viewport. Drag from the canvas
      // itself (not the crop overlay / vignette, which have their own
      // semantics) and not when in compare mode.
      let dragging = false;
      let dragStartX = 0, dragStartY = 0;
      let panStartX = 0, panStartY = 0;
      canvas.addEventListener('mousedown', (e) => {
        if (zoomMode === 'fit') return;
        if (e.button !== 0) return;
        dragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        panStartX = panX;
        panStartY = panY;
        e.preventDefault();
      });
      function applyPanTransform() {
        // Re-apply the current pan as a CSS transform. Cheaper than calling
        // fitCanvasToArea() on every drag tick (which would reset the
        // backing buffer and re-render the full pipeline).
        if (zoomMode === 'fit') return;
        const z = parseInt(zoomMode, 10) / 100;
        const aw = areaEl ? areaEl.clientWidth : window.innerWidth;
        const ah = areaEl ? areaEl.clientHeight : window.innerHeight;
        const visW = canvas.width * z;
        const visH = canvas.height * z;
        panX = Math.max(Math.min(panX, 32), Math.min(aw - visW - 32, 0));
        panY = Math.max(Math.min(panY, 32), Math.min(ah - visH - 32, 0));
        canvas.style.transformOrigin = '0 0';
        canvas.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + z + ')';
      }
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panX = panStartX + (e.clientX - dragStartX);
        panY = panStartY + (e.clientY - dragStartY);
        applyPanTransform();
      });
      window.addEventListener('mouseup', () => { dragging = false; });

      // ---- Mobile: one-finger pan + two-finger pinch-zoom ----
      // One finger when zoomed = pan (mirror of mouse drag).
      // Two fingers = pinch (continuous zoom centred on pinch midpoint).
      // State variables are shared with mouse handlers.
      let pinchStartDist = 0;
      let pinchStartZoomMode = 'fit';
      let pinchStartPanX = 0;
      let pinchStartPanY = 0;
      let pinchMidStartX = 0;
      let pinchMidStartY = 0;

      function touchDist(a, b) {
        const dx = a.clientX - b.clientX;
        const dy = a.clientY - b.clientY;
        return Math.hypot(dx, dy);
      }
      function touchMid(a, b) {
        return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
      }
      // Map a continuous zoom factor (1.0 = current zoom, 2.0 = double, 0.5 = half)
      // to the nearest discrete preset (fit/100/200/400). Otherwise free-form
      // zoom would need fractional backing-buffer sizes.
      function continuousZoomToMode(factor) {
        const order = ZOOM_ORDER; // ['fit', '100', '200', '400']
        const current = zoomMode === 'fit' ? 0 : parseInt(zoomMode, 10);
        const want = current * factor;
        let best = order[0];
        let bestDelta = Infinity;
        for (const m of order) {
          const v = m === 'fit' ? 0 : parseInt(m, 10);
          const d = Math.abs(v - want);
          if (d < bestDelta) { bestDelta = d; best = m; }
        }
        return best;
      }

      canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
          // One finger: behave like mouse drag for panning when zoomed.
          if (zoomMode === 'fit') return; // let crop handler take over
          const t = e.touches[0];
          dragging = true;
          dragStartX = t.clientX;
          dragStartY = t.clientY;
          panStartX = panX;
          panStartY = panY;
        } else if (e.touches.length === 2) {
          // Two fingers: start pinch.
          e.preventDefault();
          dragging = false;
          pinchStartDist = touchDist(e.touches[0], e.touches[1]);
          pinchStartZoomMode = zoomMode;
          pinchStartPanX = panX;
          pinchStartPanY = panY;
          const mid = touchMid(e.touches[0], e.touches[1]);
          pinchMidStartX = mid.x;
          pinchMidStartY = mid.y;
        }
      }, { passive: false });

      canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1 && dragging) {
          // Pan
          e.preventDefault();
          const t = e.touches[0];
          panX = panStartX + (t.clientX - dragStartX);
          panY = panStartY + (t.clientY - dragStartY);
          applyPanTransform();
        } else if (e.touches.length === 2) {
          // Pinch zoom
          e.preventDefault();
          const dist = touchDist(e.touches[0], e.touches[1]);
          if (pinchStartDist < 1) return;
          const factor = dist / pinchStartDist;
          const newMode = continuousZoomToMode(factor);
          if (newMode !== zoomMode) {
            setZoom(newMode);
            // setZoom resets pan to centred. Override to keep the pinch
            // midpoint anchored under the user's fingers.
            const mid = touchMid(e.touches[0], e.touches[1]);
            const dx = mid.x - pinchMidStartX;
            const dy = mid.y - pinchMidStartY;
            panX = pinchStartPanX + dx;
            panY = pinchStartPanY + dy;
            applyPanTransform();
          } else {
            // Same mode — just translate the canvas under the midpoint.
            const mid = touchMid(e.touches[0], e.touches[1]);
            const dx = mid.x - pinchMidStartX;
            const dy = mid.y - pinchMidStartY;
            panX = pinchStartPanX + dx;
            panY = pinchStartPanY + dy;
            applyPanTransform();
          }
        }
      }, { passive: false });

      canvas.addEventListener('touchend', (e) => {
        if (e.touches.length === 0) {
          dragging = false;
          pinchStartDist = 0;
        } else if (e.touches.length === 1) {
          // Dropped from two-finger pinch back to one-finger pan.
          // Reset the pan origin to the remaining finger so subsequent
          // drag continues smoothly from where it is, not from where the
          // pinch started.
          const t = e.touches[0];
          dragging = true;
          dragStartX = t.clientX;
          dragStartY = t.clientY;
          panStartX = panX;
          panStartY = panY;
          pinchStartDist = 0;
        }
      });
      canvas.addEventListener('touchcancel', () => {
        dragging = false;
        pinchStartDist = 0;
      });

      // ---- Presets + LUTs ----
      const PRESET_SLIDER_KEYS = ['exposure','contrast','brightness','highlights','shadows','whites','blacks','saturation','temp','tint','sharpen','vignette','lut_intensity','cg_shadows_intensity','cg_midtones_intensity','cg_highlights_intensity','cg_global_intensity', ...RAW_KEYS];

      async function loadPresets() {
        try {
          const res = await fetch('/api/presets');
          if (!res.ok) return;
          const { presets } = await res.json();
          const sel = document.getElementById('preset-select');
          if (!sel) return;
          // Reset to default option
          sel.innerHTML = '<option value="">Choose preset…</option>';
          for (const p of presets) {
            const opt = document.createElement('option');
            opt.value = String(p.id);
            opt.textContent = (p.kind === 'builtin' ? '★ ' : '') + p.name;
            opt.dataset.kind = p.kind;
            if (p.kind === 'user' && p.username) opt.dataset.username = p.username;
            sel.appendChild(opt);
          }
          window.__snappydoPresets = presets;
          // Refresh Delete button visibility in case a new user preset was just saved
          if (typeof updateDeletePresetButton === 'function') updateDeletePresetButton();
        } catch (e) { console.warn('loadPresets failed', e); }
        // R48 — On reopen: sync the preset dropdown to whatever was saved (state.preset_id).
        // loadPresets() populates options asynchronously; we need to set the value AFTER
        // the options are in the DOM or the dropdown silently shows "Choose preset…".
        try {
          const sel2 = document.getElementById('preset-select');
          if (sel2 && state && state.preset_id) {
            sel2.value = String(state.preset_id);
            if (typeof updateDeletePresetButton === 'function') updateDeletePresetButton();
          }
        } catch {}
      }

      // Sort LUTs so the 5 built-ins sit at the top of the dropdown,
      // then uploaded, then user-saved/synthesised (alphabetical within each).
      function sortLutsForDisplay(luts: any[]): any[] {
        const rank: Record<string, number> = { builtin: 0, uploaded: 1, synthesised: 2 };
        return [...luts].sort((a, b) => {
          const ra = rank[a.kind] ?? 9;
          const rb = rank[b.kind] ?? 9;
          if (ra !== rb) return ra - rb;
          return String(a.name).localeCompare(String(b.name));
        });
      }

      async function loadLuts() {
        try {
          const res = await fetch('/api/luts');
          if (!res.ok) return;
          const { luts } = await res.json();
          const sorted = sortLutsForDisplay(luts || []);
          const sel = document.getElementById('lut-select');
          if (!sel) return;
          sel.innerHTML = '<option value="">No LUT</option>';
          for (const l of sorted) {
            const opt = document.createElement('option');
            opt.value = String(l.id);
            let prefix = '';
            if (l.kind === 'builtin') prefix = '★ ';
            else if (l.kind === 'synthesised') prefix = '✦ ';
            opt.textContent = prefix + l.name;
            sel.appendChild(opt);
          }
          // Keep full unsorted list on window for lookup-by-id
          window.__snappydoLuts = luts;
        } catch (e) { console.warn('loadLuts failed', e); }
      }

      async function fetchLutData(lutId) {
        if (lutCache.has(lutId)) {
          const cached = lutCache.get(lutId);
          // Push cached LUT to worker if it exists.
          if (lutWorker) {
            lutWorker.postMessage({ kind: 'lut', data: cached.data, size: cached.size });
          }
          return cached;
        }
        const res = await fetch('/api/luts/' + lutId);
        if (!res.ok) throw new Error('failed to fetch LUT');
        const json = await res.json();
        const u8 = new Uint8Array(json.data);
        const cached = { size: json.size, data: u8 };
        lutCache.set(lutId, cached);
        // Push new LUT to worker if it exists. Worker stays alive across LUTs.
        if (lutWorker) {
          lutWorker.postMessage({ kind: 'lut', data: cached.data, size: cached.size });
        }
        return cached;
      }

      // LUT select change → fetch + activate, and restore saved slider params if synthesised
      const lutSelect = document.getElementById('lut-select');
      if (lutSelect) {
        lutSelect.addEventListener('change', async () => {
          const v = lutSelect.value;
          state.lut_id = v ? Number(v) : 0;
          if (state.lut_id) {
            // First-time select: nudge intensity to 80 if it's still at 0
            // so the user actually sees the effect immediately.
            if (!state.lut_intensity) {
              state.lut_intensity = 80;
              const intensityInput = document.querySelector('#slider-lut-intensity input');
              const intensityVal = document.querySelector('#slider-lut-intensity .val');
              if (intensityInput) intensityInput.value = '80';
              if (intensityVal) intensityVal.textContent = '80';
            }
            try {
              activeLut = await fetchLutData(state.lut_id);

              // If this LUT was synthesised from sliders, restore those sliders.
              const meta = (window.__snappydoLuts || []).find((x: any) => Number(x.id) === state.lut_id);
            } catch (e) {
              setStatus('Failed to load LUT.', true);
              state.lut_id = 0;
              lutSelect.value = '';
              activeLut = null;
            }
          } else {
            activeLut = null;
          }
          draw();
        });
      }

      // Show/hide the Delete button based on whether the selected preset is a user-saved one
      function updateDeletePresetButton() {
        const btn = document.getElementById('btn-delete-preset');
        const sel = document.getElementById('preset-select');
        if (!btn || !sel) return;
        const v = sel.value;
        if (!v) { btn.style.display = 'none'; return; }
        const meta = (window.__snappydoPresets || []).find((x: any) => String(x.id) === String(v));
        btn.style.display = (meta && meta.kind === 'user') ? 'inline-flex' : 'none';
      }

      // Preset apply → load params into state + sliders + LUT select
      const presetSelect = document.getElementById('preset-select');
      if (presetSelect) {
        presetSelect.addEventListener('change', () => {
          updateDeletePresetButton();
          const id = Number(presetSelect.value);
          if (!id) return;
          const p = (window.__snappydoPresets || []).find((x) => x.id === id);
          if (!p) return;
          applyPresetToState(p.params);
        });
      }

      // Delete Preset button — DELETE /api/presets/[id] + refresh
      const btnDeletePreset = document.getElementById('btn-delete-preset');
      if (btnDeletePreset) {
        btnDeletePreset.addEventListener('click', async () => {
          const sel = document.getElementById('preset-select');
          if (!sel) return;
          const meta = (window.__snappydoPresets || []).find((x: any) => String(x.id) === String(sel.value));
          if (!meta || meta.kind !== 'user') return;
          if (!confirm('Delete preset "' + meta.name + '"? This cannot be undone.')) return;
          btnDeletePreset.disabled = true;
          const original = btnDeletePreset.textContent;
          btnDeletePreset.textContent = 'Deleting…';
          try {
            const res = await fetch('/api/presets/' + meta.id, {
              method: 'DELETE',
              credentials: 'same-origin',
            });
            if (res.status === 204) {
              setStatus('Preset deleted: ' + meta.name);
              sel.value = '';
              await loadPresets();
              updateDeletePresetButton();
            } else if (res.status === 403) {
              setStatus('Cannot delete built-in preset', true);
            } else {
              const err = await res.json().catch(() => ({}));
              setStatus('Delete preset failed: ' + (err.error || res.status), true);
            }
          } catch (e: any) {
            setStatus('Delete preset error: ' + (e?.message || String(e)), true);
          } finally {
            btnDeletePreset.disabled = false;
            btnDeletePreset.textContent = original;
          }
        });
      }


      // Save current state as a user preset
      const btnSavePreset = document.getElementById('btn-save-preset');
      if (btnSavePreset) {
        btnSavePreset.addEventListener('click', async () => {
          const name = window.prompt('Name for this preset:', '');
          if (!name) return;
          btnSavePreset.disabled = true;
          try {
            // Snapshot COMPLETE state: sliders + wheels + tone curve (so the preset
            // restores everything, not just the slider panel).
            const snapshot = snapshotPreset();
            const res = await fetch('/api/presets', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name, params: snapshot }),
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              setStatus('Save preset failed: ' + (err.error || res.statusText), true);
              return;
            }
            setStatus('Preset saved: ' + name, false);
            await loadPresets();
            if (typeof updateDeletePresetButton === 'function') updateDeletePresetButton();
          } finally {
            btnSavePreset.disabled = false;
          }
        });
      }

      // Hydrate LUTs + Presets + Tone Curve on load
      loadPresets();
      loadLuts().then(() => {
        // If state already has a lut_id from initialParams (saved edit),
        // set the dropdown and load the data.
        if (state.lut_id) {
          const sel = document.getElementById('lut-select');
          if (sel) sel.value = String(state.lut_id);
          fetchLutData(state.lut_id).then((d) => { activeLut = d; draw(); }).catch(() => { activeLut = null; });
        }
      });

      // ---- Preset capture/restore helper ----

      // Extended preset keys: base sliders + ST/CG/HSL/grain/dehaze
      const PRESET_EXTRA_KEYS = [
        // Split Toning
        'st_balance', 'st_shadows_hue', 'st_shadows_saturation',
        'st_highlights_hue', 'st_highlights_saturation',
        // Color Grading colours + mode
        'cg_mode',
        'cg_shadows_colour', 'cg_midtones_colour', 'cg_highlights_colour', 'cg_global_colour',
        // HSL ranges
        'hsl_red', 'hsl_orange', 'hsl_yellow', 'hsl_green',
        'hsl_aqua', 'hsl_blue', 'hsl_purple', 'hsl_magenta',
        // Grain + dehaze
        'grain_amount', 'grain_size',
        'dehaze',
      ];

      const HSL_RANGES_LIST = ['red','orange','yellow','green','aqua','blue','purple','magenta'];

      // Snapshot current state for preset save. Includes slider-style keys AND
      // colour wheels + tone curve (so loading a preset restores EVERYTHING).
      function snapshotPreset() {
        const snapshot: Record<string, any> = {};
        // base + extra scalar keys
        const all: string[] = [];
        all.push(...(typeof PRESET_SLIDER_KEYS !== 'undefined' ? PRESET_SLIDER_KEYS : []));
        all.push(...PRESET_EXTRA_KEYS);
        for (const k of all) {
          if (k in state && state[k as keyof typeof state] !== undefined) {
            snapshot[k] = state[k as keyof typeof state];
          }
        }
        // LUT
        snapshot.lut_id = state.lut_id || 0;
        snapshot.lut_intensity = state.lut_intensity || 0;
        // Tone curve: serialise each channel as [[x,y],...]
        const cv = (window as any)._cvData;
        if (cv && cv.rgb && cv.r && cv.g && cv.b) {
          snapshot.curve = {
            rgb: cv.rgb.map((p: [number, number]) => [p[0], p[1]]),
            r: cv.r.map((p: [number, number]) => [p[0], p[1]]),
            g: cv.g.map((p: [number, number]) => [p[0], p[1]]),
            b: cv.b.map((p: [number, number]) => [p[0], p[1]]),
          };
        }
        // Capture the active channel too so the restore knows whether to mirror rgb→r/g/b
        if (typeof (window as any)._cvCh === 'function') {
          snapshot.curveCh = (window as any)._cvCh();
        }
        return snapshot;
      }

      // Move a colour wheel's pointer to (hue, sat 0..1) by directly manipulating the SVG circle.
      function setWheelPointer(wheelId: string, hue: number, sat: number) {
        const el = document.getElementById(wheelId);
        if (!el) return;
        const pointer = el.querySelector('.cw-pointer') as SVGCircleElement | null;
        if (!pointer) return;
        const radius = (Number(pointer.getAttribute('r')) || 8) > 0 ? (el.getBoundingClientRect().width / 2 - 5) : 50;
        const a = hue * Math.PI / 180;
        const r = Math.min(1, sat);
        const px = Math.cos(a) * radius * r;
        const py = Math.sin(a) * radius * r;
        pointer.setAttribute('cx', String(px));
        pointer.setAttribute('cy', String(py));
      }

      // Restore all state from a preset's params object.
      function applyPresetToState(params: any) {
        if (!params) return;
        // 1. Restore all scalar sliders via the existing helper.
        for (const k of PRESET_SLIDER_KEYS) {
          if (k in params) setSliderValue(k, Number(params[k]) || 0);
        }
        // 2. Restore extra scalar keys (also via setSliderValue if it's a slider,
        // otherwise just write into state and update any visible label).
        for (const k of PRESET_EXTRA_KEYS) {
          if (!(k in params)) continue;
          const val = params[k];
          if (typeof val === 'number') {
            (state as any)[k] = val;
            // Update its DOM slider if it exists
            const wrap = document.querySelector('.slider[data-key="' + k + '"]');
            if (wrap) {
              const inp = wrap.querySelector('input'); if (inp) inp.value = String(val);
              const v = wrap.querySelector('.val');    if (v) v.textContent = String(val);
            }
            // Update HSL row labels if it's an HSL slider we missed above
            if (k.startsWith('hsl_')) {
              const range = k.slice(4);
              const row = document.querySelector('.cg-hsl-row[data-range="' + range + '"]');
              if (row) {
                const hSpan = row.querySelector('.cg-hsl-val.h');
                if (hSpan) hSpan.textContent = String(Math.round(val));
              }
            }
          } else if (Array.isArray(val)) {
            // e.g. CG colours stored as [r,g,b]
            (state as any)[k] = val;
          }
        }
        // 3. Restore HSL ranges from {h, s, l} objects: write the slider labels and hidden inputs.
        for (const range of HSL_RANGES_LIST) {
          const v = params['hsl_' + range];
          if (v && typeof v === 'object') {
            (state as any)['hsl_' + range] = { h: v.h || 0, s: v.s || 0, l: v.l || 0 };
            const row = document.querySelector('.cg-hsl-row[data-range="' + range + '"]');
            if (row) {
              const hInput = row.querySelector('input[data-channel="h"]') as HTMLInputElement | null;
              const sInput = row.querySelector('input[data-channel="s"]') as HTMLInputElement | null;
              const lInput = row.querySelector('input[data-channel="l"]') as HTMLInputElement | null;
              if (hInput) hInput.value = String(Math.round(v.h || 0));
              if (sInput) sInput.value = String(Math.round(v.s || 0));
              if (lInput) lInput.value = String(Math.round(v.l || 0));
              const hSpan = row.querySelector('.cg-hsl-val.h'); if (hSpan) hSpan.textContent = String(Math.round(v.h || 0));
              const sSpan = row.querySelector('.cg-hsl-val.s'); if (sSpan) sSpan.textContent = String(Math.round(v.s || 0));
              const lSpan = row.querySelector('.cg-hsl-val.l'); if (lSpan) lSpan.textContent = String(Math.round(v.l || 0));
            }
          }
        }
        // 4. Move wheel pointers to match restored state.
        // CG colours: convert [r,g,b] → hue/sat, move pointer
        const CG_WHEELS = [
          { id: 'cw-cg-shadows-colour', key: 'cg_shadows_colour' },
          { id: 'cw-cg-midtones-colour', key: 'cg_midtones_colour' },
          { id: 'cw-cg-highlights-colour', key: 'cg_highlights_colour' },
          { id: 'cw-cg-global-colour', key: 'cg_global_colour' },
        ];
        for (const w of CG_WHEELS) {
          const c = (state as any)[w.key];
          if (Array.isArray(c)) {
            const hsl = rgb2hsl255(c[0] ?? 128, c[1] ?? 128, c[2] ?? 128);
            setWheelPointer(w.id, hsl.h, hsl.s / 100);
          }
        }
        // ST wheels
        const ST_WHEELS = [
          { id: 'cw-st-shadows', h: 'st_shadows_hue', s: 'st_shadows_saturation' },
          { id: 'cw-st-highlights', h: 'st_highlights_hue', s: 'st_highlights_saturation' },
        ];
        for (const w of ST_WHEELS) {
          const hue = (state as any)[w.h] ?? 0;
          const sat = (state as any)[w.s] ?? 0;
          setWheelPointer(w.id, hue, sat / 100);
        }
        // HSL wheels: convert slider {h,s,l} back to wheel position
        const HSL_RANGES: Record<string, number> = {
          red: 0, orange: 30, yellow: 60, green: 120,
          aqua: 180, blue: 240, purple: 270, magenta: 300,
        };
        for (const range of HSL_RANGES_LIST) {
          const k = 'hsl_' + range;
          const v = (state as any)[k] || { h: 0, s: 0 };
          const centre = HSL_RANGES[range] ?? 0;
          const angle = (centre + (v.h || 0) * 1.8 + 360) % 360;
          setWheelPointer('cw-hsl-' + range, angle, (v.s || 0) / 100);
        }
        // 5. Restore tone curve.
        if (params.curve && typeof params.curve === 'object') {
          const cv = (window as any)._cvData;
          if (cv) {
            ['rgb', 'r', 'g', 'b'].forEach((ch) => {
              if (Array.isArray(params.curve[ch])) {
                cv[ch] = params.curve[ch].filter((p: any) =>
                  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
                );
                // Ensure at least the anchor endpoints exist
                if (cv[ch].length === 0 || cv[ch][0][0] !== 0) cv[ch].unshift([0, 0]);
                if (cv[ch][cv[ch].length - 1][0] !== 255) cv[ch].push([255, 255]);
                cv[ch].sort((a: any, b: any) => a[0] - b[0]);
              }
            });
            // Restore the active channel BEFORE calling _cvSync — otherwise _cvSync's
            // mirror block clobbers per-channel edits with the identity rgb curve.
            if (params.curveCh && typeof (window as any).setCvCh === 'function') {
              (window as any).setCvCh(params.curveCh);
            }
            if (typeof (window as any)._cvSync === 'function') (window as any)._cvSync();
            if (typeof (window as any)._cvRefresh === 'function') (window as any)._cvRefresh();
          }
        }
        // 6. LUT — set the dropdown and (async) load the data.
        const newLutId = params.lut_id ? Number(params.lut_id) : 0;
        state.lut_id = newLutId;
        const lutSelEl = document.getElementById('lut-select');
        if (lutSelEl) lutSelEl.value = newLutId ? String(newLutId) : '';
        if (newLutId) {
          fetchLutData(newLutId).then((d) => {
            activeLut = d;
            _sharpenCacheKey = -1;
            applyVignetteOverlay();
            draw();
          }).catch(() => { activeLut = null; });
        } else {
          activeLut = null;
        }
        applyVignetteOverlay();
        _sharpenCacheKey = -1;
        draw();
        setStatus('Preset loaded');
      }

      // ---- Sliders ----

      // Helper: set a potentially nested key in state
      function setNestedState(state, key, value) {
        if (key.includes(".")) {
          const parts = key.split(".");
          let obj = state;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]]) obj[parts[i]] = {};
            obj = obj[parts[i]];
          }
          obj[parts[parts.length - 1]] = value;
        } else {
          state[key] = value;
        }
      }
      function getNestedState(state, key) {
        if (key.includes(".")) {
          const parts = key.split(".");
          let obj = state;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]]) return undefined;
            obj = obj[parts[i]];
          }
          return obj[parts[parts.length - 1]];
        }
        return state[key];
      }

      document.querySelectorAll('.slider').forEach((wrap) => {
        const key = wrap.dataset.key;
        const input = wrap.querySelector('input');
        const valEl = wrap.querySelector('.val');
        const initVal = getNestedState(state, key);
        input.value = String(initVal ?? 0);
        valEl.textContent = String(initVal ?? 0);
        input.addEventListener('input', () => {
          const prevVal = getNestedState(state, key);
          const v = Number(input.value);
          // Push history entry BEFORE updating state (skip if same value)
          if (v !== prevVal && !_ignoreHistory) {
            const snap = JSON.parse(JSON.stringify(state));
            pushHistory((document.querySelector('.slider[data-key="' + key + '"] label')?.textContent || key) + ' ' + v, snap);
          }
          setNestedState(state, key, v);
          valEl.textContent = v;
          if (key === 'sharpen') {
            _sharpenCacheKey = -1; // force re-blur next draw
            if (v > 0) getSharpenedSource(v); // pre-warm async-ish
          }
          applyVignetteOverlay();
          applyRawPreviewFx();
          scheduleDraw();
          // RAW preview-render: re-fetch on slider-release (debounced 300ms).
          // Only fires if the slider is one of the RAW-only keys.
          if (RAW_KEYS.includes(key)) scheduleRawPreviewFetch('slider:' + key);
        });
      });

      function resetKeys(keys) {
        keys.forEach((k) => { state[k] = 0; });
        document.querySelectorAll('.slider').forEach((wrap) => {
          if (keys.includes(wrap.dataset.key)) {
            const input = wrap.querySelector('input');
            const valEl = wrap.querySelector('.val');
            input.value = 0;
            valEl.textContent = '0';
          }
        });
        draw();
      }

      function setSliderValue(key, v) {
        state[key] = v;
        const wrap = document.querySelector('.slider[data-key="' + key + '"]');
        if (wrap) {
          const input = wrap.querySelector('input');
          const valEl = wrap.querySelector('.val');
          if (input) input.value = v;
          if (valEl) valEl.textContent = v;
        }
      }
      btnReset.onclick = () => {
        ['exposure','contrast','brightness','highlights','shadows','whites','blacks','saturation','temp','tint','sharpen','vignette','lut_intensity','cg_shadows_intensity','cg_midtones_intensity','cg_highlights_intensity','cg_global_intensity'].forEach((k) => { state[k] = 0; });
        (state as any).straighten = 0;
        setSliderValue('straighten', 0);
        if (webglPipeline) webglPipeline.updateState({ straighten: 0 });
        if (isRawAtRuntime) {
          for (const k of RAW_KEYS) {
            state[k] = RAW_DEFAULTS[k];
            const wrap = document.querySelector('.slider[data-key="' + k + '"]');
            if (wrap) {
              const inp = wrap.querySelector('input');
              const valEl = wrap.querySelector('.val');
              if (inp) inp.value = String(RAW_DEFAULTS[k]);
              if (valEl) valEl.textContent = String(RAW_DEFAULTS[k]);
            }
          }
          const lensCb = document.getElementById('raw-lens-on');
          if (lensCb) lensCb.checked = false;
        }
        document.querySelectorAll('.slider').forEach((wrap) => {
          const input = wrap.querySelector('input');
          const valEl = wrap.querySelector('.val');
          input.value = 0;
          valEl.textContent = '0';
        });
        state.crop = null;
        state.lut_id = 0;
        const lutSel = document.getElementById('lut-select');
        if (lutSel) lutSel.value = '';
        activeLut = null;
        // Reset tone curve shape (channel points + active channel)
        if (typeof (window as any)._cvReset === 'function') (window as any)._cvReset();
        // Reset effects (dehaze, split toning, grain), CG colours, HSL
        resetKeys(['dehaze','st_balance','grain_amount','grain_size']);
        resetStWheels();  // Resets ST state + wheel pointers
        resetCgKeys();
        draw();
      };
      document.getElementById('btn-reset-light').onclick = () => resetKeys(['exposure','contrast','brightness']);
      document.getElementById('btn-auto-tone').onclick = () => autoTone();
      document.getElementById('btn-history-undo').onclick = () => undo();
      document.getElementById('btn-history-redo').onclick = () => redo();
      document.getElementById('btn-reset-tone').onclick = () => resetKeys(['highlights','shadows','whites','blacks']);
      document.getElementById('btn-reset-color').onclick = () => resetKeys(['saturation','temp','tint']);
      document.getElementById('btn-reset-fx').onclick = () => {
  resetKeys(['sharpen','vignette','dehaze','st_balance','grain_amount','grain_size']);
  resetStWheels();
  resetCgKeys();
  draw();
};
      // Wire the Color Grading section reset button (resets CG colours + HSL)
      const btnResetCg = document.getElementById('btn-reset-cg');
      if (btnResetCg) btnResetCg.onclick = () => resetCgKeys();
      // Wire any per-section reset buttons for Split Toning + HSL if present
      const btnResetSt = document.getElementById('btn-reset-st');
      if (btnResetSt) btnResetSt.onclick = () => { resetKeys(['st_balance']); resetStWheels(); draw(); };
      const btnResetHsl = document.getElementById('btn-reset-hsl');
      if (btnResetHsl) btnResetHsl.onclick = () => { resetCgKeys(); draw(); }; // resets HSL too

      // Add small × reset button on every colour wheel for individual reset
      document.querySelectorAll('.cw').forEach((wheel: any) => {
        if (wheel.querySelector('.cw-reset-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'cw-reset-btn';
        btn.textContent = '×';
        btn.title = 'Reset colour';
        wheel.appendChild(btn);
        btn.addEventListener('click', (e: MouseEvent) => {
          e.stopPropagation();
          e.preventDefault();
          // Move pointer to centre
          const pointer = wheel.querySelector('.cw-pointer') as SVGCircleElement | null;
          if (pointer) { pointer.setAttribute('cx', '0'); pointer.setAttribute('cy', '0'); }
          // Clear state based on the wheel's data attrs
          const stateKey = wheel.dataset.stateKey;
          const stHue = wheel.dataset.stHue;
          const stSat = wheel.dataset.stSat;
          const hslRange = wheel.dataset.hslRange;
          if (stateKey) {
            (window as any).state[stateKey] = [128, 128, 128];
          }
          if (stHue && stSat) {
            (window as any).state[stHue] = 0;
            (window as any).state[stSat] = 0;
            const wrap1 = document.querySelector('.slider[data-key="' + stHue + '"]');
            if (wrap1) {
              const sl = wrap1.querySelector('input'); if (sl) sl.value = '0';
              const val = wrap1.querySelector('.val'); if (val) val.textContent = '0';
            }
            const wrap2 = document.querySelector('.slider[data-key="' + stSat + '"]');
            if (wrap2) {
              const sl = wrap2.querySelector('input'); if (sl) sl.value = '0';
              const val = wrap2.querySelector('.val'); if (val) val.textContent = '0';
            }
          }
          if (hslRange) {
            (window as any).state['hsl_' + hslRange] = { h: 0, s: 0, l: 0 };
          }
          if (typeof scheduleDraw === 'function') scheduleDraw();
          else if (typeof draw === 'function') draw();
        });
      });

      // Reset a colour wheel pointer to centre (neutral)
      function resetWheelPointer(elId: string) {
        const el = document.getElementById(elId);
        if (!el) return;
        const pointer = el.querySelector('.cw-pointer') as SVGCircleElement | null;
        if (pointer) { pointer.setAttribute('cx', '0'); pointer.setAttribute('cy', '0'); }
      }

      function resetCgKeys() {
        const RANGES = ['red','orange','yellow','green','aqua','blue','purple','magenta'];
        for (const range of RANGES) {
          state['hsl_' + range] = { h: 0, s: 0, l: 0 };
          const row = document.querySelector('.cg-hsl-row[data-range="' + range + '"]');
          if (row) {
            row.querySelectorAll('.cg-hsl-slider').forEach((sl: any) => { sl.value = '0'; });
            row.querySelectorAll('.cg-hsl-val').forEach((sp: any) => { sp.textContent = '0'; });
          }
          // Reset HSL wheel pointer
          resetWheelPointer('cw-hsl-' + range);
        }
        // Reset CG colours to gray (neutral — black would mean a colour tint)
        state.cg_shadows_colour = [128, 128, 128];
        state.cg_midtones_colour = [128, 128, 128];
        state.cg_highlights_colour = [128, 128, 128];
        state.cg_global_colour = [128, 128, 128];
        state.cg_shadows_intensity = 0;
        state.cg_midtones_intensity = 0;
        state.cg_highlights_intensity = 0;
        state.cg_global_intensity = 0;
        state.cg_mode = 'saturation';
        // Reset CG wheel pointers to centre
        resetWheelPointer('cw-cg-shadows-colour');
        resetWheelPointer('cw-cg-midtones-colour');
        resetWheelPointer('cw-cg-highlights-colour');
        resetWheelPointer('cw-cg-global-colour');
        const modeSel = document.getElementById('cg-mode-select') as HTMLSelectElement;
        if (modeSel) modeSel.value = 'saturation';
        ['cg_shadows_intensity','cg_midtones_intensity','cg_highlights_intensity','cg_global_intensity'].forEach((k) => {
          const sl = document.querySelector('[data-key="' + k + '"] input[type="range"]') as HTMLInputElement;
          const val = document.querySelector('[data-key="' + k + '"] .val');
          if (sl) { sl.value = '0'; if (val) val.textContent = '0'; }
        });
        if (typeof drawWebGL === 'function') drawWebGL();
        if (typeof draw === 'function') draw();
      }

      function resetStWheels() {
        // Reset Split Toning wheels + their underlying state
        state.st_shadows_hue = 0;
        state.st_shadows_saturation = 0;
        state.st_highlights_hue = 0;
        state.st_highlights_saturation = 0;
        resetWheelPointer('cw-st-shadows');
        resetWheelPointer('cw-st-highlights');
        ['st_shadows_hue','st_shadows_saturation','st_highlights_hue','st_highlights_saturation'].forEach((k) => {
          const sl = document.querySelector('[data-key="' + k + '"] input[type="range"]') as HTMLInputElement;
          const val = document.querySelector('[data-key="' + k + '"] .val');
          if (sl) { sl.value = '0'; if (val) val.textContent = '0'; }
        });
      }

      // Wire HSL sliders
      document.querySelectorAll('.cg-hsl-slider').forEach((sl: any) => {
        sl.addEventListener('input', () => {
          const range = sl.dataset.range;
          const channel = sl.dataset.channel;
          if (!range || !channel) return;
          const key = 'hsl_' + range;
          if (!state[key]) state[key] = { h: 0, s: 0, l: 0 };
          state[key][channel] = parseInt(sl.value) || 0;
          // Update value display
          const row = sl.closest('.cg-hsl-row');
          if (row) {
            const valEl = row.querySelector('.cg-hsl-val.' + channel);
            if (valEl) valEl.textContent = sl.value;
          }
          scheduleDraw();
        });
      });

      // ── Visual colour wheel helper ──────────────────────────────
      // Reusable: any element with class .cw, data-state-key, and .cw-pointer inside.
      // On click/drag, computes hue/saturation from mouse position and writes to state[stateKey].
      // For CG colours, stores RGB array. For ST hue+sat, stores separate fields.
      function rgb2hsl255(r: number, g: number, b: number): { h: number; s: number; l: number } {
        r /= 255; g /= 255; b /= 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const l = (mx + mn) / 2;
        let h = 0, s = 0;
        if (mx !== mn) {
          const d = mx - mn;
          s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
          if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
          else if (mx === g) h = ((b - r) / d + 2);
          else h = ((r - g) / d + 4);
          h *= 60;
        }
        return { h, s, l };
      }
      function hsl2rgb255(h: number, s: number, l: number): [number, number, number] {
        h /= 360;
        let r: number, g: number, b: number;
        if (s === 0) { r = g = b = l; }
        else {
          const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
          const p = 2 * l - q;
          r = hue2rgb(p, q, h + 1/3);
          g = hue2rgb(p, q, h);
          b = hue2rgb(p, q, h - 1/3);
        }
        return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
      }
      function hue2rgb(p: number, q: number, t: number): number {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      }
      function makeColorWheel(el: HTMLElement, opts: {
        stateKey?: string;        // CG colour: writes state[key] = [r,g,b]
        stHueKey?: string;        // Split toning: writes state[stHueKey] = hue (0-360), state[stSatKey] = sat (0-100)
        stSatKey?: string;
        hslRange?: string;        // HSL mixer: writes state['hsl_' + range] = { h, s, l }
        size?: number;            // diameter (default 100)
      }) {
        const size = opts.size ?? 110;
        const radius = size / 2 - 5;  // pointer stays slightly inside the rim
        const pointer = el.querySelector('.cw-pointer') as SVGCircleElement | null;
        if (!pointer) return;
        function updatePointer(hue: number, sat: number) {
          const a = hue * Math.PI / 180;
          const r = Math.min(1, sat);
          const px = Math.cos(a) * radius * r;
          const py = Math.sin(a) * radius * r;
          pointer!.setAttribute('cx', String(px));
          pointer!.setAttribute('cy', String(py));
        }
        function fromMouse(e: MouseEvent | TouchEvent) {
          const rect = el.getBoundingClientRect();
          const cx = rect.width / 2, cy = rect.height / 2;
          let clientX: number, clientY: number;
          if ('touches' in e && e.touches.length) {
            clientX = e.touches[0].clientX; clientY = e.touches[0].clientY;
          } else if ('clientX' in e) {
            clientX = e.clientX; clientY = e.clientY;
          } else return;
          const x = (clientX - rect.left) - cx;
          const y = (clientY - rect.top) - cy;
          const r = Math.min(1, Math.sqrt(x*x + y*y) / radius);
          let angle = Math.atan2(y, x) * 180 / Math.PI;
          if (angle < 0) angle += 360;
          const hue = angle;
          const sat = r * 100;  // 0-100
          if (opts.stateKey) {
            const [r255, g255, b255] = hsl2rgb255(hue, r, 0.5);
            state[opts.stateKey] = [r255, g255, b255];
          }
          if (opts.stHueKey) {
            (state as any)[opts.stHueKey] = hue;
            (state as any)[opts.stSatKey!] = sat;
            // Update any associated intensity slider label
            const wrap = document.querySelector('.slider[data-key="' + opts.stHueKey + '"]');
            if (wrap) (wrap.querySelector('.val') as HTMLElement).textContent = String(Math.round(hue));
            const wrap2 = document.querySelector('.slider[data-key="' + opts.stSatKey + '"]');
            if (wrap2) (wrap2.querySelector('.val') as HTMLElement).textContent = String(Math.round(sat));
          }
          if (opts.hslRange) {
            const key = 'hsl_' + opts.hslRange;
            const cur = (state as any)[key] || { h: 0, s: 0, l: 0 };
            // Map absolute wheel position to slider scale (-100..100)
            // Each range has a centre hue; wheel position relative to centre = hue shift.
            const HSL_RANGES: Record<string, number> = {
              red: 0, orange: 30, yellow: 60, green: 120,
              aqua: 180, blue: 240, purple: 270, magenta: 300,
            };
            const centre = HSL_RANGES[opts.hslRange] ?? 0;
            let delta = hue - centre;
            // Normalise to -180..+180
            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;
            // ±180° = ±100 hue shift on slider; cap at slider range
            const sliderH = Math.max(-100, Math.min(100, delta / 1.8));
            // Saturation: distance from centre, 0..1 → 0..100 (only positive = boost)
            const sliderS = r * 100;
            (state as any)[key] = { h: sliderH, s: sliderS, l: cur.l ?? 0 };
            // Update HSL slider labels and hidden input values
            const row = document.querySelector('.cg-hsl-row[data-range="' + opts.hslRange + '"]');
            if (row) {
              const hSpan = row.querySelector('.cg-hsl-val.h');
              const sSpan = row.querySelector('.cg-hsl-val.s');
              if (hSpan) hSpan.textContent = String(Math.round(sliderH));
              if (sSpan) sSpan.textContent = String(Math.round(sliderS));
              const hInput = row.querySelector('input[data-channel="h"]') as HTMLInputElement | null;
              const sInput = row.querySelector('input[data-channel="s"]') as HTMLInputElement | null;
              if (hInput) hInput.value = String(Math.round(sliderH));
              if (sInput) sInput.value = String(Math.round(sliderS));
            }
          }
          updatePointer(hue, r);
          scheduleDraw();
        }
        function initFromState() {
          let hue = 0, sat = 0;
          if (opts.stateKey) {
            const c = (state as any)[opts.stateKey] || [128, 128, 128];
            const hsl = rgb2hsl255(c[0], c[1], c[2]);
            hue = hsl.h; sat = hsl.s;
          } else if (opts.stHueKey) {
            hue = (state as any)[opts.stHueKey] ?? 0;
            sat = ((state as any)[opts.stSatKey!] ?? 0) / 100;
          } else if (opts.hslRange) {
            // Convert slider values back to wheel position (inverse mapping)
            const k = (state as any)['hsl_' + opts.hslRange] || { h: 0, s: 0 };
            const HSL_RANGES: Record<string, number> = {
              red: 0, orange: 30, yellow: 60, green: 120,
              aqua: 180, blue: 240, purple: 270, magenta: 300,
            };
            const centre = HSL_RANGES[opts.hslRange] ?? 0;
            const sliderH = k.h ?? 0;
            const sliderS = k.s ?? 0;
            // slider h = delta / 1.8 → delta = sliderH * 1.8
            const angle = (centre + sliderH * 1.8 + 360) % 360;
            sat = sliderS / 100;
            hue = angle;
          }
          updatePointer(hue, sat);
        }
        let dragging = false;
        el.addEventListener('mousedown', (e: MouseEvent) => { dragging = true; fromMouse(e); e.preventDefault(); });
        window.addEventListener('mousemove', (e: MouseEvent) => { if (dragging) fromMouse(e); });
        window.addEventListener('mouseup', () => { dragging = false; });
        el.addEventListener('touchstart', (e: TouchEvent) => { dragging = true; fromMouse(e); e.preventDefault(); }, { passive: false });
        el.addEventListener('touchmove', (e: TouchEvent) => { if (dragging) fromMouse(e); e.preventDefault(); }, { passive: false });
        el.addEventListener('touchend', () => { dragging = false; });
        // Reset wheel to neutral on double-click
        el.addEventListener('dblclick', () => {
          if (opts.stateKey) (state as any)[opts.stateKey] = [128, 128, 128];
          if (opts.stHueKey) {
            (state as any)[opts.stHueKey] = 0;
            (state as any)[opts.stSatKey!] = 0;
          }
          if (opts.hslRange) {
            const key = 'hsl_' + opts.hslRange;
            (state as any)[key] = { h: 0, s: 0, l: 0 };
          }
          updatePointer(0, 0);
          scheduleDraw();
        });
        initFromState();
      }

      // Wire visual colour wheels for Color Grading
      makeColorWheel(document.getElementById('cw-cg-shadows-colour')!, { stateKey: 'cg_shadows_colour' });
      makeColorWheel(document.getElementById('cw-cg-midtones-colour')!, { stateKey: 'cg_midtones_colour' });
      makeColorWheel(document.getElementById('cw-cg-highlights-colour')!, { stateKey: 'cg_highlights_colour' });
      makeColorWheel(document.getElementById('cw-cg-global-colour')!, { stateKey: 'cg_global_colour' });

      // Wire visual colour wheels for Split Toning (each combines hue+saturation)
      makeColorWheel(document.getElementById('cw-st-shadows')!, { stHueKey: 'st_shadows_hue', stSatKey: 'st_shadows_saturation' });
      makeColorWheel(document.getElementById('cw-st-highlights')!, { stHueKey: 'st_highlights_hue', stSatKey: 'st_highlights_saturation' });

      // Wire visual colour wheels for HSL Mixer (one per range)
      ['red','orange','yellow','green','aqua','blue','purple','magenta'].forEach((rng) => {
        const el = document.getElementById('cw-hsl-' + rng);
        if (el) makeColorWheel(el as HTMLElement, { hslRange: rng });
      });

      // Wire CG mode select
      const cgModeSel = document.getElementById('cg-mode-select') as HTMLSelectElement;
      if (cgModeSel) {
        cgModeSel.addEventListener('change', () => {
          state.cg_mode = cgModeSel.value as 'saturation' | 'luminance';
          scheduleDraw();
        });
      }

      // Expose state on window for preset save/load
      (window as any)._hslData = () => {
        const RANGES = ['red','orange','yellow','green','aqua','blue','purple','magenta'];
        const hsl: Record<string, {h:number;s:number;l:number}> = {};
        for (const range of RANGES) {
          hsl['hsl_' + range] = state['hsl_' + range] ?? { h: 0, s: 0, l: 0 };
        }
        return hsl;
      };
      (window as any)._colorGradingData = () => ({
        shadows_colour: state.cg_shadows_colour ?? [0, 0, 0],
        midtones_colour: state.cg_midtones_colour ?? [0, 0, 0],
        highlights_colour: state.cg_highlights_colour ?? [0, 0, 0],
        global_colour: state.cg_global_colour ?? [0, 0, 0],
        shadows_intensity: state.cg_shadows_intensity ?? 0,
        midtones_intensity: state.cg_midtones_intensity ?? 0,
        highlights_intensity: state.cg_highlights_intensity ?? 0,
        global_intensity: state.cg_global_intensity ?? 0,
        mode: (state.cg_mode as 'saturation' | 'luminance') ?? 'saturation',
      });

      const btnResetRaw = document.getElementById('btn-reset-raw');
      if (btnResetRaw) {
        btnResetRaw.onclick = () => {
          for (const k of RAW_KEYS) {
            state[k] = RAW_DEFAULTS[k];
            const wrap = document.querySelector('.slider[data-key="' + k + '"]');
            if (wrap) {
              const inp = wrap.querySelector('input');
              const valEl = wrap.querySelector('.val');
              if (inp) inp.value = String(RAW_DEFAULTS[k]);
              if (valEl) valEl.textContent = String(RAW_DEFAULTS[k]);
            }
          }
          const lensCb = document.getElementById('raw-lens-on');
          if (lensCb) lensCb.checked = false;
          state.lens_corrections = { enabled: false, remove_baseline_exposure: 0, chromatic_aberration: 0, chromatic_aberration_x: 0, chromatic_aberration_y: 0 };
          document.querySelectorAll('.slider[data-key^="lens_corrections."]').forEach((wrap) => {
            const input = wrap.querySelector('input');
            const valEl = wrap.querySelector('.val');
            const key = wrap.dataset.key || '';
            const nestedKey = key.split('.')[1];
            const v = nestedKey ? (state.lens_corrections || {})[nestedKey] ?? 0 : 0;
            if (input) input.value = String(v);
            if (valEl) valEl.textContent = String(v);
          });
        };
      }
      // Wire the lens checkbox to state
      const lensCbEl = document.getElementById('raw-lens-on');
      if (lensCbEl) {
        lensCbEl.checked = !!state.raw_lens_on;
        lensCbEl.addEventListener('change', () => {
          state.raw_lens_on = lensCbEl.checked ? 1 : 0;
          applyRawPreviewFx();
          scheduleDraw();
          scheduleRawPreviewFetch('lens');
        });
      }


      // Calibration reset
      const btnResetCalib = document.getElementById('btn-reset-calibration');
      if (btnResetCalib) {
        btnResetCalib.onclick = () => {
          state.calibration = { shadow_tint: 0, saturation: 0 };
          document.querySelectorAll(".slider[data-key^=\"calibration.\"]").forEach((wrap) => {
            const input = wrap.querySelector("input");
            const valEl = wrap.querySelector(".val");
            const key = wrap.dataset.key || "";
            const nestedKey = key.split(".")[1];
            const v = nestedKey ? (state.calibration || {})[nestedKey] ?? 0 : 0;
            if (input) input.value = String(v);
            if (valEl) valEl.textContent = String(v);
          });
          scheduleDraw();
        };
      }

      // ---- Crop drag (works on the canvas) ----
      let cropBox = null;       // { x, y, w, h } in canvas pixels
      let dragMode = null;      // 'create' | 'move' | 'nw' | 'ne' | 'sw' | 'se' | null
      let dragOffset = null;
      function getPos(e) {
        const r = canvas.getBoundingClientRect();
        const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
        const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
        return { x: cx * (canvas.width / r.width), y: cy * (canvas.height / r.height) };
      }
      canvas.addEventListener('mousedown', onDown);
      canvas.addEventListener('touchstart', onDown, { passive: false });
      window.addEventListener('mousemove', onMove);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchend', onUp);
      function onDown(e) {

        const p = getPos(e);
        // Hit-test corners of existing cropBox
        if (cropBox) {
          const h = 14;
          const corners = {
            nw: [cropBox.x, cropBox.y],
            ne: [cropBox.x + cropBox.w, cropBox.y],
            sw: [cropBox.x, cropBox.y + cropBox.h],
            se: [cropBox.x + cropBox.w, cropBox.y + cropBox.h],
          };
          for (const [name, [x, y]] of Object.entries(corners)) {
            if (Math.abs(p.x - x) <= h && Math.abs(p.y - y) <= h) {
              dragMode = name;
              e.preventDefault();
              return;
            }
          }
          if (p.x >= cropBox.x && p.x <= cropBox.x + cropBox.w && p.y >= cropBox.y && p.y <= cropBox.y + cropBox.h) {
            dragMode = 'move';
            dragOffset = { dx: p.x - cropBox.x, dy: p.y - cropBox.y };
            e.preventDefault();
            return;
          }
        }
        // Start a new crop
        cropBox = { x: p.x, y: p.y, w: 1, h: 1 };
        dragMode = 'se';
        e.preventDefault();
      }
      function onMove(e) {
        if (!dragMode) return;
        e.preventDefault();
        const p = getPos(e);
        if (dragMode === 'create' || dragMode === 'se') {
          cropBox.w = Math.max(2, p.x - cropBox.x);
          cropBox.h = Math.max(2, p.y - cropBox.y);
        } else if (dragMode === 'nw') {
          cropBox.w += cropBox.x - p.x; cropBox.h += cropBox.y - p.y;
          cropBox.x = p.x; cropBox.y = p.y;
        } else if (dragMode === 'ne') {
          cropBox.w = Math.max(2, p.x - cropBox.x);
          cropBox.h += cropBox.y - p.y; cropBox.y = p.y;
        } else if (dragMode === 'sw') {
          cropBox.w += cropBox.x - p.x; cropBox.x = p.x;
          cropBox.h = Math.max(2, p.y - cropBox.y);
        } else if (dragMode === 'move' && dragOffset) {
          cropBox.x = p.x - dragOffset.dx;
          cropBox.y = p.y - dragOffset.dy;
        }
        clampCrop();
        syncStateCrop();
        draw();
      }
      function onUp() {
        dragMode = null;
        dragOffset = null;
        if (cropBox && (cropBox.w < 8 || cropBox.h < 8)) {
          cropBox = null;
          state.crop = null;
          draw();
        }
      }
      function clampCrop() {
        if (!cropBox) return;
        cropBox.x = Math.max(0, Math.min(canvas.width - 2, cropBox.x));
        cropBox.y = Math.max(0, Math.min(canvas.height - 2, cropBox.y));
        cropBox.w = Math.max(2, Math.min(canvas.width - cropBox.x, cropBox.w));
        cropBox.h = Math.max(2, Math.min(canvas.height - cropBox.y, cropBox.h));
      }
      function syncStateCrop() {

        if (!cropBox) { state.crop = null; return; }
        // Convert canvas-pixel cropBox to source UV. Since canvas aspect ==
        // source aspect in fit mode, canvas-normalized = source-normalized
        // for COORDINATES (x/y/w/h all in [0,1]). The aspect ratio
        // conversion is handled in makeCropAtAspect itself.
        state.crop = {
          x: cropBox.x / canvas.width,
          y: cropBox.y / canvas.height,
          w: cropBox.w / canvas.width,
          h: cropBox.h / canvas.height,
        };
      }

      // Aspect ratio presets
      let currentAspect = null;
      function setAspectPreset(ratio) {
        // ratio = w/h; null = free
        document.querySelectorAll('[data-aspect]').forEach((b) => b.classList.remove('active'));
        const label = ratio === null ? 'free' : (function () {
          // pick the closest standard button label to highlight
          const map = { '1': '1:1', '4/3': '4:3', '3/2': '3:2', '16/9': '16:9' };
          let best = null, bestDiff = Infinity;
          for (const [r, lbl] of Object.entries(map)) {
            const diff = Math.abs(Number(r) - ratio);
            if (diff < bestDiff) { bestDiff = diff; best = lbl; }
          }
          return bestDiff < 0.02 ? best : null;
        })();
        if (label) {
          const btn = document.querySelector('[data-aspect="' + label + '"]');
          if (btn) btn.classList.add('active');
        }
        currentAspect = ratio;
      }
      function makeCropAtAspect() {

        // Compute the source UV region representing a crop with aspect
        // `wByH` (W/H in source pixels), then translate to canvas pixels.
        //
        // The math: a crop with aspect wByH in source pixels means
        //   cropW * sw / (cropH * sh) = wByH
        //   => cropW / cropH = wByH * (sh / sw)
        // For maximum crop fitting inside [0,1]^2 UV, take the smaller of
        // {clamped to 1, full opposite axis}.
        const imgR = canvas.width / canvas.height;
        const wByH = currentAspect || imgR;
        // Source dimensions for UV ratio. canvas aspect == source aspect in
        // fit mode (fitCanvasToArea preserves source aspect), so canvas
        // dimensions can stand in.
        const sourceAspect = imgR;  // sh/sw = canvas.h/canvas.w (same value)
        const uvAspect = wByH * (1 / sourceAspect);  // cropW/cropH in UV
        let cropW, cropH;
        if (uvAspect >= 1.0) {
          // Wider-than-tall in UV (crop is wide). cropH=1 (full), cropW=1/uvAspect.
          cropH = 1.0;
          cropW = 1.0 / uvAspect;
        } else {
          // Taller-than-wide in UV. cropW=1 (full), cropH=uvAspect.
          cropW = 1.0;
          cropH = uvAspect;
        }
        // Centre on source UV.
        const cropX = (1 - cropW) / 2;
        const cropY = (1 - cropH) / 2;
        // Translate to canvas pixels for cropBox (used for overlay + drag).
        cropBox = {
          x: Math.round(cropX * canvas.width),
          y: Math.round(cropY * canvas.height),
          w: Math.round(cropW * canvas.width),
          h: Math.round(cropH * canvas.height),
        };
        syncStateCrop();
      }
      document.querySelectorAll('[data-aspect]').forEach((btn) => {
        btn.addEventListener('click', () => {
  
          const asp = btn.dataset.aspect;
          if (asp === 'free') { setAspectPreset(null); return; }
          const [aw, ah] = asp.split(':').map(Number);
          if (!aw || !ah) return;
          setAspectPreset(aw / ah);
          // ALWAYS reset to a fresh centred crop at this aspect fitted to the
          // FULL image bounds. Earlier behaviour preserved the old crop's
          // size when changing presets, so 4:3 → 16:9 cropped INSIDE the 4:3
          // area instead of replacing it. Now presets replace the crop
          // outright; dragging is still free-form and keeps current crop.
          makeCropAtAspect();
          clampCrop(); syncStateCrop(); draw();
        });
      });
      document.getElementById('btn-clear-crop').onclick = () => {
        cropBox = null; currentAspect = null;
        document.querySelectorAll('[data-aspect]').forEach((b) => b.classList.remove('active'));
        state.crop = null;
        (state as any).straighten = 0;
        setSliderValue('straighten', 0);
        if (webglPipeline) webglPipeline.updateState({ straighten: 0 });
        draw();
      };

      // Straighten slider handler
      const straightenWrap = document.querySelector('.slider[data-key="straighten"]');
      if (straightenWrap) {
        const straightenInput = straightenWrap.querySelector('input') as HTMLInputElement;
        const straightenVal = straightenWrap.querySelector('.val');
        straightenInput.value = String((state as any).straighten || 0);
        straightenVal.textContent = straightenInput.value;
        straightenInput.addEventListener('input', () => {
          const v = parseFloat(straightenInput.value);
          (state as any).straighten = v;
          straightenVal.textContent = v.toFixed(1);
          if (webglPipeline) webglPipeline.updateState({ straighten: v });
          draw();
        });
      }

      // Custom aspect ratio input
      document.getElementById('btn-apply-aspect').addEventListener('click', () => {
        const input = document.getElementById('crop-aspect-input') as HTMLInputElement;
        const val = input.value.trim();
        if (!val) return;
        const parts = val.split(':');
        if (parts.length === 2) {
          const w = parseFloat(parts[0]);
          const h = parseFloat(parts[1]);
          if (w && h && w > 0 && h > 0) {
            currentAspect = w / h;
            makeCropAtAspect();
            clampCrop();
            syncStateCrop();
            draw();
            toast('Aspect ' + val + ' applied');
            return;
          }
        }
        // Try decimal ratio
        const ratio = parseFloat(val);
        if (!isNaN(ratio) && ratio > 0) {
          currentAspect = ratio;
          makeCropAtAspect();
          clampCrop();
          syncStateCrop();
          draw();
          toast('Aspect ' + ratio.toFixed(2) + ':1 applied');
        } else {
          toast('Invalid aspect ratio. Use e.g. 4:5 or 2.39');
        }
      });

      // Update crop dimensions display on every draw
      function updateCropDims() {
        const el = document.getElementById('crop-dims');
        if (!el || !state.crop) { if (el) el.textContent = ''; return; }
        const c = state.crop;
        const imgW = sourceImage.naturalWidth || canvas.width;
        const imgH = sourceImage.naturalHeight || canvas.height;
        const px = Math.round(c.w * imgW);
        const py = Math.round(c.h * imgH);
        const mp = ((px * py) / 1000000).toFixed(1);
        el.textContent = px + ' x ' + py + ' px  (' + mp + ' MP)';
      }
      // Expose for call from draw
      (window as any).updateCropDims = updateCropDims;
      // Call on draw completion
      const _origDraw = draw;
      

      // ---- Compare: hold button (or SPACE) to see the ORIGINAL ----
      // "Lightroom before/after" pattern. Drag = interactive, click = static.
      const btnCompare = document.getElementById('btn-compare');
      const indicatorEl = document.getElementById('compare-indicator');
      let comparing = false;
      function setComparing(v) {
        if (comparing === v) return;
        comparing = v;
        indicatorEl.classList.toggle('visible', v);
        btnCompare.classList.toggle('active', v); btnCompare.setAttribute('aria-pressed', v ? 'true' : 'false');
        draw();
      }
      // mouse / touch — press to compare, release to return
      btnCompare.addEventListener('mousedown', () => setComparing(true));
      btnCompare.addEventListener('touchstart', (e) => { setComparing(true); e.preventDefault(); }, { passive: false });
      const releaseCompare = () => setComparing(false);
      window.addEventListener('mouseup', releaseCompare);
      window.addEventListener('touchend', releaseCompare);
      // Also SPACE while focused (keyboard shortcut)
      btnCompare.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setComparing(true); } });
      btnCompare.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setComparing(false); } });

      // Toast
      const toastEl = document.getElementById('toast');
      let toastT = null;
      function toast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add('visible');
        clearTimeout(toastT);
        toastT = setTimeout(() => toastEl.classList.remove('visible'), 2000);
      }

      // ---- Save → server-side render via sharp ----
      btnSave.onclick = async () => {
        btnSave.disabled = true;
        setStatus('Saving…');
        try {
          const res = await fetch('/api/images/' + imageId + '/edit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ params: { ...state, history: _history, curve: _cvData }, sourceUrl }),
          });
          if (!res.ok) throw new Error(await res.text());
          const data = await res.json();
          setStatus('Saved #' + data.edit.id + ' at ' + new Date(data.edit.created_at + 'Z').toLocaleTimeString() + '. Reloading source…');
          btnRevert.disabled = false;
          toast('Edit saved.');
          // Reload the source from the CORS endpoint so subsequent edits
          // re-fetch from disk. Cache-buster avoids the 5-min browser cache
          // on /source. DO NOT set _resetOnLoad here — that triggers
          // resetAllStateAndUi() on sourceImage.onload, which wipes every
          // slider to zero and visibly shifts the preview after every Save.
          // /source now always serves the original file, so state must be
          // preserved across the reload.
          sourceImage.src = '/api/images/' + imageId + '/source?ts=' + Date.now();
          // Reapply CSS preview approximation after reload (saved state may differ)
          if (typeof applyRawPreviewFx === 'function') applyRawPreviewFx();
        } catch (e) {
          console.error(e);
          setStatus('Save failed: ' + e.message, true);
        } finally {
          btnSave.disabled = false;
        }
      };

      btnRevert.onclick = async () => {
        if (!confirm('Discard all saved edits and revert to the original?')) return;
        btnRevert.disabled = true;
        try {
          const res = await fetch('/api/images/' + imageId + '/edit', { method: 'DELETE' });
          if (!res.ok) throw new Error(await res.text());
          setStatus('Reverted to original. Reloading…');
          toast('Reverted.');
          _resetOnLoad = true;
          sourceImage.src = '/api/images/' + imageId + '/source?ts=' + Date.now();
        } catch (e) {
          setStatus('Revert failed: ' + e.message, true);
          btnRevert.disabled = false;
        }
      };

      // Resize handling
      window.addEventListener('resize', () => {
        if (sourceImage.complete && sourceImage.naturalWidth) {
          fitCanvasToArea();
          draw();
        }
      });

      // ---- Keyboard shortcuts ----
      window.addEventListener('keydown', (e) => {
        // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z = redo
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          undo();
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) {
          e.preventDefault();
          redo();
        }
        // R = rotate 90° CW, Shift+R = rotate 90° CCW
        if (e.key === 'r' || e.key === 'R') {
          if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
          if (e.shiftKey) {
            // Rotate CCW: decrement straighten angle by 90 (mod 360)
            const current = (state as any).straighten || 0;
            const newAngle = current - 90;
            setSliderValue('straighten', newAngle);
            (state as any).straighten = newAngle;
            if (webglPipeline) webglPipeline.updateState({ straighten: newAngle });
            draw();
          } else {
            // Rotate CW: increment straighten angle by 90
            const current = (state as any).straighten || 0;
            const newAngle = current + 90;
            setSliderValue('straighten', newAngle);
            (state as any).straighten = newAngle;
            if (webglPipeline) webglPipeline.updateState({ straighten: newAngle });
            draw();
          }
        }
      });


  // ── Tone Curve ─────────────────────────────────────────────────────────────
  type CVCh = 'rgb'|'r'|'g'|'b';
  const _cvData: Record<CVCh, [number,number][]> = {
    rgb: [[0,0],[255,255]], r: [[0,0],[255,255]], g: [[0,0],[255,255]], b: [[0,0],[255,255]]
  };
  let _cvCh: CVCh = 'rgb';
  let _cvDrag: { idx: number } | null = null;
  (window as any)._cvData = _cvData;

  function _cvS(v: number) { return 10 + v * 200 / 255; }

  function _cvPath(): string {
    const pts = [..._cvData[_cvCh]].sort((a,b) => a[0]-b[0]) as [number,number][];
    if (!pts.length) return '';
    return 'M' + pts.map(([x,y]) => `${_cvS(x)},${_cvS(y)}`).join('L');
  }

  function _cvSync() {
    const pipe = (window as any)._webgl;
    if (!pipe?.ready) return;
    // The GPU curve shader only reads R/G/B LUT samples (uCurveR/G/B), not a
    // master rgb LUT. So when the user is editing the master rgb channel,
    // mirror its curve into the R/G/B channels. If the user later switches to
    // a per-channel mode and edits, the master rgb data is unused for that
    // channel (r/g/b keep their own per-channel curves).
    //
    // IMPORTANT: also MUTATE _cvData.r/g/b so subsequent draw() calls (e.g.
    // from slider tweaks) see the mirrored data and don't revert to flat.
    if (_cvCh === "rgb") {
      _cvData.r = _cvData.rgb.slice();
      _cvData.g = _cvData.rgb.slice();
      _cvData.b = _cvData.rgb.slice();
    }
    pipe.setCurves({ rgb: _cvData.rgb, r: _cvData.r, g: _cvData.g, b: _cvData.b });
    pipe.render();
  }

  function _cvRefresh() {
    const path = document.getElementById('cv-path') as SVGPathElement | null;
    const ptsEl = document.getElementById('cv-pts') as SVGGElement | null;
    const info = document.getElementById('cv-info') as HTMLSpanElement | null;
    if (path) path.setAttribute('d', _cvPath());
    const custom = !isFlat({ rgb: _cvData.rgb, r: _cvData.r, g: _cvData.g, b: _cvData.b });
    if (info) info.textContent = custom ? _cvCh.toUpperCase() : '';
    if (!ptsEl) return;
    ptsEl.innerHTML = '';
    const color = _cvCh === 'rgb' ? '#ddd' : _cvCh === 'r' ? '#f66' : _cvCh === 'g' ? '#6e6' : '#66f';
    for (let i = 0; i < _cvData[_cvCh].length; i++) {
      const [x, y] = _cvData[_cvCh][i];
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(_cvS(x))); c.setAttribute('cy', String(_cvS(y)));
      c.setAttribute('r', '4'); c.setAttribute('fill', color);
      c.setAttribute('stroke', '#111'); c.setAttribute('stroke-width', '1');
      c.setAttribute('data-idx', String(i)); c.style.cursor = 'move';
      ptsEl.appendChild(c);
    }
  }

  function _cvAddPt(sx: number, sy: number): number {
    const x = Math.max(0, Math.min(255, Math.round((sx-10)*255/200)));
    const y = Math.max(0, Math.min(255, Math.round((sy-10)*255/200)));
    _cvData[_cvCh].push([x,y]);
    _cvData[_cvCh].sort((a,b) => a[0]-b[0]);
    const idx = _cvData[_cvCh].findIndex(([px, py]) => px === x && py === y);
    _cvSync(); _cvRefresh();
    return idx;
  }

  function _cvRmPt(idx: number) {
    if (_cvData[_cvCh].length <= 2) return;
    _cvData[_cvCh].splice(idx, 1);
    _cvSync(); _cvRefresh();
  }

  function _cvReset() {
    for (const ch of ['rgb','r','g','b'] as CVCh[]) _cvData[ch] = [[0,0],[255,255]];
    _cvCh = 'rgb';
    document.querySelectorAll('.ch-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.ch-tab[data-cvch="rgb"]')?.classList.add('active');
    _cvSync(); _cvRefresh();
  }
  (window as any)._cvReset = _cvReset;
  (window as any)._cvSync = _cvSync;
  (window as any)._cvRefresh = _cvRefresh;
  (window as any)._cvAddPt = _cvAddPt;
  (window as any)._cvReset = _cvReset;
  (window as any)._cvCh = (): CVCh => _cvCh;
  (window as any).setCvCh = (ch: CVCh) => {
    _cvCh = ch;
    document.querySelectorAll('.ch-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.ch-tab[data-cvch="' + ch + '"]')?.classList.add('active');
    _cvRefresh();
  };

  function _cvInit() {
    const svg = document.getElementById('cv-svg') as SVGSVGElement | null;
    if (!svg) return;
    const r = () => svg.getBoundingClientRect();

    svg.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      const rect = r();
      const sx = (e.clientX - rect.left) * 220 / rect.width;
      const sy = (e.clientY - rect.top) * 220 / rect.height;
      let hit = -1;
      for (let i = 0; i < _cvData[_cvCh].length; i++) {
        const [x,y] = _cvData[_cvCh][i];
        if (Math.abs(_cvS(x)-sx) < 8 && Math.abs(_cvS(y)-sy) < 8) { hit = i; break; }
      }
      if (hit >= 0) {
        _cvDrag = { idx: hit };
      } else {
        const newIdx = _cvAddPt(sx, sy);
        if (newIdx >= 0) _cvDrag = { idx: newIdx };
      }
    });

    window.addEventListener('mousemove', (e: MouseEvent) => {
      if (!_cvDrag) return;
      const rect = r();
      const sx = (e.clientX - rect.left) * 220 / rect.width;
      const sy = (e.clientY - rect.top) * 220 / rect.height;
      const x = Math.max(0, Math.min(255, Math.round((sx-10)*255/200)));
      const y = Math.max(0, Math.min(255, Math.round((sy-10)*255/200)));
      _cvData[_cvCh][_cvDrag.idx] = [x, y];
      _cvData[_cvCh].sort((a,b) => a[0]-b[0]);
      _cvRefresh();
    });

    window.addEventListener('mouseup', () => { if (_cvDrag) { _cvDrag = null; _cvSync(); } });

    svg.addEventListener('dblclick', (e: MouseEvent) => {
      const rect = r();
      const sx = (e.clientX - rect.left) * 220 / rect.width;
      const sy = (e.clientY - rect.top) * 220 / rect.height;
      for (let i = 0; i < _cvData[_cvCh].length; i++) {
        const [x,y] = _cvData[_cvCh][i];
        if (Math.abs(_cvS(x)-sx) < 8 && Math.abs(_cvS(y)-sy) < 8) { _cvRmPt(i); break; }
      }
    });

    document.getElementById('cv-reset')?.addEventListener('click', _cvReset);
    document.querySelectorAll('.ch-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.ch-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        _cvCh = (tab as HTMLElement).dataset.cvch as CVCh;
        _cvRefresh();
      });
    });

    _cvRefresh();
  }

  // ── Histogram ─────────────────────────────────────────────────────────────
  function _histCapture() {
    const canvas = document.getElementById('preview') as HTMLCanvasElement | null;
    const pipe = (window as any)._webgl;
    if (!canvas || !pipe?.ready) return;
    const oc = document.createElement('canvas');
    oc.width = 64; oc.height = 64;
    const ctx = oc.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    const cnts: Record<string, Uint32Array> = {
      r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256)
    };
    for (let i = 0; i < d.length; i += 4) {
      const [rv,gv,bv] = [d[i], d[i+1], d[i+2]];
      cnts.r[rv]++; cnts.g[gv]++; cnts.b[bv]++;
      cnts.l[Math.round(0.299*rv + 0.587*gv + 0.114*bv)]++;
    }
    _histRender(cnts);
  }

  function _histRender(cnts: Record<string, Uint32Array>) {
    const el = document.getElementById('cv-hist') as SVGPathElement | null;
    if (!el) return;
    const ch = _cvCh === 'rgb' ? 'l' : _cvCh;
    const arr = cnts[ch];
    let mx = 1; for (let i = 0; i < 256; i++) if (arr[i] > mx) mx = arr[i];
    const bins = 200, bh = 200, bw = 200;
    let d = `M10,210`;
    for (let i = 0; i < bins; i++) {
      const v = arr[Math.min(255, ((i * 256 / bins) | 0))];
      d += ` L${10 + i*bw/bins},${10 + bh - (v/mx)*bh}`;
    }
    d += ` L${10+bins*bw/bins},210 Z`;
    el.setAttribute('d', d);
  }

  let _histT: ReturnType<typeof setInterval> | null = null;
  function _histStart() { if (!_histT) _histT = setInterval(_histCapture, 300); }
  function _histStop() { if (_histT) { clearInterval(_histT); _histT = null; } }
  window.addEventListener('beforeunload', _histStop);

  // ── Snapshots ─────────────────────────────────────────────────────────────
      function renderSnapshotList() {
        const list = document.getElementById("snapshot-list");
        if (!list) return;
        list.innerHTML = "";
        const snaps: any[] = state.snapshots || [];
        snaps.forEach((s, idx) => {
          const div = document.createElement("div");
          div.style.cssText = "display:flex;gap:4px;align-items:center;padding:3px 6px;background:#1a1a1a;border-radius:4px;cursor:pointer";
          div.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(s.name || "Unnamed")}</span><button data-del-idx="${idx}" style="background:none;border:none;color:#888;cursor:pointer;font-size:0.7rem;padding:0 2px">X</button>`;
          div.querySelector("span")?.addEventListener("click", () => restoreSnapshot(idx));
          div.querySelector("[data-del-idx]")?.addEventListener("click", (e) => { e.stopPropagation(); deleteSnapshot(idx); });
          list.appendChild(div);
        });
      }
      function saveSnapshot() {
        const input = document.getElementById("snapshot-name-input") as HTMLInputElement;
        const name = input?.value?.trim() || ("Snapshot " + ((state.snapshots?.length || 0) + 1));
        const snap = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          name,
          state: JSON.parse(JSON.stringify(state)),
          created_at: new Date().toISOString(),
        };
        if (!state.snapshots) state.snapshots = [];
        state.snapshots.push(snap);
        const input2 = document.getElementById("snapshot-name-input") as HTMLInputElement;
        if (input2) input2.value = "";
        renderSnapshotList();
        toast("Snapshot saved: " + name);
      }
      function restoreSnapshot(idx: number) {
        const snaps: any[] = state.snapshots || [];
        if (!snaps[idx]) return;
        const snap = snaps[idx];
        // Deep merge snapshot state into current state (preserve snapshots array)
        const snapState = JSON.parse(JSON.stringify(snap.state));
        delete snapState.snapshots;
        Object.assign(state, snapState);
        // Re-render all slider UI
        document.querySelectorAll(".slider").forEach((wrap) => {
          const key = wrap.dataset.key;
          const input = wrap.querySelector("input") as HTMLInputElement;
          const valEl = wrap.querySelector(".val");
          if (!key || !input) return;
          const v = getNestedState(state, key);
          input.value = String(v ?? 0);
          if (valEl) valEl.textContent = String(v ?? 0);
        });
        renderSnapshotList();
        scheduleDraw();
        toast("Restored: " + snap.name);
      }
      function deleteSnapshot(idx: number) {
        if (!state.snapshots) return;
        state.snapshots.splice(idx, 1);
        renderSnapshotList();
      }

      // ── Spot Removal ───────────────────────────────────────────────────────────
      let spotMode: "clone" | "heal" | null = null;
      let currentSpot: any = null;
      let isDragging = false;
      const spotOverlay = document.getElementById("spot-overlay-canvas") as HTMLCanvasElement;
      const spotCtx = spotOverlay?.getContext("2d");

      function renderSpotOverlay() {
        if (!spotOverlay || !spotCtx) return;
        const dpr = window.devicePixelRatio || 1;
        spotOverlay.width = spotOverlay.offsetWidth * dpr;
        spotOverlay.height = spotOverlay.offsetHeight * dpr;
        spotCtx.clearRect(0, 0, spotOverlay.width, spotOverlay.height);
        const spots: any[] = state.spot_removals || [];
        spots.forEach((s, i) => {
          const cx = s.x * spotOverlay.offsetWidth;
          const cy = s.y * spotOverlay.offsetHeight;
          const r = s.radius * (spotOverlay.offsetWidth / canvas.offsetWidth);
          const scx = s.srcX * spotOverlay.offsetWidth;
          const scy = s.srcY * spotOverlay.offsetHeight;
          spotCtx.beginPath();
          spotCtx.arc(cx, cy, r, 0, Math.PI * 2);
          spotCtx.strokeStyle = s.mode === "heal" ? "#4af" : "#f84";
          spotCtx.lineWidth = 1.5;
          spotCtx.stroke();
          // Source circle
          spotCtx.beginPath();
          spotCtx.arc(scx, scy, r, 0, Math.PI * 2);
          spotCtx.strokeStyle = "#888";
          spotCtx.setLineDash([3, 3]);
          spotCtx.stroke();
          spotCtx.setLineDash([]);
          // Index label
          spotCtx.fillStyle = s.mode === "heal" ? "#4af" : "#f84";
          spotCtx.font = "9px sans-serif";
          spotCtx.fillText(String(i + 1), cx - 3, cy + 3);
        });
      }

      function addSpot(e: MouseEvent) {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        const spot = {
          x, y,
          radius: Math.round(Math.min(rect.width, rect.height) * 0.03),
          mode: spotMode || "clone",
          srcX: x + 0.05,
          srcY: y + 0.05,
        };
        if (!state.spot_removals) state.spot_removals = [];
        state.spot_removals.push(spot);
        currentSpot = spot;
        isDragging = true;
        renderSpotOverlay();
        renderSpotList();
        scheduleDraw();
      }

      function renderSpotList() {
        const list = document.getElementById("spot-list");
        if (!list) return;
        list.innerHTML = "";
        const spots: any[] = state.spot_removals || [];
        spots.forEach((s, i) => {
          const div = document.createElement("div");
          div.style.cssText = "display:flex;gap:4px;align-items:center;padding:2px 4px;background:#1a1a1a;border-radius:3px;font-size:0.7rem";
          div.innerHTML = `<span style="color:${s.mode === "heal" ? "#4af" : "#f84"};width:30px">${s.mode.charAt(0).toUpperCase()}</span><span style="flex:1">Spot ${i+1} r=${s.radius}</span><button data-idx="${i}" style="background:none;border:none;color:#888;cursor:pointer">X</button>`;
          div.querySelector("[data-idx]")?.addEventListener("click", (e) => {
            const idx = parseInt((e.target as HTMLElement).dataset.idx || "0");
            state.spot_removals.splice(idx, 1);
            renderSpotOverlay();
            renderSpotList();
            scheduleDraw();
          });
          list.appendChild(div);
        });
      }

      // Canvas mouse events for spot removal
      if (canvas) {
        canvas.addEventListener("mousedown", (e) => {
          if (!spotMode) return;
          addSpot(e);
        });
        canvas.addEventListener("mousemove", (e) => {
          if (!isDragging || !currentSpot || !canvas) return;
          const rect = canvas.getBoundingClientRect();
          currentSpot.srcX = (e.clientX - rect.left) / rect.width;
          currentSpot.srcY = (e.clientY - rect.top) / rect.height;
          renderSpotOverlay();
        });
        canvas.addEventListener("mouseup", () => {
          isDragging = false;
          currentSpot = null;
        });
        canvas.addEventListener("mouseleave", () => {
          isDragging = false;
          currentSpot = null;
        });
      }

      // Spot removal mode buttons
      const btnClone = document.getElementById("btn-spot-add-clone");
      const btnHeal = document.getElementById("btn-spot-add-heal");
      const btnResetSpot = document.getElementById("btn-reset-spot");
      const spotModeLabel = document.getElementById("spot-mode-label");
      function setSpotMode(mode: "clone" | "heal" | null) {
        spotMode = mode;
        if (btnClone) btnClone.style.fontWeight = mode === "clone" ? "bold" : "";
        if (btnHeal) btnHeal.style.fontWeight = mode === "heal" ? "bold" : "";
        if (spotModeLabel) spotModeLabel.textContent = mode ? "Click canvas to add " + mode + " spot" : "Click canvas to add spot";
      }
      btnClone?.addEventListener("click", () => setSpotMode(spotMode === "clone" ? null : "clone"));
      btnHeal?.addEventListener("click", () => setSpotMode(spotMode === "heal" ? null : "heal"));
      btnResetSpot?.addEventListener("click", () => {
        state.spot_removals = [];
        renderSpotOverlay();
        renderSpotList();
        scheduleDraw();
      });

      // Snapshot save button
      const btnSnapSave = document.getElementById("btn-snapshot-save");
      btnSnapSave?.addEventListener("click", saveSnapshot);
      const snapInput = document.getElementById("snapshot-name-input");
      snapInput?.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") saveSnapshot();
      });

      // Initial render
      renderSnapshotList();
      renderSpotList();
      if (spotOverlay) {
        window.addEventListener("resize", renderSpotOverlay);
      }

  // ── Boot ───────────────────────────────────────────────────────────────────
  _cvInit();

  // R48 — On reopen: load the saved tone curve into _cvData so the curve UI
  // and canvas both reflect what was saved. state.curve is {rgb,r,g,b} arrays
  // of [x,y] points where x/y are 0..255. _cvData expects the same shape.
  // Must run AFTER _cvData is initialised (line 2916) and _cvInit() (above)
  // has set up the SVG / channel tabs / handlers.
  try {
    const savedCurve = (window.__EDITOR_DATA__?.initialParams?.curve) || state?.curve;
    if (savedCurve && typeof savedCurve === 'object' && window._cvData) {
      const cv = window._cvData;
      ['rgb', 'r', 'g', 'b'].forEach((ch) => {
        if (Array.isArray(savedCurve[ch])) {
          cv[ch] = savedCurve[ch]
            .filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
            .map((p) => [Number(p[0]), Number(p[1])]);
          if (cv[ch].length === 0 || cv[ch][0][0] !== 0) cv[ch].unshift([0, 0]);
          if (cv[ch][cv[ch].length - 1][0] !== 255) cv[ch].push([255, 255]);
          cv[ch].sort((a, b) => a[0] - b[0]);
        }
      });
      // Restore the active channel so the curve tab indicator + display match saved state
      const savedCh = (window.__EDITOR_DATA__?.initialParams?.curveCh) || state?.curveCh;
      if (savedCh && typeof window.setCvCh === 'function') {
        window.setCvCh(savedCh);
      }
      // Push the saved curves into the GPU pipeline and redraw + redraw the SVG
      if (typeof window._cvSync === 'function') window._cvSync();
      if (typeof window._cvRefresh === 'function') window._cvRefresh();
      // Trigger one render so the canvas shows the saved curve straight away
      if (typeof draw === 'function') draw();
    }
  } catch (e) { console.warn('curve hydrate failed', e); }
  _histStart();
      setStatus('Editor ready.');
