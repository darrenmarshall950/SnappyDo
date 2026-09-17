const VERT_SRC = `#version 300 es
precision highp float;
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;
const SLIDERS_LUT_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler3D uLut;
uniform float uLutSize;
uniform float uLutIntensity;  // 0..1
uniform float uExposure;       // -200..200, multiplicative 2^(uExposure/100)
uniform float uContrast;       // -100..100, pivot 0.5
uniform float uBrightness;     // -100..100, multiplicative scale
uniform float uSaturation;     // -100..100, 0 = grayscale at -100, +100 = 2x
uniform float uTemp;           // -100..100, warm/cool tint (R-/B+ or R+/B-)
uniform float uTint;           // -100..100, magenta/green tint

vec3 applySliders(vec3 c) {
  // Exposure (multiplicative). 2^(ev/100): ev=100 doubles, ev=-100 halves.
  c *= pow(2.0, uExposure / 100.0);
  // Brightness (multiplicative scale around 1.0).
  c *= (1.0 + uBrightness / 100.0);
  // Contrast (linear stretch around 0.5).
  float cFactor = (100.0 + uContrast) / 100.0;
  c = (c - 0.5) * cFactor + 0.5;
  c = clamp(c, 0.0, 1.0);
  // Saturation: luma-weighted mix with grayscale.
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  float satFactor = max(0.0, 1.0 + uSaturation / 100.0); // -100 \u2192 0, 0 \u2192 1, +100 \u2192 2
  c = mix(vec3(luma), c, satFactor);
  // Temp (warm/cool): shift R opposite B
  float tempShift = uTemp / 100.0 * 0.15;
  c.r += tempShift;
  c.b -= tempShift;
  // Tint (magenta/green): shift R+G opposite B
  float tintShift = uTint / 100.0 * 0.1;
  c.r += tintShift * 0.5;
  c.g += tintShift * 0.5;
  c.b -= tintShift;
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec3 src = texture(uSource, vUv).rgb;
  vec3 adjusted = applySliders(src);
  // Sample 3D LUT. Clamp to ensure 0..1 even after slider overshoot,
  // since LUT cube indices are 0..size-1.
  vec3 clamped = clamp(adjusted, 0.0, 1.0);
  // 3D texture sample: uvw maps to cube coordinates. Linear filtering
  // gives us trilinear interpolation between 8 corners automatically.
  vec3 lutResult = texture(uLut, clamped).rgb;
  // Mix sliders+LUT result with the slider-only result based on intensity.
  vec3 outColor = mix(adjusted, lutResult, uLutIntensity);
  fragColor = vec4(clamp(outColor, 0.0, 1.0), 1.0);
}
`;
const BLUR_H_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uTexelSize;  // (1/w, 1/h)

