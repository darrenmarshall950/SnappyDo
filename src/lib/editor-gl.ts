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
uniform float uStraightenAngle; // -45..45 degrees
uniform float uCropX;          // 0..1, crop after straighten
uniform float uCropY;
uniform float uCropW;
uniform float uCropH;

// ── Chromatic Aberration ──────────────────────────────────────────────
uniform float uCAStrength;   // 0..100
uniform float uCAX;          // -1..1
uniform float uCAY;          // -1..1
uniform float uVignette;     // 0..100, darken at edges
uniform float uHighlights;    // -100..100, brighten/darken highlights
uniform float uShadows;       // -100..100, brighten/darken shadows
uniform float uWhites;        // -100..100, shift white point
uniform float uBlacks;        // -100..100, shift black point

// Rotate UV around center by angle in degrees
vec2 rotateUv(vec2 uv, float angleDeg) {
  float a = angleDeg * 0.01745329251;
  float s = sin(a), c = cos(a);
  uv -= 0.5;
  uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
  return uv + 0.5;
}

vec2 applyStraightenAndCrop(vec2 uv) {
  if (abs(uStraightenAngle) > 0.01) {
    uv = rotateUv(uv, uStraightenAngle);
  }
  if (uCropW > 0.0 && uCropH > 0.0) {
    // Crop is specified in SOURCE UV. vUv is the canvas fragment position
    // normalised to [0,1] which in fit mode equals source UV (canvas aspect
    // matches source aspect). Sample source at vUv directly so only the
    // cropped source region is rendered, preserving aspect.
    if (uv.x < uCropX || uv.x > uCropX + uCropW ||
        uv.y < uCropY || uv.y > uCropY + uCropH) {
      return vec2(-1.0);
    }
  }
  return clamp(uv, 0.0, 1.0);
}

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

  // Tone-region adjustments (Lightroom-style).
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float shadowsMask = 1.0 - smoothstep(0.0, 0.35, lum);
  float highlightsMask = smoothstep(0.65, 1.0, lum);

  // Shadows slider: positive lifts shadows, negative darkens
  if (uShadows != 0.0) {
    float sh = uShadows / 100.0 * 0.5;
    c += sh * shadowsMask;
  }
  // Highlights slider: positive brightens, negative darkens
  if (uHighlights != 0.0) {
    float hi = uHighlights / 100.0 * 0.5;
    c += hi * highlightsMask;
  }
  // Whites: shift white point globally toward c.r=1 (positive) or c.r=0 (negative)
  if (uWhites != 0.0) {
    float w = uWhites / 100.0 * 0.3;
    // Apply proportional to how bright the pixel is
    float wMask = smoothstep(0.4, 1.0, lum);
    c += w * wMask;
  }
  // Blacks: shift black point toward 0 (negative) or lift (positive)
  if (uBlacks != 0.0) {
    float b = uBlacks / 100.0 * 0.3;
    float bMask = 1.0 - smoothstep(0.0, 0.6, lum);
    c += b * bMask;
  }

  return clamp(c, 0.0, 1.0);
}

