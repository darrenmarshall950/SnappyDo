/**
 * SnappyDo — LUT (Look-Up Table) library
 *
 * Two kinds of LUT:
 *  - BUILTIN: hard-coded transform functions in this file. Globally enabled
 *    for all accounts. No file on disk.
 *  - UPLOADED: .cube files uploaded via the admin UI, stored under
 *    /app/uploads/luts/, listed in the `luts` table. Can be globally enabled
 *    or disabled (visible toggle in admin).
 *
 * Internal representation after parse:
 *   { size, data } — `size` is the cube edge (e.g. 33 for a 33³ LUT),
 *                    `data` is a Uint8Array of size*size*size*3 RGB bytes.
 *   Indexing: data[((b*size + g)*size + r) * 3 + channel]
 *
 * Application:
 *   - applyLutTrilinear() — high-quality trilinear interpolation (server)
 *   - applyLutNearest()   — fast nearest-neighbour (live preview, OK on 33³+)
 *   - applyLutToRgba()    — in-place pixel buffer pass with intensity mix
 *
 * Image_edits integration:
 *   params_json includes { lut_id: <int>|null, lut_intensity: 0..100 }.
 *   Missing fields default to no LUT (null id) and full intensity (100).
 */
import type Database from 'better-sqlite3';
import { getDb } from './db';
import { readFileSync, unlinkSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { applySlidersToRgb, formatCubeFile } from './slider-color';
import { join } from 'node:path';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
const LUT_DIR = join(UPLOAD_DIR, 'luts');

// ─────────────────────────────────────────────────────────────
// Built-in LUTs — small, named colour transforms. Implemented as
// plain JS functions returning {r,g,b} for an input triplet. They're
// compiled to a 33³ Uint8Array on first read so the rest of the code
// path is identical for built-ins and uploaded LUTs.
// ─────────────────────────────────────────────────────────────

type BuiltinFn = (r: number, g: number, b: number) => [number, number, number];

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

const BUILTINS: Record<string, { name: string; fn: BuiltinFn }> = {
  'bw-classic': {
    name: 'B&W Classic',
    fn: (r, g, b) => {
      // Rec. 601 luma, then a gentle S-curve for contrast
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const s = lum < 128
        ? lum * lum / 128             // lift shadows slightly
        : 255 - (255 - lum) * (255 - lum) / 128;
      return [clamp(s), clamp(s), clamp(s)];
    },
  },
  'vintage-warm': {
    name: 'Vintage Warm',
    fn: (r, g, b) => {
      // Desaturate ~15%, warm cast, lift blacks (faded print look)
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const desat = 0.15;
      r = r + (lum - r) * desat;
      g = g + (lum - g) * desat;
      b = b + (lum - b) * desat;
      // Lift blacks + warm cast
      r = clamp(r * 0.92 + 18);
      g = clamp(g * 0.92 + 10);
      b = clamp(b * 0.85 - 5);
      return [r, g, b];
    },
  },
  'teal-orange': {
    name: 'Teal & Orange',
    fn: (r, g, b) => {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      // Shadows → teal: pull R/B down, push G up
      const shadowMask = 1 - lum / 255;
      r = clamp(r - 22 * shadowMask);
      g = clamp(g + 8 * shadowMask);
      b = clamp(b + 14 * shadowMask);
      // Highlights → orange: push R up, B down
      const highlightMask = lum / 255;
      r = clamp(r + 18 * highlightMask);
      g = clamp(g - 4 * highlightMask);
      b = clamp(b - 24 * highlightMask);
      return [r, g, b];
    },
  },
  'faded-matte': {
    name: 'Faded Matte',
    fn: (r, g, b) => {
      // Lift blacks, drop highlights — that "Instagram faded" feel
      r = clamp(r * 0.85 + 28);
      g = clamp(g * 0.85 + 28);
      b = clamp(b * 0.85 + 28);
      return [r, g, b];
    },
  },
  'punchy-color': {
    name: 'Punchy Colour',
    fn: (r, g, b) => {
      // Saturation boost + mild S-curve
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = 1.35;
      r = clamp(lum + (r - lum) * sat);
      g = clamp(lum + (g - lum) * sat);
      b = clamp(lum + (b - lum) * sat);
      const s = r < 128
        ? r * r / 128
        : 255 - (255 - r) * (255 - r) / 128;
      // Apply S-curve proportionally to all three
      const sf = (channel: number) =>
        clamp(channel < 128 ? channel * channel / 128 : 255 - (255 - channel) * (255 - channel) / 128);
      return [sf(r), sf(g), sf(b)];
    },
  },
};

function compileBuiltin(size: number, key: string): Uint8Array {
  const fn = BUILTINS[key]?.fn;
  if (!fn) throw new Error(`unknown built-in LUT: ${key}`);
  const data = new Uint8Array(size * size * size * 3);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const rf = (r / (size - 1)) * 255;
        const gf = (g / (size - 1)) * 255;
        const bf = (b / (size - 1)) * 255;
        const [ro, go, bo] = fn(rf, gf, bf);
        const idx = ((b * size + g) * size + r) * 3;
        data[idx] = ro;
        data[idx + 1] = go;
        data[idx + 2] = bo;
      }
    }
  }
  return data;
}