void main() {
  vec3 sum = vec3(0.0);
  // 9-tap Gaussian, \u03C3 \u2248 1.0
  sum += texture(uSource, vUv + vec2(-4.0 * uTexelSize.x, 0.0)).rgb * 0.0162;
  sum += texture(uSource, vUv + vec2(-3.0 * uTexelSize.x, 0.0)).rgb * 0.0540;
  sum += texture(uSource, vUv + vec2(-2.0 * uTexelSize.x, 0.0)).rgb * 0.1216;
  sum += texture(uSource, vUv + vec2(-1.0 * uTexelSize.x, 0.0)).rgb * 0.1946;
  sum += texture(uSource, vUv                              ).rgb * 0.2270;
  sum += texture(uSource, vUv + vec2( 1.0 * uTexelSize.x, 0.0)).rgb * 0.1946;
  sum += texture(uSource, vUv + vec2( 2.0 * uTexelSize.x, 0.0)).rgb * 0.1216;
  sum += texture(uSource, vUv + vec2( 3.0 * uTexelSize.x, 0.0)).rgb * 0.0540;
  sum += texture(uSource, vUv + vec2( 4.0 * uTexelSize.x, 0.0)).rgb * 0.0162;
  fragColor = vec4(sum, 1.0);
}
`;
const BLUR_V_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uTexelSize;

void main() {
  vec3 sum = vec3(0.0);
  sum += texture(uSource, vUv + vec2(0.0, -4.0 * uTexelSize.y)).rgb * 0.0162;
  sum += texture(uSource, vUv + vec2(0.0, -3.0 * uTexelSize.y)).rgb * 0.0540;
  sum += texture(uSource, vUv + vec2(0.0, -2.0 * uTexelSize.y)).rgb * 0.1216;
  sum += texture(uSource, vUv + vec2(0.0, -1.0 * uTexelSize.y)).rgb * 0.1946;
  sum += texture(uSource, vUv                          ).rgb * 0.2270;
  sum += texture(uSource, vUv + vec2(0.0,  1.0 * uTexelSize.y)).rgb * 0.1946;
  sum += texture(uSource, vUv + vec2(0.0,  2.0 * uTexelSize.y)).rgb * 0.1216;
  sum += texture(uSource, vUv + vec2(0.0,  3.0 * uTexelSize.y)).rgb * 0.0540;
  sum += texture(uSource, vUv + vec2(0.0,  4.0 * uTexelSize.y)).rgb * 0.0162;
  fragColor = vec4(sum, 1.0);
}
`;
const UNSHARP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uBlur;
uniform float uAmount;  // 0..1

void main() {
  vec3 src = texture(uSource, vUv).rgb;
  vec3 blr = texture(uBlur, vUv).rgb;
  vec3 diff = src - blr;
  vec3 result = src + diff * uAmount;
  fragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}
