---
name: HubCloud R2 private bucket strategy
description: How to handle plain pub-*.r2.dev URLs from HubCloud (HDHub4U / 4KHDHub) — server-side proxy cannot reach them but the player's IP can.
---

## Rule
Plain `pub-*.r2.dev` URLs (no `X-Amz-Signature`, `token`, or `Expires` params) must never be proxied directly — always attempt re-extraction first, then fall back to a 302 redirect for the player.

## Why
Cloudflare R2 private buckets return 403 "This bucket cannot be viewed" for all requests from data-centre IP ranges (including Replit). The player's mobile/residential IP can access public R2 buckets directly. Proxying through our server guarantees a 403; a 302 redirect gives the player a chance.

## How to apply

### In `hd4uStreamToStremio` / `fourkdStreamToStremio` (stremio.ts)
- Before the `referer && req` proxy branch, check `isPlainR2(s.url)`.
- If true, route through proxy with `lp=` but no `ori=` (proxy handles redirect, not piping).

### In proxy route `/proxy` (proxy.ts)
- `isPlainR2(targetUrl)` AND `(landingPage || referer)` → trigger proactive re-extraction.
- `reExtractFromHubCloud(landingPage)` tries BuzzServer → 10Gbps → ZipDisk → signed URLs → direct video links.
- If fresh non-R2 URL found → pipe it through proxy.
- If re-extraction fails or returns another R2 URL → `res.redirect(302, targetUrl)`.

### In `extract10Gbps` (hubcloud.ts)
- Only push a stream if a redirect was actually found (`finalUrl !== ""`).
- If `getNoRedirect` finds no `location` header, skip — the original button URL is an HTML page, not a CDN URL.

### `isPlainR2(url)` definition
```typescript
function isPlainR2(url: string): boolean {
  return /pub-[0-9a-f]{10,}\.r2\.dev\//i.test(url) &&
         !/[?&](X-Amz-Signature|token|Expires)=/i.test(url);
}
```
Defined at top-level in both `proxy.ts` and `stremio.ts`.