// ─────────────────────────────────────────────────────────────
// .cube parser — Adobe / Irrlicht standard
// LUT_3D_SIZE N    — cube edge (typically 17, 33, or 65)
// r g b            — triplets, one per line, total N³ lines
// Lines may be in any order (we don't assume ordering).
// Comments start with #.
// ─────────────────────────────────────────────────────────────

export function parseCube(text: string): { size: number; data: Uint8Array } {
  let size = 0;
  const samples: [number, number, number][] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') {
      size = parseInt(parts[1], 10);
      continue;
    }
    if (parts[0] === 'LUT_1D_SIZE' || parts[0] === 'TITLE' || parts[0] === 'DOMAIN_MIN' || parts[0] === 'DOMAIN_MAX') {
      continue; // unsupported in 3D-only mode; just skip
    }
    if (parts.length >= 3) {
      const r = Number(parts[0]);
      const g = Number(parts[1]);
      const b = Number(parts[2]);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
      samples.push([
        Math.max(0, Math.min(255, Math.round(r * 255))),
        Math.max(0, Math.min(255, Math.round(g * 255))),
        Math.max(0, Math.min(255, Math.round(b * 255))),
      ]);
    }
  }
  if (size <= 0) {
    // Some .cube files omit LUT_3D_SIZE — infer from sample count (perfect cube)
    const n = Math.round(Math.cbrt(samples.length));
    if (n * n * n !== samples.length) {
      throw new Error(`Could not determine LUT size (${samples.length} samples, no LUT_3D_SIZE)`);
    }
    size = n;
  } else if (samples.length !== size * size * size) {
    throw new Error(`LUT size mismatch: header says ${size} but got ${samples.length} samples`);
  }
  const data = new Uint8Array(size * size * size * 3);
  for (let i = 0; i < samples.length; i++) {
    const [r, g, b] = samples[i];
    data[i * 3] = r;
    data[i * 3 + 1] = g;
    data[i * 3 + 2] = b;
  }
  return { size, data };
}

// ─────────────────────────────────────────────────────────────
// Apply LUT to a single RGB triplet — trilinear (server, high quality)
// or nearest-neighbour (live preview, fast).
// Output is rounded to integer 0..255.
// ─────────────────────────────────────────────────────────────

export function applyLutTrilinear(
  size: number,
  data: Uint8Array,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const fs = size - 1;
  const rf = Math.max(0, Math.min(fs, r / 255 * fs));
  const gf = Math.max(0, Math.min(fs, g / 255 * fs));
  const bf = Math.max(0, Math.min(fs, b / 255 * fs));
  const r0 = Math.floor(rf), g0 = Math.floor(gf), b0 = Math.floor(bf);
  const r1 = Math.min(size - 1, r0 + 1);
  const g1 = Math.min(size - 1, g0 + 1);
  const b1 = Math.min(size - 1, b0 + 1);
  const dr = rf - r0, dg = gf - g0, db = bf - b0;
  const idx = (rr: number, gg: number, bb: number) => ((bb * size + gg) * size + rr) * 3;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c000 = data[idx(r0, g0, b0) + c];
    const c100 = data[idx(r1, g0, b0) + c];
    const c010 = data[idx(r0, g1, b0) + c];
    const c110 = data[idx(r1, g1, b0) + c];
    const c001 = data[idx(r0, g0, b1) + c];
    const c101 = data[idx(r1, g0, b1) + c];
    const c011 = data[idx(r0, g1, b1) + c];
    const c111 = data[idx(r1, g1, b1) + c];
    const c00 = c000 * (1 - dr) + c100 * dr;
    const c10 = c010 * (1 - dr) + c110 * dr;
    const c01 = c001 * (1 - dr) + c101 * dr;
    const c11 = c011 * (1 - dr) + c111 * dr;
    const c0 = c00 * (1 - dg) + c10 * dg;
    const c1 = c01 * (1 - dg) + c11 * dg;
    out[c] = Math.round(c0 * (1 - db) + c1 * db);
  }
  return out;
}

