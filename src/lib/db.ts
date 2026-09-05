/**
 * SQLite database — single-file, no separate process.
 * For v0.3 prototype. Swap for Postgres + Drizzle/Prisma in v0.4.
 *
 * Schema:
 *   galleries (id, slug, title, description, template_id, template_config_json, cover_image_id, password_hash, created_at)
 *   images    (id, gallery_id, path, original_name, width, height, bytes, mime, exif_json, sort_order, created_at)
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = process.env.DB_PATH || '/app/data/snappydo.db';
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS galleries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      template_id TEXT NOT NULL DEFAULT 'masonry',
      template_config_json TEXT NOT NULL DEFAULT '{}',
      cover_image_id INTEGER,
      password_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      bytes INTEGER,
      mime TEXT NOT NULL,
      exif_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_images_gallery ON images(gallery_id, sort_order);

    CREATE TABLE IF NOT EXISTS favourites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      gallery_token TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(image_id, gallery_token)
    );
  `);

  // Seed with sample galleries on first boot
  const count = (db.prepare('SELECT COUNT(*) as n FROM galleries').get() as { n: number }).n;
  if (count === 0) {
    seedGalleries(db);
  } else {
    // Add any new seed galleries introduced in later versions (idempotent).
    const insertIfMissing = db.prepare(`
      INSERT INTO galleries (slug, title, description, template_id)
      SELECT ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM galleries WHERE slug = ?)
    `);
    const newSeeds = [
      { slug: 'safari', title: 'Safari — Serengeti', description: 'A week of golden-hour wildlife in Tanzania.', template_id: 'cover' },
      { slug: 'city-of-london', title: 'City of London', description: 'Architectural studies around the Square Mile.', template_id: 'carousel' },
      { slug: 'studio-light', title: 'Studio Light', description: 'A short study in single-source lighting.', template_id: 'slideshow' },
      { slug: 'wild-coast', title: 'Wild Coast', description: 'Surf, sand, and shoreline.', template_id: 'justified' },
    ];
    for (const s of newSeeds) {
      insertIfMissing.run(s.slug, s.title, s.description, s.template_id, s.slug);
    }
  }

  _db = db;
  return db;
}

function seedGalleries(db: Database.Database) {
  const seedStmt = db.prepare(`
    INSERT INTO galleries (slug, title, description, template_id)
    VALUES (?, ?, ?, ?)
  `);
  const seeds = [
    { slug: 'iceland-winter', title: 'Iceland — Winter Light', description: 'Eight days chasing aurora and winter storms around the Ring Road.', template_id: 'masonry' },
    { slug: 'tokyo-nights', title: 'Tokyo Nights', description: 'Neon, rain, and long exposures in Shibuya and Shinjuku.', template_id: 'grid' },
    { slug: 'studio-portraits', title: 'Studio Portraits', description: 'Available-light portraits, mostly prime lenses.', template_id: 'lightbox' },
    { slug: 'safari', title: 'Safari — Serengeti', description: 'A week of golden-hour wildlife in Tanzania.', template_id: 'cover' },
    { slug: 'city-of-london', title: 'City of London', description: 'Architectural studies around the Square Mile.', template_id: 'carousel' },
    { slug: 'studio-light', title: 'Studio Light', description: 'A short study in single-source lighting.', template_id: 'slideshow' },
    { slug: 'wild-coast', title: 'Wild Coast', description: 'Surf, sand, and shoreline.', template_id: 'justified' },
  ];
  for (const s of seeds) {
    seedStmt.run(s.slug, s.title, s.description, s.template_id);
  }
}

// ----- Typed queries -----

export type GalleryRow = {
  id: number;
  slug: string;
  title: string;
  description: string;
  template_id: string;
  template_config_json: string;
  cover_image_id: number | null;
  password_hash: string | null;
  created_at: string;
};

export type ImageRow = {
  id: number;
  gallery_id: number;
  path: string;
  original_name: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  mime: string;
  exif_json: string;
  sort_order: number;
  created_at: string;
};

export function listGalleries(): GalleryRow[] {
  return getDb().prepare('SELECT * FROM galleries ORDER BY created_at DESC').all() as GalleryRow[];
}

export function getGalleryBySlug(slug: string): GalleryRow | undefined {
  return getDb().prepare('SELECT * FROM galleries WHERE slug = ?').get(slug) as GalleryRow | undefined;
}

export function getGalleryById(id: number): GalleryRow | undefined {
  return getDb().prepare('SELECT * FROM galleries WHERE id = ?').get(id) as GalleryRow | undefined;
}

export function listImagesForGallery(galleryId: number): ImageRow[] {
  return getDb()
    .prepare('SELECT * FROM images WHERE gallery_id = ? ORDER BY sort_order ASC, id ASC')
    .all(galleryId) as ImageRow[];
}

export function getImage(id: number): ImageRow | undefined {
  return getDb().prepare('SELECT * FROM images WHERE id = ?').get(id) as ImageRow | undefined;
}

export function insertImage(input: {
  gallery_id: number;
  path: string;
  original_name: string;
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
  mime: string;
  exif?: Record<string, unknown>;
}): number {
  const next = (getDb()
    .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM images WHERE gallery_id = ?')
    .get(input.gallery_id) as { n: number }).n;
  const stmt = getDb().prepare(`
    INSERT INTO images (gallery_id, path, original_name, width, height, bytes, mime, exif_json, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    input.gallery_id,
    input.path,
    input.original_name,
    input.width ?? null,
    input.height ?? null,
    input.bytes ?? null,
    input.mime,
    JSON.stringify(input.exif ?? {}),
    next,
  );
  return Number(info.lastInsertRowid);
}

export function deleteImage(id: number): boolean {
  return getDb().prepare('DELETE FROM images WHERE id = ?').run(id).changes > 0;
}

export function imageCount(galleryId: number): number {
  return (getDb().prepare('SELECT COUNT(*) as n FROM images WHERE gallery_id = ?').get(galleryId) as { n: number }).n;
}
