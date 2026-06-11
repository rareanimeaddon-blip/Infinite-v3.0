---
name: HubCloud BuzzServer HTML-body change
description: BuzzServer /download endpoint now returns 200 HTML instead of a redirect header; CDN URL is inside the HTML body.
---

## Rule
When calling `${buzzLink}/download`, always check for BOTH the old redirect-header path AND the new 200-HTML-body path.

## Why
Around 2025-06, BuzzServer changed its `/download` endpoint response:
- **Old**: HTTP 302/200 with `hx-redirect` or `location` header pointing directly to the CDN video URL.
- **New**: HTTP 200 with an HTML "Link Generated! Download Here" page; the actual CDN URL is in `<a id="download" href="CDN_URL">`.

The old `getNoRedirect` approach discarded the response body, so it always saw empty headers and logged "no redirect found" — resulting in no stream being added.

## How to apply
In `extractBuzzServer` (hubcloud.ts) and the BuzzServer section of `reExtractFromHubCloud` (proxy.ts):
1. Use `fetch` with `redirect: "manual"` (not `getNoRedirect`) to access both headers AND body.
2. First check `hx-redirect` / `location` headers (old path).
3. If status is 200, read body and regex-match `id="download"` href (new path).
4. Only push/return a URL if it starts with "http".
