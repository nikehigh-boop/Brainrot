import { verifyToken } from '@clerk/backend';

// Returns the Clerk user id for a valid session token, or null.
export async function userId(req) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secretKey || !tok) return null;
  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const claims = await verifyToken(tok, { secretKey, authorizedParties: [`${proto}://${req.headers.host}`] });
    return claims.sub || null;
  } catch {
    return null;
  }
}
