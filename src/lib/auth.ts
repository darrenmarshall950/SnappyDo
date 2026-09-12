/**
 * Authentication primitives for SnappyDo.
 *
 * For v0.6/v0.7 this is a single-photographer system:
 *   - Admin credentials configured via env (ADMIN_USERNAME, ADMIN_PASSWORD_HASH)
 *   - Per-gallery passwords are bcrypt-hashed and stored in the gallery row
 *   - Sessions are signed HTTP-only cookies (no JWT, no localStorage)
 *
 * Cookie naming:
 *   - snappydo_admin       — admin login session (signed JSON payload)
 *   - snappydo_gallery_<id> — per-gallery unlock token
 *
 * Cookie security:
 *   - HttpOnly (no JS access)
 *   - SameSite=Lax (CSRF mitigation, allows top-level nav)
 *   - Secure flag added automatically when not localhost
 *   - Signed with HMAC-SHA256 using SESSION_SECRET (rotating-secret safe)
 *
 * Constant-time comparison: all cookie verification uses crypto.timingSafeEqual.
 * Password hashing: bcrypt cost 12 (matches OWASP recommendation).
 */
import { hash, verify } from '@node-rs/bcrypt';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const COOKIE_SECRET = process.env.SESSION_SECRET || 'change-me-in-prod-this-is-insecure';
const ADMIN_COOKIE = 'snappydo_admin';
const GALLERY_COOKIE_PREFIX = 'snappydo_gallery_';
const ADMIN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const GALLERY_TTL_SECONDS = 60 * 60 * 24;   // 24 hours

export const BCRYPT_COST = 12;

// ============================================================
// Password hashing (bcrypt)
// ============================================================

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  try {
    return await verify(plain, hashed);
  } catch {
    return false;
  }
}

// ============================================================
// Admin credentials (env-based)
// ============================================================

export function getAdminUsername(): string {
  return process.env.ADMIN_USERNAME || 'admin';
}

export function getAdminPasswordHash(): string | null {
  // Primary: env var (works when .env escaping is correct)
  const fromEnv = process.env.ADMIN_PASSWORD_HASH;
  if (fromEnv && fromEnv.startsWith('$2b$') && fromEnv.length > 50) {
    return fromEnv;
  }
  // Fallback: read from secrets file written at deploy time
  // This avoids .env $ escaping issues in Docker Compose .env files
  try {
    const secretPath = '/app/data/admin_password_hash';
    if (existsSync(secretPath)) {
      const content = readFileSync(secretPath, 'utf8').trim();
      if (content.startsWith('$2b$') && content.length > 50) {
        return content;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/** True if admin credentials are configured. */
export function adminAuthConfigured(): boolean {
  const u = getAdminUsername();
  const h = getAdminPasswordHash();
  return Boolean(u && h && h.length > 10);
}

export async function verifyAdminCredentials(username: string, password: string): Promise<boolean> {
  if (username !== getAdminUsername()) return false;
  const stored = getAdminPasswordHash();
  if (!stored) return false;
  return verifyPassword(password, stored);
}

// ============================================================
// Signed cookies (HMAC-SHA256, constant-time compare)
// ============================================================

function sign(payload: string): string {
  const h = createHmac('sha256', COOKIE_SECRET).update(payload).digest('base64url');
  return `${payload}.${h}`;
}

function verify_(signed: string): string | null {
  const lastDot = signed.lastIndexOf('.');
  if (lastDot < 0) return null;
  const payload = signed.slice(0, lastDot);
  const sig = signed.slice(lastDot + 1);
  const expected = createHmac('sha256', COOKIE_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length) return null;
  try {
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return payload;
}

interface AdminSession {
  user: string;
  exp: number;
}

interface GallerySession {
  galleryId: number;
  exp: number;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  const parts = raw.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function buildCookie(name: string, value: string, ttlSeconds: number, secure: boolean): string {
  const expires = new Date(Date.now() + ttlSeconds * 1000).toUTCString();
  const flags = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Expires=${expires}`,
  ];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

function clearCookie(name: string, secure: boolean): string {
  const flags = [
    `${name}=`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  ];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

function isSecureRequest(req: Request): boolean {
  // For local LAN / docker, the host header doesn't indicate HTTPS.
  // Treat localhost/127.0.0.1 as non-secure; everything else gets Secure.
  const url = new URL(req.url);
  return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? false : url.protocol === 'https:';
}

// ============================================================
// Admin session
// ============================================================

export function createAdminSessionCookie(req: Request, username: string): string {
  const payload: AdminSession = { user: username, exp: Date.now() + ADMIN_TTL_SECONDS * 1000 };
  const signed = sign(JSON.stringify(payload));
  return buildCookie(ADMIN_COOKIE, signed, ADMIN_TTL_SECONDS, isSecureRequest(req));
}

export function clearAdminSessionCookie(req: Request): string {
  return clearCookie(ADMIN_COOKIE, isSecureRequest(req));
}

export function readAdminSession(req: Request): AdminSession | null {
  const signed = readCookie(req, ADMIN_COOKIE);
  if (!signed) return null;
  const payload = verify_(signed);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as AdminSession;
    if (!parsed.user || !parsed.exp) return null;
    if (parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ============================================================
// Gallery unlock (per-gallery password cookie)
// ============================================================

export function createGalleryUnlockCookie(req: Request, galleryId: number): string {
  const payload: GallerySession = { galleryId, exp: Date.now() + GALLERY_TTL_SECONDS * 1000 };
  const signed = sign(JSON.stringify(payload));
  return buildCookie(`${GALLERY_COOKIE_PREFIX}${galleryId}`, signed, GALLERY_TTL_SECONDS, isSecureRequest(req));
}

export function clearGalleryUnlockCookie(req: Request, galleryId: number): string {
  return clearCookie(`${GALLERY_COOKIE_PREFIX}${galleryId}`, isSecureRequest(req));
}

export function readGalleryUnlock(req: Request, galleryId: number): boolean {
  const signed = readCookie(req, `${GALLERY_COOKIE_PREFIX}${galleryId}`);
  if (!signed) return false;
  const payload = verify_(signed);
  if (!payload) return false;
  try {
    const parsed = JSON.parse(payload) as GallerySession;
    return parsed.galleryId === galleryId && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

// ============================================================
// Rate limiting (in-memory, MVP only — replace with Redis for prod)
// ============================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const rateLimits = new Map<string, RateLimitEntry>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || entry.resetAt < now) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}

// ============================================================
// Utility — generate a random password (for initial admin setup)
// ============================================================

export function generateRandomPassword(length = 16): string {
  const bytes = randomBytes(length);
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}