export function applyLutNearest(
  size: number,
  data: Uint8Array,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const fs = size - 1;
  const rr = Math.max(0, Math.min(fs, Math.round((r / 255) * fs)));
  const gg = Math.max(0, Math.min(fs, Math.round((g / 255) * fs)));
  const bb = Math.max(0, Math.min(fs, Math.round((b / 255) * fs)));
  const i = ((bb * size + gg) * size + rr) * 3;
  return [data[i], data[i + 1], data[i + 2]];
}

/**
 * In-place RGBA pixel buffer pass with intensity mix (0..1).
 * intensity=1 fully replaces; intensity=0 leaves the pixel untouched.
 */
export function applyLutToRgba(
  size: number,
  data: Uint8Array,
  pixels: Uint8Array,
  intensity: number,
  useNearest = false,
): void {
  if (intensity <= 0) return;
  const mix = Math.max(0, Math.min(1, intensity));
  const fn = useNearest ? applyLutNearest : applyLutTrilinear;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const [ro, go, bo] = fn(size, data, r, g, b);
    pixels[i]     = Math.round(r * (1 - mix) + ro * mix);
    pixels[i + 1] = Math.round(g * (1 - mix) + go * mix);
    pixels[i + 2] = Math.round(b * (1 - mix) + bo * mix);
    // alpha untouched
  }
}

// ─────────────────────────────────────────────────────────────
// DB layer
// ─────────────────────────────────────────────────────────────

let _migrated = false;
function ensureSchema() {
  if (_migrated) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS luts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'uploaded',  -- 'builtin' | 'uploaded'
      builtin_key TEXT UNIQUE,
      file_path TEXT,
      size INTEGER NOT NULL DEFAULT 33,
      enabled_global INTEGER NOT NULL DEFAULT 1,
      uploaded_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_luts_enabled ON luts(enabled_global);
  `);
  // Idempotent ALTERs for columns added in later schema versions.
  const cols = db.prepare("PRAGMA table_info(luts)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'parent_id')) {
    db.exec(`ALTER TABLE luts ADD COLUMN parent_id INTEGER REFERENCES luts(id);`);
  }
  if (!cols.some((c) => c.name === 'synth_params_json')) {
    db.exec(`ALTER TABLE luts ADD COLUMN synth_params_json TEXT;`);
  }
  // Seed built-in rows if missing (so they have stable ids across restarts).
  const upsert = db.prepare(`
    INSERT INTO luts (name, kind, builtin_key, size, enabled_global)
    SELECT ?, 'builtin', ?, 33, 1
    WHERE NOT EXISTS (SELECT 1 FROM luts WHERE builtin_key = ?)
  `);
  for (const [key, def] of Object.entries(BUILTINS)) {
    upsert.run(def.name, key, key);
  }
  _migrated = true;
}

export type LutRow = {
  id: number;
  name: string;
  kind: 'builtin' | 'uploaded' | 'synthesised';
  builtin_key: string | null;
  file_path: string | null;
  size: number;
  enabled_global: 0 | 1;
  uploaded_by: string | null;
  parent_id: number | null;
  synth_params_json: string | null;
  created_at: string;
};

export function listAvailableLuts(): LutRow[] {
  ensureSchema();
  return getDb()
    .prepare(`SELECT * FROM luts WHERE enabled_global = 1 ORDER BY kind DESC, name ASC`)
    .all() as LutRow[];
}

export function getLutById(id: number): LutRow | undefined {
  ensureSchema();
  return getDb().prepare(`SELECT * FROM luts WHERE id = ?`).get(id) as LutRow | undefined;
}

/**
 * Returns the parsed LUT data for a given row. For built-ins, compile on
 * demand. For uploaded, read from disk and parse the .cube file.
 * Cached in-memory per row id to avoid re-parsing on every frame.
 */
const _dataCache = new Map<number, { size: number; data: Uint8Array }>();
export function getLutData(row: LutRow): { size: number; data: Uint8Array } {
  const cached = _dataCache.get(row.id);
  if (cached) return cached;
  let parsed: { size: number; data: Uint8Array };
  if (row.kind === 'builtin' && row.builtin_key) {
    parsed = { size: row.size || 33, data: compileBuiltin(row.size || 33, row.builtin_key) };
  } else if (row.file_path) {
    const abs = row.file_path.startsWith('/') ? row.file_path : join(UPLOAD_DIR, row.file_path);
    const text = readFileSync(abs, 'utf8');
    parsed = parseCube(text);
  } else {
    throw new Error(`LUT row ${row.id} has neither builtin_key nor file_path`);
  }
  _dataCache.set(row.id, parsed);
  return parsed;
}

export function uploadLut(name: string, filePath: string, uploadedBy: string, size: number): LutRow {
  ensureSchema();
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO luts (name, kind, file_path, size, enabled_global, uploaded_by)
    VALUES (?, 'uploaded', ?, ?, 1, ?)
  `).run(name, filePath, size, uploadedBy);
  _dataCache.delete(Number(info.lastInsertRowid));
  return db.prepare(`SELECT * FROM luts WHERE id = ?`).get(info.lastInsertRowid) as LutRow;
}

