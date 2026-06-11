---
name: HubCloud R2 strategy and download page structure
description: Complete HubCloud download chain as of 2025-06, including FSL Server R2, 10Gbps hubcloud.cx chain, and what gamerxyt.com handles.
---

## Current HubCloud download chain (2025-06)

### Landing page → download page
- Landing: `hubcloud.foo/drive/SLUG`
- `id="download"` href → `gamerxyt.com/hubcloud.php?host=hubcloud&id=SLUG&token=TOKEN`
  - **NOTE**: download page is now on `gamerxyt.com`, not `hubcloud.dad`. Code checks `url.includes("hubcloud.php")` which matches either domain. ✓

### Download page buttons (class="btn btn-*")
1. **FSL Server** (`btn-success`): `pub-*.r2.dev/HASH?token=TIMESTAMP`
   - Signed R2 with `?token=` — accessible from server-side (200 OK) even from data-centre IPs
   - Token is a Unix timestamp expiry, short-lived (hours)
   - `isPlainR2()` returns false for `?token=` URLs → routed through proxy with `ori=` param ✓
2. **10Gbps** (`btn-danger`): `gpdl.hubcloud.cx/?id=LONG_HASH::SHORT_HASH`
   - Chain: hubcloud.cx → workers.dev → `gamerxyt.com/dl.php?link=GOOGLE_VIDEO_URL` (200 HTML)
   - The `dl.php` wrapper returns **200 HTML**, NOT a redirect
   - Actual video URL is in the `?link=` query param of the final `dl.php` URL
   - Must use `redirect: "follow"` and extract `link=` param from `resp.url`

### No BuzzServer buttons on this page format
The current HubCloud download page does NOT have BuzzServer buttons. BuzzServer handling still exists for older pages.

## Rule
Whenever a hubcloud.cx URL is encountered (in `extract10Gbps` or proxy re-extraction):
1. Use `fetch(url, { redirect: "follow" })` to follow the full chain
2. Check `new URL(resp.url).searchParams.get("link")` for the video URL
3. If found and starts with "http" → that IS the video URL

## Why
gpdl.hubcloud.cx redirects to a Cloudflare Workers endpoint, which redirects to `gamerxyt.com/dl.php?link=VIDEO_URL`. The dl.php page is an HTML wrapper — the video URL is ONLY in the URL query parameter `link=`, not the response body.

## How to apply
- `extract10Gbps` in `hubcloud.ts`: calls `resolveHubcloudCxUrl(link)` → follows chain → returns Google Video URL
- Priority 2 in `reExtractFromHubCloud` in `proxy.ts`: same inline logic
- `refreshFromDownloadPage` in `proxy.ts`: same inline logic for Priority 2

## R2 plain bucket handling (no token)
Plain `pub-*.r2.dev` URLs (no `?token=`) are blocked by R2 for data-centre IPs:
- `isPlainR2()` detects these: `/pub-[0-9a-f]{10,}\.r2\.dev\//i.test(url) && !/[?&](X-Amz-Signature|token|Expires)=/i.test(url)`
- Route through proxy for re-extraction; if re-extraction fails → 302 redirect so player's IP reaches R2 directly
