/**
 * WebGL 2 editor pipeline for SnappyDo.
 *
 * Replaces the legacy canvas-2D + JS pixel-pass + Web Worker LUT pipeline
 * with a fully GPU-resident pipeline. Targets WebGL 2 (universal support,
 * 3D textures, full GLSL ES 3.00) — no WebGPU for now (over-engineering for
 * this workload).
 *
 * Architecture:
 *   - Source texture: sourceImage pixels uploaded once per source load
 *   - LUT cube 3D texture: uploaded once per LUT selection
 *   - Programs:
 *       1. slidersLutProgram  — apply exposure/contrast/... + trilinear LUT
 *          sample + intensity mix. Outputs to canvas (default) or FBO.
 *       2. blurHProgram       — horizontal Gaussian blur (separable sharpen)
 *       3. blurVProgram       — vertical Gaussian blur
 *       4. unsharpProgram     — combines source - blur with sharpen amount
 *   - FBO ping-pong for blur passes (WebGL requires read != write for
 *     same texture, so we use two textures)
 *
 * Performance targets:
 *   - LUT pass: 250ms (JS) → ~1ms (GPU fragment shader)
 *   - Slider pass: 30ms (filter) → ~1ms (GPU fragment shader)
 *   - Sharpen: 600ms (JS first run) → ~2ms (GPU)
 *   - Net per-slider-tick: ~5ms (target)
 *
 * Robustness:
 *   - init() returns null if WebGL 2 unavailable (Safari < 15.4, old iOS,
 *     some embedded browsers). Caller should fall back to legacy pipeline.
 *   - All textures/programs released in destroy() to avoid leaks.
 *   - Float texture linear filtering not guaranteed on all WebGL 2 drivers;
 *     we use unsigned-byte LUT (8-bit per channel) which is universally
 *     supported with linear filtering on 3D textures (RGBA8 + LINEAR).
 *
 * Lazy texture uploads:
 *   - Source texture is created in setSource(), kept until destroy()
 *   - LUT texture is created in setLut(), rebuilt only when LUT changes
 *   - Sliders uniforms updated each render() call (cheap, just gl.uniformX)
 *
 * Coordinate convention: all textures are TEXTURE_2D with origin at
 * bottom-left in WebGL. The full-screen quad is rendered with two
 * triangles covering [-1, 1]^2 in clip space. Vertex positions are
 * computed once and uploaded at program creation.
 */

// ─── Shader sources ───────────────────────────────────────────────────

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

// Fragment shader: sliders + 3D LUT sample + intensity mix.
// Equivalent to the legacy applySlidersToRgba + applyLutToRgba chain, all
// in one fragment pass.
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
  float satFactor = max(0.0, 1.0 + uSaturation / 100.0); // -100 → 0, 0 → 1, +100 → 2
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

// Fragment shader: horizontal Gaussian blur (separable, σ ≈ 1.0).
const BLUR_H_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uTexelSize;  // (1/w, 1/h)

