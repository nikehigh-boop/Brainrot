import { createHash, timingSafeEqual } from 'node:crypto';

// SHA-256 of the admin token. The token itself is never stored in the repo.
const ADMIN_SHA256 = process.env.ADMIN_TOKEN_SHA256 || '22f8b9d681e4d53c904317c8fc2bf8519a4ef2bdb9c97a6f6ddba49b14bee572';

export function isAdmin(authorization) {
  const got = String(authorization || '').replace(/^Bearer\s+/i, '');
  if (got.length < 24) return false;
  return timingSafeEqual(createHash('sha256').update(got).digest(), Buffer.from(ADMIN_SHA256, 'hex'));
}