void main() {
  vec2 uv = applyStraightenAndCrop(vUv);
  if (uv.x < 0.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 caOffset = vec2(0.0);
  if (uCAStrength > 0.0) {
    float strength = uCAStrength / 100.0;
    caOffset = strength * 0.006 * vec2(uCAX, uCAY);
  }
  vec2 uvR = clamp(uv + caOffset, 0.0, 1.0);
  vec2 uvB = clamp(uv - caOffset, 0.0, 1.0);
  float r = texture(uSource, uvR).r;
  float g = texture(uSource, uv).g;
  float b = texture(uSource, uvB).b;
  vec3 src = vec3(r, g, b);
  vec3 adjusted = applySliders(src);
  // Sample 3D LUT. Clamp to ensure 0..1 even after slider overshoot,
  // since LUT cube indices are 0..size-1.
  vec3 clamped = clamp(adjusted, 0.0, 1.0);
  // 3D texture sample: uvw maps to cube coordinates. Linear filtering
  // gives us trilinear interpolation between 8 corners automatically.
  vec3 lutResult = texture(uLut, clamped).rgb;
  // Mix sliders+LUT result with the slider-only result based on intensity.
  vec3 outColor = mix(adjusted, lutResult, uLutIntensity);

  // Vignette: darken at edges. Compute distance from center of vUv (assumes
  // canvas is centered on source UV). Strength 0..100 maps to 0..0.9 darkening.
  if (uVignette > 0.0) {
    // Aspect-correct distance: account for canvas aspect so the vignette
    // is circular, not elliptical. Use a 'shorter axis' reference.
    vec2 d = vUv - 0.5;
    float r = length(d);
    // At strength 100, factor at corner r=0.707 is ~0.30 (darken to 30%).
    // Smooth ramp from 0 at center to full at corner.
    float vig = 1.0 - smoothstep(0.2, 0.8, r) * (uVignette / 100.0) * 0.85;
    outColor *= vig;
  }

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


// ─── Curve pass fragment shader ────────────────────────────────────────────
// Per-channel tone curves using three 256x1 2D textures as 1D LUTs.
// Applied AFTER sliders-LUT pass (linear-light position, before saturation).
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


// ─── HSL Color Mixer + Color Grading + Split Toning + Effects ────────────
// Applied AFTER the curve pass. Handles per-range HSL adjustments,
// Lightroom-style three-way color grading, split toning, grain, dehaze.
const HSL_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;

// ── Time for grain animation ─────────────────────────────────────────────────
uniform float uTime;

// ── Split Toning ─────────────────────────────────────────────────────────────
uniform float uStShadowsHue;
uniform float uStShadowsSat;
uniform float uStHighlightsHue;
uniform float uStHighlightsSat;
uniform float uStBalance;

// ── Grain ────────────────────────────────────────────────────────────────────
uniform float uGrainAmount;
uniform float uGrainSize;
uniform vec2  uTexelSize;

// ── Dehaze ───────────────────────────────────────────────────────────────────
uniform float uDehaze;

// ── HSL helpers ─────────────────────────────────────────────────────────────
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float s = 0.0;
  float h = 0.0;
  if (mx != mn) {
    float d = mx - mn;
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}

vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x;
  float s = hsl.y;
  float l = hsl.z;
  if (s < 1e-5) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  float r = fract(h + 1.0/3.0);
  float g = fract(h);
  float b = fract(h - 1.0/3.0);
  r = r < 0.0 ? r + 1.0 : (r > 1.0 ? r - 1.0 : r);
  b = b < 0.0 ? b + 1.0 : (b > 1.0 ? b - 1.0 : b);
  vec3 c;
  c.r = r < 1.0/6.0 ? p + (q - p) * 6.0 * r :
        r < 0.5 ? q :
        r < 2.0/3.0 ? p + (q - p) * (2.0/3.0 - r) * 6.0 : p;
  c.g = g < 1.0/6.0 ? p + (q - p) * 6.0 * g :
        g < 0.5 ? q :
        g < 2.0/3.0 ? p + (q - p) * (2.0/3.0 - g) * 6.0 : p;
  c.b = b < 1.0/6.0 ? p + (q - p) * 6.0 * b :
        b < 0.5 ? q :
        b < 2.0/3.0 ? p + (q - p) * (2.0/3.0 - b) * 6.0 : p;
  return clamp(c, 0.0, 1.0);
}

float hueDist(float h1, float h2) {
  float d = abs(h2 - h1);
  return d > 0.5 ? 1.0 - d : d;
}

vec3 adjustRange(vec3 hsl, float centerH, float range, float dH, float dS, float dL) {
  float d = hueDist(hsl.x, centerH);
  float w = 1.0 - smoothstep(0.0, range, d);
  hsl.x = fract(hsl.x + dH * w);
  hsl.y = clamp(hsl.y + dS * w, 0.0, 1.0);
  hsl.z = clamp(hsl.z + dL * w, 0.0, 1.0);
  return hsl;
}

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// ── Color grading ───────────────────────────────────────────────────────────
uniform vec3  uCgShadowsColour;
uniform vec3  uCgMidtonesColour;
uniform vec3  uCgHighlightsColour;
uniform vec3  uCgGlobalColour;
uniform float uCgShadowsIntensity;
uniform float uCgMidtonesIntensity;
uniform float uCgHighlightsIntensity;
uniform float uCgGlobalIntensity;
uniform int   uCgMode;

vec3 applyColorGrading(vec3 c) {
  float lum = luminance(c);
  float shadowsMask = 1.0 - smoothstep(0.0, 0.35, lum);
  float highlightsMask = smoothstep(0.65, 1.0, lum);
  float midtonesMask = clamp(1.0 - shadowsMask - highlightsMask, 0.0, 1.0);

  float shI = uCgShadowsIntensity / 100.0;
  float miI = uCgMidtonesIntensity / 100.0;
  float hiI = uCgHighlightsIntensity / 100.0;
  float glI = uCgGlobalIntensity / 100.0;

  if (shI > 0.0 || miI > 0.0 || hiI > 0.0 || glI > 0.0) {
    vec3 tint = vec3(0.0);
    if (shI > 0.0) tint += uCgShadowsColour * shadowsMask * shI;
    if (miI > 0.0) tint += uCgMidtonesColour * midtonesMask * miI;
    if (hiI > 0.0) tint += uCgHighlightsColour * highlightsMask * hiI;

    if (uCgMode == 0) {
      c = mix(c, c + tint * 0.5, clamp(length(tint), 0.0, 1.0));
    } else {
      c += tint;
    }
    if (glI > 0.0) {
      c += uCgGlobalColour * glI * 0.5;
    }
  }
  return c;
}

uniform float uHslRed_h; uniform float uHslRed_s; uniform float uHslRed_l;
uniform float uHslOrange_h; uniform float uHslOrange_s; uniform float uHslOrange_l;
uniform float uHslYellow_h; uniform float uHslYellow_s; uniform float uHslYellow_l;
uniform float uHslGreen_h; uniform float uHslGreen_s; uniform float uHslGreen_l;
uniform float uHslAqua_h; uniform float uHslAqua_s; uniform float uHslAqua_l;
uniform float uHslBlue_h; uniform float uHslBlue_s; uniform float uHslBlue_l;
uniform float uHslPurple_h; uniform float uHslPurple_s; uniform float uHslPurple_l;
uniform float uHslMagenta_h; uniform float uHslMagenta_s; uniform float uHslMagenta_l;
uniform bool  uHslActive;

void main() {
  vec3 c = texture(uSource, vUv).rgb;

  if (uHslActive) {
    vec3 hsl = rgb2hsl(c);
    float range = 0.125;
    hsl = adjustRange(hsl, 0.0/8.0, range, uHslRed_h,    uHslRed_s,    uHslRed_l);
    hsl = adjustRange(hsl, 1.0/8.0, range, uHslOrange_h, uHslOrange_s, uHslOrange_l);
    hsl = adjustRange(hsl, 2.0/8.0, range, uHslYellow_h, uHslYellow_s, uHslYellow_l);
    hsl = adjustRange(hsl, 3.0/8.0, range, uHslGreen_h,   uHslGreen_s,   uHslGreen_l);
    hsl = adjustRange(hsl, 4.0/8.0, range, uHslAqua_h,   uHslAqua_s,   uHslAqua_l);
    hsl = adjustRange(hsl, 5.0/8.0, range, uHslBlue_h,   uHslBlue_s,   uHslBlue_l);
    hsl = adjustRange(hsl, 6.0/8.0, range, uHslPurple_h, uHslPurple_s, uHslPurple_l);
    hsl = adjustRange(hsl, 7.0/8.0, range, uHslMagenta_h, uHslMagenta_s, uHslMagenta_l);
    c = hsl2rgb(hsl);
  }

  c = applyColorGrading(c);

  // ── Split Toning ─────────────────────────────────────────────────────────
  if (uStShadowsSat > 0.0 || uStHighlightsSat > 0.0 || uStBalance != 0.0) {
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    float pivot = 0.35 + uStBalance * 0.003;
    float hlRatio = smoothstep(pivot - 0.1, pivot + 0.1, luma);

    float shH = fract(uStShadowsHue / 360.0);
    float shS = uStShadowsSat / 100.0;
    vec3 shadowTint = hsl2rgb(vec3(shH, shS, 0.5));

    float hiH = fract(uStHighlightsHue / 360.0);
    float hiS = uStHighlightsSat / 100.0;
    vec3 highlightTint = hsl2rgb(vec3(hiH, hiS, 0.5));

    vec3 tint = mix(shadowTint, highlightTint, hlRatio);
    float avgSat = (uStShadowsSat + uStHighlightsSat) / 200.0;
    float blend = avgSat * 0.5;
    c = c + (tint - 0.5) * blend;
  }

  // ── Dehaze ───────────────────────────────────────────────────────────────
  if (uDehaze != 0.0) {
    float haze = min(c.r, min(c.g, c.b));
    float hazeAmount = uDehaze * 0.003 * haze;
    c = c - hazeAmount;
  }

  // ── Grain (Lightroom-style: subtle, shadow-biased, size affects particle scale not intensity) ──
  if (uGrainAmount > 0.0) {
    // Size controls grain particle scale: size=0 → 1 px particles, size=100 → ~4 px particles.
    // Round to nearest INTEGER block size so every pixel lands cleanly in a bucket — non-integer
    // scales cause inconsistent bucket widths and produce visible bands/stripes across the image.
    float grainScale = max(1.0, floor(1.0 + uGrainSize / 33.333 + 0.5));
    vec2 grainPx = floor(vUv / uTexelSize / grainScale);
    float seed = dot(grainPx, vec2(12.9898, 78.233)) + uTime;
    // Hash the seed to break up any low-frequency banding from the sin() pattern
    float noise = fract(sin(seed) * 43758.5453 + sin(seed * 1.731) * 12345.6789) - 0.5;
    // Luma weighting: more grain in shadows/midtones, less in highlights (Lightroom behaviour)
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    float grainWeight = mix(1.0, 0.35, luma);
    // Amount 100 produces a moderate ~7-10% max-intensity grain at default size
    float g = noise * (uGrainAmount / 100.0) * 0.18 * grainWeight;
    c = c + g;
  }

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;


// ─── Calibration (Camera Profile) ─────────────────────────────────────
// Final pass: applies shadow tint hue shift + global saturation boost.
const CALIBRATION_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform float uShadowTint;  // -100..+100 (0=neutral)
uniform float uCalSat;      // 0..100 extra saturation

void main() {
  vec3 c = texture(uSource, vUv).rgb;

  // Shadow tint: shift hue in shadows only
  if (abs(uShadowTint) > 0.1) {
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    float shadowMask = 1.0 - smoothstep(0.0, 0.4, luma);
    float amount = uShadowTint / 100.0 * shadowMask * 0.5;
    c.r += amount * 0.5;
    c.g -= amount * 0.3;
    c.b += amount * 0.5;
  }

  // Calibration saturation
  if (uCalSat > 0.0) {
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    float satFactor = 1.0 + uCalSat / 100.0;
    c = mix(vec3(luma), c, satFactor);
  }

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

// ─── Main pipeline ────────────────────────────────────────────────────

export interface CurvePoint { 0: number; 1: number; }
export type CurveChannel = CurvePoint[];
export interface CurveData { rgb: CurveChannel; r: CurveChannel; g: CurveChannel; b: CurveChannel; }

export interface HslRange { h: number; s: number; l: number; }

export interface ColorGradingData {
  shadows_colour: number[];    // [r, g, b] 0..255
  midtones_colour: number[];
  highlights_colour: number[];
  global_colour: number[];
  shadows_intensity: number;   // 0..100
  midtones_intensity: number;
  highlights_intensity: number;
  global_intensity: number;
  mode: 'saturation' | 'luminance';
}

export interface SplitToningData {
  shadows_hue: number;
  shadows_saturation: number;
  highlights_hue: number;
  highlights_saturation: number;
  balance: number;
}

export interface GrainData {
  amount: number;
  size: number;
}

export interface WebGLPipelineState {
  exposure: number;
  contrast: number;
  brightness: number;
  saturation: number;
  temp: number;
  tint: number;
  sharpen: number;     // 0..100
  lut_id: number;
  lut_intensity: number;
  straighten: number;   // -45..45 degrees
  cropX: number; cropY: number; cropW: number; cropH: number; // 0..1
  /** Curve control points per channel. Null/empty = identity (no-op). */
  curve?: { rgb?: CurveChannel; r?: CurveChannel; g?: CurveChannel; b?: CurveChannel; } | null;
  /** HSL Color Mixer — per-range H/S/L offsets in -100..100. */
  hsl?: Record<string, HslRange>;
  /** Lightroom-style color grading. */
  colorGrading?: ColorGradingData;
  /** Split Toning. */
  splitToning?: SplitToningData;
  /** Film Grain. */
  grain?: GrainData;
  /** Dehaze (-100 to +100). */
  dehaze?: number;
  /** Lens corrections. */
  lens_corrections?: {
    enabled?: boolean;
    remove_baseline_exposure?: number;  // -5..+5
    chromatic_aberration?: number;        // 0..100
    chromatic_aberration_x?: number;      // -1..1
    chromatic_aberration_y?: number;       // -1..1
  };
  /** Calibration (Camera Profile). */
  calibration?: {
    shadow_tint?: number;   // -100..+100
    saturation?: number;    // 0..100
  };
  /** Vignette: 0..100 (0 = no vignette, 100 = strong). */
  vignette?: number;
  highlights?: number;   // -100..100
  shadows?: number;      // -100..100
  whites?: number;       // -100..100
  blacks?: number;       // -100..100
}

export interface WebGLPipeline {
  /** Initialise WebGL context + programs. Returns null if unavailable. */
  init(canvas: HTMLCanvasElement): boolean;
  /** Upload source image as a 2D texture (called once on source load). */
  setSource(image: HTMLImageElement | HTMLCanvasElement | ImageBitmap): void;
  /** Upload LUT data as a 3D texture (called once per LUT selection). */
  setLut(lut: { data: Float32Array | Uint8Array; size: number }): void;
  /** Upload curve LUT textures. Called whenever curve data changes. */
  setCurves(curves: CurveData): void;
  /** Upload HSL Color Mixer + Color Grading state. */
  setHsl(hslData: Record<string, HslRange>, colorGrading?: ColorGradingData): void;
  /** Update render state. Called on every slider change. */
  updateState(state: Partial<WebGLPipelineState>): void;
  /** Render the pipeline to the canvas. No-op if init() returned false. */
  render(): void;
  /** Free GPU resources. Call on page unload. */
  destroy(): void;
  /** True if init succeeded and pipeline is ready. */
  ready: boolean;
}

export function createWebGLPipeline(): WebGLPipeline {

  // ─── Curve resources ────────────────────────────────────────────────────────
  // Three 256x1 2D textures acting as 1D LUTs for R, G, B.
  let curveTexR: WebGLTexture | null = null;
  let curveTexG: WebGLTexture | null = null;
  let curveTexB: WebGLTexture | null = null;
  // FBO + texture to hold sliders-LUT output before the curve pass.
  let curveFbo: WebGLFramebuffer | null = null;
  let curveTex: WebGLTexture | null = null;   // RGBA8, canvas size
  let postCurveTex: WebGLTexture | null = null; // RGBA8, holds pass-2 (curve) output
  let postCurveFbo: WebGLFramebuffer | null = null;
  // True when all channels are identity — skips the curve pass.
  let curveIsIdentity = true;

  // HSL program + FBO
  let hslProg: WebGLProgram | null = null;
  let hslFbo: WebGLFramebuffer | null = null;
  let hslTex: WebGLTexture | null = null;
  // True when all HSL values are zero — skips the hsl pass.
  let hslIsFlat = true;

  // Calibration (Camera Profile) program
  let calibProg: WebGLProgram | null = null;
  let calibIsFlat = true;

  // Pre-built identity LUT: lut[i] = i/255.
  const _identityLut = new Float32Array(256);
  for (let i = 0; i < 256; i++) _identityLut[i] = i / 255;

  // ─── Curve helpers ──────────────────────────────────────────────────────
  function _buildLut(ch: CurveChannel | undefined): Float32Array {
    if (!ch || ch.length === 0) return new Float32Array(_identityLut);
    const pts = [...ch].sort((a, b) => a[0] - b[0]) as CurveChannel;
    const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
    const lut = new Float32Array(256);
    for (let x = 0; x < 256; x++) {
      if (x <= x0) { lut[x] = pts[0][1] / 255; continue; }
      if (x >= x1) { lut[x] = pts[pts.length - 1][1] / 255; continue; }
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid][0] <= x) lo = mid; else hi = mid;
      }
      const xLo = pts[lo][0], yLo = pts[lo][1];
      const xHi = pts[hi][0], yHi = pts[hi][1];
      const t = (xHi === xLo) ? 0 : (x - xLo) / (xHi - xLo);
      lut[x] = (yLo + t * (yHi - yLo)) / 255;
    }
    return lut;
  }

  function _isIdentity(ch: CurveChannel | undefined): boolean {
    if (!ch || ch.length === 0) return true;
    if (ch.length === 2 && ch[0][0] === 0 && ch[0][1] === 0 &&
        ch[1][0] === 255 && ch[1][1] === 255) return true;
    return false;
  }

  function _uploadCurveTex(tex: WebGLTexture, lut: Float32Array) {
    if (!gl) return;
    const rgba = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const v = Math.max(0, Math.min(255, Math.round(lut[i] * 255)));
      rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function _float32Eq(a: Float32Array, b: Float32Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
    return true;
  }

  let _lastCurveR: Float32Array | null = null;
  let _lastCurveG: Float32Array | null = null;
  let _lastCurveB: Float32Array | null = null;

  // ── HSL + Color Grading state ─────────────────────────────────────────────
  function isEffectsFlat(): boolean {
    // HSL
    if (lastState.hsl) {
      for (const key of Object.keys(lastState.hsl)) {
        const r = lastState.hsl[key];
        if (Math.abs(r.h) > 1e-4 || Math.abs(r.s) > 1e-4 || Math.abs(r.l) > 1e-4) return false;
      }
    }
    // Color grading
    const cg = lastState.colorGrading;
    if (cg && (
      (cg.shadows_intensity ?? 0) !== 0 ||
      (cg.midtones_intensity ?? 0) !== 0 ||
      (cg.highlights_intensity ?? 0) !== 0 ||
      (cg.global_intensity ?? 0) !== 0
    )) return false;
    // Split toning
    const st = lastState.splitToning;
    if (st && (
      Math.abs(st.shadows_hue) > 1e-4 ||
      Math.abs(st.shadows_saturation) > 1e-4 ||
      Math.abs(st.highlights_hue) > 1e-4 ||
      Math.abs(st.highlights_saturation) > 1e-4 ||
      Math.abs(st.balance) > 1e-4
    )) return false;
    // Grain
    const gr = lastState.grain;
    if (gr && Math.abs(gr.amount) > 1e-4) return false;
    // Dehaze
    if (lastState.dehaze && Math.abs(lastState.dehaze) > 1e-4) return false;
    return true;
  }

  function setHsl(hslData: Record<string, HslRange>, colorGrading?: ColorGradingData) {
    if (!ready || !gl) return;
    // Update lastState so render() picks up the new values via isEffectsFlat()
    lastState.hsl = hslData;
    if (colorGrading) lastState.colorGrading = colorGrading;
  }

  function setSplitToning(st: SplitToningData) {
    if (!ready || !gl) return;
    lastState.splitToning = st;
  }

  function setGrain(gr: GrainData) {
    if (!ready || !gl) return;
    lastState.grain = gr;
  }

  function setCurves(curves: CurveData) {
    if (!ready || !gl) return;
    if (!curveTexR) { curveTexR = gl.createTexture()!; }
    if (!curveTexG) { curveTexG = gl.createTexture()!; }
    if (!curveTexB) { curveTexB = gl.createTexture()!; }
    const chR = curves?.r, chG = curves?.g, chB = curves?.b;
    curveIsIdentity = _isIdentity(chR) && _isIdentity(chG) && _isIdentity(chB);
    const lutR = _buildLut(curveIsIdentity ? undefined : chR);
    const lutG = _buildLut(curveIsIdentity ? undefined : chG);
    const lutB = _buildLut(curveIsIdentity ? undefined : chB);
    if (!_lastCurveR || !_float32Eq(lutR, _lastCurveR)) { _uploadCurveTex(curveTexR, lutR); _lastCurveR = lutR; }
    if (!_lastCurveG || !_float32Eq(lutG, _lastCurveG)) { _uploadCurveTex(curveTexG, lutG); _lastCurveG = lutG; }
    if (!_lastCurveB || !_float32Eq(lutB, _lastCurveB)) { _uploadCurveTex(curveTexB, lutB); _lastCurveB = lutB; }
  }
  // ─── End of curve resources ─────────────────────────────────────────────

  let gl: WebGL2RenderingContext | null = null;
  let canvasRef: HTMLCanvasElement | null = null;
  let ready = false;

  // Programs
  let slidersLutProg: WebGLProgram | null = null;
  let blurHProg: WebGLProgram | null = null;
  let blurVProg: WebGLProgram | null = null;
  let unsharpProg: WebGLProgram | null = null;
  let curveProg: WebGLProgram | null = null;

  // Vertex array for full-screen quad
  let quadVao: WebGLVertexArrayObject | null = null;

  // Textures
  let sourceTex: WebGLTexture | null = null;
  let lutTex: WebGLTexture | null = null;
  let sharpenTexA: WebGLTexture | null = null;  // ping
  let sharpenTexB: WebGLTexture | null = null;  // pong
  let sharpenFboA: WebGLFramebuffer | null = null;  // writes to A
  let sharpenFboB: WebGLFramebuffer | null = null;  // writes to B

  // Texture dimensions (source dimensions, used to size FBO and uniforms)
  let sourceW = 0;
  let sourceH = 0;

  // Cached state (last values uploaded — avoid redundant uniform updates)
  const lastState: WebGLPipelineState = {
    exposure: 0, contrast: 0, brightness: 0, saturation: 0,
    temp: 0, tint: 0, sharpen: 0, lut_id: 0, lut_intensity: 0, vignette: 0,
    highlights: 0, shadows: 0, whites: 0, blacks: 0,
    straighten: 0,
    cropX: 0, cropY: 0, cropW: 0, cropH: 0,
    curve: undefined,
    hsl: undefined,
    colorGrading: undefined,
    splitToning: { shadows_hue: 0, shadows_saturation: 0, highlights_hue: 0, highlights_saturation: 0, balance: 0 },
    grain: { amount: 0, size: 25 },
    dehaze: 0,
  };

  // Cached HSL state for hsl pass uniforms
  let lastHslState: { hsl: Record<string, HslRange>; cg: ColorGradingData | undefined } = {
    hsl: {}, cg: undefined,
  };

  // ── Helpers ──

  function compileShader(type: number, source: string): WebGLShader {
    const shader = gl!.createShader(type);
    if (!shader) throw new Error('createShader failed');
    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
      const log = gl!.getShaderInfoLog(shader);
      gl!.deleteShader(shader);
      throw new Error('shader compile failed: ' + log);
    }
    return shader;
  }

  function createProgram(vert: string, frag: string): WebGLProgram {
    const v = compileShader(gl!.VERTEX_SHADER, vert);
    const f = compileShader(gl!.FRAGMENT_SHADER, frag);
    const prog = gl!.createProgram();
    if (!prog) throw new Error('createProgram failed');
    gl!.attachShader(prog, v);
    gl!.attachShader(prog, f);
    gl!.linkProgram(prog);
    if (!gl!.getProgramParameter(prog, gl!.LINK_STATUS)) {
      const log = gl!.getProgramInfoLog(prog);
      gl!.deleteProgram(prog);
      throw new Error('program link failed: ' + log);
    }
    // Clean up the now-linked shader objects
    gl!.detachShader(prog, v);
    gl!.detachShader(prog, f);
    gl!.deleteShader(v);
    gl!.deleteShader(f);
    return prog;
  }

  function setupQuad() {
    const vao = gl!.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    gl!.bindVertexArray(vao);
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
    const vbo = gl!.createBuffer();
    gl!.bindBuffer(gl!.ARRAY_BUFFER, vbo);
    gl!.bufferData(gl!.ARRAY_BUFFER, verts, gl!.STATIC_DRAW);

    // Position attribute (location 0 in shader)
    gl!.enableVertexAttribArray(0);
    gl!.vertexAttribPointer(0, 2, gl!.FLOAT, false, 16, 0);
    // UV attribute (location 1)
    gl!.enableVertexAttribArray(1);
    gl!.vertexAttribPointer(1, 2, gl!.FLOAT, false, 16, 8);

    gl!.bindVertexArray(null);
  }

  function createColorTex(w: number, h: number, internalFmt: number, fmt: number, type: number): WebGLTexture {
    const tex = gl!.createTexture();
    if (!tex) throw new Error('createTexture failed');
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, internalFmt, w, h, 0, fmt, type, null);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    return tex;
  }

  function attachFbo(tex: WebGLTexture): WebGLFramebuffer {
    const fbo = gl!.createFramebuffer();
    if (!fbo) throw new Error('createFramebuffer failed');
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0,
      gl!.TEXTURE_2D, tex, 0);
    const status = gl!.checkFramebufferStatus(gl!.FRAMEBUFFER);
    if (status !== gl!.FRAMEBUFFER_COMPLETE) {
      throw new Error('framebuffer incomplete: 0x' + status.toString(16));
    }
    return fbo;
  }

  function init(canvas: HTMLCanvasElement): boolean {
    canvasRef = canvas;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
        premultipliedAlpha: false,
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
      curveProg = createProgram(VERT_SRC, CURVE_FRAG);
      hslProg = createProgram(VERT_SRC, HSL_FRAG);
      calibProg = createProgram(VERT_SRC, CALIBRATION_FRAG);

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
    sourceW = (image as any).naturalWidth || (image as any).width;
    sourceH = (image as any).naturalHeight || (image as any).height;
    if (sourceTex) gl.deleteTexture(sourceTex);
    sourceTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);  // canvas convention: top-left origin
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image as any);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Rebuild sharpen ping-pong textures + FBOs at source res.
    if (sharpenTexA) gl.deleteTexture(sharpenTexA);
    if (sharpenTexB) gl.deleteTexture(sharpenTexB);
    if (sharpenFboA) gl.deleteFramebuffer(sharpenFboA);
    if (sharpenFboB) gl.deleteFramebuffer(sharpenFboB);
    // Sharpen textures are sized at the *canvas display size* (canvasRef.width ×
    // canvasRef.height), not the source resolution. The sliders-LUT pass that
    // consumes the sharpened output runs at canvas size too, so there's no
    // resolution mismatch. Allocating at source res (e.g. 4592×3448) caused the
    // sharpen slider to lag because three full-res GPU passes (blurH, blurV,
    // unsharp) were running per frame on swiftshader / mobile GPUs.
    const cw = canvasRef ? canvasRef.width : 1;
    const ch = canvasRef ? canvasRef.height : 1;
    sharpenTexA = createColorTex(cw, ch, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE);
    sharpenTexB = createColorTex(cw, ch, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE);
    sharpenFboA = attachFbo(sharpenTexA);
    sharpenFboB = attachFbo(sharpenTexB);
  }

  function setLut(lut) {
    if (!ready || !gl) return;
    const { data, size } = lut;
    // Pack RGB float/uint8 data into RGBA8 (unified format, alpha = 255).
    // The .cube-file format we use stores size*size*size cells as a flat
    // array of RGB triples (size*size*size * 3 = 32*32*32*3 = 98304 floats).
    // WebGL2 3D textures expect RGBA. We allocate alpha = 255 and read the
    // texture as RGB in the shader (using .rgb).
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

  function updateState(state: Partial<WebGLPipelineState>) {
    // Skip undefined values so we don't overwrite numeric state with NaN.
    // Object.assign would copy undefined keys through, which then becomes
    // NaN in division-based uniform calculations.
    for (const k in state) {
      const v = (state as any)[k];
      if (v !== undefined) (lastState as any)[k] = v;
    }
  }

  function runPass(
    prog: WebGLProgram,
    uniforms: () => void,
    targetFbo: WebGLFramebuffer | null,
    width: number,
    height: number,
    _label?: string,
  ) {
    if (!gl) return;
    gl.useProgram(prog);
    gl.bindVertexArray(quadVao);
    gl.viewport(0, 0, width, height);
    if (targetFbo) gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    uniforms();
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const _err = gl.getError();
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
      runPass(blurHProg!, () => {
        gl.uniform1i(gl.getUniformLocation(blurHProg, 'uSource'), 0);
        gl.uniform2f(gl.getUniformLocation(blurHProg, 'uTexelSize'),
          1 / sourceW, 1 / sourceH);
      }, sharpenFboA, sourceW, sourceH);

      // Pass 2: vertical blur of texA → texB
      gl.bindTexture(gl.TEXTURE_2D, sharpenTexA);
      runPass(blurVProg!, () => {
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
      runPass(unsharpProg!, () => {
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

    // ── Pass 1: sliders-LUT → curveFBO ─────────────────────────────────────
    // Lazy-allocate curveFBO at canvas size.
    if (!curveFbo || !curveTex || curveTex.width !== w || curveTex.height !== h) {
      if (curveTex) gl.deleteTexture(curveTex);
      if (curveFbo) gl.deleteFramebuffer(curveFbo);
      curveTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, curveTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      curveFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, curveFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, curveTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // Rebind the correct input texture to TEXTURE0 before Pass 1.
    // After sharpen pass, TEXTURE0 is bound to sharpenTexA (the sharpened result).
    // After the lazy FBO alloc, TEXTURE0 got rebound to curveTex.
    // We want Pass 1 (sliders-LUT) to read from the OUTPUT of sharpen (which
    // is sharpenTexA when sharpen > 0, otherwise sourceTex). The `outputTex`
    // variable was set earlier by the sharpen block; fall back to sourceTex.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, outputTex);

    gl.bindFramebuffer(gl.FRAMEBUFFER, curveFbo);
    gl.viewport(0, 0, w, h);
    runPass(slidersLutProg!, () => {
      const p = slidersLutProg!;
      gl.uniform1i(gl.getUniformLocation(p, 'uSource'), 0);
      gl.uniform1i(gl.getUniformLocation(p, 'uLut'), 1);
      gl.uniform1f(gl.getUniformLocation(p, 'uLutSize'), 32);
      // If no LUT is loaded (texture is null), force intensity to 0 so
      // mix(adjusted, lutResult, 0) = adjusted (passthrough). With no LUT
      // bound, sampling TEXTURE_3D returns garbage, making high intensities
      // produce black output instead of just being a no-op.
      gl.uniform1f(gl.getUniformLocation(p, 'uLutIntensity'),
        lutTex ? Math.max(0, Math.min(1, lastState.lut_intensity / 100)) : 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uExposure'), lastState.exposure);
      gl.uniform1f(gl.getUniformLocation(p, 'uContrast'), lastState.contrast);
      gl.uniform1f(gl.getUniformLocation(p, 'uBrightness'), lastState.brightness);
      gl.uniform1f(gl.getUniformLocation(p, 'uSaturation'), lastState.saturation);
      gl.uniform1f(gl.getUniformLocation(p, 'uTemp'), lastState.temp);
      gl.uniform1f(gl.getUniformLocation(p, 'uTint'), lastState.tint);
      gl.uniform1f(gl.getUniformLocation(p, 'uStraightenAngle'), lastState.straighten || 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uCropX'), lastState.cropX || 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uCropY'), lastState.cropY || 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uCropW'), lastState.cropW || 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uCropH'), lastState.cropH || 0);
      const lc = lastState.lens_corrections || {};
      gl.uniform1f(gl.getUniformLocation(p, 'uCAStrength'), lc.chromatic_aberration || 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uCAX'), lc.chromatic_aberration_x || 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uCAY'), lc.chromatic_aberration_y || 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uVignette'), lastState.vignette || 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uHighlights'), lastState.highlights || 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uShadows'), lastState.shadows || 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uWhites'), lastState.whites || 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uBlacks'), lastState.blacks || 0);
    }, curveFbo, w, h);

    // ── Pass 2: curve → postCurveFbo (NOT canvas) ───────────────────────────
    // The post-curve output is consumed by Pass 3 (HSL/ST/grain/dehaze), so we
    // need it as a samplable texture. Writing to canvas was the bug — pass 3
    // couldn't read it back as a texture, so the curve got silently dropped
    // whenever grain/dehaze/etc. were non-zero.
    if (!postCurveFbo || !postCurveTex || postCurveTex.width !== w || postCurveTex.height !== h) {
      if (postCurveTex) gl.deleteTexture(postCurveTex);
      if (postCurveFbo) gl.deleteFramebuffer(postCurveFbo);
      postCurveTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, postCurveTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      postCurveFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, postCurveFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, postCurveTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, postCurveFbo);
    gl.viewport(0, 0, w, h);
    if (curveProg && curveTexR && curveTexG && curveTexB) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, curveTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, curveTexR);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, curveTexG);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, curveTexB);
      runPass(curveProg!, () => {
        const p = curveProg!;
        gl.uniform1i(gl.getUniformLocation(p, 'uSource'), 0);
        gl.uniform1i(gl.getUniformLocation(p, 'uCurveR'), 1);
        gl.uniform1i(gl.getUniformLocation(p, 'uCurveG'), 2);
        gl.uniform1i(gl.getUniformLocation(p, 'uCurveB'), 3);
        gl.uniform1i(gl.getUniformLocation(p, "uHasCurve"), curveIsIdentity ? 0 : 1);
      }, postCurveFbo, w, h);
    }

    // ── Pass 3: HSL Color Mixer + Color Grading → canvas ───────────────────
    if (!isEffectsFlat() && hslProg) {
      // Lazy-allocate hslFBO at canvas size (not needed but keeps structure)
      if (!hslFbo || !hslTex || hslTex.width !== w || hslTex.height !== h) {
        if (hslTex) gl.deleteTexture(hslTex);
        if (hslFbo) gl.deleteFramebuffer(hslFbo);
        hslTex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, hslTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        hslFbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, hslFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hslTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }

      // Source for hsl pass: read from postCurveTex which holds pass 2's
      // curve-applied output. Previously this read from curveTex (pass 1 only),
      // which silently dropped the tone curve whenever grain/dehaze was on.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, postCurveTex || curveTex);
      runPass(hslProg, () => {
        const p = hslProg!;
        gl.uniform1i(gl.getUniformLocation(p, 'uSource'), 0);
        gl.uniform2f(gl.getUniformLocation(p, 'uTexelSize'), 1.0 / w, 1.0 / h);

        const hsl = lastState.hsl || {};
        const cg = lastState.colorGrading;
        const RANGES = ['Red','Orange','Yellow','Green','Aqua','Blue','Purple','Magenta'];
        RANGES.forEach((name, i) => {
          const r = hsl['hsl_' + name.toLowerCase()] || { h: 0, s: 0, l: 0 };
          gl.uniform1f(gl.getUniformLocation(p, `uHsl${name}_h`), r.h / 100);
          gl.uniform1f(gl.getUniformLocation(p, `uHsl${name}_s`), r.s / 100);
          gl.uniform1f(gl.getUniformLocation(p, `uHsl${name}_l`), r.l / 100);
        });
        gl.uniform1i(gl.getUniformLocation(p, 'uHslActive'), isEffectsFlat() ? 0 : 1);

        if (cg) {
          gl.uniform3fv(gl.getUniformLocation(p, 'uCgShadowsColour'), [(cg.shadows_colour[0] ?? 0)/255, (cg.shadows_colour[1] ?? 0)/255, (cg.shadows_colour[2] ?? 0)/255]);
          gl.uniform3fv(gl.getUniformLocation(p, 'uCgMidtonesColour'), [(cg.midtones_colour[0] ?? 0)/255, (cg.midtones_colour[1] ?? 0)/255, (cg.midtones_colour[2] ?? 0)/255]);
          gl.uniform3fv(gl.getUniformLocation(p, 'uCgHighlightsColour'), [(cg.highlights_colour[0] ?? 0)/255, (cg.highlights_colour[1] ?? 0)/255, (cg.highlights_colour[2] ?? 0)/255]);
          gl.uniform3fv(gl.getUniformLocation(p, 'uCgGlobalColour'), [(cg.global_colour[0] ?? 0)/255, (cg.global_colour[1] ?? 0)/255, (cg.global_colour[2] ?? 0)/255]);
          gl.uniform1f(gl.getUniformLocation(p, 'uCgShadowsIntensity'), cg.shadows_intensity ?? 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uCgMidtonesIntensity'), cg.midtones_intensity ?? 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uCgHighlightsIntensity'), cg.highlights_intensity ?? 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uCgGlobalIntensity'), cg.global_intensity ?? 0);
          gl.uniform1i(gl.getUniformLocation(p, 'uCgMode'), cg.mode === 'luminance' ? 1 : 0);
        } else {
          gl.uniform3f(gl.getUniformLocation(p, 'uCgShadowsColour'), 0, 0, 0);
          gl.uniform3f(gl.getUniformLocation(p, 'uCgMidtonesColour'), 0, 0, 0);
          gl.uniform3f(gl.getUniformLocation(p, 'uCgHighlightsColour'), 0, 0, 0);
          gl.uniform3f(gl.getUniformLocation(p, 'uCgGlobalColour'), 0, 0, 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uCgShadowsIntensity'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uCgMidtonesIntensity'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uCgHighlightsIntensity'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uCgGlobalIntensity'), 0);
          gl.uniform1i(gl.getUniformLocation(p, 'uCgMode'), 0);
        }

        // Split Toning
        const st = lastState.splitToning || { shadows_hue: 0, shadows_saturation: 0, highlights_hue: 0, highlights_saturation: 0, balance: 0 };
        gl.uniform1f(gl.getUniformLocation(p, 'uStShadowsHue'), st.shadows_hue);
        gl.uniform1f(gl.getUniformLocation(p, 'uStShadowsSat'), st.shadows_saturation);
        gl.uniform1f(gl.getUniformLocation(p, 'uStHighlightsHue'), st.highlights_hue);
        gl.uniform1f(gl.getUniformLocation(p, 'uStHighlightsSat'), st.highlights_saturation);
        gl.uniform1f(gl.getUniformLocation(p, 'uStBalance'), st.balance);

        // Grain
        const gr = lastState.grain || { amount: 0, size: 25 };
        gl.uniform1f(gl.getUniformLocation(p, 'uGrainAmount'), gr.amount);
        gl.uniform1f(gl.getUniformLocation(p, 'uGrainSize'), gr.size);

        // Dehaze
        gl.uniform1f(gl.getUniformLocation(p, 'uDehaze'), lastState.dehaze || 0);

        // Time (for grain animation)
        gl.uniform1f(gl.getUniformLocation(p, 'uTime'), performance.now() / 1000);
      }, null, w, h);
    }

    // ── Pass: Calibration (Camera Profile) → canvas ─────────────────────
    {
      const calib = lastState.calibration || {};
      const shadowTint = calib.shadow_tint || 0;
      const calSat = calib.saturation || 0;
      calibIsFlat = shadowTint === 0 && calSat === 0;
      const calibRan = !calibIsFlat && calibProg;
      if (calibRan) {
        gl.activeTexture(gl.TEXTURE0);
        // Source: whatever is currently on canvas (from HSL pass)
        gl.bindTexture(gl.TEXTURE_2D, hslTex || curveTex || sourceTex);
        runPass(calibProg, () => {
          const p = calibProg!;
          gl.uniform1i(gl.getUniformLocation(p, 'uSource'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uShadowTint'), shadowTint);
          gl.uniform1f(gl.getUniformLocation(p, 'uCalSat'), calSat);
        }, null, w, h);
      }

      // ── Final blit: postCurveTex → canvas (only if no effect pass ran) ────
      // The previous version ALWAYS ran this blit, which silently overwrote
      // the HSL/ST/CG/grain/dehaze and calibration pass outputs. Dehaze (and
      // any other pass-3-only effect) showed zero visual change because
      // postCurveTex doesn't include those effects.
      //
      // Condition: only run if BOTH Pass 3 (hslProg) and the calibration pass
      // were skipped. effectsRan covers the Pass 3 case; calibRan is computed
      // above.
      const effectsRan = !isEffectsFlat() && !!hslProg;
      const needFinalBlit = !effectsRan && !calibRan;
      if (needFinalBlit && postCurveTex && slidersLutProg) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, postCurveTex);
        runPass(slidersLutProg!, () => {
          const p = slidersLutProg!;
          gl.uniform1i(gl.getUniformLocation(p, 'uSource'), 0);
          // Force sliders uniforms to neutral so the blit is a straight copy.
          gl.uniform1f(gl.getUniformLocation(p, 'uLutIntensity'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uExposure'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uContrast'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uBrightness'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uSaturation'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uTemp'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uTint'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uVignette'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uHighlights'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uShadows'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uWhites'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uBlacks'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uStraightenAngle'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uCropX'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uCropY'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uCropW'), 1);
          gl.uniform1f(gl.getUniformLocation(p, 'uCropH'), 1);
          gl.uniform1f(gl.getUniformLocation(p, 'uCAStrength'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uCAX'), 0);
          gl.uniform1f(gl.getUniformLocation(p, 'uCAY'), 0);
        }, null, w, h);
      }
    }

    gl.bindVertexArray(null);
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
    if (curveTex) gl.deleteTexture(curveTex);
    if (curveFbo) gl.deleteFramebuffer(curveFbo);
    if (curveTexR) gl.deleteTexture(curveTexR);
    if (curveTexG) gl.deleteTexture(curveTexG);
    if (curveTexB) gl.deleteTexture(curveTexB);
    if (hslTex) gl.deleteTexture(hslTex);
    if (hslFbo) gl.deleteFramebuffer(hslFbo);
    if (slidersLutProg) gl.deleteProgram(slidersLutProg);
    if (blurHProg) gl.deleteProgram(blurHProg);
    if (blurVProg) gl.deleteProgram(blurVProg);
    if (unsharpProg) gl.deleteProgram(unsharpProg);
    if (curveProg) gl.deleteProgram(curveProg);
    if (hslProg) gl.deleteProgram(hslProg);
    if (calibProg) gl.deleteProgram(calibProg);
    quadVao = sourceTex = lutTex = sharpenTexA = sharpenTexB = curveTex = hslTex = null;
    sharpenFboA = sharpenFboB = curveFbo = hslFbo = null;
    curveTexR = curveTexG = curveTexB = null;
    slidersLutProg = blurHProg = blurVProg = unsharpProg = curveProg = hslProg = null;
    calibIsFlat = true; calibProg = null;
    ready = false;
  }

  return { init, setSource, setLut, setCurves, setHsl, setSplitToning, setGrain, updateState, render, destroy,
           get ready() { return ready; } };
}
