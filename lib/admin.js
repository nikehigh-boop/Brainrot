import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';

// SHA-256 of the admin token. The token itself is never stored in the repo.
const ADMIN_SHA256 = process.env.ADMIN_TOKEN_SHA256 || '22f8b9d681e4d53c904317c8fc2bf8519a4ef2bdb9c97a6f6ddba49b14bee572';

export function isAdmin(authorization) {
  const got = String(authorization || '').replace(/^Bearer\s+/i, '');
  if (got.length < 24) return false;
  return timingSafeEqual(createHash('sha256').update(got).digest(), Buffer.from(ADMIN_SHA256, 'hex'));
}

// Stats page key: a salted scrypt hash only, the key itself is never stored.
const STATS_SALT = '186a521e1f662cb6b42594bf9a516bc7';
const STATS_SCRYPT = process.env.STATS_KEY_SCRYPT || 'e4b4729a2db758d6e0781d75636135e6814f12efd590008d54493f1e380774ba';
export function isStatsKey(authorization) {
  const got = String(authorization || '').replace(/^Bearer\s+/i, '');
  if (!got || got.length > 200) return false;
  return timingSafeEqual(scryptSync(got, STATS_SALT, 32), Buffer.from(STATS_SCRYPT, 'hex'));
}
