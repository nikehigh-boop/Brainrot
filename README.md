# Brainrot Dex

Steal the Brainrot (Fortnite) tracker: a static page plus a few small Vercel functions.
Live at https://brainrotdex.vercel.app · pushes to `main` deploy automatically.

```
index.html       the whole app (data and splash embedded; art and sounds live in a/)
a/               brainrot art, icons and sounds, named by content hash (cached for a year)
stats.html       private visitor stats page (/stats, needs the admin token)
feed.json        bundled snapshot of the live feed (used until the first update)
sw.js            service worker: push alerts, offline copy, art cache
api/config.js    hands the browser the Clerk publishable key
api/state.js     GET/PUT a signed-in player's progress (Upstash Redis)
api/feed.js      GET live feed · POST updates (admin token) · schedules timed alerts
api/notify.js    sends push alerts (called by QStash at the scheduled time)
api/push.js      subscribe / unsubscribe a device for alerts
api/stats.js     anonymous visit counter (POST) · totals (GET, admin token)
api/discord.js   reads followed STB channels through your bot; ?sync=1 turns Admin Machine posts into rolls
lib/             Redis, auth, push, alert and scheduling helpers
```

Sign-in: Clerk (Google, Apple, email), via the Vercel Marketplace integration.
Storage: Upstash Redis, via the Vercel Marketplace integration.
Both integrations set their own environment variables, so there are no keys to copy by hand.

Without them the site still works: progress stays in each visitor's browser and the feed comes from feed.json.

## Updating the live feed

```bash
curl -X POST https://<your-site>/api/feed \
  -H "Authorization: Bearer <admin token>" -H "Content-Type: application/json" \
  -d '{"live": { ... }}'
```

Top-level fields you send replace the stored ones. Browsers poll `/api/feed` every 5 minutes.
The repo only holds the token's SHA-256 hash (override with `ADMIN_TOKEN_SHA256`).
