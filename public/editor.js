"use strict";
(() => {
  // src/lib/curve.ts
  var _identityLut = null;
  function _getIdentityLut() {
    if (_identityLut) return _identityLut;
    _identityLut = new Float32Array(256);
    for (let i = 0; i < 256; i++) _identityLut[i] = i / 255;
    return _identityLut;
  }
  function buildLut(ch) {
    if (!ch || ch.length === 0) return new Float32Array(_getIdentityLut());
    const pts = [...ch].sort((a, b) => a[0] - b[0]);
    const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
    const lut = new Float32Array(256);
    for (let x = 0; x < 256; x++) {
      if (x <= x0) {
        lut[x] = pts[0][1] / 255;
        continue;
      }
      if (x >= x1) {
        lut[x] = pts[pts.length - 1][1] / 255;
        continue;
      }
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) {
        const mid = lo + hi >> 1;
        if (pts[mid][0] <= x) lo = mid;
        else hi = mid;
      }
      const xLo = pts[lo][0], yLo = pts[lo][1];
      const xHi = pts[hi][0], yHi = pts[hi][1];
      const t = xHi === xLo ? 0 : (x - xLo) / (xHi - xLo);
      lut[x] = (yLo + t * (yHi - yLo)) / 255;
    }
    return lut;
  }
  function isIdentity(ch) {
    if (!ch || ch.length === 0) return true;
    if (ch.length === 2 && ch[0][0] === 0 && ch[0][1] === 0 && ch[1][0] === 255 && ch[1][1] === 255) return true;
    return false;
  }
  function isFlat(curve) {
    return isIdentity(curve?.rgb) && isIdentity(curve?.r) && isIdentity(curve?.g) && isIdentity(curve?.b);
  }
  function applyToneCurveToRgba(data, curve) {
    if (!curve) return;
    const rgbIsIdentity = isIdentity(curve.rgb);
    const rgbLut = rgbIsIdentity ? null : buildLut(curve.rgb);
    const rLut = rgbIsIdentity ? buildLut(curve.r) : rgbLut;
    const gLut = rgbIsIdentity ? buildLut(curve.g) : rgbLut;
    const bLut = rgbIsIdentity ? buildLut(curve.b) : rgbLut;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.max(0, Math.min(255, Math.round(rLut[data[i]] * 255)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(gLut[data[i + 1]] * 255)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(bLut[data[i + 2]] * 255)));
    }
  }

  // src/lib/editor.ts
  var RAW_DEFAULTS = {
    raw_wb_kelvin: 5500,
    raw_wb_tint: 0,
    raw_nr_lum: 0,
    raw_nr_chroma: 0,
    raw_lens_on: 0
  };
  var RAW_KEYS = Object.keys(RAW_DEFAULTS);
  var imageId = window.__EDITOR_DATA__.imageId;
  var sourceUrl = window.__EDITOR_DATA__.sourceUrl;
  var initialParams = window.__EDITOR_DATA__.initialParams;
  var hasExistingEdit = window.__EDITOR_DATA__.hasExistingEdit;
  var rawPreviewEnabled = window.__EDITOR_DATA__.rawPreviewEnabled;
  var statusEl = document.getElementById("status");
  var btnSave = document.getElementById("btn-save");
  var btnRevert = document.getElementById("btn-revert");
  var btnReset = document.getElementById("btn-reset");
  var isIOS = typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var _origCanvas = document.getElementById("preview");
  var canvas = _origCanvas.cloneNode(false);
  _origCanvas.parentNode.replaceChild(canvas, _origCanvas);
  var ctx = null;
  var webglPipeline = null;
  var useWebGL = false;
  var _gl2 = null;
  if (_gl2) {
    useWebGL = true;
  } else {
    ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      statusEl.textContent = "Canvas 2D not supported in this browser.";
      statusEl.classList.add("error");
      throw new Error("no 2d ctx");
    }
    ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) {
      ctx.imageSmoothingQuality = "high";
    }
  }
  var _drawPipelineLoading = null;
  async function loadWebGLPipeline() {
    if (webglPipeline !== null && webglPipeline !== false) return webglPipeline;
    if (!_drawPipelineLoading) {
      _drawPipelineLoading = (async () => {
        try {
          const res = await fetch("/_webgl-pipeline.js");
          if (!res.ok) throw new Error("pipeline not served");
          const code = await res.text();
          const blob = new Blob([code], { type: "application/javascript" });
          const url = URL.createObjectURL(blob);
          const mod = await import(
            /* @vite-ignore */
            url
          );
          if (typeof mod.createWebGLPipeline !== "function") throw new Error("bad module");
          const p = mod.createWebGLPipeline();
          if (!p || !p.init(canvas)) throw new Error("init returned false");
          return p;
        } catch (e) {
          console.warn("WebGL pipeline load failed:", e);
          return false;
        }
      })();
    }
    const result = await _drawPipelineLoading;
    webglPipeline = result;
    window._webgl = webglPipeline;
    window.state = state;
    window.draw = draw;
    window.scheduleDraw = typeof scheduleDraw === "function" ? scheduleDraw : draw;
    return webglPipeline;
  }
  var state = { ...initialParams };
  var lutCache = /* @__PURE__ */ new Map();
  var activeLut = null;
  var _lastLutPreview = null;
  var _lastLutPreviewKey = "";
  var _lutPreviewGeneration = 0;
  var sourceImage = new Image();
  sourceImage.crossOrigin = "anonymous";
  var authoritativePreviewTimer = null;
  var authoritativePreviewUrl = null;
  var authoritativePreviewRequest = 0;
  var authoritativePreviewImage = new Image();
  var authoritativePreviewReady = false;
  var authoritativePreviewKey = "";
  function renderStateKey() {
    const clone = { ...state };
    delete clone.snapshots;
    return JSON.stringify({ params: clone, curve: _cvData });
  }
  function scheduleAuthoritativePreview() {
    clearTimeout(authoritativePreviewTimer);
    const request = ++authoritativePreviewRequest;
    const key = renderStateKey();
    authoritativePreviewTimer = setTimeout(async () => {
      try {
        const r = await fetch("/api/images/" + imageId + "/preview-edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ params: { ...state, curve: _cvData } }) });
        if (!r.ok || request !== authoritativePreviewRequest) return;
        const blob = await r.blob();
        if (!blob.size || request !== authoritativePreviewRequest) return;
        const url = URL.createObjectURL(blob);
        const probe = new Image();
        probe.onload = () => {
          if (!probe.naturalWidth || !probe.naturalHeight || request !== authoritativePreviewRequest) {
            URL.revokeObjectURL(url);
            return;
          }
          const old = authoritativePreviewUrl;
          authoritativePreviewUrl = url;
          authoritativePreviewImage.src = url;
          authoritativePreviewReady = true;
          authoritativePreviewKey = key;
          if (old) URL.revokeObjectURL(old);
          scheduleDraw();
        };
        probe.onerror = () => URL.revokeObjectURL(url);
        probe.src = url;
      } catch (_) {
      }
    }, 250);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      if (typeof applyRawPreviewFx === "function") applyRawPreviewFx();
    });
  }
  function setStatus(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.classList.toggle("error", !!isErr);
    statusEl.classList.toggle("ok", !isErr);
  }
  function computeFilters(opts) {
    const s = state;
    const previewTemp = opts && opts.temp != null ? opts.temp : s.temp;
    const previewTint = opts && opts.tint != null ? opts.tint : s.tint;
    const f = [];
    const exposureStops = s.exposure / 100;
    const expBrightness = Math.pow(2, exposureStops);
    if (s.exposure !== 0) f.push("brightness(" + expBrightness.toFixed(3) + ")");
    if (s.contrast !== 0) f.push("contrast(" + (100 + s.contrast) + "%)");
    if (s.saturation !== 0) f.push("saturate(" + (100 + s.saturation) + "%)");
    if (s.brightness !== 0) f.push("brightness(" + (100 + s.brightness) + "%)");
    if (previewTemp > 0) f.push("sepia(" + Math.min(100, previewTemp * 40) + "%)");
    else if (previewTemp < 0) f.push("hue-rotate(" + Math.max(-180, previewTemp * 30) + "deg)");
    if (previewTint > 0) f.push("hue-rotate(" + Math.min(90, previewTint * 30) + "deg)");
    const shadowBoost = s.shadows / 100;
    const highlightCut = s.highlights / 100;
    if (s.shadows !== 0 || s.highlights !== 0) {
      const tones = (highlightCut - shadowBoost) * 0.2;
      f.push("contrast(" + (100 + tones * 20) + "%)");
      f.push("brightness(" + (100 + (shadowBoost + highlightCut) * 8) + "%)");
    }
    if (s.whites !== 0 || s.blacks !== 0) {
      const ends = (s.whites - s.blacks) / 100;
      f.push("contrast(" + (100 + ends * 12) + "%)");
    }
    return f.join(" ");
  }
  var _sharpenCanvas = document.createElement("canvas");
  var _sharpenCtx = _sharpenCanvas.getContext("2d");
  var _sharpenCacheKey = -1;
  var _sharpenCacheCanvas = null;
  var _drawScheduled = false;
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
    _sharpenCtx.clearRect(0, 0, w, h);
    _sharpenCtx.drawImage(sourceImage, 0, 0, w, h);
    const sharpImg = _sharpenCtx.getImageData(0, 0, w, h);
    const sw = sharpImg.width, sh = sharpImg.height;
    const sd = sharpImg.data;
    const tmp = new Uint8ClampedArray(sd.length);
    for (let y = 0; y < sh; y++) {
      const row = y * sw * 4;
      for (let x = 0; x < sw; x++) {
        const i = row + x * 4;
        let r = 0, g = 0, b = 0, c = 0;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= sw) continue;
          const ni = row + nx * 4;
          r += sd[ni];
          g += sd[ni + 1];
          b += sd[ni + 2];
          c++;
        }
        tmp[i] = r / c;
        tmp[i + 1] = g / c;
        tmp[i + 2] = b / c;
        tmp[i + 3] = sd[i + 3];
      }
    }
    const blur = new Uint8ClampedArray(sd.length);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4;
        let r = 0, g = 0, b = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= sh) continue;
          const ni = (ny * sw + x) * 4;
          r += tmp[ni];
          g += tmp[ni + 1];
          b += tmp[ni + 2];
          c++;
        }
        blur[i] = r / c;
        blur[i + 1] = g / c;
        blur[i + 2] = b / c;
        blur[i + 3] = tmp[i + 3];
      }
    }
    const k = amount / 100;
    for (let i = 0; i < sd.length; i += 4) {
      const dr = sd[i] - blur[i];
      const dg = sd[i + 1] - blur[i + 1];
      const db = sd[i + 2] - blur[i + 2];
      let r = sd[i] + dr * k;
      let g = sd[i + 1] + dg * k;
      let b = sd[i + 2] + db * k;
      if (r < 0) r = 0;
      else if (r > 255) r = 255;
      if (g < 0) g = 0;
      else if (g > 255) g = 255;
      if (b < 0) b = 0;
      else if (b > 255) b = 255;
      sd[i] = r;
      sd[i + 1] = g;
      sd[i + 2] = b;
    }
    _sharpenCtx.putImageData(sharpImg, 0, 0);
    _sharpenCacheKey = amount;
    _sharpenCacheCanvas = _sharpenCanvas;
    return _sharpenCanvas;
  }
  var _origSourceAssign = sourceImage.src;
  sourceImage.addEventListener("load", () => {
    _sharpenCacheKey = -1;
    _sharpenCacheCanvas = null;
  });
  var vignetteEl = document.getElementById("vignette-overlay");
  function applyVignetteOverlay() {
    if (useWebGL) {
      vignetteEl.style.opacity = "0";
      return;
    }
    const v = Number(state.vignette) || 0;
    if (v <= 0) {
      vignetteEl.style.opacity = "0";
      return;
    }
    const o = Math.max(0.05, Math.min(0.85, v / 100 * 0.85));
    vignetteEl.style.opacity = String(o);
  }
  window.applyVignetteOverlay = applyVignetteOverlay;
  var zoomMode = "fit";
  var panX = 0;
  var panY = 0;
  var ZOOM_STORAGE_KEY = "snappydo:zoom:";
  function loadZoomFromHash() {
    try {
      const m = location.hash.match(/z=(fit|100|200|400)/);
      if (m) return m[1];
      const saved = localStorage.getItem(ZOOM_STORAGE_KEY + imageId);
      if (saved && ["fit", "100", "200", "400"].includes(saved)) return saved;
    } catch (e) {
    }
    return "fit";
  }
  function saveZoom(mode) {
    try {
      localStorage.setItem(ZOOM_STORAGE_KEY + imageId, mode);
    } catch (e) {
    }
    if (mode === "fit") {
      history.replaceState(null, "", location.pathname);
    } else {
      history.replaceState(null, "", location.pathname + "#z=" + mode);
    }
  }
  function setZoom(mode, opts) {
    if (!["fit", "100", "200", "400"].includes(mode)) return;
    zoomMode = mode;
    saveZoom(mode);
    panX = 0;
    panY = 0;
    document.querySelectorAll(".zoom-controls button").forEach((b) => {
      b.classList.toggle("active", b.dataset.zoom === mode);
    });
    const wrap = document.getElementById("canvas-wrap");
    if (wrap) wrap.classList.toggle("zoomed", mode !== "fit");
    fitCanvasToArea();
    draw();
    if (!opts || !opts.silent) {
      const ztxt = mode === "fit" ? "fit-to-screen" : mode + "%";
      setStatus("Zoom: " + ztxt + ".");
    }
  }
  function fitCanvasToArea() {
    const area = document.querySelector(".canvas-area");
    ;
    const aw = area ? area.clientWidth : window.innerWidth;
    const ah = area ? area.clientHeight : window.innerHeight;
    if (!sourceImage.width) return;
    let bw, bh;
    if (zoomMode === "fit") {
      const dispScale = Math.min(aw / sourceImage.width, ah / sourceImage.height, 1);
      bw = Math.max(1, Math.round(sourceImage.width * dispScale));
      bh = Math.max(1, Math.round(sourceImage.height * dispScale));
      canvas.width = bw;
      canvas.height = bh;
      canvas.style.width = bw + "px";
      canvas.style.height = bh + "px";
      canvas.style.transform = "";
      canvas.style.position = "";
      canvas.style.left = "";
      canvas.style.top = "";
    } else {
      bw = sourceImage.width;
      bh = sourceImage.height;
      canvas.width = bw;
      canvas.height = bh;
      canvas.style.width = bw + "px";
      canvas.style.height = bh + "px";
      const z = parseInt(zoomMode, 10) / 100;
      if (panX === 0 && panY === 0) {
        const visW2 = bw * z;
        const visH2 = bh * z;
        panX = Math.round((aw - visW2) / 2);
        panY = Math.round((ah - visH2) / 2);
      }
      const visW = bw * z;
      const visH = bh * z;
      panX = Math.max(Math.min(panX, 32), Math.min(aw - visW - 32, 0));
      panY = Math.max(Math.min(panY, 32), Math.min(ah - visH - 32, 0));
      canvas.style.transformOrigin = "0 0";
      canvas.style.left = panX + "px";
      canvas.style.top = panY + "px";
      canvas.style.transform = z === 1 ? "" : "scale(" + z + ")";
    }
    if (ctx && ctx.imageSmoothingQuality !== void 0) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
  }
  function applyLutToRgba(lut, data, mix) {
    const size = lut.size;
    const lutData = lut.data;
    const fs = size - 1;
    const inv = fs / 255;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const rf = r * inv;
      const gf = g * inv;
      const bf = b * inv;
      const r0 = rf | 0, g0 = gf | 0, b0 = bf | 0;
      const r1 = Math.min(size - 1, r0 + 1);
      const g1 = Math.min(size - 1, g0 + 1);
      const b1 = Math.min(size - 1, b0 + 1);
      const dr = rf - r0;
      const dg = gf - g0;
      const db = bf - b0;
      const i000 = ((b0 * size + g0) * size + r0) * 3;
      const i100 = ((b0 * size + g0) * size + r1) * 3;
      const i010 = ((b0 * size + g1) * size + r0) * 3;
      const i110 = ((b0 * size + g1) * size + r1) * 3;
      const i001 = ((b1 * size + g0) * size + r0) * 3;
      const i101 = ((b1 * size + g0) * size + r1) * 3;
      const i011 = ((b1 * size + g1) * size + r0) * 3;
      const i111 = ((b1 * size + g1) * size + r1) * 3;
      const w000 = (1 - dr) * (1 - dg) * (1 - db);
      const w100 = dr * (1 - dg) * (1 - db);
      const w010 = (1 - dr) * dg * (1 - db);
      const w110 = dr * dg * (1 - db);
      const w001 = (1 - dr) * (1 - dg) * db;
      const w101 = dr * (1 - dg) * db;
      const w011 = (1 - dr) * dg * db;
      const w111 = dr * dg * db;
      const ro = lutData[i000] * w000 + lutData[i100] * w100 + lutData[i010] * w010 + lutData[i110] * w110 + lutData[i001] * w001 + lutData[i101] * w101 + lutData[i011] * w011 + lutData[i111] * w111;
      const go = lutData[i000 + 1] * w000 + lutData[i100 + 1] * w100 + lutData[i010 + 1] * w010 + lutData[i110 + 1] * w110 + lutData[i001 + 1] * w001 + lutData[i101 + 1] * w101 + lutData[i011 + 1] * w011 + lutData[i111 + 1] * w111;
      const bo = lutData[i000 + 2] * w000 + lutData[i100 + 2] * w100 + lutData[i010 + 2] * w010 + lutData[i110 + 2] * w110 + lutData[i001 + 2] * w001 + lutData[i101 + 2] * w101 + lutData[i011 + 2] * w011 + lutData[i111 + 2] * w111;
      const imix = 1 - mix;
      data[i] = r * imix + ro * mix + 0.5 | 0;
      data[i + 1] = g * imix + go * mix + 0.5 | 0;
      data[i + 2] = b * imix + bo * mix + 0.5 | 0;
    }
  }
  var lutWorker = null;
  var lutWorkerToken = 0;
  var lutWorkerResolve = null;
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
    const blob = new Blob([code], { type: "application/javascript" });
    lutWorker = new Worker(URL.createObjectURL(blob));
    lutWorker.onmessage = (e) => {
      const msg = e.data;
      if (msg.token !== lutWorkerToken) return;
      if (lutWorkerResolve) {
        const resolve = lutWorkerResolve;
        lutWorkerResolve = null;
        if (msg.error) resolve(null);
        else resolve(new ImageData(msg.data, canvas.width, canvas.height));
      }
    };
    if (activeLut) {
      lutWorker.postMessage({ kind: "lut", data: activeLut.data, size: activeLut.size });
    }
    return lutWorker;
  }
  function applyLutToRgbaAsync(imgData, mix) {
    return new Promise((resolve) => {
      const w = ensureLutWorker();
      lutWorkerToken++;
      lutWorkerResolve = resolve;
      const buf = new Uint8ClampedArray(imgData.data);
      w.postMessage({ kind: "apply", token: lutWorkerToken, data: buf, mix }, [buf.buffer]);
    });
  }
  function applySlidersToRgba(data, s) {
    if (s.exposure === 0 && s.contrast === 0 && s.brightness === 0 && s.saturation === 0 && s.temp === 0 && s.tint === 0) {
      return;
    }
    const expBrightness = Math.pow(2, s.exposure / 100);
    const cMult = (100 + s.contrast) / 100;
    const satMult = (100 + s.saturation) / 100;
    const addBright = (100 + s.brightness) / 100;
    const tempShift = s.temp * 0.3;
    const tintShift = s.tint * 0.2;
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
      data[i] = r < 0 ? 0 : r > 255 ? 255 : r | 0;
      data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g | 0;
      data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b | 0;
    }
  }
  function applyToneControlsToRgba(data, s) {
    const smoothstep = (a, b, x) => {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      let add = 0;
      add += s.shadows / 100 * 0.5 * (1 - smoothstep(0, 0.35, lum)) * 255;
      add += s.highlights / 100 * 0.5 * smoothstep(0.65, 1, lum) * 255;
      add += s.whites / 100 * 0.3 * smoothstep(0.4, 1, lum) * 255;
      add += s.blacks / 100 * 0.3 * (1 - smoothstep(0, 0.6, lum)) * 255;
      data[i] = Math.max(0, Math.min(255, r + add));
      data[i + 1] = Math.max(0, Math.min(255, g + add));
      data[i + 2] = Math.max(0, Math.min(255, b + add));
    }
  }
  function applyDehazeToRgba(data, dehaze) {
    if (!dehaze) return;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const haze = Math.min(r, Math.min(g, b)) / 255;
      const hazeAmount = dehaze * 3e-3 * haze;
      data[i] = Math.max(0, Math.min(255, Math.round((r / 255 - hazeAmount) * 255)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round((g / 255 - hazeAmount) * 255)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round((b / 255 - hazeAmount) * 255)));
    }
  }
  function drawLegacy() {
    if (!sourceImage.complete || !sourceImage.naturalWidth) return;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const authReady = authoritativePreviewReady && authoritativePreviewImage.complete && !!authoritativePreviewImage.naturalWidth && !state.crop && !state.straighten;
    if (authReady && !comparing) {
      ctx.drawImage(authoritativePreviewImage, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      if (state.crop) {
        const c = state.crop;
        const cx = c.x * canvas.width, cy = c.y * canvas.height;
        const cw = c.w * canvas.width, ch = c.h * canvas.height;
        ctx.strokeStyle = "#fafafa";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx, cy, cw, ch);
        const h = 12;
        ctx.fillStyle = "#fafafa";
        [[cx, cy], [cx + cw, cy], [cx, cy + ch], [cx + cw, cy + ch]].forEach(([x, y]) => {
          ctx.fillRect(x - h / 2, y - h / 2, h, h);
        });
      }
      return;
    }
    let previewTemp = state.temp;
    let previewTint = state.tint;
    if (isRawAtRuntime && state.raw_wb_kelvin != null) {
      const deltaK = (state.raw_wb_kelvin - 5500) / 20;
      previewTemp = Math.max(-100, Math.min(100, deltaK));
      previewTint = state.raw_wb_tint != null ? state.raw_wb_tint : 0;
    }
    if (comparing) {
      ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      return;
    }
    if (state.crop) {
      const c = state.crop;
      const cx = c.x * canvas.width, cy = c.y * canvas.height;
      const cw = c.w * canvas.width, ch = c.h * canvas.height;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, canvas.width, cy);
      ctx.fillRect(0, cy, cx, ch);
      ctx.fillRect(cx + cw, cy, canvas.width - cx - cw, ch);
      ctx.fillRect(0, cy + ch, canvas.width, canvas.height);
      ctx.beginPath();
      ctx.rect(cx, cy, cw, ch);
      ctx.clip();
    }
    const hasSliderWork = isIOS && (state.exposure !== 0 || state.contrast !== 0 || state.brightness !== 0 || state.saturation !== 0 || previewTemp !== 0 || previewTint !== 0 || state.highlights !== 0 || state.shadows !== 0 || state.whites !== 0 || state.blacks !== 0);
    const hasSharpen = state.sharpen > 0;
    const hasLut = !!(activeLut && state.lut_id && state.lut_intensity > 0);
    const hasToneCurve = typeof _cvData !== "undefined" && !isFlat(_cvData);
    const hasFilterWork = !isIOS && computeFilters({ temp: previewTemp, tint: previewTint }) !== "";
    const hasDehaze = (state.dehaze || 0) !== 0;
    const needsPixelPass = hasSliderWork || hasLut || hasToneCurve || hasDehaze;
    const needsFullPipeline = hasSharpen || needsPixelPass || hasFilterWork;
    if (!needsFullPipeline) {
      ctx.filter = "none";
      ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
    } else if (isIOS) {
      ctx.filter = "none";
      const drawSource = hasSharpen ? getSharpenedSource(state.sharpen) : sourceImage;
      ctx.drawImage(drawSource, 0, 0, canvas.width, canvas.height);
      if (needsPixelPass) {
        try {
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imgData.data;
          if (hasSliderWork) {
            applySlidersToRgba(data, { ...state, temp: previewTemp, tint: previewTint });
            applyToneControlsToRgba(data, state);
          }
          if (hasToneCurve) applyToneCurveToRgba(imgData.data, _cvData);
          if (hasLut) {
            const mix = Math.max(0, Math.min(1, state.lut_intensity / 100));
            applyLutToRgba(activeLut, data, mix);
          }
          if (hasDehaze) {
            applyDehazeToRgba(data, state.dehaze || 0);
          }
          ctx.putImageData(imgData, 0, 0);
        } catch (e) {
          console.warn("iOS pixel pass failed:", e);
        }
      }
    } else {
      const filters = computeFilters({ temp: previewTemp, tint: previewTint });
      ctx.filter = filters;
      const drawSource = hasSharpen ? getSharpenedSource(state.sharpen) : sourceImage;
      ctx.drawImage(drawSource, 0, 0, canvas.width, canvas.height);
      ctx.filter = "none";
      if (hasToneCurve) {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        applyToneCurveToRgba(imgData.data, _cvData);
        ctx.putImageData(imgData, 0, 0);
      }
      if (hasLut) {
        try {
          const lutPreviewKey = canvas.width + "x" + canvas.height + ":" + state.lut_id;
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          if (_lastLutPreview && _lastLutPreviewKey === lutPreviewKey) {
            ctx.putImageData(_lastLutPreview, 0, 0);
          }
          const mix = Math.max(0, Math.min(1, state.lut_intensity / 100));
          const generation = ++_lutPreviewGeneration;
          applyLutToRgbaAsync(imgData, mix).then((result) => {
            if (!result || generation !== _lutPreviewGeneration) return;
            _lastLutPreview = result;
            _lastLutPreviewKey = lutPreviewKey;
            ctx.putImageData(result, 0, 0);
          });
        } catch (e) {
          console.warn("LUT pass failed:", e);
        }
      } else {
        _lastLutPreview = null;
        _lastLutPreviewKey = "";
      }
      if (hasDehaze) {
        try {
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          applyDehazeToRgba(imgData.data, state.dehaze || 0);
          ctx.putImageData(imgData, 0, 0);
        } catch (e) {
          console.warn("Dehaze pass failed:", e);
        }
      }
    }
    ctx.restore();
    if (state.crop) {
      const c = state.crop;
      const cx = c.x * canvas.width, cy = c.y * canvas.height;
      const cw = c.w * canvas.width, ch = c.h * canvas.height;
      ctx.strokeStyle = "#fafafa";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx, cy, cw, ch);
      const h = 12;
      ctx.fillStyle = "#fafafa";
      [[cx, cy], [cx + cw, cy], [cx, cy + ch], [cx + cw, cy + ch]].forEach(([x, y]) => {
        ctx.fillRect(x - h / 2, y - h / 2, h, h);
      });
    }
  }
  var _webglSourceRef = null;
  var _webglSourceUploaded = false;
  var _webglLutRef = null;
  async function drawWebGL() {
    if (!useWebGL) return false;
    if (webglPipeline === null || webglPipeline === false) {
      if (webglPipeline === null) {
        const p = await loadWebGLPipeline();
        if (!p) {
          ;
          return false;
        }
        webglPipeline = p;
      } else {
        return false;
      }
    }
    if (!sourceImage.complete || !sourceImage.naturalWidth) {
      ;
      return false;
    }
    if (_webglSourceRef !== sourceImage.src) {
      _webglSourceUploaded = false;
      _webglSourceRef = sourceImage.src;
    }
    if (!_webglSourceUploaded) {
      webglPipeline.setSource(sourceImage);
      _webglSourceUploaded = true;
    }
    if (comparing) {
      webglPipeline.updateState({
        exposure: 0,
        contrast: 0,
        brightness: 0,
        saturation: 0,
        temp: 0,
        tint: 0,
        sharpen: 0,
        lut_id: 0,
        lut_intensity: 0,
        vignette: 0,
        highlights: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
        straighten: 0,
        cropX: 0,
        cropY: 0,
        cropW: 0,
        cropH: 0,
        dehaze: 0,
        lens_corrections: { enabled: false, remove_baseline_exposure: 0, chromatic_aberration: 0, chromatic_aberration_x: 0, chromatic_aberration_y: 0 },
        calibration: { shadow_tint: 0, saturation: 0 }
      });
      webglPipeline.setGrain({ amount: 0, size: 25 });
      webglPipeline.setSplitToning({ shadows_hue: 0, shadows_saturation: 0, highlights_hue: 0, highlights_saturation: 0, balance: 0 });
      webglPipeline.setHsl({}, null);
      webglPipeline.setCurves({
        rgb: [[0, 0], [255, 255]],
        r: [[0, 0], [255, 255]],
        g: [[0, 0], [255, 255]],
        b: [[0, 0], [255, 255]]
      });
      webglPipeline.render();
      return true;
    }
    if (activeLut && _webglLutRef !== activeLut) {
      webglPipeline.setLut(activeLut);
      _webglLutRef = activeLut;
    }
    let previewTemp = state.temp;
    let previewTint = state.tint;
    if (isRawAtRuntime && state.raw_wb_kelvin != null) {
      const deltaK = (state.raw_wb_kelvin - 5500) / 20;
      previewTemp = Math.max(-100, Math.min(100, deltaK));
      previewTint = state.raw_wb_tint != null ? state.raw_wb_tint : 0;
    }
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
      dehaze: state.dehaze ?? 0,
      lens_corrections: state.lens_corrections ?? {
        enabled: false,
        remove_baseline_exposure: 0,
        chromatic_aberration: 0,
        chromatic_aberration_x: 0,
        chromatic_aberration_y: 0
      },
      calibration: state.calibration ?? { shadow_tint: 0, saturation: 0 },
      straighten: state.straighten ?? 0,
      cropX: state.crop?.x ?? 0,
      cropY: state.crop?.y ?? 0,
      cropW: state.crop?.w ?? 0,
      cropH: state.crop?.h ?? 0
    });
    webglPipeline.setCurves({
      rgb: _cvData.rgb,
      r: _cvData.r,
      g: _cvData.g,
      b: _cvData.b
    });
    const RANGES = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"];
    const hslData = {};
    for (const range of RANGES) {
      const key = "hsl_" + range;
      hslData[key] = {
        h: state[key]?.h ?? 0,
        s: state[key]?.s ?? 0,
        l: state[key]?.l ?? 0
      };
    }
    const colorGrading = {
      shadows_colour: state.cg_shadows_colour ?? [0, 0, 0],
      midtones_colour: state.cg_midtones_colour ?? [0, 0, 0],
      highlights_colour: state.cg_highlights_colour ?? [0, 0, 0],
      global_colour: state.cg_global_colour ?? [0, 0, 0],
      shadows_intensity: state.cg_shadows_intensity ?? 0,
      midtones_intensity: state.cg_midtones_intensity ?? 0,
      highlights_intensity: state.cg_highlights_intensity ?? 0,
      global_intensity: state.cg_global_intensity ?? 0,
      mode: state.cg_mode ?? "saturation"
    };
    webglPipeline.setHsl(hslData, colorGrading);
    webglPipeline.setSplitToning({
      shadows_hue: state.st_shadows_hue ?? 0,
      shadows_saturation: state.st_shadows_saturation ?? 0,
      highlights_hue: state.st_highlights_hue ?? 0,
      highlights_saturation: state.st_highlights_saturation ?? 0,
      balance: state.st_balance ?? 0
    });
    webglPipeline.setGrain({
      amount: state.grain_amount ?? 0,
      size: state.grain_size ?? 25
    });
    webglPipeline.render();
    return true;
  }
  try {
    if (window.updateCropDims) window.updateCropDims();
  } catch (e) {
  }
  function drawCropOverlayDom() {
    let overlay = document.getElementById("crop-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "crop-overlay";
      overlay.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:4;";
      canvas.parentNode.appendChild(overlay);
    }
    overlay.innerHTML = "";
    if (!state.crop) return;
    const c = state.crop;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const x = c.x * cw, y = c.y * ch, w = c.w * cw, h = c.h * ch;
    const dim = "position:absolute;background:rgba(0,0,0,0.55);";
    overlay.appendChild(Object.assign(document.createElement("div"), { style: dim + "left:0;top:0;width:" + cw + "px;height:" + y + "px;" }));
    overlay.appendChild(Object.assign(document.createElement("div"), { style: dim + "left:0;top:" + y + "px;width:" + x + "px;height:" + h + "px;" }));
    overlay.appendChild(Object.assign(document.createElement("div"), { style: dim + "left:" + (x + w) + "px;top:" + y + "px;width:" + (cw - x - w) + "px;height:" + h + "px;" }));
    overlay.appendChild(Object.assign(document.createElement("div"), { style: dim + "left:0;top:" + (y + h) + "px;width:" + cw + "px;height:" + (ch - y - h) + "px;" }));
    overlay.appendChild(Object.assign(document.createElement("div"), { style: "position:absolute;left:" + x + "px;top:" + y + "px;width:" + w + "px;height:" + h + "px;border:1.5px solid #fafafa;box-sizing:border-box;" }));
    const hs = 12;
    const handleStyle = "position:absolute;background:#fafafa;width:" + hs + "px;height:" + hs + "px;";
    [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([hx, hy]) => {
      const d = document.createElement("div");
      d.style.cssText = handleStyle + "left:" + (hx - hs / 2) + "px;top:" + (hy - hs / 2) + "px;";
      overlay.appendChild(d);
    });
  }
  function applyRawPreviewFx() {
    if (!canvas) return;
    const lum = Number(state.raw_nr_lum) || 0;
    const chr = Number(state.raw_nr_chroma) || 0;
    const lens = !!state.raw_lens_on;
    const blurPx = (lum + chr) / 200 * 2.5;
    const filt = [];
    if (blurPx > 0.05) filt.push("blur(" + blurPx.toFixed(2) + "px)");
    if (lens) filt.push("brightness(1.03)");
    canvas.style.filter = filt.length ? filt.join(" ") : "";
    const badge = document.getElementById("lens-corrections-badge");
    if (badge) badge.style.display = lens ? "inline-block" : "none";
  }
  var _webglWarned = false;
  var _webglFailed = false;
  function draw() {
    if (!sourceImage.complete || !sourceImage.naturalWidth) return;
    if (useWebGL && !_webglFailed) {
      drawWebGL().then((ok) => {
        if (!ok) {
          if (!_webglWarned) {
            setStatus("WebGL pipeline unavailable, using 2D fallback.", true);
            _webglWarned = true;
          }
          _webglFailed = true;
          useWebGL = false;
          drawLegacy();
        }
        applyVignetteOverlay();
        drawCropOverlayDom();
        try {
          if (window.updateCropDims) window.updateCropDims();
        } catch (e) {
        }
      }).catch((err) => {
        console.warn("drawWebGL threw, falling back to legacy:", err);
        if (!_webglWarned) {
          setStatus("WebGL pipeline failed, using 2D fallback.", true);
          _webglWarned = true;
        }
        _webglFailed = true;
        useWebGL = false;
        try {
          drawLegacy();
        } catch (e2) {
          console.error("drawLegacy also failed:", e2);
        }
        applyVignetteOverlay();
        drawCropOverlayDom();
        try {
          if (window.updateCropDims) window.updateCropDims();
        } catch (e) {
        }
      });
      return;
    }
    drawLegacy();
    applyVignetteOverlay();
    drawCropOverlayDom();
    try {
      if (window.updateCropDims) window.updateCropDims();
    } catch (e) {
    }
  }
  var _resetOnLoad = false;
  var SLIDER_KEYS = ["exposure", "contrast", "brightness", "highlights", "shadows", "whites", "blacks", "saturation", "temp", "tint", "sharpen", "vignette", "lut_intensity", "cg_shadows_intensity", "cg_midtones_intensity", "cg_highlights_intensity", "cg_global_intensity", ...RAW_KEYS];
  var MAX_HISTORY = 50;
  var _history = [];
  var _historyIndex = -1;
  var _ignoreHistory = false;
  function pushHistory(label, snapshot) {
    if (_ignoreHistory) return;
    if (_historyIndex >= 0) {
      const last = _history[_historyIndex];
      let same = true;
      for (const k of Object.keys(snapshot)) {
        if (JSON.stringify(last.snapshot[k]) !== JSON.stringify(snapshot[k])) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
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
  function _applyHistoryEntry(idx) {
    const entry = _history[idx];
    if (!entry) return;
    _ignoreHistory = true;
    const snap = entry.snapshot;
    for (const k of SLIDER_KEYS) {
      if (snap[k] !== void 0) {
        state[k] = snap[k];
        const wrap = document.querySelector(".slider[data-key= + k + ]");
        if (wrap) {
          const inp = wrap.querySelector("input");
          const valEl = wrap.querySelector(".val");
          if (inp) inp.value = String(snap[k]);
          if (valEl) valEl.textContent = String(snap[k]);
        }
      }
    }
    if (snap.crop !== void 0) {
      state.crop = snap.crop;
      if (snap.crop) {
        const c = snap.crop;
        cropBox = {
          x: c.x * canvas.width,
          y: c.y * canvas.height,
          w: c.w * canvas.width,
          h: c.h * canvas.height
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
    const panel = document.getElementById("history-list");
    if (!panel) return;
    panel.innerHTML = "";
    const start = Math.max(0, _historyIndex - 14);
    const visible = _history.slice(start, start + 20);
    visible.forEach((entry, i) => {
      const globalIdx = start + i;
      const div = document.createElement("div");
      div.className = "hist-entry" + (globalIdx === _historyIndex ? " active" : "");
      const t = new Date(entry.ts);
      const timeStr = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      div.innerHTML = "<span class=hist-time>" + timeStr + "</span><span class=hist-label>" + entry.label + "</span>";
      div.addEventListener("click", () => {
        _historyIndex = globalIdx;
        _applyHistoryEntry(globalIdx);
      });
      panel.appendChild(div);
    });
    const undoBtn = document.getElementById("btn-history-undo");
    const redoBtn = document.getElementById("btn-history-redo");
    if (undoBtn) undoBtn.disabled = _historyIndex <= 0;
    if (redoBtn) redoBtn.disabled = _historyIndex >= _history.length - 1;
  }
  async function autoTone() {
    if (!useWebGL || !webglPipeline || !sourceImage.complete) {
      setSliderValue("exposure", 15);
      setSliderValue("contrast", 10);
      setSliderValue("highlights", -20);
      setSliderValue("shadows", 20);
      draw();
      return;
    }
    try {
      let percentile2 = function(hist, pct) {
        let acc = 0;
        const target = total * pct;
        for (let v = 0; v < 256; v++) {
          acc += hist[v];
          if (acc >= target) return v;
        }
        return 255;
      }, findPoint2 = function(hist, clip) {
        let acc = 0;
        for (let v = 0; v < 256; v++) {
          acc += hist[v];
          if (acc >= total * clip) return v;
        }
        return 255;
      };
      var percentile = percentile2, findPoint = findPoint2;
      const size = 64;
      const offscreen = document.createElement("canvas");
      offscreen.width = size;
      offscreen.height = size;
      const octx = offscreen.getContext("2d");
      if (!octx) return;
      octx.drawImage(sourceImage, 0, 0, size, size);
      const imgData = octx.getImageData(0, 0, size, size);
      const data = imgData.data;
      const histR = new Uint32Array(256);
      const histG = new Uint32Array(256);
      const histB = new Uint32Array(256);
      for (let i = 0; i < data.length; i += 4) {
        histR[data[i]]++;
        histG[data[i + 1]]++;
        histB[data[i + 2]]++;
      }
      const total = size * size;
      const loR = percentile2(histR, 5e-3), hiR = percentile2(histR, 0.995);
      const loG = percentile2(histG, 5e-3), hiG = percentile2(histG, 0.995);
      const loB = percentile2(histB, 5e-3), hiB = percentile2(histB, 0.995);
      const lo = Math.min(loR, loG, loB) / 255;
      const hi = Math.max(hiR, hiG, hiB) / 255;
      const blackClip = 5e-3;
      const whiteClip = 5e-3;
      const blackR = findPoint2(histR, blackClip);
      const blackG = findPoint2(histG, blackClip);
      const blackB = findPoint2(histB, blackClip);
      const whiteR = percentile2(histR, 1 - whiteClip);
      const whiteG = percentile2(histG, 1 - whiteClip);
      const whiteB = percentile2(histB, 1 - whiteClip);
      const avgBlack = (blackR + blackG + blackB) / 3;
      const avgWhite = (whiteR + whiteG + whiteB) / 3;
      const midRange = (avgWhite - avgBlack) / 255;
      const targetMid = 0.45;
      const exposure = Math.round((128 - avgBlack) / 128 * 50);
      const exposureVal = Math.max(-200, Math.min(200, exposure));
      const targetRange = 0.84;
      const actualRange = (avgWhite - avgBlack) / 255;
      const contrastVal = Math.round((targetRange / actualRange - 1) * 50);
      const contrastAdjust = Math.max(-50, Math.min(50, contrastVal));
      const highlightsVal = avgWhite > 230 ? Math.round(-(avgWhite - 230) * 1.5) : 0;
      const highlightsAdjust = Math.max(-100, Math.min(100, highlightsVal));
      const shadowsVal = avgBlack < 15 ? Math.round((15 - avgBlack) * 2) : 0;
      const shadowsAdjust = Math.max(-100, Math.min(100, shadowsVal));
      _ignoreHistory = true;
      setSliderValue("exposure", exposureVal);
      setSliderValue("contrast", contrastAdjust);
      setSliderValue("highlights", highlightsAdjust);
      setSliderValue("shadows", shadowsAdjust);
      state.exposure = exposureVal;
      state.contrast = contrastAdjust;
      state.highlights = highlightsAdjust;
      state.shadows = shadowsAdjust;
      _ignoreHistory = false;
      pushHistory("Auto Tone", state);
      draw();
    } catch (e) {
      console.warn("autoTone failed:", e);
    }
  }
  var _rawPreviewTimer = null;
  var _rawPreviewInFlight = null;
  var _lastRawPreviewHash = null;
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
      nr_chroma: Number(state.raw_nr_chroma) || 0
    };
    const hashKey = JSON.stringify(body);
    if (hashKey === _lastRawPreviewHash) return;
    _lastRawPreviewHash = hashKey;
    if (_rawPreviewInFlight) {
      try {
        _rawPreviewInFlight.abort();
      } catch {
      }
    }
    const ctrl = new AbortController();
    _rawPreviewInFlight = ctrl;
    setStatus("RAW preview rendering\u2026");
    try {
      const r = await fetch("/api/images/" + imageId + "/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        setStatus("RAW preview failed: " + (err.error || r.statusText), true);
        return;
      }
      const data = await r.json();
      const url = data.url + (data.url.includes("?") ? "&" : "?") + "v=" + data.hash;
      sourceImage.src = url;
      setStatus("RAW preview " + (data.cached ? "loaded from cache." : "rendered."));
    } catch (e) {
      if (e && e.name === "AbortError") return;
      setStatus("RAW preview error: " + (e && e.message ? e.message : e), true);
    }
  }
  var isRawAtRuntime = document.getElementById("section-raw") !== null;
  if (isRawAtRuntime) {
    document.querySelectorAll(".color-wb").forEach((el) => el.style.display = "none");
  }
  function resetAllStateAndUi() {
    for (const k of SLIDER_KEYS) state[k] = 0;
    state.crop = null;
    cropBox = null;
    currentAspect = null;
    state.preset_id = void 0;
    state.lut_id = 0;
    activeLut = null;
    const presetSelEl = document.getElementById("preset-select");
    if (presetSelEl) presetSelEl.value = "";
    const lutSelEl = document.getElementById("lut-select");
    if (lutSelEl) lutSelEl.value = "";
    if (typeof updateDeletePresetButton === "function") updateDeletePresetButton();
    document.querySelectorAll(".slider").forEach((wrap) => {
      const input = wrap.querySelector("input");
      const valEl = wrap.querySelector(".val");
      if (input) input.value = 0;
      if (valEl) valEl.textContent = "0";
    });
    document.querySelectorAll("[data-aspect]").forEach((b) => b.classList.remove("active"));
  }
  sourceImage.onload = () => {
    fitCanvasToArea();
    _sharpenCacheKey = -1;
    if (_resetOnLoad) {
      _resetOnLoad = false;
      resetAllStateAndUi();
    }
    applyVignetteOverlay();
    draw();
    const zoomTxt = zoomMode === "fit" ? "" : " (" + zoomMode + "%)";
    setStatus("Loaded " + sourceImage.width + "x" + sourceImage.height + ", display " + canvas.width + "x" + canvas.height + zoomTxt + ".");
  };
  sourceImage.onerror = () => setStatus("Image load failed.", true);
  sourceImage.src = sourceUrl;
  zoomMode = loadZoomFromHash();
  setZoom(zoomMode, { silent: true });
  document.querySelectorAll(".zoom-controls button").forEach((btn) => {
    btn.addEventListener("click", () => setZoom(btn.dataset.zoom));
  });
  var ZOOM_ORDER = ["fit", "100", "200", "400"];
  var areaEl = document.querySelector(".canvas-area");
  if (areaEl) {
    areaEl.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      let idx = ZOOM_ORDER.indexOf(zoomMode);
      if (idx < 0) idx = 0;
      if (e.deltaY < 0) idx = Math.min(idx + 1, ZOOM_ORDER.length - 1);
      else idx = Math.max(idx - 1, 0);
      setZoom(ZOOM_ORDER[idx]);
    }, { passive: false });
  }
  var dragging = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var panStartX = 0;
  var panStartY = 0;
  canvas.addEventListener("mousedown", (e) => {
    if (zoomMode === "fit") return;
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    e.preventDefault();
  });
  function applyPanTransform() {
    if (zoomMode === "fit") return;
    const z = parseInt(zoomMode, 10) / 100;
    const aw = areaEl ? areaEl.clientWidth : window.innerWidth;
    const ah = areaEl ? areaEl.clientHeight : window.innerHeight;
    const visW = canvas.width * z;
    const visH = canvas.height * z;
    panX = Math.max(Math.min(panX, 32), Math.min(aw - visW - 32, 0));
    panY = Math.max(Math.min(panY, 32), Math.min(ah - visH - 32, 0));
    canvas.style.transformOrigin = "0 0";
    canvas.style.left = panX + "px";
    canvas.style.top = panY + "px";
    canvas.style.transform = z === 1 ? "" : "scale(" + z + ")";
  }
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    applyPanTransform();
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
  });
  var pinchStartDist = 0;
  var pinchStartZoomMode = "fit";
  var pinchStartPanX = 0;
  var pinchStartPanY = 0;
  var pinchMidStartX = 0;
  var pinchMidStartY = 0;
  function touchDist(a, b) {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.hypot(dx, dy);
  }
  function touchMid(a, b) {
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }
  function continuousZoomToMode(factor) {
    const order = ZOOM_ORDER;
    const current = zoomMode === "fit" ? 0 : parseInt(zoomMode, 10);
    const want = current * factor;
    let best = order[0];
    let bestDelta = Infinity;
    for (const m of order) {
      const v = m === "fit" ? 0 : parseInt(m, 10);
      const d = Math.abs(v - want);
      if (d < bestDelta) {
        bestDelta = d;
        best = m;
      }
    }
    return best;
  }
  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      if (zoomMode === "fit") return;
      const t = e.touches[0];
      dragging = true;
      dragStartX = t.clientX;
      dragStartY = t.clientY;
      panStartX = panX;
      panStartY = panY;
    } else if (e.touches.length === 2) {
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
  canvas.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1 && dragging) {
      e.preventDefault();
      const t = e.touches[0];
      panX = panStartX + (t.clientX - dragStartX);
      panY = panStartY + (t.clientY - dragStartY);
      applyPanTransform();
    } else if (e.touches.length === 2) {
      e.preventDefault();
      const dist = touchDist(e.touches[0], e.touches[1]);
      if (pinchStartDist < 1) return;
      const factor = dist / pinchStartDist;
      const newMode = continuousZoomToMode(factor);
      if (newMode !== zoomMode) {
        setZoom(newMode);
        const mid = touchMid(e.touches[0], e.touches[1]);
        const dx = mid.x - pinchMidStartX;
        const dy = mid.y - pinchMidStartY;
        panX = pinchStartPanX + dx;
        panY = pinchStartPanY + dy;
        applyPanTransform();
      } else {
        const mid = touchMid(e.touches[0], e.touches[1]);
        const dx = mid.x - pinchMidStartX;
        const dy = mid.y - pinchMidStartY;
        panX = pinchStartPanX + dx;
        panY = pinchStartPanY + dy;
        applyPanTransform();
      }
    }
  }, { passive: false });
  canvas.addEventListener("touchend", (e) => {
    if (e.touches.length === 0) {
      dragging = false;
      pinchStartDist = 0;
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      dragging = true;
      dragStartX = t.clientX;
      dragStartY = t.clientY;
      panStartX = panX;
      panStartY = panY;
      pinchStartDist = 0;
    }
  });
  canvas.addEventListener("touchcancel", () => {
    dragging = false;
    pinchStartDist = 0;
  });
  var PRESET_SLIDER_KEYS = ["exposure", "contrast", "brightness", "highlights", "shadows", "whites", "blacks", "saturation", "temp", "tint", "sharpen", "vignette", "lut_intensity", "cg_shadows_intensity", "cg_midtones_intensity", "cg_highlights_intensity", "cg_global_intensity", ...RAW_KEYS];
  async function loadPresets() {
    try {
      const res = await fetch("/api/presets");
      if (!res.ok) return;
      const { presets } = await res.json();
      const sel = document.getElementById("preset-select");
      if (!sel) return;
      sel.innerHTML = '<option value="">No preset</option>';
      for (const p of presets) {
        const opt = document.createElement("option");
        opt.value = String(p.id);
        opt.textContent = (p.kind === "builtin" ? "\u2605 " : "") + p.name;
        opt.dataset.kind = p.kind;
        if (p.kind === "user" && p.username) opt.dataset.username = p.username;
        sel.appendChild(opt);
      }
      window.__snappydoPresets = presets;
      if (typeof updateDeletePresetButton === "function") updateDeletePresetButton();
    } catch (e) {
      console.warn("loadPresets failed", e);
    }
    try {
      const sel2 = document.getElementById("preset-select");
      if (sel2 && state && state.preset_id) {
        sel2.value = String(state.preset_id);
        if (typeof updateDeletePresetButton === "function") updateDeletePresetButton();
      }
    } catch {
    }
  }
  function sortLutsForDisplay(luts) {
    const rank = { builtin: 0, uploaded: 1, synthesised: 2 };
    return [...luts].sort((a, b) => {
      const ra = rank[a.kind] ?? 9;
      const rb = rank[b.kind] ?? 9;
      if (ra !== rb) return ra - rb;
      return String(a.name).localeCompare(String(b.name));
    });
  }
  async function loadLuts() {
    try {
      const res = await fetch("/api/luts");
      if (!res.ok) return;
      const { luts } = await res.json();
      const sorted = sortLutsForDisplay(luts || []);
      const sel = document.getElementById("lut-select");
      if (!sel) return;
      sel.innerHTML = '<option value="">No LUT</option>';
      for (const l of sorted) {
        const opt = document.createElement("option");
        opt.value = String(l.id);
        let prefix = "";
        if (l.kind === "builtin") prefix = "\u2605 ";
        else if (l.kind === "synthesised") prefix = "\u2726 ";
        opt.textContent = prefix + l.name;
        sel.appendChild(opt);
      }
      window.__snappydoLuts = luts;
    } catch (e) {
      console.warn("loadLuts failed", e);
    }
  }
  async function fetchLutData(lutId) {
    if (lutCache.has(lutId)) {
      const cached2 = lutCache.get(lutId);
      if (lutWorker) {
        lutWorker.postMessage({ kind: "lut", data: cached2.data, size: cached2.size });
      }
      return cached2;
    }
    const res = await fetch("/api/luts/" + lutId);
    if (!res.ok) throw new Error("failed to fetch LUT");
    const json = await res.json();
    const u8 = new Uint8Array(json.data);
    const cached = { size: json.size, data: u8 };
    lutCache.set(lutId, cached);
    if (lutWorker) {
      lutWorker.postMessage({ kind: "lut", data: cached.data, size: cached.size });
    }
    return cached;
  }
  var lutSelect = document.getElementById("lut-select");
  if (lutSelect) {
    lutSelect.addEventListener("change", async () => {
      const v = lutSelect.value;
      state.lut_id = v ? Number(v) : 0;
      const presetSelectEl = document.getElementById("preset-select");
      if (state.lut_id && state.preset_id) {
        const activePreset = (window.__snappydoPresets || []).find((x) => Number(x.id) === Number(state.preset_id));
        const presetLutId = activePreset && activePreset.params && activePreset.params.lut_id ? Number(activePreset.params.lut_id) : 0;
        if (presetLutId > 0) {
          const presetName = activePreset ? activePreset.name : "Preset " + state.preset_id;
          if (presetSelectEl) presetSelectEl.value = "";
          state.preset_id = void 0;
          updateDeletePresetButton();
          setStatus('Removed preset "' + presetName + '" because it includes a LUT and you changed the LUT.', false);
        }
      }
      if (state.lut_id) {
        if (!state.lut_intensity) {
          state.lut_intensity = 80;
          const intensityInput = document.querySelector("#slider-lut-intensity input");
          const intensityVal = document.querySelector("#slider-lut-intensity .val");
          if (intensityInput) intensityInput.value = "80";
          if (intensityVal) intensityVal.textContent = "80";
        }
        try {
          activeLut = await fetchLutData(state.lut_id);
          const meta = (window.__snappydoLuts || []).find((x) => Number(x.id) === state.lut_id);
        } catch (e) {
          setStatus("Failed to load LUT.", true);
          state.lut_id = 0;
          lutSelect.value = "";
          activeLut = null;
        }
      } else {
        activeLut = null;
      }
      draw();
    });
  }
  function updateDeletePresetButton() {
    const btn = document.getElementById("btn-delete-preset");
    const sel = document.getElementById("preset-select");
    if (!btn || !sel) return;
    const v = sel.value;
    if (!v) {
      btn.style.display = "none";
      return;
    }
    const meta = (window.__snappydoPresets || []).find((x) => String(x.id) === String(v));
    btn.style.display = meta && meta.kind === "user" ? "inline-flex" : "none";
  }
  var presetSelect = document.getElementById("preset-select");
  if (presetSelect) {
    presetSelect.addEventListener("change", () => {
      updateDeletePresetButton();
      const id = Number(presetSelect.value);
      if (!id) {
        const hadPreset = !!state.preset_id;
        state.preset_id = void 0;
        if (hadPreset) setStatus("Preset removed \u2014 keeping current edits.", false);
        return;
      }
      const p = (window.__snappydoPresets || []).find((x) => x.id === id);
      if (!p) return;
      const newLutId = p.params && p.params.lut_id ? Number(p.params.lut_id) : 0;
      const prevLutId = state.lut_id || 0;
      const willReplaceLut = newLutId > 0 && newLutId !== prevLutId;
      const presetHasLut = newLutId > 0;
      applyPresetToState(id, p.params);
      if (willReplaceLut && prevLutId > 0) {
        const newLutMeta = (window.__snappydoLuts || []).find((x) => Number(x.id) === newLutId);
        const prevLutMeta = (window.__snappydoLuts || []).find((x) => Number(x.id) === prevLutId);
        const newName = newLutMeta ? newLutMeta.name : "LUT " + newLutId;
        const prevName = prevLutMeta ? prevLutMeta.name : "LUT " + prevLutId;
        setStatus('Replaced LUT "' + prevName + '" with preset "' + newName + '"', false);
      } else if (!presetHasLut && prevLutId > 0) {
        const prevLutMeta = (window.__snappydoLuts || []).find((x) => Number(x.id) === prevLutId);
        const prevName = prevLutMeta ? prevLutMeta.name : "LUT " + prevLutId;
        setStatus('Preset loaded \u2014 keeping manual LUT "' + prevName + '"', false);
      }
    });
  }
  var btnDeletePreset = document.getElementById("btn-delete-preset");
  if (btnDeletePreset) {
    btnDeletePreset.addEventListener("click", async () => {
      const sel = document.getElementById("preset-select");
      if (!sel) return;
      const meta = (window.__snappydoPresets || []).find((x) => String(x.id) === String(sel.value));
      if (!meta || meta.kind !== "user") return;
      if (!confirm('Delete preset "' + meta.name + '"? This cannot be undone.')) return;
      btnDeletePreset.disabled = true;
      const original = btnDeletePreset.textContent;
      btnDeletePreset.textContent = "Deleting\u2026";
      try {
        const res = await fetch("/api/presets/" + meta.id, {
          method: "DELETE",
          credentials: "same-origin"
        });
        if (res.status === 204) {
          setStatus("Preset deleted: " + meta.name);
          sel.value = "";
          await loadPresets();
          updateDeletePresetButton();
        } else if (res.status === 403) {
          setStatus("Cannot delete built-in preset", true);
        } else {
          const err = await res.json().catch(() => ({}));
          setStatus("Delete preset failed: " + (err.error || res.status), true);
        }
      } catch (e) {
        setStatus("Delete preset error: " + (e?.message || String(e)), true);
      } finally {
        btnDeletePreset.disabled = false;
        btnDeletePreset.textContent = original;
      }
    });
  }
  var btnSavePreset = document.getElementById("btn-save-preset");
  if (btnSavePreset) {
    btnSavePreset.addEventListener("click", async () => {
      const name = window.prompt("Name for this preset:", "");
      if (!name) return;
      btnSavePreset.disabled = true;
      try {
        const snapshot = snapshotPreset();
        const res = await fetch("/api/presets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, params: snapshot })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setStatus("Save preset failed: " + (err.error || res.statusText), true);
          return;
        }
        setStatus("Preset saved: " + name, false);
        await loadPresets();
        if (typeof updateDeletePresetButton === "function") updateDeletePresetButton();
      } finally {
        btnSavePreset.disabled = false;
      }
    });
  }
  loadPresets();
  loadLuts().then(() => {
    if (state.lut_id) {
      const sel = document.getElementById("lut-select");
      if (sel) sel.value = String(state.lut_id);
      fetchLutData(state.lut_id).then((d) => {
        activeLut = d;
        draw();
      }).catch(() => {
        activeLut = null;
      });
    }
  });
  var PRESET_EXTRA_KEYS = [
    // Split Toning
    "st_balance",
    "st_shadows_hue",
    "st_shadows_saturation",
    "st_highlights_hue",
    "st_highlights_saturation",
    // Color Grading colours + mode
    "cg_mode",
    "cg_shadows_colour",
    "cg_midtones_colour",
    "cg_highlights_colour",
    "cg_global_colour",
    // HSL ranges
    "hsl_red",
    "hsl_orange",
    "hsl_yellow",
    "hsl_green",
    "hsl_aqua",
    "hsl_blue",
    "hsl_purple",
    "hsl_magenta",
    // Grain + dehaze
    "grain_amount",
    "grain_size",
    "dehaze"
  ];
  var HSL_RANGES_LIST = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"];
  function snapshotPreset() {
    const snapshot = {};
    const all = [];
    all.push(...typeof PRESET_SLIDER_KEYS !== "undefined" ? PRESET_SLIDER_KEYS : []);
    all.push(...PRESET_EXTRA_KEYS);
    for (const k of all) {
      if (k in state && state[k] !== void 0) {
        snapshot[k] = state[k];
      }
    }
    snapshot.lut_id = state.lut_id || 0;
    snapshot.lut_intensity = state.lut_intensity || 0;
    const cv = window._cvData;
    if (cv && cv.rgb && cv.r && cv.g && cv.b) {
      snapshot.curve = {
        rgb: cv.rgb.map((p) => [p[0], p[1]]),
        r: cv.r.map((p) => [p[0], p[1]]),
        g: cv.g.map((p) => [p[0], p[1]]),
        b: cv.b.map((p) => [p[0], p[1]])
      };
    }
    if (typeof window._cvCh === "function") {
      snapshot.curveCh = window._cvCh();
    }
    return snapshot;
  }
  function setWheelPointer(wheelId, hue, sat) {
    const el = document.getElementById(wheelId);
    if (!el) return;
    const pointer = el.querySelector(".cw-pointer");
    if (!pointer) return;
    const radius = (Number(pointer.getAttribute("r")) || 8) > 0 ? el.getBoundingClientRect().width / 2 - 5 : 50;
    const a = hue * Math.PI / 180;
    const r = Math.min(1, sat);
    const px = Math.cos(a) * radius * r;
    const py = Math.sin(a) * radius * r;
    pointer.setAttribute("cx", String(px));
    pointer.setAttribute("cy", String(py));
  }
  function applyPresetToState(presetId, params) {
    if (!params) return;
    if (presetId != null) state.preset_id = Number(presetId);
    const _prevLutId = state.lut_id || 0;
    const _presetHasLut = !!(params.lut_id && Number(params.lut_id));
    for (const k of PRESET_SLIDER_KEYS) {
      if (k in params) setSliderValue(k, Number(params[k]) || 0);
    }
    for (const k of PRESET_EXTRA_KEYS) {
      if (!(k in params)) continue;
      const val = params[k];
      if (typeof val === "number") {
        state[k] = val;
        const wrap = document.querySelector('.slider[data-key="' + k + '"]');
        if (wrap) {
          const inp = wrap.querySelector("input");
          if (inp) inp.value = String(val);
          const v = wrap.querySelector(".val");
          if (v) v.textContent = String(val);
        }
        if (k.startsWith("hsl_")) {
          const range = k.slice(4);
          const row = document.querySelector('.cg-hsl-row[data-range="' + range + '"]');
          if (row) {
            const hSpan = row.querySelector(".cg-hsl-val.h");
            if (hSpan) hSpan.textContent = String(Math.round(val));
          }
        }
      } else if (Array.isArray(val)) {
        state[k] = val;
      }
    }
    for (const range of HSL_RANGES_LIST) {
      const v = params["hsl_" + range];
      if (v && typeof v === "object") {
        state["hsl_" + range] = { h: v.h || 0, s: v.s || 0, l: v.l || 0 };
        const row = document.querySelector('.cg-hsl-row[data-range="' + range + '"]');
        if (row) {
          const hInput = row.querySelector('input[data-channel="h"]');
          const sInput = row.querySelector('input[data-channel="s"]');
          const lInput = row.querySelector('input[data-channel="l"]');
          if (hInput) hInput.value = String(Math.round(v.h || 0));
          if (sInput) sInput.value = String(Math.round(v.s || 0));
          if (lInput) lInput.value = String(Math.round(v.l || 0));
          const hSpan = row.querySelector(".cg-hsl-val.h");
          if (hSpan) hSpan.textContent = String(Math.round(v.h || 0));
          const sSpan = row.querySelector(".cg-hsl-val.s");
          if (sSpan) sSpan.textContent = String(Math.round(v.s || 0));
          const lSpan = row.querySelector(".cg-hsl-val.l");
          if (lSpan) lSpan.textContent = String(Math.round(v.l || 0));
        }
      }
    }
    const CG_WHEELS = [
      { id: "cw-cg-shadows-colour", key: "cg_shadows_colour" },
      { id: "cw-cg-midtones-colour", key: "cg_midtones_colour" },
      { id: "cw-cg-highlights-colour", key: "cg_highlights_colour" },
      { id: "cw-cg-global-colour", key: "cg_global_colour" }
    ];
    for (const w of CG_WHEELS) {
      const c = state[w.key];
      if (Array.isArray(c)) {
        const hsl = rgb2hsl255(c[0] ?? 128, c[1] ?? 128, c[2] ?? 128);
        setWheelPointer(w.id, hsl.h, hsl.s / 100);
      }
    }
    const ST_WHEELS = [
      { id: "cw-st-shadows", h: "st_shadows_hue", s: "st_shadows_saturation" },
      { id: "cw-st-highlights", h: "st_highlights_hue", s: "st_highlights_saturation" }
    ];
    for (const w of ST_WHEELS) {
      const hue = state[w.h] ?? 0;
      const sat = state[w.s] ?? 0;
      setWheelPointer(w.id, hue, sat / 100);
    }
    const HSL_RANGES = {
      red: 0,
      orange: 30,
      yellow: 60,
      green: 120,
      aqua: 180,
      blue: 240,
      purple: 270,
      magenta: 300
    };
    for (const range of HSL_RANGES_LIST) {
      const k = "hsl_" + range;
      const v = state[k] || { h: 0, s: 0 };
      const centre = HSL_RANGES[range] ?? 0;
      const angle = (centre + (v.h || 0) * 1.8 + 360) % 360;
      setWheelPointer("cw-hsl-" + range, angle, (v.s || 0) / 100);
    }
    if (params.curve && typeof params.curve === "object") {
      const cv = window._cvData;
      if (cv) {
        ["rgb", "r", "g", "b"].forEach((ch) => {
          if (Array.isArray(params.curve[ch])) {
            cv[ch] = params.curve[ch].filter(
              (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
            );
            if (cv[ch].length === 0 || cv[ch][0][0] !== 0) cv[ch].unshift([0, 0]);
            if (cv[ch][cv[ch].length - 1][0] !== 255) cv[ch].push([255, 255]);
            cv[ch].sort((a, b) => a[0] - b[0]);
          }
        });
        if (params.curveCh && typeof window.setCvCh === "function") {
          window.setCvCh(params.curveCh);
        }
        if (typeof window._cvSync === "function") window._cvSync();
        if (typeof window._cvRefresh === "function") window._cvRefresh();
      }
    }
    let newLutId = 0;
    if (_presetHasLut) {
      newLutId = Number(params.lut_id);
      state.lut_id = newLutId;
      const lutSelEl = document.getElementById("lut-select");
      if (lutSelEl) lutSelEl.value = String(newLutId);
      fetchLutData(newLutId).then((d) => {
        activeLut = d;
        _sharpenCacheKey = -1;
        applyVignetteOverlay();
        draw();
      }).catch(() => {
        activeLut = null;
      });
    } else if (_prevLutId) {
      newLutId = _prevLutId;
      const lutSelEl = document.getElementById("lut-select");
      if (lutSelEl) lutSelEl.value = String(_prevLutId);
    } else {
      state.lut_id = 0;
      const lutSelEl = document.getElementById("lut-select");
      if (lutSelEl) lutSelEl.value = "";
      activeLut = null;
    }
    applyVignetteOverlay();
    _sharpenCacheKey = -1;
    draw();
    setStatus("Preset loaded");
  }
  function setNestedState(state2, key, value) {
    if (key.includes(".")) {
      const parts = key.split(".");
      let obj = state2;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
    } else {
      state2[key] = value;
    }
  }
  function getNestedState(state2, key) {
    if (key.includes(".")) {
      const parts = key.split(".");
      let obj = state2;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) return void 0;
        obj = obj[parts[i]];
      }
      return obj[parts[parts.length - 1]];
    }
    return state2[key];
  }
  document.querySelectorAll(".slider").forEach((wrap) => {
    const key = wrap.dataset.key;
    const input = wrap.querySelector("input");
    const valEl = wrap.querySelector(".val");
    const initVal = getNestedState(state, key);
    input.value = String(initVal ?? 0);
    valEl.textContent = String(initVal ?? 0);
    input.addEventListener("input", () => {
      const prevVal = getNestedState(state, key);
      const v = Number(input.value);
      if (v !== prevVal && !_ignoreHistory) {
        const snap = JSON.parse(JSON.stringify(state));
        pushHistory((document.querySelector('.slider[data-key="' + key + '"] label')?.textContent || key) + " " + v, snap);
      }
      setNestedState(state, key, v);
      valEl.textContent = v;
      if (key === "sharpen") {
        _sharpenCacheKey = -1;
        if (v > 0) getSharpenedSource(v);
      }
      applyVignetteOverlay();
      applyRawPreviewFx();
      clearTimeout(authoritativePreviewTimer);
      authoritativePreviewRequest++;
      authoritativePreviewReady = false;
      scheduleDraw();
      if (RAW_KEYS.includes(key)) scheduleRawPreviewFetch("slider:" + key);
    });
    input.addEventListener("change", () => {
      scheduleAuthoritativePreview();
    });
  });
  function resetKeys(keys) {
    keys.forEach((k) => {
      state[k] = 0;
    });
    document.querySelectorAll(".slider").forEach((wrap) => {
      if (keys.includes(wrap.dataset.key)) {
        const input = wrap.querySelector("input");
        const valEl = wrap.querySelector(".val");
        input.value = 0;
        valEl.textContent = "0";
      }
    });
    draw();
  }
  function setSliderValue(key, v) {
    state[key] = v;
    const wrap = document.querySelector('.slider[data-key="' + key + '"]');
    if (wrap) {
      const input = wrap.querySelector("input");
      const valEl = wrap.querySelector(".val");
      if (input) input.value = v;
      if (valEl) valEl.textContent = v;
    }
  }
  btnReset.onclick = () => {
    ["exposure", "contrast", "brightness", "highlights", "shadows", "whites", "blacks", "saturation", "temp", "tint", "sharpen", "vignette", "lut_intensity", "cg_shadows_intensity", "cg_midtones_intensity", "cg_highlights_intensity", "cg_global_intensity"].forEach((k) => {
      state[k] = 0;
    });
    state.straighten = 0;
    setSliderValue("straighten", 0);
    if (webglPipeline) webglPipeline.updateState({ straighten: 0 });
    if (isRawAtRuntime) {
      for (const k of RAW_KEYS) {
        state[k] = RAW_DEFAULTS[k];
        const wrap = document.querySelector('.slider[data-key="' + k + '"]');
        if (wrap) {
          const inp = wrap.querySelector("input");
          const valEl = wrap.querySelector(".val");
          if (inp) inp.value = String(RAW_DEFAULTS[k]);
          if (valEl) valEl.textContent = String(RAW_DEFAULTS[k]);
        }
      }
      const lensCb = document.getElementById("raw-lens-on");
      if (lensCb) lensCb.checked = false;
    }
    document.querySelectorAll(".slider").forEach((wrap) => {
      const input = wrap.querySelector("input");
      const valEl = wrap.querySelector(".val");
      input.value = 0;
      valEl.textContent = "0";
    });
    state.crop = null;
    state.lut_id = 0;
    const lutSel = document.getElementById("lut-select");
    if (lutSel) lutSel.value = "";
    activeLut = null;
    if (typeof window._cvReset === "function") window._cvReset();
    resetKeys(["dehaze", "st_balance", "grain_amount", "grain_size"]);
    resetStWheels();
    resetCgKeys();
    draw();
  };
  document.getElementById("btn-reset-light").onclick = () => resetKeys(["exposure", "contrast", "brightness"]);
  document.getElementById("btn-auto-tone").onclick = () => autoTone();
  document.getElementById("btn-history-undo").onclick = () => undo();
  document.getElementById("btn-history-redo").onclick = () => redo();
  document.getElementById("btn-reset-tone").onclick = () => resetKeys(["highlights", "shadows", "whites", "blacks"]);
  document.getElementById("btn-reset-color").onclick = () => resetKeys(["saturation", "temp", "tint"]);
  document.getElementById("btn-reset-fx").onclick = () => {
    resetKeys(["sharpen", "vignette", "dehaze", "st_balance", "grain_amount", "grain_size"]);
    resetStWheels();
    resetCgKeys();
    draw();
  };
  var btnResetCg = document.getElementById("btn-reset-cg");
  if (btnResetCg) btnResetCg.onclick = () => resetCgKeys();
  var btnResetSt = document.getElementById("btn-reset-st");
  if (btnResetSt) btnResetSt.onclick = () => {
    resetKeys(["st_balance"]);
    resetStWheels();
    draw();
  };
  var btnResetHsl = document.getElementById("btn-reset-hsl");
  if (btnResetHsl) btnResetHsl.onclick = () => {
    resetCgKeys();
    draw();
  };
  document.querySelectorAll(".cw").forEach((wheel) => {
    if (wheel.querySelector(".cw-reset-btn")) return;
    const btn = document.createElement("button");
    btn.className = "cw-reset-btn";
    btn.textContent = "\xD7";
    btn.title = "Reset colour";
    wheel.appendChild(btn);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const pointer = wheel.querySelector(".cw-pointer");
      if (pointer) {
        pointer.setAttribute("cx", "0");
        pointer.setAttribute("cy", "0");
      }
      const stateKey = wheel.dataset.stateKey;
      const stHue = wheel.dataset.stHue;
      const stSat = wheel.dataset.stSat;
      const hslRange = wheel.dataset.hslRange;
      if (stateKey) {
        window.state[stateKey] = [128, 128, 128];
      }
      if (stHue && stSat) {
        window.state[stHue] = 0;
        window.state[stSat] = 0;
        const wrap1 = document.querySelector('.slider[data-key="' + stHue + '"]');
        if (wrap1) {
          const sl = wrap1.querySelector("input");
          if (sl) sl.value = "0";
          const val = wrap1.querySelector(".val");
          if (val) val.textContent = "0";
        }
        const wrap2 = document.querySelector('.slider[data-key="' + stSat + '"]');
        if (wrap2) {
          const sl = wrap2.querySelector("input");
          if (sl) sl.value = "0";
          const val = wrap2.querySelector(".val");
          if (val) val.textContent = "0";
        }
      }
      if (hslRange) {
        window.state["hsl_" + hslRange] = { h: 0, s: 0, l: 0 };
      }
      if (typeof scheduleDraw === "function") scheduleDraw();
      else if (typeof draw === "function") draw();
    });
  });
  function resetWheelPointer(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    const pointer = el.querySelector(".cw-pointer");
    if (pointer) {
      pointer.setAttribute("cx", "0");
      pointer.setAttribute("cy", "0");
    }
  }
  function resetCgKeys() {
    const RANGES = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"];
    for (const range of RANGES) {
      state["hsl_" + range] = { h: 0, s: 0, l: 0 };
      const row = document.querySelector('.cg-hsl-row[data-range="' + range + '"]');
      if (row) {
        row.querySelectorAll(".cg-hsl-slider").forEach((sl) => {
          sl.value = "0";
        });
        row.querySelectorAll(".cg-hsl-val").forEach((sp) => {
          sp.textContent = "0";
        });
      }
      resetWheelPointer("cw-hsl-" + range);
    }
    state.cg_shadows_colour = [128, 128, 128];
    state.cg_midtones_colour = [128, 128, 128];
    state.cg_highlights_colour = [128, 128, 128];
    state.cg_global_colour = [128, 128, 128];
    state.cg_shadows_intensity = 0;
    state.cg_midtones_intensity = 0;
    state.cg_highlights_intensity = 0;
    state.cg_global_intensity = 0;
    state.cg_mode = "saturation";
    resetWheelPointer("cw-cg-shadows-colour");
    resetWheelPointer("cw-cg-midtones-colour");
    resetWheelPointer("cw-cg-highlights-colour");
    resetWheelPointer("cw-cg-global-colour");
    const modeSel = document.getElementById("cg-mode-select");
    if (modeSel) modeSel.value = "saturation";
    ["cg_shadows_intensity", "cg_midtones_intensity", "cg_highlights_intensity", "cg_global_intensity"].forEach((k) => {
      const sl = document.querySelector('[data-key="' + k + '"] input[type="range"]');
      const val = document.querySelector('[data-key="' + k + '"] .val');
      if (sl) {
        sl.value = "0";
        if (val) val.textContent = "0";
      }
    });
    if (typeof drawWebGL === "function") drawWebGL();
    if (typeof draw === "function") draw();
  }
  function resetStWheels() {
    state.st_shadows_hue = 0;
    state.st_shadows_saturation = 0;
    state.st_highlights_hue = 0;
    state.st_highlights_saturation = 0;
    resetWheelPointer("cw-st-shadows");
    resetWheelPointer("cw-st-highlights");
    ["st_shadows_hue", "st_shadows_saturation", "st_highlights_hue", "st_highlights_saturation"].forEach((k) => {
      const sl = document.querySelector('[data-key="' + k + '"] input[type="range"]');
      const val = document.querySelector('[data-key="' + k + '"] .val');
      if (sl) {
        sl.value = "0";
        if (val) val.textContent = "0";
      }
    });
  }
  document.querySelectorAll(".cg-hsl-slider").forEach((sl) => {
    sl.addEventListener("input", () => {
      const range = sl.dataset.range;
      const channel = sl.dataset.channel;
      if (!range || !channel) return;
      const key = "hsl_" + range;
      if (!state[key]) state[key] = { h: 0, s: 0, l: 0 };
      state[key][channel] = parseInt(sl.value) || 0;
      const row = sl.closest(".cg-hsl-row");
      if (row) {
        const valEl = row.querySelector(".cg-hsl-val." + channel);
        if (valEl) valEl.textContent = sl.value;
      }
      scheduleDraw();
    });
  });
  function rgb2hsl255(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s, l };
  }
  function hsl2rgb255(h, s, l) {
    h /= 360;
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  function makeColorWheel(el, opts) {
    const size = opts.size ?? 110;
    const radius = size / 2 - 5;
    const pointer = el.querySelector(".cw-pointer");
    if (!pointer) return;
    function updatePointer(hue, sat) {
      const a = hue * Math.PI / 180;
      const r = Math.min(1, sat);
      const px = Math.cos(a) * radius * r;
      const py = Math.sin(a) * radius * r;
      pointer.setAttribute("cx", String(px));
      pointer.setAttribute("cy", String(py));
    }
    function fromMouse(e) {
      const rect = el.getBoundingClientRect();
      const cx = rect.width / 2, cy = rect.height / 2;
      let clientX, clientY;
      if ("touches" in e && e.touches.length) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else if ("clientX" in e) {
        clientX = e.clientX;
        clientY = e.clientY;
      } else return;
      const x = clientX - rect.left - cx;
      const y = clientY - rect.top - cy;
      const r = Math.min(1, Math.sqrt(x * x + y * y) / radius);
      let angle = Math.atan2(y, x) * 180 / Math.PI;
      if (angle < 0) angle += 360;
      const hue = angle;
      const sat = r * 100;
      if (opts.stateKey) {
        const [r255, g255, b255] = hsl2rgb255(hue, r, 0.5);
        state[opts.stateKey] = [r255, g255, b255];
      }
      if (opts.stHueKey) {
        state[opts.stHueKey] = hue;
        state[opts.stSatKey] = sat;
        const wrap = document.querySelector('.slider[data-key="' + opts.stHueKey + '"]');
        if (wrap) wrap.querySelector(".val").textContent = String(Math.round(hue));
        const wrap2 = document.querySelector('.slider[data-key="' + opts.stSatKey + '"]');
        if (wrap2) wrap2.querySelector(".val").textContent = String(Math.round(sat));
      }
      if (opts.hslRange) {
        const key = "hsl_" + opts.hslRange;
        const cur = state[key] || { h: 0, s: 0, l: 0 };
        const HSL_RANGES = {
          red: 0,
          orange: 30,
          yellow: 60,
          green: 120,
          aqua: 180,
          blue: 240,
          purple: 270,
          magenta: 300
        };
        const centre = HSL_RANGES[opts.hslRange] ?? 0;
        let delta = hue - centre;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        const sliderH = Math.max(-100, Math.min(100, delta / 1.8));
        const sliderS = r * 100;
        state[key] = { h: sliderH, s: sliderS, l: cur.l ?? 0 };
        const row = document.querySelector('.cg-hsl-row[data-range="' + opts.hslRange + '"]');
        if (row) {
          const hSpan = row.querySelector(".cg-hsl-val.h");
          const sSpan = row.querySelector(".cg-hsl-val.s");
          if (hSpan) hSpan.textContent = String(Math.round(sliderH));
          if (sSpan) sSpan.textContent = String(Math.round(sliderS));
          const hInput = row.querySelector('input[data-channel="h"]');
          const sInput = row.querySelector('input[data-channel="s"]');
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
        const c = state[opts.stateKey] || [128, 128, 128];
        const hsl = rgb2hsl255(c[0], c[1], c[2]);
        hue = hsl.h;
        sat = hsl.s;
      } else if (opts.stHueKey) {
        hue = state[opts.stHueKey] ?? 0;
        sat = (state[opts.stSatKey] ?? 0) / 100;
      } else if (opts.hslRange) {
        const k = state["hsl_" + opts.hslRange] || { h: 0, s: 0 };
        const HSL_RANGES = {
          red: 0,
          orange: 30,
          yellow: 60,
          green: 120,
          aqua: 180,
          blue: 240,
          purple: 270,
          magenta: 300
        };
        const centre = HSL_RANGES[opts.hslRange] ?? 0;
        const sliderH = k.h ?? 0;
        const sliderS = k.s ?? 0;
        const angle = (centre + sliderH * 1.8 + 360) % 360;
        sat = sliderS / 100;
        hue = angle;
      }
      updatePointer(hue, sat);
    }
    let dragging2 = false;
    el.addEventListener("mousedown", (e) => {
      dragging2 = true;
      fromMouse(e);
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (dragging2) fromMouse(e);
    });
    window.addEventListener("mouseup", () => {
      dragging2 = false;
    });
    el.addEventListener("touchstart", (e) => {
      dragging2 = true;
      fromMouse(e);
      e.preventDefault();
    }, { passive: false });
    el.addEventListener("touchmove", (e) => {
      if (dragging2) fromMouse(e);
      e.preventDefault();
    }, { passive: false });
    el.addEventListener("touchend", () => {
      dragging2 = false;
    });
    el.addEventListener("dblclick", () => {
      if (opts.stateKey) state[opts.stateKey] = [128, 128, 128];
      if (opts.stHueKey) {
        state[opts.stHueKey] = 0;
        state[opts.stSatKey] = 0;
      }
      if (opts.hslRange) {
        const key = "hsl_" + opts.hslRange;
        state[key] = { h: 0, s: 0, l: 0 };
      }
      updatePointer(0, 0);
      scheduleDraw();
    });
    initFromState();
  }
  makeColorWheel(document.getElementById("cw-cg-shadows-colour"), { stateKey: "cg_shadows_colour" });
  makeColorWheel(document.getElementById("cw-cg-midtones-colour"), { stateKey: "cg_midtones_colour" });
  makeColorWheel(document.getElementById("cw-cg-highlights-colour"), { stateKey: "cg_highlights_colour" });
  makeColorWheel(document.getElementById("cw-cg-global-colour"), { stateKey: "cg_global_colour" });
  makeColorWheel(document.getElementById("cw-st-shadows"), { stHueKey: "st_shadows_hue", stSatKey: "st_shadows_saturation" });
  makeColorWheel(document.getElementById("cw-st-highlights"), { stHueKey: "st_highlights_hue", stSatKey: "st_highlights_saturation" });
  ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"].forEach((rng) => {
    const el = document.getElementById("cw-hsl-" + rng);
    if (el) makeColorWheel(el, { hslRange: rng });
  });
  var cgModeSel = document.getElementById("cg-mode-select");
  if (cgModeSel) {
    cgModeSel.addEventListener("change", () => {
      state.cg_mode = cgModeSel.value;
      scheduleDraw();
    });
  }
  window._hslData = () => {
    const RANGES = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"];
    const hsl = {};
    for (const range of RANGES) {
      hsl["hsl_" + range] = state["hsl_" + range] ?? { h: 0, s: 0, l: 0 };
    }
    return hsl;
  };
  window._colorGradingData = () => ({
    shadows_colour: state.cg_shadows_colour ?? [0, 0, 0],
    midtones_colour: state.cg_midtones_colour ?? [0, 0, 0],
    highlights_colour: state.cg_highlights_colour ?? [0, 0, 0],
    global_colour: state.cg_global_colour ?? [0, 0, 0],
    shadows_intensity: state.cg_shadows_intensity ?? 0,
    midtones_intensity: state.cg_midtones_intensity ?? 0,
    highlights_intensity: state.cg_highlights_intensity ?? 0,
    global_intensity: state.cg_global_intensity ?? 0,
    mode: state.cg_mode ?? "saturation"
  });
  var btnResetRaw = document.getElementById("btn-reset-raw");
  if (btnResetRaw) {
    btnResetRaw.onclick = () => {
      for (const k of RAW_KEYS) {
        state[k] = RAW_DEFAULTS[k];
        const wrap = document.querySelector('.slider[data-key="' + k + '"]');
        if (wrap) {
          const inp = wrap.querySelector("input");
          const valEl = wrap.querySelector(".val");
          if (inp) inp.value = String(RAW_DEFAULTS[k]);
          if (valEl) valEl.textContent = String(RAW_DEFAULTS[k]);
        }
      }
      const lensCb = document.getElementById("raw-lens-on");
      if (lensCb) lensCb.checked = false;
      state.lens_corrections = { enabled: false, remove_baseline_exposure: 0, chromatic_aberration: 0, chromatic_aberration_x: 0, chromatic_aberration_y: 0 };
      document.querySelectorAll('.slider[data-key^="lens_corrections."]').forEach((wrap) => {
        const input = wrap.querySelector("input");
        const valEl = wrap.querySelector(".val");
        const key = wrap.dataset.key || "";
        const nestedKey = key.split(".")[1];
        const v = nestedKey ? (state.lens_corrections || {})[nestedKey] ?? 0 : 0;
        if (input) input.value = String(v);
        if (valEl) valEl.textContent = String(v);
      });
    };
  }
  var lensCbEl = document.getElementById("raw-lens-on");
  if (lensCbEl) {
    lensCbEl.checked = !!state.raw_lens_on;
    lensCbEl.addEventListener("change", () => {
      state.raw_lens_on = lensCbEl.checked ? 1 : 0;
      applyRawPreviewFx();
      scheduleDraw();
      scheduleRawPreviewFetch("lens");
    });
  }
  var btnResetCalib = document.getElementById("btn-reset-calibration");
  if (btnResetCalib) {
    btnResetCalib.onclick = () => {
      state.calibration = { shadow_tint: 0, saturation: 0 };
      document.querySelectorAll('.slider[data-key^="calibration."]').forEach((wrap) => {
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
  var cropBox = null;
  var dragMode = null;
  var dragOffset = null;
  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return { x: cx * (canvas.width / r.width), y: cy * (canvas.height / r.height) };
  }
  canvas.addEventListener("mousedown", onDown);
  canvas.addEventListener("touchstart", onDown, { passive: false });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("mouseup", onUp);
  window.addEventListener("touchend", onUp);
  function onDown(e) {
    if (zoomMode !== "fit") return;
    const p = getPos(e);
    if (cropBox) {
      const h = 14;
      const corners = {
        nw: [cropBox.x, cropBox.y],
        ne: [cropBox.x + cropBox.w, cropBox.y],
        sw: [cropBox.x, cropBox.y + cropBox.h],
        se: [cropBox.x + cropBox.w, cropBox.y + cropBox.h]
      };
      for (const [name, [x, y]] of Object.entries(corners)) {
        if (Math.abs(p.x - x) <= h && Math.abs(p.y - y) <= h) {
          dragMode = name;
          e.preventDefault();
          return;
        }
      }
      if (p.x >= cropBox.x && p.x <= cropBox.x + cropBox.w && p.y >= cropBox.y && p.y <= cropBox.y + cropBox.h) {
        dragMode = "move";
        dragOffset = { dx: p.x - cropBox.x, dy: p.y - cropBox.y };
        e.preventDefault();
        return;
      }
    }
    cropBox = { x: p.x, y: p.y, w: 1, h: 1 };
    dragMode = "se";
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragMode) return;
    e.preventDefault();
    const p = getPos(e);
    if (dragMode === "create" || dragMode === "se") {
      cropBox.w = Math.max(2, p.x - cropBox.x);
      cropBox.h = Math.max(2, p.y - cropBox.y);
    } else if (dragMode === "nw") {
      cropBox.w += cropBox.x - p.x;
      cropBox.h += cropBox.y - p.y;
      cropBox.x = p.x;
      cropBox.y = p.y;
    } else if (dragMode === "ne") {
      cropBox.w = Math.max(2, p.x - cropBox.x);
      cropBox.h += cropBox.y - p.y;
      cropBox.y = p.y;
    } else if (dragMode === "sw") {
      cropBox.w += cropBox.x - p.x;
      cropBox.x = p.x;
      cropBox.h = Math.max(2, p.y - cropBox.y);
    } else if (dragMode === "move" && dragOffset) {
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
    if (!cropBox) {
      state.crop = null;
      return;
    }
    state.crop = {
      x: cropBox.x / canvas.width,
      y: cropBox.y / canvas.height,
      w: cropBox.w / canvas.width,
      h: cropBox.h / canvas.height
    };
  }
  var currentAspect = null;
  function setAspectPreset(ratio) {
    document.querySelectorAll("[data-aspect]").forEach((b) => b.classList.remove("active"));
    const label = ratio === null ? "free" : function() {
      const map = { "1": "1:1", "4/3": "4:3", "3/2": "3:2", "16/9": "16:9" };
      let best = null, bestDiff = Infinity;
      for (const [r, lbl] of Object.entries(map)) {
        const diff = Math.abs(Number(r) - ratio);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = lbl;
        }
      }
      return bestDiff < 0.02 ? best : null;
    }();
    if (label) {
      const btn = document.querySelector('[data-aspect="' + label + '"]');
      if (btn) btn.classList.add("active");
    }
    currentAspect = ratio;
  }
  function makeCropAtAspect() {
    const imgR = canvas.width / canvas.height;
    const wByH = currentAspect || imgR;
    const sourceAspect = imgR;
    const uvAspect = wByH * (1 / sourceAspect);
    let cropW, cropH;
    if (uvAspect >= 1) {
      cropH = 1;
      cropW = 1 / uvAspect;
    } else {
      cropW = 1;
      cropH = uvAspect;
    }
    const cropX = (1 - cropW) / 2;
    const cropY = (1 - cropH) / 2;
    cropBox = {
      x: Math.round(cropX * canvas.width),
      y: Math.round(cropY * canvas.height),
      w: Math.round(cropW * canvas.width),
      h: Math.round(cropH * canvas.height)
    };
    syncStateCrop();
  }
  document.querySelectorAll("[data-aspect]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const asp = btn.dataset.aspect;
      if (asp === "free") {
        setAspectPreset(null);
        return;
      }
      const [aw, ah] = asp.split(":").map(Number);
      if (!aw || !ah) return;
      setAspectPreset(aw / ah);
      makeCropAtAspect();
      clampCrop();
      syncStateCrop();
      draw();
    });
  });
  document.getElementById("btn-clear-crop").onclick = () => {
    cropBox = null;
    currentAspect = null;
    document.querySelectorAll("[data-aspect]").forEach((b) => b.classList.remove("active"));
    state.crop = null;
    state.straighten = 0;
    setSliderValue("straighten", 0);
    if (webglPipeline) webglPipeline.updateState({ straighten: 0 });
    draw();
  };
  var straightenWrap = document.querySelector('.slider[data-key="straighten"]');
  if (straightenWrap) {
    const straightenInput = straightenWrap.querySelector("input");
    const straightenVal = straightenWrap.querySelector(".val");
    straightenInput.value = String(state.straighten || 0);
    straightenVal.textContent = straightenInput.value;
    straightenInput.addEventListener("input", () => {
      const v = parseFloat(straightenInput.value);
      state.straighten = v;
      straightenVal.textContent = v.toFixed(1);
      if (webglPipeline) webglPipeline.updateState({ straighten: v });
      draw();
    });
  }
  document.getElementById("btn-apply-aspect").addEventListener("click", () => {
    const input = document.getElementById("crop-aspect-input");
    const val = input.value.trim();
    if (!val) return;
    const parts = val.split(":");
    if (parts.length === 2) {
      const w = parseFloat(parts[0]);
      const h = parseFloat(parts[1]);
      if (w && h && w > 0 && h > 0) {
        currentAspect = w / h;
        makeCropAtAspect();
        clampCrop();
        syncStateCrop();
        draw();
        toast("Aspect " + val + " applied");
        return;
      }
    }
    const ratio = parseFloat(val);
    if (!isNaN(ratio) && ratio > 0) {
      currentAspect = ratio;
      makeCropAtAspect();
      clampCrop();
      syncStateCrop();
      draw();
      toast("Aspect " + ratio.toFixed(2) + ":1 applied");
    } else {
      toast("Invalid aspect ratio. Use e.g. 4:5 or 2.39");
    }
  });
  function updateCropDims() {
    const el = document.getElementById("crop-dims");
    if (!el || !state.crop) {
      if (el) el.textContent = "";
      return;
    }
    const c = state.crop;
    const imgW = sourceImage.naturalWidth || canvas.width;
    const imgH = sourceImage.naturalHeight || canvas.height;
    const px = Math.round(c.w * imgW);
    const py = Math.round(c.h * imgH);
    const mp = (px * py / 1e6).toFixed(1);
    el.textContent = px + " x " + py + " px  (" + mp + " MP)";
  }
  window.updateCropDims = updateCropDims;
  var btnCompare = document.getElementById("btn-compare");
  var indicatorEl = document.getElementById("compare-indicator");
  var comparing = false;
  function setComparing(v) {
    if (comparing === v) return;
    comparing = v;
    indicatorEl.classList.toggle("visible", v);
    btnCompare.classList.toggle("active", v);
    btnCompare.setAttribute("aria-pressed", v ? "true" : "false");
    if (!comparing) _sharpenCacheKey = -1;
    draw();
  }
  btnCompare.addEventListener("mousedown", () => setComparing(true));
  btnCompare.addEventListener("touchstart", (e) => {
    setComparing(true);
    e.preventDefault();
  }, { passive: false });
  var releaseCompare = () => setComparing(false);
  window.addEventListener("mouseup", releaseCompare);
  window.addEventListener("touchend", releaseCompare);
  btnCompare.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      setComparing(true);
    }
  });
  btnCompare.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      setComparing(false);
    }
  });
  var toastEl = document.getElementById("toast");
  var toastT = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("visible");
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove("visible"), 2e3);
  }
  btnSave.onclick = async () => {
    btnSave.disabled = true;
    setStatus("Saving\u2026");
    try {
      const res = await fetch("/api/images/" + imageId + "/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: { ...state, history: _history, curve: _cvData }, sourceUrl })
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setStatus("Saved #" + data.edit.id + " at " + (/* @__PURE__ */ new Date(data.edit.created_at + "Z")).toLocaleTimeString() + ". Reloading source\u2026");
      btnRevert.disabled = false;
      toast("Edit saved.");
      sourceImage.src = "/api/images/" + imageId + "/source?ts=" + Date.now();
      if (typeof applyRawPreviewFx === "function") applyRawPreviewFx();
    } catch (e) {
      console.error(e);
      setStatus("Save failed: " + e.message, true);
    } finally {
      btnSave.disabled = false;
    }
  };
  btnRevert.onclick = async () => {
    if (!confirm("Discard all saved edits and revert to the original?")) return;
    btnRevert.disabled = true;
    try {
      const res = await fetch("/api/images/" + imageId + "/edit", { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      setStatus("Reverted to original. Reloading\u2026");
      toast("Reverted.");
      _resetOnLoad = true;
      sourceImage.src = "/api/images/" + imageId + "/source?ts=" + Date.now();
    } catch (e) {
      setStatus("Revert failed: " + e.message, true);
      btnRevert.disabled = false;
    }
  };
  window.addEventListener("resize", () => {
    if (sourceImage.complete && sourceImage.naturalWidth) {
      fitCanvasToArea();
      draw();
    }
  });
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey) {
      e.preventDefault();
      redo();
    }
    if (e.key === "r" || e.key === "R") {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      if (e.shiftKey) {
        const current = state.straighten || 0;
        const newAngle = current - 90;
        setSliderValue("straighten", newAngle);
        state.straighten = newAngle;
        if (webglPipeline) webglPipeline.updateState({ straighten: newAngle });
        draw();
      } else {
        const current = state.straighten || 0;
        const newAngle = current + 90;
        setSliderValue("straighten", newAngle);
        state.straighten = newAngle;
        if (webglPipeline) webglPipeline.updateState({ straighten: newAngle });
        draw();
      }
    }
  });
  var _cvData = {
    rgb: [[0, 0], [255, 255]],
    r: [[0, 0], [255, 255]],
    g: [[0, 0], [255, 255]],
    b: [[0, 0], [255, 255]]
  };
  var _cvCh = "rgb";
  var _cvDrag = null;
  window._cvData = _cvData;
  function _cvS(v) {
    return 10 + v * 200 / 255;
  }
  function _cvPath() {
    const pts = [..._cvData[_cvCh]].sort((a, b) => a[0] - b[0]);
    if (!pts.length) return "";
    return "M" + pts.map(([x, y]) => `${_cvS(x)},${_cvS(y)}`).join("L");
  }
  function _cvSync() {
    const pipe = window._webgl;
    if (_cvCh === "rgb") {
      _cvData.r = _cvData.rgb.slice();
      _cvData.g = _cvData.rgb.slice();
      _cvData.b = _cvData.rgb.slice();
    }
    state.curve = {
      rgb: _cvData.rgb.map((p) => [p[0], p[1]]),
      r: _cvData.r.map((p) => [p[0], p[1]]),
      g: _cvData.g.map((p) => [p[0], p[1]]),
      b: _cvData.b.map((p) => [p[0], p[1]])
    };
    if (pipe?.ready) {
      pipe.setCurves({ rgb: _cvData.rgb, r: _cvData.r, g: _cvData.g, b: _cvData.b });
      pipe.render();
    }
  }
  function _cvRefresh() {
    const path = document.getElementById("cv-path");
    const ptsEl = document.getElementById("cv-pts");
    const info = document.getElementById("cv-info");
    if (path) path.setAttribute("d", _cvPath());
    const custom = !isFlat({ rgb: _cvData.rgb, r: _cvData.r, g: _cvData.g, b: _cvData.b });
    if (info) info.textContent = custom ? _cvCh.toUpperCase() : "";
    if (!ptsEl) return;
    ptsEl.innerHTML = "";
    const color = _cvCh === "rgb" ? "#ddd" : _cvCh === "r" ? "#f66" : _cvCh === "g" ? "#6e6" : "#66f";
    for (let i = 0; i < _cvData[_cvCh].length; i++) {
      const [x, y] = _cvData[_cvCh][i];
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", String(_cvS(x)));
      c.setAttribute("cy", String(_cvS(y)));
      c.setAttribute("r", "4");
      c.setAttribute("fill", color);
      c.setAttribute("stroke", "#111");
      c.setAttribute("stroke-width", "1");
      c.setAttribute("data-idx", String(i));
      c.style.cursor = "move";
      ptsEl.appendChild(c);
    }
  }
  function _cvAddPt(sx, sy) {
    const x = Math.max(0, Math.min(255, Math.round((sx - 10) * 255 / 200)));
    const y = Math.max(0, Math.min(255, Math.round((sy - 10) * 255 / 200)));
    _cvData[_cvCh].push([x, y]);
    _cvData[_cvCh].sort((a, b) => a[0] - b[0]);
    const idx = _cvData[_cvCh].findIndex(([px, py]) => px === x && py === y);
    _cvSync();
    _cvRefresh();
    scheduleDraw();
    return idx;
  }
  function _cvRmPt(idx) {
    if (_cvData[_cvCh].length <= 2) return;
    _cvData[_cvCh].splice(idx, 1);
    _cvSync();
    _cvRefresh();
    scheduleDraw();
  }
  function _cvReset() {
    for (const ch of ["rgb", "r", "g", "b"]) _cvData[ch] = [[0, 0], [255, 255]];
    _cvCh = "rgb";
    document.querySelectorAll(".ch-tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.ch-tab[data-cvch="rgb"]')?.classList.add("active");
    _cvSync();
    _cvRefresh();
    scheduleDraw();
    scheduleAuthoritativePreview();
  }
  window._cvReset = _cvReset;
  window._cvSync = _cvSync;
  window._cvRefresh = _cvRefresh;
  window._cvAddPt = _cvAddPt;
  window._cvReset = _cvReset;
  window._cvCh = () => _cvCh;
  window.setCvCh = (ch) => {
    _cvCh = ch;
    document.querySelectorAll(".ch-tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.ch-tab[data-cvch="' + ch + '"]')?.classList.add("active");
    _cvRefresh();
  };
  function _cvInit() {
    const svg = document.getElementById("cv-svg");
    if (!svg) return;
    const r = () => svg.getBoundingClientRect();
    const curvePointFromEvent = (clientX, clientY) => {
      const rect = r();
      const sx = (clientX - rect.left) * 220 / rect.width;
      const sy = (clientY - rect.top) * 220 / rect.height;
      return {
        x: Math.max(0, Math.min(255, Math.round((sx - 10) * 255 / 200))),
        y: Math.max(0, Math.min(255, Math.round((sy - 10) * 255 / 200)))
      };
    };
    const beginCurveDrag = (clientX, clientY) => {
      const rect = r();
      const sx = (clientX - rect.left) * 220 / rect.width;
      const sy = (clientY - rect.top) * 220 / rect.height;
      let hit = -1;
      for (let i = 0; i < _cvData[_cvCh].length; i++) {
        const [x, y] = _cvData[_cvCh][i];
        if (Math.abs(_cvS(x) - sx) < 8 && Math.abs(_cvS(y) - sy) < 8) {
          hit = i;
          break;
        }
      }
      if (hit >= 0) _cvDrag = { idx: hit };
      else {
        const newIdx = _cvAddPt(sx, sy);
        if (newIdx >= 0) _cvDrag = { idx: newIdx };
      }
    };
    const moveCurveDrag = (clientX, clientY) => {
      if (!_cvDrag) return;
      const { x, y } = curvePointFromEvent(clientX, clientY);
      _cvData[_cvCh][_cvDrag.idx] = [x, y];
      _cvData[_cvCh].sort((a, b) => a[0] - b[0]);
      _cvSync();
      _cvRefresh();
      scheduleDraw();
    };
    const endCurveDrag = () => {
      if (!_cvDrag) return;
      _cvDrag = null;
      _cvSync();
      scheduleAuthoritativePreview();
    };
    svg.addEventListener("mousedown", (e) => {
      e.preventDefault();
      beginCurveDrag(e.clientX, e.clientY);
    });
    window.addEventListener("mousemove", (e) => {
      moveCurveDrag(e.clientX, e.clientY);
    });
    window.addEventListener("mouseup", () => {
      endCurveDrag();
    });
    svg.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      if (!t) return;
      e.preventDefault();
      beginCurveDrag(t.clientX, t.clientY);
    }, { passive: false });
    svg.addEventListener("touchmove", (e) => {
      const t = e.changedTouches[0];
      if (!t) return;
      e.preventDefault();
      moveCurveDrag(t.clientX, t.clientY);
    }, { passive: false });
    const endTouch = (e) => {
      e.preventDefault();
      endCurveDrag();
    };
    svg.addEventListener("touchend", endTouch, { passive: false });
    svg.addEventListener("touchcancel", endTouch, { passive: false });
    svg.addEventListener("dblclick", (e) => {
      const rect = r();
      const sx = (e.clientX - rect.left) * 220 / rect.width;
      const sy = (e.clientY - rect.top) * 220 / rect.height;
      for (let i = 0; i < _cvData[_cvCh].length; i++) {
        const [x, y] = _cvData[_cvCh][i];
        if (Math.abs(_cvS(x) - sx) < 8 && Math.abs(_cvS(y) - sy) < 8) {
          _cvRmPt(i);
          break;
        }
      }
    });
    document.getElementById("cv-reset")?.addEventListener("click", _cvReset);
    document.querySelectorAll(".ch-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".ch-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        _cvCh = tab.dataset.cvch;
        _cvRefresh();
      });
    });
    _cvRefresh();
  }
  function _histCapture() {
    const canvas2 = document.getElementById("preview");
    const pipe = window._webgl;
    if (!canvas2 || !pipe?.ready) return;
    const oc = document.createElement("canvas");
    oc.width = 64;
    oc.height = 64;
    const ctx2 = oc.getContext("2d");
    ctx2.drawImage(canvas2, 0, 0, 64, 64);
    const d = ctx2.getImageData(0, 0, 64, 64).data;
    const cnts = {
      r: new Uint32Array(256),
      g: new Uint32Array(256),
      b: new Uint32Array(256),
      l: new Uint32Array(256)
    };
    for (let i = 0; i < d.length; i += 4) {
      const [rv, gv, bv] = [d[i], d[i + 1], d[i + 2]];
      cnts.r[rv]++;
      cnts.g[gv]++;
      cnts.b[bv]++;
      cnts.l[Math.round(0.299 * rv + 0.587 * gv + 0.114 * bv)]++;
    }
    _histRender(cnts);
  }
  function _histRender(cnts) {
    const el = document.getElementById("cv-hist");
    if (!el) return;
    const ch = _cvCh === "rgb" ? "l" : _cvCh;
    const arr = cnts[ch];
    let mx = 1;
    for (let i = 0; i < 256; i++) if (arr[i] > mx) mx = arr[i];
    const bins = 200, bh = 200, bw = 200;
    let d = `M10,210`;
    for (let i = 0; i < bins; i++) {
      const v = arr[Math.min(255, i * 256 / bins | 0)];
      d += ` L${10 + i * bw / bins},${10 + bh - v / mx * bh}`;
    }
    d += ` L${10 + bins * bw / bins},210 Z`;
    el.setAttribute("d", d);
  }
  var _histT = null;
  function _histStart() {
    if (!_histT) _histT = setInterval(_histCapture, 300);
  }
  function _histStop() {
    if (_histT) {
      clearInterval(_histT);
      _histT = null;
    }
  }
  window.addEventListener("beforeunload", _histStop);
  function renderSnapshotList() {
    const list = document.getElementById("snapshot-list");
    if (!list) return;
    list.innerHTML = "";
    const snaps = state.snapshots || [];
    snaps.forEach((s, idx) => {
      const div = document.createElement("div");
      div.style.cssText = "display:flex;gap:4px;align-items:center;padding:3px 6px;background:#1a1a1a;border-radius:4px;cursor:pointer";
      div.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name || "Unnamed"}</span><button data-del-idx="${idx}" style="background:none;border:none;color:#888;cursor:pointer;font-size:0.7rem;padding:0 2px">X</button>`;
      div.querySelector("span")?.addEventListener("click", () => restoreSnapshot(idx));
      div.querySelector("[data-del-idx]")?.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSnapshot(idx);
      });
      list.appendChild(div);
    });
  }
  function saveSnapshot() {
    const input = document.getElementById("snapshot-name-input");
    const name = input?.value?.trim() || "Snapshot " + ((state.snapshots?.length || 0) + 1);
    const snap = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      name,
      state: JSON.parse(JSON.stringify(state)),
      created_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (!state.snapshots) state.snapshots = [];
    state.snapshots.push(snap);
    const input2 = document.getElementById("snapshot-name-input");
    if (input2) input2.value = "";
    renderSnapshotList();
    toast("Snapshot saved: " + name);
  }
  function restoreSnapshot(idx) {
    const snaps = state.snapshots || [];
    if (!snaps[idx]) return;
    const snap = snaps[idx];
    const snapState = JSON.parse(JSON.stringify(snap.state));
    delete snapState.snapshots;
    Object.assign(state, snapState);
    document.querySelectorAll(".slider").forEach((wrap) => {
      const key = wrap.dataset.key;
      const input = wrap.querySelector("input");
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
  function deleteSnapshot(idx) {
    if (!state.snapshots) return;
    state.snapshots.splice(idx, 1);
    renderSnapshotList();
  }
  var spotMode = null;
  var currentSpot = null;
  var isDragging = false;
  var spotOverlay = document.getElementById("spot-overlay-canvas");
  var spotCtx = spotOverlay?.getContext("2d");
  function renderSpotOverlay() {
    if (!spotOverlay || !spotCtx) return;
    const dpr = window.devicePixelRatio || 1;
    spotOverlay.width = spotOverlay.offsetWidth * dpr;
    spotOverlay.height = spotOverlay.offsetHeight * dpr;
    spotCtx.clearRect(0, 0, spotOverlay.width, spotOverlay.height);
    const spots = state.spot_removals || [];
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
      spotCtx.beginPath();
      spotCtx.arc(scx, scy, r, 0, Math.PI * 2);
      spotCtx.strokeStyle = "#888";
      spotCtx.setLineDash([3, 3]);
      spotCtx.stroke();
      spotCtx.setLineDash([]);
      spotCtx.fillStyle = s.mode === "heal" ? "#4af" : "#f84";
      spotCtx.font = "9px sans-serif";
      spotCtx.fillText(String(i + 1), cx - 3, cy + 3);
    });
  }
  function addSpot(e) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const spot = {
      x,
      y,
      radius: Math.round(Math.min(rect.width, rect.height) * 0.03),
      mode: spotMode || "clone",
      srcX: x + 0.05,
      srcY: y + 0.05
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
    const spots = state.spot_removals || [];
    spots.forEach((s, i) => {
      const div = document.createElement("div");
      div.style.cssText = "display:flex;gap:4px;align-items:center;padding:2px 4px;background:#1a1a1a;border-radius:3px;font-size:0.7rem";
      div.innerHTML = `<span style="color:${s.mode === "heal" ? "#4af" : "#f84"};width:30px">${s.mode.charAt(0).toUpperCase()}</span><span style="flex:1">Spot ${i + 1} r=${s.radius}</span><button data-idx="${i}" style="background:none;border:none;color:#888;cursor:pointer">X</button>`;
      div.querySelector("[data-idx]")?.addEventListener("click", (e) => {
        const idx = parseInt(e.target.dataset.idx || "0");
        state.spot_removals.splice(idx, 1);
        renderSpotOverlay();
        renderSpotList();
        scheduleDraw();
      });
      list.appendChild(div);
    });
  }
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
  var btnClone = document.getElementById("btn-spot-add-clone");
  var btnHeal = document.getElementById("btn-spot-add-heal");
  var btnResetSpot = document.getElementById("btn-reset-spot");
  var spotModeLabel = document.getElementById("spot-mode-label");
  function setSpotMode(mode) {
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
  var btnSnapSave = document.getElementById("btn-snapshot-save");
  btnSnapSave?.addEventListener("click", saveSnapshot);
  var snapInput = document.getElementById("snapshot-name-input");
  snapInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveSnapshot();
  });
  renderSnapshotList();
  renderSpotList();
  if (spotOverlay) {
    window.addEventListener("resize", renderSpotOverlay);
  }
  _cvInit();
  try {
    const savedCurve = window.__EDITOR_DATA__?.initialParams?.curve || state?.curve;
    if (savedCurve && typeof savedCurve === "object" && window._cvData) {
      const cv = window._cvData;
      ["rgb", "r", "g", "b"].forEach((ch) => {
        if (Array.isArray(savedCurve[ch])) {
          cv[ch] = savedCurve[ch].filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [Number(p[0]), Number(p[1])]);
          if (cv[ch].length === 0 || cv[ch][0][0] !== 0) cv[ch].unshift([0, 0]);
          if (cv[ch][cv[ch].length - 1][0] !== 255) cv[ch].push([255, 255]);
          cv[ch].sort((a, b) => a[0] - b[0]);
        }
      });
      const savedCh = window.__EDITOR_DATA__?.initialParams?.curveCh || state?.curveCh;
      if (savedCh && typeof window.setCvCh === "function") {
        window.setCvCh(savedCh);
      }
      if (typeof window._cvSync === "function") window._cvSync();
      if (typeof window._cvRefresh === "function") window._cvRefresh();
      if (typeof draw === "function") draw();
    }
  } catch (e) {
    console.warn("curve hydrate failed", e);
  }
  _histStart();
  setStatus("Editor ready.");
})();
