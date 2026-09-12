/**
 * Image edits — non-destructive edit history per image.
 *
 * Each save creates a new row. Originals in `images.path` are NEVER overwritten.
 * The latest edit's `rendered_path` is what the gallery displays (via image-adapter).
 *
 * Schema:
 *   image_edits (id, image_id, params_json, rendered_path, created_at)
 *   ON DELETE CASCADE from images — if image is deleted, all its edits go with it.
 */

import { getDb } from './db';

export type ImageEditRow = {
  id: number;
  image_id: number;
  params_json: string;
  rendered_path: string;
  created_at: string;
};

let _migrated = false;
function ensureSchema() {
  if (_migrated) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      params_json TEXT NOT NULL DEFAULT '{}',
      rendered_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_image_edits_image ON image_edits(image_id, created_at DESC);
  `);
  _migrated = true;
}

export function insertImageEdit(input: {
  image_id: number;
  params_json: string;
  rendered_path: string;
}): number {
  ensureSchema();
  const info = getDb()
    .prepare(
      `INSERT INTO image_edits (image_id, params_json, rendered_path)
       VALUES (?, ?, ?)`,
    )
    .run(input.image_id, input.params_json, input.rendered_path);
  return Number(info.lastInsertRowid);
}

export function getLatestImageEdit(imageId: number): ImageEditRow | undefined {
  ensureSchema();
  return getDb()
    .prepare(
      `SELECT * FROM image_edits WHERE image_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(imageId) as ImageEditRow | undefined;
}

export function listImageEdits(imageId: number): ImageEditRow[] {
  ensureSchema();
  return getDb()
    .prepare(
      `SELECT * FROM image_edits WHERE image_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(imageId) as ImageEditRow[];
}

export function getImageEdit(id: number): ImageEditRow | undefined {
  ensureSchema();
  return getDb()
    .prepare(`SELECT * FROM image_edits WHERE id = ?`)
    .get(id) as ImageEditRow | undefined;
}

export function deleteAllImageEdits(imageId: number): number {
  ensureSchema();
  const info = getDb()
    .prepare(`DELETE FROM image_edits WHERE image_id = ?`)
    .run(imageId);
  return info.changes;
}

/** Helper used by adaptImage — returns latest edit or undefined. */
export function latestEditFor(imageId: number): ImageEditRow | undefined {
  return getLatestImageEdit(imageId);
}