/**
 * Synthesise a 3D LUT from slider ops applied to either an identity grid
 * or a base LUT. Writes a .cube file under UPLOAD_DIR/luts/<uuid>.cube and
 * inserts a row with kind='synthesised' and parent_id = baseLutId (if any).
 */
export function synthesizeLut(
  name: string,
  params: Record<string, any>,
  baseLutId: number | null,
  uploadedBy: string,
  size = 33,
): LutRow {
  ensureSchema();
  ensureLutDir();
  let baseLookup: ((r: number, g: number, b: number) => [number, number, number]) | null = null;
  if (baseLutId) {
    const baseRow = getLutById(baseLutId);
    if (baseRow) {
      const baseData = getLutData(baseRow);
      baseLookup = (r, g, b) => applyLutTrilinear(baseData.size, baseData.data, r, g, b);
    }
  }
  const lookup = (r: number, g: number, b: number): [number, number, number] => {
    let rr = r, gg = g, bb = b;
    if (baseLookup) [rr, gg, bb] = baseLookup(rr, gg, bb);
    return applySlidersToRgb(rr, gg, bb, params);
  };
  const cubeText = formatCubeFile(size, lookup, name);
  const uuid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const relPath = `luts/${uuid}.cube`;
  const absPath = join(UPLOAD_DIR, relPath);
  writeFileSync(absPath, cubeText, 'utf8');
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO luts (name, kind, file_path, size, enabled_global, uploaded_by, parent_id, synth_params_json)
    VALUES (?, 'synthesised', ?, ?, 1, ?, ?, ?)
  `).run(name, relPath, size, uploadedBy, baseLutId, JSON.stringify(params));
  const newId = Number(info.lastInsertRowid);
  _dataCache.delete(newId);
  return db.prepare(`SELECT * FROM luts WHERE id = ?`).get(newId) as LutRow;
}

/** Return the params that produced a synthesised LUT, or null if not synthesised. */
export function getLutSynthParams(id: number): Record<string, any> | null {
  const row = getLutById(id);
  if (!row || row.kind !== 'synthesised' || !row.synth_params_json) return null;
  try { return JSON.parse(row.synth_params_json); } catch { return null; }
}

/**
 * Top N LUTs by usage count from image_edits.params_json. Built-ins
 * always appear (with their natural rank) even if not yet used.
 */
export function listTopLuts(n = 10): Array<LutRow & { use_count: number }> {
  ensureSchema();
  const db = getDb();
  const usedRows = db.prepare(`
    SELECT json_extract(params_json, '$.lut_id') as lid, COUNT(*) as c
    FROM image_edits
    WHERE json_extract(params_json, '$.lut_id') IS NOT NULL
      AND json_extract(params_json, '$.lut_id') > 0
    GROUP BY lid
    ORDER BY c DESC
  `).all() as Array<{ lid: number; c: number }>;
  const usage = new Map(usedRows.map((r) => [r.lid, r.c]));
  const all = db.prepare(`SELECT * FROM luts WHERE enabled_global = 1 ORDER BY name ASC`).all() as LutRow[];
  return all
    .map((l) => ({ ...l, use_count: usage.get(l.id) || 0 }))
    .sort((a, b) => b.use_count - a.use_count || a.name.localeCompare(b.name))
    .slice(0, n);
}

export function deleteLut(id: number): boolean {
  ensureSchema();
  const row = getLutById(id);
  if (!row || row.kind === 'builtin') return false; // never delete a built-in
  if (row.file_path) {
    const abs = row.file_path.startsWith('/') ? row.file_path : join(UPLOAD_DIR, row.file_path);
    if (existsSync(abs)) {
      try { unlinkSync(abs); } catch { /* ignore */ }
    }
  }
  _dataCache.delete(id);
  getDb().prepare(`DELETE FROM luts WHERE id = ?`).run(id);
  return true;
}

export function setLutEnabled(id: number, enabled: boolean): void {
  ensureSchema();
  getDb().prepare(`UPDATE luts SET enabled_global = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

export function ensureLutDir(): void {
  mkdirSync(LUT_DIR, { recursive: true });
}

export const LUT_UPLOAD_DIR = LUT_DIR;

// Re-export built-in keys for the client
export const BUILTIN_LUT_KEYS = Object.keys(BUILTINS);
export const BUILTIN_LUT_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(BUILTINS).map(([k, v]) => [k, v.name]),
);
