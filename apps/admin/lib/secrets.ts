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

  // Google Sheets (Admin Sync Only)
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

    // Google Sheets (Admin Sync Only)
    googleSheetId: required('googleSheetId', 'GOOGLE_SHEET_ID'),
    googleServiceAccountEmail: required('googleServiceAccountEmail', 'GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    googlePrivateKey: required('googlePrivateKey', 'GOOGLE_PRIVATE_KEY'),

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