`;
const CURVE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uCurveR;
uniform sampler2D uCurveG;
uniform sampler2D uCurveB;
uniform bool     uHasCurve;

void main() {
  vec3 c = texture(uSource, vUv).rgb;
  if (uHasCurve) {
    c.r = texture(uCurveR, vec2(clamp(c.r,0.0,1.0), 0.5)).r;
    c.g = texture(uCurveG, vec2(clamp(c.g,0.0,1.0), 0.5)).g;
    c.b = texture(uCurveB, vec2(clamp(c.b,0.0,1.0), 0.5)).b;
  }
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
let curveTexR = null;
let curveTexG = null;
let curveTexB = null;
let curveFbo = null;
let curveTex = null;
let curveIsIdentity = true;
const _identityLut = new Float32Array(256);
for (let i = 0; i < 256; i++) _identityLut[i] = i / 255;
function _buildLut(ch) {
  if (!ch || ch.length === 0) return new Float32Array(_identityLut);
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
function _isIdentity(ch) {
  if (!ch || ch.length === 0) return true;
  if (ch.length === 2 && ch[0][0] === 0 && ch[0][1] === 0 && ch[1][0] === 255 && ch[1][1] === 255) return true;
  return false;
}
function _uploadCurveTex(tex, lut) {
  if (!gl) return;
  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = Math.max(0, Math.min(255, Math.round(lut[i] * 255)));
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
function _float32Eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
  return true;
}
let _lastCurveR = null;
let _lastCurveG = null;
let _lastCurveB = null;
function setCurves(curves) {
  if (!ready || !gl) return;
  if (!curveTexR) {
    curveTexR = gl.createTexture();
  }
  if (!curveTexG) {
    curveTexG = gl.createTexture();
  }
  if (!curveTexB) {
    curveTexB = gl.createTexture();
  }
  const chR = curves?.r, chG = curves?.g, chB = curves?.b;
  curveIsIdentity = _isIdentity(chR) && _isIdentity(chG) && _isIdentity(chB);
  const lutR = _buildLut(curveIsIdentity ? void 0 : chR);
  const lutG = _buildLut(curveIsIdentity ? void 0 : chG);
  const lutB = _buildLut(curveIsIdentity ? void 0 : chB);
  if (!_lastCurveR || !_float32Eq(lutR, _lastCurveR)) {
    _uploadCurveTex(curveTexR, lutR);
    _lastCurveR = lutR;
  }
  if (!_lastCurveG || !_float32Eq(lutG, _lastCurveG)) {
    _uploadCurveTex(curveTexG, lutG);
    _lastCurveG = lutG;
  }
  if (!_lastCurveB || !_float32Eq(lutB, _lastCurveB)) {
    _uploadCurveTex(curveTexB, lutB);
    _lastCurveB = lutB;
  }
}
function createWebGLPipeline() {
  let gl2 = null;
  let canvasRef = null;
  let ready2 = false;
  let slidersLutProg = null;
  let blurHProg = null;
  let blurVProg = null;
  let unsharpProg = null;
  let curveProg = null;
  let quadVao = null;
  let sourceTex = null;
  let lutTex = null;
  let sharpenTexA = null;
  let sharpenTexB = null;
  let sharpenFboA = null;
  let sharpenFboB = null;
  let sourceW = 0;
  let sourceH = 0;
  const lastState = {
    exposure: 0,
    contrast: 0,
    brightness: 0,
    saturation: 0,
    temp: 0,
    tint: 0,
    sharpen: 0,
    lut_id: 0,
    lut_intensity: 0,
    curve: void 0
  };
  function compileShader(type, source) {
    const shader = gl2.createShader(type);
    if (!shader) throw new Error("createShader failed");
    gl2.shaderSource(shader, source);
    gl2.compileShader(shader);
    if (!gl2.getShaderParameter(shader, gl2.COMPILE_STATUS)) {
      const log = gl2.getShaderInfoLog(shader);
      gl2.deleteShader(shader);
      throw new Error("shader compile failed: " + log);
    }
    return shader;
  }
  function createProgram(vert, frag) {
    const v = compileShader(gl2.VERTEX_SHADER, vert);
    const f = compileShader(gl2.FRAGMENT_SHADER, frag);
    const prog = gl2.createProgram();
    if (!prog) throw new Error("createProgram failed");
    gl2.attachShader(prog, v);
    gl2.attachShader(prog, f);
    gl2.linkProgram(prog);
    if (!gl2.getProgramParameter(prog, gl2.LINK_STATUS)) {
      const log = gl2.getProgramInfoLog(prog);
      gl2.deleteProgram(prog);
      throw new Error("program link failed: " + log);
    }
    gl2.detachShader(prog, v);
    gl2.detachShader(prog, f);
    gl2.deleteShader(v);
    gl2.deleteShader(f);
    return prog;
  }
  function setupQuad() {
    const vao = gl2.createVertexArray();
    if (!vao) throw new Error("createVertexArray failed");
    gl2.bindVertexArray(vao);
    quadVao = vao;
    const verts = new Float32Array([
      // x, y, u, v
      -1,
      -1,
      0,
      0,
      1,
      -1,
      1,
      0,
      -1,
      1,
      0,
      1,
      -1,
      1,
      0,
      1,
      1,
      -1,
      1,
      0,
      1,
      1,
      1,
      1
    ]);
    const vbo = gl2.createBuffer();
    gl2.bindBuffer(gl2.ARRAY_BUFFER, vbo);
    gl2.bufferData(gl2.ARRAY_BUFFER, verts, gl2.STATIC_DRAW);
    gl2.enableVertexAttribArray(0);
    gl2.vertexAttribPointer(0, 2, gl2.FLOAT, false, 16, 0);
    gl2.enableVertexAttribArray(1);
    gl2.vertexAttribPointer(1, 2, gl2.FLOAT, false, 16, 8);
    gl2.bindVertexArray(null);
  }
  function createColorTex(w, h, internalFmt, fmt, type) {
    const tex = gl2.createTexture();
    if (!tex) throw new Error("createTexture failed");
    gl2.bindTexture(gl2.TEXTURE_2D, tex);
    gl2.texImage2D(gl2.TEXTURE_2D, 0, internalFmt, w, h, 0, fmt, type, null);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
    return tex;
  }
  function attachFbo(tex) {
    const fbo = gl2.createFramebuffer();
    if (!fbo) throw new Error("createFramebuffer failed");
    gl2.bindFramebuffer(gl2.FRAMEBUFFER, fbo);
    gl2.framebufferTexture2D(
      gl2.FRAMEBUFFER,
      gl2.COLOR_ATTACHMENT0,
      gl2.TEXTURE_2D,
      tex,
      0
    );
    const status = gl2.checkFramebufferStatus(gl2.FRAMEBUFFER);
    if (status !== gl2.FRAMEBUFFER_COMPLETE) {
      throw new Error("framebuffer incomplete: 0x" + status.toString(16));
    }
    return fbo;
  }
  function init(canvas) {
    canvasRef = canvas;
    try {
      gl2 = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        premultipliedAlpha: false
      });
      if (!gl2) return false;
      slidersLutProg = createProgram(VERT_SRC, SLIDERS_LUT_FRAG);
      blurHProg = createProgram(VERT_SRC, BLUR_H_FRAG);
      blurVProg = createProgram(VERT_SRC, BLUR_V_FRAG);
      unsharpProg = createProgram(VERT_SRC, UNSHARP_FRAG);
      curveProg = createProgram(VERT_SRC, CURVE_FRAG);
      setupQuad();
      ready2 = true;
      return true;
    } catch (e) {
      console.warn("WebGL pipeline init failed:", e);
      ready2 = false;
      return false;
    }
  }
  function setSource(image) {
    if (!ready2 || !gl2) return;
    sourceW = image.naturalWidth || image.width;
    sourceH = image.naturalHeight || image.height;
    if (sourceTex) gl2.deleteTexture(sourceTex);
    sourceTex = gl2.createTexture();
    gl2.bindTexture(gl2.TEXTURE_2D, sourceTex);
    gl2.pixelStorei(gl2.UNPACK_FLIP_Y_WEBGL, true);
    gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, gl2.RGBA, gl2.UNSIGNED_BYTE, image);
    gl2.pixelStorei(gl2.UNPACK_FLIP_Y_WEBGL, false);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
    if (sharpenTexA) gl2.deleteTexture(sharpenTexA);
    if (sharpenTexB) gl2.deleteTexture(sharpenTexB);
    if (sharpenFboA) gl2.deleteFramebuffer(sharpenFboA);
    if (sharpenFboB) gl2.deleteFramebuffer(sharpenFboB);
    sharpenTexA = createColorTex(sourceW, sourceH, gl2.RGBA, gl2.RGBA, gl2.UNSIGNED_BYTE);
    sharpenTexB = createColorTex(sourceW, sourceH, gl2.RGBA, gl2.RGBA, gl2.UNSIGNED_BYTE);
    sharpenFboA = attachFbo(sharpenTexA);
    sharpenFboB = attachFbo(sharpenTexB);
  }
  function setLut(lut) {
    if (!ready2 || !gl2) return;
    const { data, size } = lut;
    const cellCount = size * size * size;
    const rgba = new Uint8Array(cellCount * 4);
    if (data instanceof Float32Array) {
      for (let i = 0; i < cellCount; i++) {
        rgba[i * 4] = Math.max(0, Math.min(255, data[i * 3] * 255));
        rgba[i * 4 + 1] = Math.max(0, Math.min(255, data[i * 3 + 1] * 255));
        rgba[i * 4 + 2] = Math.max(0, Math.min(255, data[i * 3 + 2] * 255));
        rgba[i * 4 + 3] = 255;
      }
    } else {
      for (let i = 0; i < cellCount; i++) {
        rgba[i * 4] = data[i * 3];
        rgba[i * 4 + 1] = data[i * 3 + 1];
        rgba[i * 4 + 2] = data[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
    }
    if (lutTex) gl2.deleteTexture(lutTex);
    lutTex = gl2.createTexture();
    gl2.activeTexture(gl2.TEXTURE1);
    gl2.bindTexture(gl2.TEXTURE_3D, lutTex);
    gl2.pixelStorei(gl2.UNPACK_ALIGNMENT, 1);
    gl2.texImage3D(
      gl2.TEXTURE_3D,
      0,
      gl2.RGBA8,
      size,
      size,
      size,
      0,
      gl2.RGBA,
      gl2.UNSIGNED_BYTE,
      rgba
    );
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_WRAP_R, gl2.CLAMP_TO_EDGE);
    gl2.activeTexture(gl2.TEXTURE0);
  }
  function updateState(state) {
    Object.assign(lastState, state);
  }
  function runPass(prog, uniforms, targetFbo, width, height) {
    if (!gl2) return;
    gl2.useProgram(prog);
    gl2.bindVertexArray(quadVao);
    gl2.viewport(0, 0, width, height);
    if (targetFbo) gl2.bindFramebuffer(gl2.FRAMEBUFFER, targetFbo);
    else gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
    uniforms();
    gl2.drawArrays(gl2.TRIANGLES, 0, 6);
  }
  function render() {
    if (!ready2 || !gl2 || !canvasRef) return;
    const ctx = gl2;
    const w = canvasRef.width;
    const h = canvasRef.height;
    let outputTex = sourceTex;
    if (lastState.sharpen > 0 && sharpenTexA && sharpenTexB && sharpenFboA && sharpenFboB) {
      const amount = Math.max(0, Math.min(1, lastState.sharpen / 100));
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, sourceTex);
      runPass(blurHProg, () => {
        gl2.uniform1i(gl2.getUniformLocation(blurHProg, "uSource"), 0);
        gl2.uniform2f(
          gl2.getUniformLocation(blurHProg, "uTexelSize"),
          1 / sourceW,
          1 / sourceH
        );
      }, sharpenFboA, sourceW, sourceH);
      gl2.bindTexture(gl2.TEXTURE_2D, sharpenTexA);
      runPass(blurVProg, () => {
        gl2.uniform1i(gl2.getUniformLocation(blurVProg, "uSource"), 0);
        gl2.uniform2f(
          gl2.getUniformLocation(blurVProg, "uTexelSize"),
          1 / sourceW,
          1 / sourceH
        );
      }, sharpenFboB, sourceW, sourceH);
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, sourceTex);
      gl2.activeTexture(gl2.TEXTURE2);
      gl2.bindTexture(gl2.TEXTURE_2D, sharpenTexB);
      runPass(unsharpProg, () => {
        gl2.uniform1i(gl2.getUniformLocation(unsharpProg, "uSource"), 0);
        gl2.uniform1i(gl2.getUniformLocation(unsharpProg, "uBlur"), 2);
        gl2.uniform1f(gl2.getUniformLocation(unsharpProg, "uAmount"), amount);
      }, sharpenFboA, sourceW, sourceH);
      outputTex = sharpenTexA;
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, outputTex);
    } else {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, sourceTex);
    }
    gl2.activeTexture(gl2.TEXTURE1);
    if (lutTex) gl2.bindTexture(gl2.TEXTURE_3D, lutTex);
    gl2.activeTexture(gl2.TEXTURE0);
    if (!curveFbo || !curveTex || curveTex.width !== w || curveTex.height !== h) {
      if (curveTex) gl2.deleteTexture(curveTex);
      if (curveFbo) gl2.deleteFramebuffer(curveFbo);
      curveTex = gl2.createTexture();
      gl2.bindTexture(gl2.TEXTURE_2D, curveTex);
      gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA8, w, h, 0, gl2.RGBA, gl2.UNSIGNED_BYTE, null);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
      curveFbo = gl2.createFramebuffer();
      gl2.bindFramebuffer(gl2.FRAMEBUFFER, curveFbo);
      gl2.framebufferTexture2D(gl2.FRAMEBUFFER, gl2.COLOR_ATTACHMENT0, gl2.TEXTURE_2D, curveTex, 0);
      gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
    }
    gl2.bindFramebuffer(gl2.FRAMEBUFFER, curveFbo);
    gl2.viewport(0, 0, w, h);
    runPass(slidersLutProg, () => {
      const p = slidersLutProg;
      gl2.uniform1i(gl2.getUniformLocation(p, "uSource"), 0);
      gl2.uniform1i(gl2.getUniformLocation(p, "uLut"), 1);
      gl2.uniform1f(gl2.getUniformLocation(p, "uLutSize"), 32);
      gl2.uniform1f(
        gl2.getUniformLocation(p, "uLutIntensity"),
        Math.max(0, Math.min(1, lastState.lut_intensity / 100))
      );
      gl2.uniform1f(gl2.getUniformLocation(p, "uExposure"), lastState.exposure);
      gl2.uniform1f(gl2.getUniformLocation(p, "uContrast"), lastState.contrast);
      gl2.uniform1f(gl2.getUniformLocation(p, "uBrightness"), lastState.brightness);
      gl2.uniform1f(gl2.getUniformLocation(p, "uSaturation"), lastState.saturation);
      gl2.uniform1f(gl2.getUniformLocation(p, "uTemp"), lastState.temp);
      gl2.uniform1f(gl2.getUniformLocation(p, "uTint"), lastState.tint);
    }, null, w, h);
    gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
    gl2.viewport(0, 0, w, h);
    if (!curveIsIdentity && curveProg && curveTexR && curveTexG && curveTexB) {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, curveTex);
      gl2.activeTexture(gl2.TEXTURE1);
      gl2.bindTexture(gl2.TEXTURE_2D, curveTexR);
      gl2.activeTexture(gl2.TEXTURE2);
      gl2.bindTexture(gl2.TEXTURE_2D, curveTexG);
      gl2.activeTexture(gl2.TEXTURE3);
      gl2.bindTexture(gl2.TEXTURE_2D, curveTexB);
      runPass(curveProg, () => {
        const p = curveProg;
        gl2.uniform1i(gl2.getUniformLocation(p, "uSource"), 0);
        gl2.uniform1i(gl2.getUniformLocation(p, "uCurveR"), 1);
        gl2.uniform1i(gl2.getUniformLocation(p, "uCurveG"), 2);
        gl2.uniform1i(gl2.getUniformLocation(p, "uCurveB"), 3);
        gl2.uniform1i(gl2.getUniformLocation(p, "uHasCurve"), 1);
      }, null, w, h);
    }
    gl2.bindVertexArray(null);
  }
  function destroy() {
    if (!gl2) return;
    if (quadVao) gl2.deleteVertexArray(quadVao);
    if (sourceTex) gl2.deleteTexture(sourceTex);
    if (lutTex) gl2.deleteTexture(lutTex);
    if (sharpenTexA) gl2.deleteTexture(sharpenTexA);
    if (sharpenTexB) gl2.deleteTexture(sharpenTexB);
    if (sharpenFboA) gl2.deleteFramebuffer(sharpenFboA);
    if (sharpenFboB) gl2.deleteFramebuffer(sharpenFboB);
    if (curveTex) gl2.deleteTexture(curveTex);
    if (curveFbo) gl2.deleteFramebuffer(curveFbo);
    if (curveTexR) gl2.deleteTexture(curveTexR);
    if (curveTexG) gl2.deleteTexture(curveTexG);
    if (curveTexB) gl2.deleteTexture(curveTexB);
    if (slidersLutProg) gl2.deleteProgram(slidersLutProg);
    if (blurHProg) gl2.deleteProgram(blurHProg);
    if (blurVProg) gl2.deleteProgram(blurVProg);
    if (unsharpProg) gl2.deleteProgram(unsharpProg);
    if (curveProg) gl2.deleteProgram(curveProg);
    quadVao = sourceTex = lutTex = sharpenTexA = sharpenTexB = curveTex = null;
    sharpenFboA = sharpenFboB = curveFbo = null;
    curveTexR = curveTexG = curveTexB = null;
    slidersLutProg = blurHProg = blurVProg = unsharpProg = curveProg = null;
    ready2 = false;
  }
  return {
    init,
    setSource,
    setLut,
    setCurves,
    updateState,
    render,
    destroy,
    get ready() {
      return ready2;
    }
  };
}
export {
  createWebGLPipeline
};
