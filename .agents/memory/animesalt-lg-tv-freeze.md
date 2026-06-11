---
name: AnimeSalt LG TV video freeze fix
description: Root cause and fix for LG WebOS video freezing while audio plays on AnimeSalt CDN multi-quality master streams.
---

## Rule

For AnimeSalt CDN multi-quality master streams (`isVariant = false` path in `computeRelayM3u8`):

1. **Probe the first segment of the first video variant** to get the CDN PMT PID (consistently 4096 = 0x1000).
2. **Route every video quality variant URL** through `/m3u8?...&audiopid=1&pmtpid=4096&noAudioProbe=1` so the `/m3u8` handler sets `doAudioFilter=true` and routes all segments through `/as-va`.
3. `/as-va` patches the PMT to remove the audio PID entry and drops all audio TS packets → truly video-only TS.
4. **Keep the CDN audio renditions** in the outer master (do NOT strip them). Run `putHindiFirstInMaster()` to ensure Hindi is listed first with `DEFAULT=YES`.

**Why:** LG WebOS GStreamer pipeline finds two audio sources — the PMT-declared audio PID in the video TS + the external AUDIO= renditions. This double-audio condition stalls the video decoder. Symptom: audio plays, video frozen. Removing the audio PID from the video TS PMT (via /as-va) eliminates the conflict so LG TV uses only the external CDN audio renditions.

**Fallback:** If the CDN master probe fails (`cdnPmtPid <= 0`), strip all `#EXT-X-MEDIA:TYPE=AUDIO` lines and `AUDIO="..."` attributes from `#EXT-X-STREAM-INF` as a safety net. LG TV then plays the muxed audio silently, better than the freeze.

**How to apply:** Only in the `isVariant = false` branch. The `isVariant = true` synthetic-master path is unaffected — it already routes video through `/as-va` + audio through `/as-audio-pl`.

## Verified

- CDN PMT PID = 4096 (0x1000) consistently.
- After fix: ffprobe on `/as-va` segment → `Video=1 Audio=0`. Raw PMT parse → single entry `{H264_VIDEO, pid:256}`. No audio PID declared.
- Server logs: `AnimeSalt relay: CDN master segment probe` with `pmtPid: 4096`.

## noAudioProbe guard (companion fix)

`noAudioProbe=1` is added to every playlist URL in `proxyUrl()`. The `/m3u8` handler skips its TS audio probe when set, preventing it from replacing a variant playlist with a synthetic master. Condition in `/m3u8` handler: `!doAudioFilter && !noAudioProbe`.

## CDN structure

- `isVariant = false` master: 4 quality variants (240p/360p/480p/720p) + 5 audio renditions (Hindi/Japanese/English/Malayalam/Tamil). PMT in video TS declares audio PID 256 (Hindi) but the PID has no actual audio packets.
- `isVariant = true` variant: single-quality segment playlist, TS has real multi-audio PIDs → probe finds all tracks → synthetic master built.
