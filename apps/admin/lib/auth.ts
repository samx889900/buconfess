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
  const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;

  if (!passwordHash) {
    throw new Error(
      'ADMIN_PASSWORD_HASH is not set. Generate one with: npx tsx scripts/generate-password-hash.ts "your-password"'
    );
  }

  if (username !== expectedUsername) return false;

  return bcrypt.compare(password, passwordHash);
}

/**
 * Checks if the current request has a valid admin session cookie.
 */
export async function getAdminFromRequest(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get('admin_token')?.value;
  if (!token) return false;
  const payload = verifyToken(token);
  return !!payload;
}
