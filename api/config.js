// Public client config: Clerk publishable key and the web-push public key.
import { vapid } from '../lib/push.js';

export default async function handler(req, res) {
  let vapidKey = null;
  try { vapidKey = (await vapid())?.publicKey || null; } catch {}
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({
    clerkKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY || null,
    vapidKey,
  });
}
