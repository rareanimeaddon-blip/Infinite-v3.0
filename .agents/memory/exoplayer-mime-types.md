---
name: ExoPlayer MIME type normalization
description: HubCloud CDNs return wrong Content-Type labels that cause ExoPlayer to silently fail (no fatal error, 0ms position, Codec N/A). Fix lives in resolveContentType() in proxy.ts.
---

## The problem
HubCloud FSL/buzz CDNs serve Matroska (.mkv) video files with `Content-Type: video/mkv`.  
`video/mkv` is **not** an IANA-registered type. ExoPlayer has no MatroskaExtractor mapped to it, so it:
- Downloads the bytes (network activity is active)
- Cannot identify a parser → Position stays at 0ms, Video/Audio Codec = N/A
- No fatal error logged — silent failure

The same CDNs send `application/octet-stream` for MP4 files.

## Diagnostic method
1. `curl -sI <proxy_url>` → check `Content-Type` in response
2. `curl -s -r 0-15 <proxy_url> | od -A x -t x1z` → check magic bytes
   - MKV: `1A 45 DF A3`
   - MP4: bytes 4-7 are `66 74 79 70` ("ftyp")
   - MPEG-TS: first byte `47`

## Fix
`resolveContentType(raw, firstBytes?)` in `proxy.ts` (used by both `pipeUpstream` and `/hmproxy`):
1. `video/mkv` / `video/x-mkv` → `video/x-matroska`
2. `application/octet-stream` / `binary/octet-stream` / empty → sniff magic bytes, then fallback `video/mp4`
3. All other types → pass through unchanged

The function is called AFTER peeking the first chunk (one `reader.read()` before setting response headers), so magic-byte sniffing doesn't require buffering the whole body.

**Why:**  
ExoPlayer maps MIME types to media extractors at the start of playback. An unrecognised type means no extractor is selected, no frames are decoded, and the player appears frozen at position 0.

**How to apply:**  
Any time a CDN adds a new non-standard type (e.g. `video/avi`, `video/x-msvideo`), add it to `resolveContentType`. Run `curl -sI <proxy_url>` to verify the normalised type is returned before testing in Stremio.
