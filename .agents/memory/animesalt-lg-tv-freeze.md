---
name: AnimeSalt LG TV video freeze fix
description: Root causes and fixes for LG WebOS video freeze on AnimeSalt CDN streams — double-audio condition AND multi-variant ABR switching.
---

## Two distinct LG WebOS failure modes — both must be fixed

### Failure 1: Double-audio condition (video freeze, audio plays)

For AnimeSalt CDN multi-quality master streams (`isVariant = false` path in `computeRelayM3u8`):

1. **Probe the first segment of the first video variant** to get the CDN PMT PID (consistently 4096 = 0x1000).
2. **Route every video quality variant URL** through `/m3u8?...&audiopid=1&pmtpid=4096&noAudioProbe=1` so the `/m3u8` handler sets `doAudioFilter=true` and routes all segments through `/as-va`.
3. `/as-va` patches the PMT to remove the audio PID entry and drops all audio TS packets → truly video-only TS.
4. **Keep the CDN audio renditions** in the outer master (do NOT strip them). Run `putHindiFirstInMaster()` to ensure Hindi is listed first with `DEFAULT=YES`.

**Why:** LG WebOS GStreamer pipeline finds two audio sources — the PMT-declared audio PID in the video TS + the external AUDIO= renditions. This double-audio condition stalls the video decoder. Symptom: audio plays, video frozen.

**Fallback:** If the CDN master probe fails (`cdnPmtPid <= 0`), strip all `#EXT-X-MEDIA:TYPE=AUDIO` lines and `AUDIO="..."` attributes from `#EXT-X-STREAM-INF` as a safety net.

---

### Failure 2: ABR multi-variant switching (video freeze at ~5 s)

`computeRelayM3u8` for the `isVariant = false` path was returning the full 4-quality master (240p/360p/480p/720p) after applying the double-audio fix above — without calling `filterToSingleVariantProxy`. LG TV would attempt ABR quality switching at ~5 s, triggering a codec/resolution re-init it cannot recover from.

**Fix:** After `putHindiFirstInMaster()`, call `filterToSingleVariantProxy(withHindiFirst)` and return the result (`withSingleVariant`) instead of `withHindiFirst` directly. This collapses the master to the single highest-bandwidth variant while **preserving all `#EXT-X-MEDIA` audio renditions** (the audio group system is orthogonal to quality variant selection).

**Why missed earlier:** The `/m3u8` handler already calls `filterToSingleVariantProxy` at line 1521, but that handler is only invoked for the individual variant playlists (which are already single-variant) — NOT for the outer master, which is built and returned by `computeRelayM3u8` directly and served by `/as-relay`. The relay path never went through the `/m3u8` handler's ABR filter.

**How to apply:** In `computeRelayM3u8`, the call is placed after the `withHindiFirst` computation block and before the `isVariant && detectedTracks.length > 1` early-return path. The `isVariant=true` + multi-track path returns early before this code — unaffected.

---

## Verified facts about CDN structure

- `isVariant = false` master: 4 quality variants (240p/360p/480p/720p) + 5 audio renditions (Hindi/Japanese/English/Malayalam/Tamil). PMT in video TS declares audio PID 256 (Hindi) but the PID has no actual audio packets.
- `isVariant = true` variant: single-quality segment playlist, TS has real multi-audio PIDs → probe finds all tracks → synthetic master built (already single-variant by construction).
- CDN PMT PID = 4096 (0x1000) consistently.

## noAudioProbe guard (companion fix)

`noAudioProbe=1` is added to every playlist URL in `proxyUrl()`. The `/m3u8` handler skips its TS audio probe when set, preventing it from replacing a variant playlist with a synthetic master. Condition in `/m3u8` handler: `!doAudioFilter && !noAudioProbe`.
