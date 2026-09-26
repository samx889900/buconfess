// ---------------------------------------------------------------------------
// Centralized Secrets & Environment Configuration
// ---------------------------------------------------------------------------
// All secret access must flow through this module. No direct `process.env`
// reads for secrets anywhere else in the codebase.
//
// Non-secret configuration (like feature flags or public URLs) may still
// use process.env directly, but any value that would be dangerous to log
// or expose must be accessed via getSecrets().
// ---------------------------------------------------------------------------

import { z } from 'zod';

export interface AppSecrets {
  // Supabase
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  supabaseAnonKey: string;

  // Google Gemini
  geminiApiKey: string;

  // Instagram Graph API
  instagramAccessToken: string;
  instagramUserId: string;

  // Google Sheets (Secondary Sync Destination — Non-blocking)
  googleSheetId: string;
  googleServiceAccountEmail: string;
  googlePrivateKey: string;

  // Email
  resendApiKey: string;
  digestEmail: string;

  // Admin Authentication & Security
  adminUsername: string;
  adminPasswordHash: string;
  jwtSecret: string;
  ipHashSecret: string;
}

// Server environment schema
const ServerEnvSchema = z.object({
  SUPABASE_URL: z.string().min(1, 'SUPABASE_URL is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  INSTAGRAM_ACCESS_TOKEN: z.string().min(1, 'INSTAGRAM_ACCESS_TOKEN is required'),
  INSTAGRAM_USER_ID: z.string().min(1, 'INSTAGRAM_USER_ID is required'),
  ADMIN_PASSWORD_HASH: z.string().min(1, 'ADMIN_PASSWORD_HASH is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  IP_HASH_SECRET: z.string().min(1, 'IP_HASH_SECRET is required'),
});

/**
 * Validates server environment variables using Zod.
 * Emits actionable error logs specifying only the missing variable name(s),
 * never printing or exposing secret values.
 */
export function validateServerEnv(): { valid: boolean; missingKeys: string[] } {
  const result = ServerEnvSchema.safeParse(process.env);
  if (!result.success) {
    const missingKeys = result.error.issues.map((i) => String(i.path[0]));
    for (const key of missingKeys) {
      console.error(`[CONFIG] Missing required production environment variable: ${key}`);
    }
    return { valid: false, missingKeys };
  }
  return { valid: true, missingKeys: [] };
}

// Cache the secrets object so we only parse env vars once
let _secrets: AppSecrets | null = null;

/**
 * Loads and validates all application secrets from environment variables.
 * Throws if any required secret is missing.
 *
 * Call this early in application startup to fail fast on misconfiguration.
 */
export function getSecrets(): AppSecrets {
  if (_secrets) return _secrets;

  const required = (key: string, envKey: string): string => {
    const value = process.env[envKey];
    if (!value) {
      console.error(`[CONFIG] Missing required production environment variable: ${envKey}`);
      throw new Error(`Missing required environment variable: ${envKey}`);
    }
    return value;
  };

  const optional = (envKey: string, fallback: string = ''): string => {
    return process.env[envKey] || fallback;
  };

  _secrets = {
    // Supabase
    supabaseUrl: required('supabaseUrl', 'SUPABASE_URL'),
    supabaseServiceRoleKey: required('supabaseServiceRoleKey', 'SUPABASE_SERVICE_ROLE_KEY'),
    supabaseAnonKey: optional('NEXT_PUBLIC_SUPABASE_ANON_KEY'),

    // Google Gemini
    geminiApiKey: required('geminiApiKey', 'GEMINI_API_KEY'),

    // Instagram Graph API
    instagramAccessToken: required('instagramAccessToken', 'INSTAGRAM_ACCESS_TOKEN'),
    instagramUserId: required('instagramUserId', 'INSTAGRAM_USER_ID'),

    // Google Sheets (Secondary Sync Destination — Non-blocking, optional at core startup)
    googleSheetId: optional('GOOGLE_SHEET_ID'),
    googleServiceAccountEmail: optional('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    googlePrivateKey: optional('GOOGLE_PRIVATE_KEY'),

    // Email
    resendApiKey: optional('RESEND_API_KEY'),
    digestEmail: optional('DIGEST_EMAIL', 'admin@buconfess.com'),

    // Admin Authentication & Security
    adminUsername: optional('ADMIN_USERNAME', 'admin'),
    adminPasswordHash: required('adminPasswordHash', 'ADMIN_PASSWORD_HASH'),
    jwtSecret: required('jwtSecret', 'JWT_SECRET'),
    ipHashSecret: required('ipHashSecret', 'IP_HASH_SECRET'),
  };

  return _secrets;
}

/**
 * Returns Google Sheets credentials if configured, or null if unconfigured.
 * Ensures Google Sheets remains strictly secondary and unblocks core publishing.
 */
export function getGoogleSheetsSecrets(): {
  sheetId: string;
  serviceAccountEmail: string;
  privateKey: string;
} | null {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (!sheetId || !email || !key) return null;
  return { sheetId, serviceAccountEmail: email, privateKey: key };
}

/**
 * Lazily loads secrets, returning null for missing values instead of throwing.
 * Use this in contexts where not all secrets are required (e.g., public app).
 */
export function getOptionalSecret(envKey: string): string | undefined {
  return process.env[envKey] || undefined;
}

/**
 * Returns a list of all secret environment variable names.
 * Used by redactSecrets() to sanitize logs and emails.
 */
export function getSecretEnvKeys(): string[] {
  return [
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'GEMINI_API_KEY',
    'INSTAGRAM_ACCESS_TOKEN',
    'GOOGLE_PRIVATE_KEY',
    'RESEND_API_KEY',
    'ADMIN_PASSWORD_HASH',
    'JWT_SECRET',
    'IP_HASH_SECRET',
  ];
}
