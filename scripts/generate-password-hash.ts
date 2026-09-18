#!/usr/bin/env npx tsx
// ---------------------------------------------------------------------------
// generate-password-hash.ts
// ---------------------------------------------------------------------------
// Utility to generate a bcrypt hash for the admin password.
//
// Usage:
//   npx tsx scripts/generate-password-hash.ts "your-password"
//
// Output:
//   Set this as ADMIN_PASSWORD_HASH in your .env:
//   $2a$10$...
// ---------------------------------------------------------------------------

import bcrypt from 'bcryptjs';

const COST_FACTOR = 10;

async function main() {
  const password = process.argv[2];

  if (!password) {
    console.error('Usage: npx tsx scripts/generate-password-hash.ts "your-password"');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, COST_FACTOR);

  console.log('\n✅ Set this as ADMIN_PASSWORD_HASH in your .env:\n');
  console.log(hash);
  console.log('');
}

main().catch((err) => {
  console.error('Failed to generate hash:', err);
  process.exit(1);
});
