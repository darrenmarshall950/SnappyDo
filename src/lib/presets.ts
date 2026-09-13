/**
 * SnappyDo — Presets library
 *
 * Two kinds:
 *  - BUILTIN: hard-coded named looks. Globally visible to all accounts.
 *  - USER: saved by an admin user against their `username` — only visible
 *    to that user. Schema supports multi-user in future; for now the admin
 *    username is the discriminator.
 *
 * A preset stores a flat params object (same shape as the editor's state —
 * exposure, contrast, saturation, brightness, highlights, shadows, whites,
 * blacks, temp, tint, sharpen, vignette, crop, lut_id, lut_intensity).
 *
 * Built-ins are seeded into the DB on first read so they have stable ids
 * (matching the LUT pattern). User presets are created via the editor's
 * "Save current as preset" button.
 */
import { getDb } from './db';

const BUILTIN_PRESETS: Array<{ key: string; name: string; params: Record<string, any> }> = [
  {
    key: 'auto-tone',
    name: 'Auto Tone',
    params: { exposure: 8, contrast: 6, brightness: 4, highlights: -8, shadows: 12, saturation: 5 },
  },
  {
    key: 'punchy-bw',
    name: 'Punchy B&W',
    params: { saturation: -100, contrast: 18, brightness: -2, highlights: -10, shadows: 18, sharpen: 30, vignette: 25 },
  },
  {
    key: 'warm-vintage',
    name: 'Warm Vintage',
    params: { saturation: -10, contrast: -8, brightness: 4, temp: 18, tint: -4, vignette: 40, lut_id: null, lut_intensity: 0 },
  },
  {
    key: 'vibrant-pop',
    name: 'Vibrant Pop',
    params: { saturation: 28, contrast: 12, clarity: 6, vibrance: 12, sharpen: 25, lut_id: null, lut_intensity: 0 },
  },
  {
    key: 'cool-moody',
    name: 'Cool Moody',
    params: { saturation: -15, contrast: 14, brightness: -6, temp: -22, tint: 4, shadows: -10, vignette: 50 },
  },
  {
    key: 'soft-pastel',
    name: 'Soft Pastel',
    params: { saturation: -20, contrast: -10, brightness: 8, highlights: -16, whites: -10, blacks: 12 },
  },
];

let _migrated = false;
function ensureSchema() {
  if (_migrated) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      params_json TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'user',  -- 'builtin' | 'user'
      builtin_key TEXT UNIQUE,
      username TEXT,                      -- for kind='user'
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_presets_user ON presets(username, kind);
  `);
  const upsert = db.prepare(`
    INSERT INTO presets (name, params_json, kind, builtin_key)
    SELECT ?, ?, 'builtin', ?
    WHERE NOT EXISTS (SELECT 1 FROM presets WHERE builtin_key = ?)
  `);
  for (const p of BUILTIN_PRESETS) {
    upsert.run(p.name, JSON.stringify(p.params), p.key, p.key);
  }
  _migrated = true;
}

export type PresetRow = {
  id: number;
  name: string;
  params_json: string;
  kind: 'builtin' | 'user';
  builtin_key: string | null;
  username: string | null;
  created_at: string;
};

/**
 * List presets visible to a given username: all builtins + that user's
 * own custom presets. Ordered: builtins first (by name), then user presets.
 */
export function listAvailablePresets(username: string | null | undefined): PresetRow[] {
  ensureSchema();
  return getDb()
    .prepare(`
      SELECT * FROM presets
      WHERE kind = 'builtin' OR username = ?
      ORDER BY (kind = 'builtin') DESC, name ASC
    `)
    .all(username || '') as PresetRow[];
}

export function getPresetById(id: number): PresetRow | undefined {
  ensureSchema();
  return getDb().prepare(`SELECT * FROM presets WHERE id = ?`).get(id) as PresetRow | undefined;
}

export function saveUserPreset(name: string, params: Record<string, any>, username: string): PresetRow {
  ensureSchema();
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO presets (name, params_json, kind, username)
    VALUES (?, ?, 'user', ?)
  `).run(name.trim(), JSON.stringify(params), username);
  return db.prepare(`SELECT * FROM presets WHERE id = ?`).get(info.lastInsertRowid) as PresetRow;
}

export function deleteUserPreset(id: number, username: string): boolean {
  ensureSchema();
  const row = getPresetById(id);
  if (!row || row.kind !== 'user') return false;
  if (row.username !== username) return false; // users only delete their own
  getDb().prepare(`DELETE FROM presets WHERE id = ?`).run(id);
  return true;
}

export function getBuiltinPresetKeys(): string[] {
  return BUILTIN_PRESETS.map((p) => p.key);
}