void main() {
  vec3 sum = vec3(0.0);
  // 9-tap Gaussian, σ ≈ 1.0
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

// Fragment shader: vertical Gaussian blur (separable, σ ≈ 1.0).
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

// Frag shader: unsharp mask — combines source + (source - blur) * amount.
// Equivalent to the JS getSharpenedSource() output.
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

// ─── Main pipeline ────────────────────────────────────────────────────

function createWebGLPipeline() {
  let gl = null;
  let canvasRef = null;
  let ready = false;

  // Programs
  let slidersLutProg = null;
  let blurHProg = null;
  let blurVProg = null;
  let unsharpProg = null;

  // Vertex array for full-screen quad
  let quadVao = null;

  // Textures
  let sourceTex = null;
  let lutTex = null;
  let sharpenTexA = null;  // ping
  let sharpenTexB = null;  // pong
  let sharpenFboA = null;  // writes to A
  let sharpenFboB = null;  // writes to B

  // Texture dimensions (source dimensions, used to size FBO and uniforms)
  let sourceW = 0;
  let sourceH = 0;

  // Cached state (last values uploaded — avoid redundant uniform updates)
  const lastState = {
    exposure: 0, contrast: 0, brightness: 0, saturation: 0,
    temp: 0, tint: 0, sharpen: 0, lut_id: 0, lut_intensity: 0,
  };

  // ── Helpers ──

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('createShader failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('shader compile failed: ' + log);
    }
    return shader;
  }

  function createProgram(vert, frag) {
    const v = compileShader(gl.VERTEX_SHADER, vert);
    const f = compileShader(gl.FRAGMENT_SHADER, frag);
    const prog = gl.createProgram();
    if (!prog) throw new Error('createProgram failed');
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('program link failed: ' + log);
    }
    // Clean up the now-linked shader objects
    gl.detachShader(prog, v);
    gl.detachShader(prog, f);
    gl.deleteShader(v);
    gl.deleteShader(f);
    return prog;
  }

  function setupQuad() {
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    gl.bindVertexArray(vao);
    quadVao = vao;

    // Two triangles covering [-1, 1]^2 in clip space, with UVs [0, 1].
    // Note: WebGL UV origin is bottom-left, but our textures are flipped
    // (uploaded with UNPACK_FLIP_Y_WEBGL = true for source; not for LUT
    // which has its own coordinate system).
    const verts = new Float32Array([
      // x, y, u, v
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
      -1,  1, 0, 1,
       1, -1, 1, 0,
       1,  1, 1, 1,
    ]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    // Position attribute (location 0 in shader)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    // UV attribute (location 1)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    gl.bindVertexArray(null);
  }

  function createColorTex(w, h, internalFmt, fmt, type) {
    const tex = gl.createTexture();
    if (!tex) throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, fmt, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function attachFbo(tex) {
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('createFramebuffer failed');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('framebuffer incomplete: 0x' + status.toString(16));
    }
    return fbo;
  }

  function init(canvas) {
    canvasRef = canvas;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: false, premultipliedAlpha: false,
      });
      if (!gl) return false;

      // Float texture linear filtering extension check. We use 8-bit LUT
      // to avoid needing this. Float *color* textures (RGBA16F) might need
      // OES_texture_half_float_linear for linear filtering on some
      // platforms. With 8-bit, no extension needed.

      // Compile programs
      slidersLutProg = createProgram(VERT_SRC, SLIDERS_LUT_FRAG);
      blurHProg = createProgram(VERT_SRC, BLUR_H_FRAG);
      blurVProg = createProgram(VERT_SRC, BLUR_V_FRAG);
      unsharpProg = createProgram(VERT_SRC, UNSHARP_FRAG);

      setupQuad();
      ready = true;
      return true;
    } catch (e) {
      console.warn('WebGL pipeline init failed:', e);
      ready = false;
      return false;
    }
  }

  function setSource(image) {
    if (!ready || !gl) return;
    sourceW = (image).naturalWidth || (image).width;
    sourceH = (image).naturalHeight || (image).height;
    window._dbgSW = sourceW; window._dbgSH = sourceH;
    if (sourceTex) gl.deleteTexture(sourceTex);
    sourceTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);  // canvas convention: top-left origin
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const dbgFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, dbgFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sourceTex, 0);
    const srcStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    const srcPx = new Uint8Array(4);
    if (srcStatus === gl.FRAMEBUFFER_COMPLETE) {
      gl.readPixels(Math.floor(sourceW/2), Math.floor(sourceH/2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, srcPx);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(dbgFBO);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Rebuild sharpen ping-pong textures + FBOs at source res.
    if (sharpenTexA) gl.deleteTexture(sharpenTexA);
    if (sharpenTexB) gl.deleteTexture(sharpenTexB);
    if (sharpenFboA) gl.deleteFramebuffer(sharpenFboA);
    if (sharpenFboB) gl.deleteFramebuffer(sharpenFboB);
    sharpenTexA = createColorTex(sourceW, sourceH, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE);
    sharpenTexB = createColorTex(sourceW, sourceH, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE);
    sharpenFboA = attachFbo(sharpenTexA);
    sharpenFboB = attachFbo(sharpenTexB);
  }

  function setLut(lut) {
    if (!ready || !gl) return;
    const { data, size } = lut;
    // Pack RGB float/uint8 data into RGBA8 (unified format, alpha = 255).
    // The .cube-file format we use stores size*size*size cells flat
    // array of RGB triples (size*size*size * 3 = 32*32*32*3 = 98304 floats).
    // WebGL2 3D textures expect RGBA. We allocate alpha = 255 and read the
    // texture in the shader (using .rgb).
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
      // data is Uint8Array — already 0..255 per channel
      for (let i = 0; i < cellCount; i++) {
        rgba[i * 4] = data[i * 3];
        rgba[i * 4 + 1] = data[i * 3 + 1];
        rgba[i * 4 + 2] = data[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
    }

    if (lutTex) gl.deleteTexture(lutTex);
    lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lutTex);
    // No UNPACK_FLIP_Y for 3D textures (no flip applies to volume data).
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
  }

  function updateState(state) {
    // Default missing keys to 0 — undefined would otherwise become NaN
    // when divided by 100 in the shader, producing black output.
    Object.assign(lastState, {
      exposure: state.exposure || 0,
      contrast: state.contrast || 0,
      brightness: state.brightness || 0,
      saturation: state.saturation || 0,
      temp: state.temp || 0,
      tint: state.tint || 0,
      sharpen: state.sharpen || 0,
      lut_id: state.lut_id || 0,
      lut_intensity: state.lut_intensity || 0,
    });
  }

  function runPass(
    prog,
    uniforms,
    targetFbo,
    width,
    height,
  ) {
    if (!gl) return;
    gl.useProgram(prog);
    gl.bindVertexArray(quadVao);
    gl.viewport(0, 0, width, height);
    if (targetFbo) gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    uniforms();
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function render() {
    if (!ready || !gl || !canvasRef) return;
    const ctx = gl;
    const w = canvasRef.width;
    const h = canvasRef.height;

    // Sharpen pipeline: only if sharpen > 0. Source → blur → unsharp.
    // Output: texture containing sharpened image.
    // If sharpen = 0, the sliders-LUT pass reads directly from sourceTex.
    let outputTex = sourceTex;
    if (lastState.sharpen > 0 && sharpenTexA && sharpenTexB && sharpenFboA && sharpenFboB) {
      const amount = Math.max(0, Math.min(1, lastState.sharpen / 100));
      // Pass 1: horizontal blur of source → texA
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      runPass(blurHProg, () => {
        gl.uniform1i(gl.getUniformLocation(blurHProg, 'uSource'), 0);
        gl.uniform2f(gl.getUniformLocation(blurHProg, 'uTexelSize'),
          1 / sourceW, 1 / sourceH);
      }, sharpenFboA, sourceW, sourceH);

      // Pass 2: vertical blur of texA → texB
      gl.bindTexture(gl.TEXTURE_2D, sharpenTexA);
      runPass(blurVProg, () => {
        gl.uniform1i(gl.getUniformLocation(blurVProg, 'uSource'), 0);
        gl.uniform2f(gl.getUniformLocation(blurVProg, 'uTexelSize'),
          1 / sourceW, 1 / sourceH);
      }, sharpenFboB, sourceW, sourceH);

      // Pass 3: unsharp mask (source - blurredB) * amount + source → texA
      // This writes back to texA (ping-pong: texA is the "next output" after this pass)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, sharpenTexB);
      runPass(unsharpProg, () => {
        gl.uniform1i(gl.getUniformLocation(unsharpProg, 'uSource'), 0);
        gl.uniform1i(gl.getUniformLocation(unsharpProg, 'uBlur'), 2);
        gl.uniform1f(gl.getUniformLocation(unsharpProg, 'uAmount'), amount);
      }, sharpenFboA, sourceW, sourceH);

      // texA now holds the sharpened result
      outputTex = sharpenTexA;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, outputTex);
    } else {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    }

    // Sliders + LUT → canvas
    // Bind LUT texture to TEXTURE1 (always, even if no LUT — shader
    // samples will just clamp to the edge of whatever's bound)
    gl.activeTexture(gl.TEXTURE1);
    if (lutTex) gl.bindTexture(gl.TEXTURE_3D, lutTex);
    gl.activeTexture(gl.TEXTURE0);

    runPass(slidersLutProg, () => {
      const p = slidersLutProg;
      gl.uniform1i(gl.getUniformLocation(p, 'uSource'), 0);
      gl.uniform1i(gl.getUniformLocation(p, 'uLut'), 1);
      gl.uniform1f(gl.getUniformLocation(p, 'uLutSize'), 32);
      gl.uniform1f(gl.getUniformLocation(p, 'uLutIntensity'),
        Math.max(0, Math.min(1, lastState.lut_intensity / 100)));
      gl.uniform1f(gl.getUniformLocation(p, 'uExposure'), lastState.exposure);
      gl.uniform1f(gl.getUniformLocation(p, 'uContrast'), lastState.contrast);
      gl.uniform1f(gl.getUniformLocation(p, 'uBrightness'), lastState.brightness);
      gl.uniform1f(gl.getUniformLocation(p, 'uSaturation'), lastState.saturation);
      gl.uniform1f(gl.getUniformLocation(p, 'uTemp'), lastState.temp);
      gl.uniform1f(gl.getUniformLocation(p, 'uTint'), lastState.tint);
    }, null, w, h);

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function destroy() {
    if (!gl) return;
    if (quadVao) gl.deleteVertexArray(quadVao);
    if (sourceTex) gl.deleteTexture(sourceTex);
    if (lutTex) gl.deleteTexture(lutTex);
    if (sharpenTexA) gl.deleteTexture(sharpenTexA);
    if (sharpenTexB) gl.deleteTexture(sharpenTexB);
    if (sharpenFboA) gl.deleteFramebuffer(sharpenFboA);
    if (sharpenFboB) gl.deleteFramebuffer(sharpenFboB);
    if (slidersLutProg) gl.deleteProgram(slidersLutProg);
    if (blurHProg) gl.deleteProgram(blurHProg);
    if (blurVProg) gl.deleteProgram(blurVProg);
    if (unsharpProg) gl.deleteProgram(unsharpProg);
    quadVao = sourceTex = lutTex = sharpenTexA = sharpenTexB = null;
    sharpenFboA = sharpenFboB = null;
    slidersLutProg = blurHProg = blurVProg = unsharpProg = null;
    ready = false;
  }

  return { init, setSource, setLut, updateState, render, destroy,
           get ready() { return ready; } };
}


// ─── Module exports (browser-friendly) ─────────────────────────────────
export { createWebGLPipeline };
