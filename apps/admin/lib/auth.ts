import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';

// ---------------------------------------------------------------------------
// Admin Authentication Module
// ---------------------------------------------------------------------------
// Uses bcrypt for password verification (cost factor 10).
// JWT tokens for session management with 7-day expiry.
// 
// IMPORTANT: The plaintext ADMIN_PASSWORD env var has been eliminated.
// Only ADMIN_PASSWORD_HASH (bcrypt) is accepted.
// ---------------------------------------------------------------------------

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set.');
  }
  return secret;
}

export function signToken(payload: object): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' });
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (base64.length % 4)) % 4;
  const padded = base64 + '='.repeat(padLen);
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlDecodeToString(base64Url: string): string {
  const bytes = base64UrlToUint8Array(base64Url);
  return new TextDecoder().decode(bytes);
}

/**
 * Edge-compatible JWT verification using standard Web Crypto API.
 * Safely runs in Next.js middleware / Edge runtime without Node crypto dependencies.
 */
export async function verifyTokenAsync(token: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const secret = getJwtSecret();
    const sigBytes = base64UrlToUint8Array(sigB64);
    const dataBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes as BufferSource, dataBytes);
    if (!isValid) return null;

    const payloadJson = base64UrlDecodeToString(payloadB64);
    const decoded = JSON.parse(payloadJson);
    if (typeof decoded !== 'object' || decoded === null) return null;

    if (decoded.exp && typeof decoded.exp === 'number') {
      if (Date.now() >= decoded.exp * 1000) return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

export function verifyToken(token: string): jwt.JwtPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (typeof decoded === 'string') return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Verifies admin credentials using bcrypt hash comparison.
 * 
 * @param username - The submitted username.
 * @param password - The submitted plaintext password.
 * @returns true if credentials are valid.
 */
export async function verifyAdminCredentials(
  username: string,
  password: string
): Promise<boolean> {
  const expectedUsername = (process.env.ADMIN_USERNAME || 'admin').replace(/^["']|["']$/g, '');
  const rawHash = process.env.ADMIN_PASSWORD_HASH;

  if (!rawHash) {
    throw new Error(
      'ADMIN_PASSWORD_HASH is not set. Generate one with: npx tsx scripts/generate-password-hash.ts "your-password"'
    );
  }

  const passwordHash = rawHash.replace(/^["']|["']$/g, '');

  if (username !== expectedUsername) return false;

  return bcrypt.compare(password, passwordHash);
}

/**
 * Checks if the current request has a valid admin session cookie.
 * Supports passing req directly for test contexts or routes.
 */
export async function getAdminFromRequest(
  req?: { cookies: { get(name: string): { value: string } | undefined } }
): Promise<boolean> {
  let token: string | undefined;
  if (req && req.cookies && typeof req.cookies.get === 'function') {
    token = req.cookies.get('admin_token')?.value;
  }
  if (!token) {
    try {
      const cookieStore = await cookies();
      token = cookieStore.get('admin_token')?.value;
    } catch {
      // Called outside Next.js request store
    }
  }
  if (!token) return false;
  const payload = await verifyTokenAsync(token);
  return !!payload;
}
