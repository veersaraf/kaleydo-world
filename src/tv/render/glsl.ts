// Shared GLSL snippets.

export const NOISE = /* glsl */ `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float hash31(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i), n100 = hash31(i + vec3(1,0,0)), n010 = hash31(i + vec3(0,1,0)), n110 = hash31(i + vec3(1,1,0));
  float n001 = hash31(i + vec3(0,0,1)), n101 = hash31(i + vec3(1,0,1)), n011 = hash31(i + vec3(0,1,1)), n111 = hash31(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
float fbm3(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise3(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
`;

export const COLOR = /* glsl */ `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toSRGB(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 aces(vec3 x) { const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14; return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0); }
vec3 saturate3(vec3 c, float s) { float l = luma(c); return mix(vec3(l), c, s); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
`;

/** More tonemappers (linear sRGB in, display-linear out), as in three.js. */
export const TONEMAP = /* glsl */ `
// AgX (Filament / Blender, rec2020 primaries): graceful highlight roll-off, neutral hues
vec3 agxContrast(vec3 x) { vec3 x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
vec3 agx(vec3 c) {
  const mat3 toRec2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 fromRec2020 = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  c = inset * (toRec2020 * c);
  c = clamp((log2(max(c, 1e-10)) + 12.47393) / 16.5, 0.0, 1.0);
  c = outset * agxContrast(c);
  return clamp(fromRec2020 * pow(max(c, 0.0), vec3(2.2)), 0.0, 1.0);
}
// Khronos PBR Neutral: keeps base colours as authored, only rolls off highlights
vec3 neutral(vec3 c) {
  float x = min(c.r, min(c.g, c.b));
  c -= x < 0.08 ? x - 6.25 * x * x : 0.04;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < 0.76) return c;
  float newPeak = 1.0 - 0.0576 / (peak - 0.52);
  c *= newPeak / peak;
  return mix(c, vec3(newPeak), 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0));
}
`;

/**
 * FXAA 3.11 (Lottes), quality-12-like, on an HDR texture: returns where to
 * sample instead of `uv`. It runs inside a final pass, so anti-aliasing costs
 * a few taps rather than a pass of its own (or an MSAA buffer's store and resolve).
 * Luma is compressed (x / (1 + x), then sqrt) so HDR highlights don't dominate.
 */
export const FXAA = /* glsl */ `
float fxL(vec3 c) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return sqrt(l / (1.0 + l)); }
vec2 fxaaUv(sampler2D tex, vec2 uv, vec2 px) {
  float M = fxL(texture(tex, uv).rgb);
  float N = fxL(textureLodOffset(tex, uv, 0.0, ivec2(0, 1)).rgb);
  float S = fxL(textureLodOffset(tex, uv, 0.0, ivec2(0, -1)).rgb);
  float E = fxL(textureLodOffset(tex, uv, 0.0, ivec2(1, 0)).rgb);
  float W = fxL(textureLodOffset(tex, uv, 0.0, ivec2(-1, 0)).rgb);
  float mx = max(M, max(max(N, S), max(E, W))), mn = min(M, min(min(N, S), min(E, W)));
  float range = mx - mn;
  if (range < max(0.0625, mx * 0.166)) return uv;
  float NW = fxL(textureLodOffset(tex, uv, 0.0, ivec2(-1, 1)).rgb);
  float NE = fxL(textureLodOffset(tex, uv, 0.0, ivec2(1, 1)).rgb);
  float SW = fxL(textureLodOffset(tex, uv, 0.0, ivec2(-1, -1)).rgb);
  float SE = fxL(textureLodOffset(tex, uv, 0.0, ivec2(1, -1)).rgb);
  // sub-pixel aliasing: how far the centre is from its neighbourhood
  float avg = ((N + S + E + W) * 2.0 + (NW + NE + SW + SE)) / 12.0;
  float sub = clamp(abs(avg - M) / range, 0.0, 1.0);
  sub = sub * sub * (3.0 - 2.0 * sub);
  sub = sub * sub * 0.75;
  // edge orientation
  float eH = abs(NW + SW - 2.0 * W) + 2.0 * abs(N + S - 2.0 * M) + abs(NE + SE - 2.0 * E);
  float eV = abs(NW + NE - 2.0 * N) + 2.0 * abs(W + E - 2.0 * M) + abs(SW + SE - 2.0 * S);
  bool horz = eH >= eV;
  float l1 = horz ? S : W, l2 = horz ? N : E;
  float g1 = abs(l1 - M), g2 = abs(l2 - M);
  bool steep1 = g1 >= g2;
  float grad = 0.25 * max(g1, g2);
  float stepLen = horz ? px.y : px.x;
  float lumaLocal;
  if (steep1) { stepLen = -stepLen; lumaLocal = 0.5 * (l1 + M); } else lumaLocal = 0.5 * (l2 + M);
  vec2 cur = uv;
  if (horz) cur.y += stepLen * 0.5; else cur.x += stepLen * 0.5;
  // walk both ways along the edge until its contrast ends
  vec2 off = horz ? vec2(px.x, 0.0) : vec2(0.0, px.y);
  vec2 u1 = cur - off, u2 = cur + off;
  float e1 = fxL(textureLod(tex, u1, 0.0).rgb) - lumaLocal, e2 = fxL(textureLod(tex, u2, 0.0).rgb) - lumaLocal;
  bool d1 = abs(e1) >= grad, d2 = abs(e2) >= grad;
  const float STEPS[8] = float[8](1.0, 1.5, 2.0, 2.0, 2.0, 4.0, 8.0, 12.0);
  for (int i = 0; i < 8; i++) {
    if (d1 && d2) break;
    if (!d1) { u1 -= off * STEPS[i]; e1 = fxL(textureLod(tex, u1, 0.0).rgb) - lumaLocal; d1 = abs(e1) >= grad; }
    if (!d2) { u2 += off * STEPS[i]; e2 = fxL(textureLod(tex, u2, 0.0).rgb) - lumaLocal; d2 = abs(e2) >= grad; }
  }
  float dist1 = horz ? uv.x - u1.x : uv.y - u1.y;
  float dist2 = horz ? u2.x - uv.x : u2.y - uv.y;
  bool near1 = dist1 < dist2;
  float dist = min(dist1, dist2);
  float len = dist1 + dist2;
  bool goodSpan = ((near1 ? e1 : e2) < 0.0) != ((M - lumaLocal) < 0.0);
  float edgeOff = goodSpan ? 0.5 - dist / len : 0.0;
  float o = max(edgeOff, sub);
  if (horz) uv.y += o * stepLen; else uv.x += o * stepLen;
  return uv;
}
`;

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
