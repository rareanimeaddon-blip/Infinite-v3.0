---
name: AnimeSalt CDN VOD tag injection
description: Why #EXT-X-PLAYLIST-TYPE:VOD must be injected early (before rewriting loop) and gated on its own absence, not on #EXT-X-ENDLIST.
---

## Rule
Inject `#EXT-X-PLAYLIST-TYPE:VOD` into AnimeSalt CDN (`as-cdn*.top`) variant playlists by modifying `playlistText` **before** the rewriting loop in the `/m3u8` handler. Gate the injection on `!playlistText.includes("#EXT-X-PLAYLIST-TYPE")` — never on `!includes("#EXT-X-ENDLIST")`.

**Why:** The CDN already appends `#EXT-X-ENDLIST` to every variant playlist, so any condition that checks `!#EXT-X-ENDLIST` silently skips without injecting the VOD type tag. This cost many debugging iterations before the root cause was found (checking the raw CDN response directly revealed ENDLIST was present).

**How to apply:** In `artifacts/api-server/src/routes/proxy.ts`, the injection block uses `let playlistText = text` then inserts after `playlistText.indexOf("\n")` (i.e., right after the `#EXTM3U` line). Both the audio-probe block and the rewriting loop use `playlistText` so the injected tag survives into the final response.
