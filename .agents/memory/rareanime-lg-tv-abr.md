---
name: RareAnime LG TV ABR fix
description: Why RareAnime streams fail on LG WebOS after ~5-6 seconds and how it is fixed.
---

# RareAnime LG TV "Error while decoding" — root cause and fix

## Rule
When the RareAnime proxy forwards a groovy.monster multi-variant ABR master playlist verbatim, LG WebOS (Stremio on LG TV) will fail with "Error while decoding" after ~5–6 seconds. The fix is to reduce the master to a single highest-bandwidth variant before serving it.

**Why:** groovy.monster returns a 4-variant (360p/480p/720p/1080p) MPEG-TS HLS master. Android ExoPlayer handles ABR switching by re-initialising the codec. LG WebOS's native HLS player does not — when it attempts its first quality switch (~5 s after playback starts, based on its bandwidth estimate) the MPEG-TS PID/codec context changes between streams, causing an unrecoverable decode error.

**How to apply:** `filterToSingleVariant()` in `artifacts/api-server/src/routes/rareanime-proxy.ts` is called after `rewriteM3u8()` in both the `/hls/master.m3u8` and `/hls/seg` handlers. It detects `#EXT-X-STREAM-INF` presence, collects all variant+bandwidth pairs, picks the highest-BANDWIDTH entry, drops all others, drops `#EXT-X-I-FRAME-STREAM-INF` lines, and strips `AUDIO=` group references from the winning STREAM-INF (MPEG-TS embeds audio in-stream). Media playlists and single-variant masters pass through unchanged.

## Comparison: MovieBox (works) vs RareAnime (was broken)
- MovieBox: DASH MPD → HLS CMAF conversion, single repr per media playlist, `EXT-X-MAP`, version 6, explicit hev1→hvc1 codec normalisation.
- RareAnime: MPEG-TS HLS from groovy.monster CDN, no fMP4, no EXT-X-MAP needed, fix is purely ABR suppression.
