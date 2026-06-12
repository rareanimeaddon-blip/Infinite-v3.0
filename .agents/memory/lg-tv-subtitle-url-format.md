---
name: LG TV subtitle URL format
description: Stremio LG TV WebOS uses a 3-segment subtitles URL, not the standard 2-segment form; Express 5 wildcard syntax requirements.
---

## Rule
Register **two** subtitle routes to cover both Stremio client variants:
1. `/subtitles/:type/:id.json` — Android / desktop / web (2-segment)
2. `/subtitles/:type/:id/:extra.json` — LG TV WebOS (3-segment, `:extra` discarded)

## Why
Stremio LG TV WebOS appends the currently-playing stream URL as a 3rd path segment, e.g.:
```
/subtitles/movie/tt16431404/filename=m3u8%3Furl%3Dhttps%3A%2F%2F...master.m3u8%26origin%3D....json
```
The `:id` segment (`tt16431404`) is still the bare IMDB ID. The extra segment is stream context and can be ignored for subtitle lookup.

## Express 5 / path-to-regexp v8 note
`*` (bare wildcard) is rejected — `Missing parameter name`. Must use either a **named** wildcard (`:name*`) or a named param with a literal suffix like `:extra.json`. The 3-segment named-param approach (`/:extra.json`) is the simplest correct solution.

## How to apply
Extract the subtitle logic into a named handler function and register it for both routes:
```typescript
async function subtitlesHandler(req, res) { /* uses req.params.id */ }
router.get("/subtitles/:type/:id.json", subtitlesHandler);
router.get("/subtitles/:type/:id/:extra.json", subtitlesHandler);
```
