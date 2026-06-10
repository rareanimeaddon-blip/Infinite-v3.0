import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { getPlayerApiResult } from "../lib/animesalt-player-cache.js";
import { logDebug } from "../lib/debug-log.js";
import { BASE_PATH } from "../lib/base-path.js";
import { proxyFetch } from "../lib/proxy-fetch.js";
import { extractSrtFromZip } from "../lib/opensubtitles.js";
import { probeAudioTracks, filterAudioPid, filterVideoAndAudio } from "../lib/ts-audio.js";

const router = Router();

const UPSTREAM_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

export function encodeParam(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function decodeParam(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

async function pipeUpstream(
  targetUrl: string,
  cookie: string | undefined,
  req: Request,
  res: Response,
  extraHeaders?: Record<string, string>,
): Promise<void> {
  const t0 = Date.now();

  const upstreamHeaders: Record<string, string> = {
    "user-agent": UPSTREAM_UA,
    referer: "https://api3.aoneroom.com",
    origin: "https://api3.aoneroom.com",
  };
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      upstreamHeaders[k.toLowerCase()] = v;
    }
  }
  if (cookie) upstreamHeaders["cookie"] = cookie;

  const range = req.headers["range"];
  if (range) upstreamHeaders["range"] = range;

  const ifRange = req.headers["if-range"];
  if (ifRange) upstreamHeaders["if-range"] = String(ifRange);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, targetUrl }, "Upstream fetch failed");
    logDebug({
      method: req.method,
      path: req.path,
      rangeHeader: range,
      targetUrl,
      status: 502,
      durationMs: Date.now() - t0,
      error: msg,
    });
    res.status(502).end();
    return;
  }

  if (upstream.status >= 400) {
    logger.warn({ targetUrl, status: upstream.status }, "Upstream error");
    logDebug({
      method: req.method,
      path: req.path,
      rangeHeader: range,
      targetUrl,
      status: upstream.status,
      durationMs: Date.now() - t0,
      error: `CDN returned ${upstream.status}`,
    });
    res.status(upstream.status).end();
    return;
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");

  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);

  const contentRange = upstream.headers.get("content-range");
  if (contentRange) res.setHeader("Content-Range", contentRange);

  res.setHeader("Cache-Control", "no-store");
  res.status(upstream.status);

  if (!upstream.body) {
    logDebug({
      method: req.method, path: req.path, rangeHeader: range,
      targetUrl, status: upstream.status, contentType,
      bytesSent: 0, durationMs: Date.now() - t0,
    });
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  req.on("close", () => reader.cancel().catch(() => {}));

  let bytesSent = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      res.write(Buffer.from(value));
      bytesSent += value.byteLength;
    }
  } catch (err) {
    logger.warn({ err, targetUrl }, "Pipe interrupted");
  }

  logDebug({
    method: req.method, path: req.path, rangeHeader: range,
    targetUrl, status: upstream.status, contentType,
    bytesSent, durationMs: Date.now() - t0,
  });

  res.end();
}

// ─── MPD → HLS (CMAF) helpers ─────────────────────────────────────────────────
// LG WebOS browsers support HEVC in their *native* HLS player but often reject
// HEVC in MSE/DASH.  Converting the MovieBox MPD to an HLS master + media
// playlists (referencing the same fMP4 segments via our /seg proxy) lets LG TV
// play the stream through the native <video> element instead of dash.js + MSE.

function parseMpdDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!m) return 0;
  return (parseFloat(m[1] ?? "0") * 3600 +
          parseFloat(m[2] ?? "0") * 60 +
          parseFloat(m[3] ?? "0"));
}

function applyMpdTemplate(template: string, reprId: string, number?: number): string {
  let s = template.replace(/\$RepresentationID\$/g, reprId);
  s = s.replace(/\$Number(?:%0(\d+)d)?\$/g, (_full, width: string | undefined) => {
    const n = number ?? 0;
    return width ? String(n).padStart(parseInt(width, 10), "0") : String(n);
  });
  return s;
}

/** Extract a single named attribute value from a tag's attribute string (order-independent). */
function attrVal(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}="([^"]+)"`));
  return m?.[1];
}

/**
 * Normalise HEVC codec strings for LG WebOS compatibility.
 * LG WebOS Chromium's isTypeSupported() rejects bare "hev1" or "hvc1" without
 * a profile/level suffix. Convert to the canonical hvc1.1.6.LNN.90 form.
 *
 * HEVC level map (ITU-T H.265 Annex A):
 *   L60=2.0(240p)  L90=3.0(480p)  L93=3.1(720p)  L120=4.0(1080p)  L150=5.0(4K)
 */
const HEVC_LEVELS: Array<[number, string]> = [
  [240, "L60"], [480, "L90"], [720, "L93"], [1080, "L120"], [2160, "L150"],
];
function hevcLevelForHeight(h: number): string {
  for (const [maxH, lvl] of HEVC_LEVELS) if (h <= maxH) return lvl;
  return "L180";
}
function normalizeHevcCodec(codec: string, height: number): string {
  // hev1.X.Y.LZ.W → hvc1.X.Y.LZ.W  (swap type, keep profile info)
  if (/^hev1\.\S/.test(codec)) return codec.replace(/^hev1/, "hvc1");
  // bare hev1 or bare hvc1 → hvc1.1.6.LNN.90
  if (codec === "hev1" || codec === "hvc1") {
    return `hvc1.1.6.${hevcLevelForHeight(height)}.90`;
  }
  return codec;
}

// ─── MPD AdaptationSet parser ─────────────────────────────────────────────────

interface MpdSegment {
  num: number;
  durSec: number;
}

interface MpdTemplate {
  timescale: number;
  initTpl: string;
  mediaTpl: string;
  startNum: number;
  segments: MpdSegment[];
  maxSegDurSec: number;
}

interface MpdAdaptationSet {
  contentType: "video" | "audio";
  lang: string | undefined;
  template: MpdTemplate | null;
  reprs: Array<{
    id: string;
    codecs: string;
    bandwidth: number;
    width: number;
    height: number;
  }>;
}

/**
 * Expand a SegmentTimeline block into a flat list of segments.
 * Handles <S t="..." d="..." r="..." /> (r = repeat count; absent = 0).
 */
function expandSegmentTimeline(
  timelineBlock: string,
  startNum: number,
  timescale: number,
): { segments: MpdSegment[]; maxSegDurSec: number } {
  const segments: MpdSegment[] = [];
  let num = startNum;
  let maxDurSec = 0;
  for (const m of timelineBlock.matchAll(/<S\b([^>]*)\/?>/g)) {
    const attrs = m[1] ?? "";
    const d = parseInt(attrVal(attrs, "d") ?? "0", 10);
    const r = parseInt(attrVal(attrs, "r") ?? "0", 10);
    if (d <= 0) continue;
    const durSec = d / timescale;
    if (durSec > maxDurSec) maxDurSec = durSec;
    for (let i = 0; i <= r; i++) {          // r=0 → 1 segment; r=1 → 2 segments
      segments.push({ num, durSec });
      num++;
    }
  }
  return { segments, maxSegDurSec: maxDurSec };
}

/**
 * Parse a single <AdaptationSet …>…</AdaptationSet> block.
 * Returns null if the block lacks a usable SegmentTemplate.
 */
function parseAdaptationBlock(block: string, mpdTotalSecs: number): MpdAdaptationSet | null {
  const setTagM = block.match(/^<AdaptationSet([^>]*)>/);
  const setAttrs = setTagM?.[1] ?? "";

  // Determine content type
  const ctM = setAttrs.match(/contentType="([^"]+)"/);
  const rawCt = ctM?.[1]
    ?? (block.includes('mimeType="video') ? "video"
       : block.includes('mimeType="audio') ? "audio"
       : undefined);
  if (!rawCt) return null;
  const contentType = rawCt === "video" ? "video" : "audio";
  const lang = attrVal(setAttrs, "lang");

  // Collect Representation tags
  const reprs = [...block.matchAll(/<Representation\b([^>]*)>/g)].map(rm => {
    const a = rm[1] ?? "";
    const height = parseInt(attrVal(a, "height") ?? "0", 10);
    const rawCodec = attrVal(a, "codecs") ?? (contentType === "video" ? "hvc1.1.6.L120.90" : "mp4a.40.2");
    return {
      id:        attrVal(a, "id") ?? "0",
      codecs:    contentType === "video" ? normalizeHevcCodec(rawCodec, height) : rawCodec,
      bandwidth: parseInt(attrVal(a, "bandwidth") ?? "0", 10),
      width:     parseInt(attrVal(a, "width")     ?? "0", 10),
      height,
    };
  }).filter((r, i, arr) => arr.findIndex(x => x.id === r.id) === i);

  // Find SegmentTemplate (may be inside a Representation or at AdaptationSet level)
  const stTagM = block.match(/<SegmentTemplate\b([^>]*)>/);
  if (!stTagM) return { contentType, lang, template: null, reprs };

  const stAttrs = stTagM[1] ?? "";
  const timescale = parseInt(attrVal(stAttrs, "timescale") ?? "0", 10);
  const initTpl   = attrVal(stAttrs, "initialization");
  const mediaTpl  = attrVal(stAttrs, "media");
  const startNum  = parseInt(attrVal(stAttrs, "startNumber") ?? "1", 10);

  if (!timescale || !initTpl || !mediaTpl) return { contentType, lang, template: null, reprs };

  // Fixed-duration SegmentTemplate (duration attr present)
  const fixedDurTicks = parseInt(attrVal(stAttrs, "duration") ?? "0", 10);
  if (fixedDurTicks > 0) {
    const segDurSec  = fixedDurTicks / timescale;
    const totalSegs  = Math.ceil(mpdTotalSecs / segDurSec);
    const segments: MpdSegment[] = [];
    for (let i = 0; i < totalSegs; i++) {
      const isLast = i === totalSegs - 1;
      const durSec = isLast && mpdTotalSecs > 0 ? mpdTotalSecs - i * segDurSec : segDurSec;
      segments.push({ num: startNum + i, durSec });
    }
    return {
      contentType, lang, reprs,
      template: { timescale, initTpl, mediaTpl, startNum, segments, maxSegDurSec: segDurSec },
    };
  }

  // SegmentTimeline (variable-duration segments)
  const tlM = block.match(/<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/);
  if (!tlM) return { contentType, lang, template: null, reprs };

  const { segments, maxSegDurSec } = expandSegmentTimeline(tlM[1] ?? "", startNum, timescale);
  return {
    contentType, lang, reprs,
    template: { timescale, initTpl, mediaTpl, startNum, segments, maxSegDurSec },
  };
}

/**
 * Split an MPD into its AdaptationSet blocks and parse each one.
 */
function parseMpdAdaptationSets(mpdText: string, mpdTotalSecs: number): MpdAdaptationSet[] {
  const results: MpdAdaptationSet[] = [];
  for (const m of mpdText.matchAll(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g)) {
    const parsed = parseAdaptationBlock(m[0], mpdTotalSecs);
    if (parsed) results.push(parsed);
  }
  return results;
}

// ─── HLS playlist builder ─────────────────────────────────────────────────────

function buildHlsFromMpd(
  mpdText: string,
  cdnBase: string,
  cookie: string | undefined,
  segProxyBase: string,
  reprParam: string | undefined,
  m3u8BaseUrl: string,
): { content: string; contentType: string } {
  const b = encodeParam(cdnBase);
  const c = cookie ? encodeParam(cookie) : "_";
  const segBase = `${segProxyBase}/${b}/${c}/`;

  const durM = mpdText.match(/mediaPresentationDuration="([^"]+)"/);
  const mpdTotalSecs = durM ? parseMpdDuration(durM[1]) : 0;

  const adaptationSets = parseMpdAdaptationSets(mpdText, mpdTotalSecs);
  const videoSets = adaptationSets.filter(s => s.contentType === "video");
  const audioSets = adaptationSets.filter(s => s.contentType === "audio");

  if (adaptationSets.length === 0) {
    logger.warn({ cdnBase }, "buildHlsFromMpd: no AdaptationSets found in MPD");
    return { content: "#EXTM3U\n#EXT-X-ENDLIST\n", contentType: "application/vnd.apple.mpegurl" };
  }

  // Pick the best video set (has template + reprs with resolution)
  const videoSet = videoSets.find(s => s.template && s.reprs.length > 0) ?? videoSets[0];
  // Pick the first audio set that has a usable template
  const audioSet = audioSets.find(s => s.template && s.reprs.length > 0) ?? audioSets[0];

  const contentType = "application/vnd.apple.mpegurl";

  // ── Master playlist ──────────────────────────────────────────────────────────
  if (!reprParam) {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-INDEPENDENT-SEGMENTS"];

    if (audioSet?.reprs.length) {
      const audioReprId = audioSet.reprs[0]!.id;
      lines.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Main",DEFAULT=YES,AUTOSELECT=YES,` +
        `URI="${m3u8BaseUrl}&repr=audio:${audioReprId}"`,
      );
    }

    const audioGroup = audioSet?.reprs.length ? `,AUDIO="audio"` : "";
    const videoReprs = (videoSet?.reprs ?? []).sort((a, bv) => bv.bandwidth - a.bandwidth);
    for (const vr of videoReprs) {
      const ac = audioSet?.reprs.length ? ",mp4a.40.2" : "";
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${vr.bandwidth},RESOLUTION=${vr.width}x${vr.height},` +
        `CODECS="${vr.codecs}${ac}"${audioGroup}`,
      );
      lines.push(`${m3u8BaseUrl}&repr=video:${vr.id}`);
    }
    return { content: lines.join("\n") + "\n", contentType };
  }

  // ── Media playlist (video or audio) ──────────────────────────────────────────
  // repr param format: "audio:<reprId>" | "video:<reprId>"
  // Legacy format (no colon): "audio" | "video<id>"
  let isAudio: boolean;
  let reprId: string;
  if (reprParam.startsWith("audio:")) {
    isAudio = true;
    reprId = reprParam.slice("audio:".length);
  } else if (reprParam.startsWith("video:")) {
    isAudio = false;
    reprId = reprParam.slice("video:".length);
  } else if (reprParam === "audio") {
    // legacy
    isAudio = true;
    reprId = audioSet?.reprs[0]?.id ?? "3";
  } else {
    // legacy "video0" style
    isAudio = false;
    reprId = reprParam.replace(/^video/, "");
  }

  const targetSet = isAudio ? audioSet : videoSet;
  if (!targetSet?.template) {
    logger.warn({ cdnBase, reprParam }, "buildHlsFromMpd: no usable template for repr");
    return { content: "#EXTM3U\n#EXT-X-ENDLIST\n", contentType };
  }

  const { initTpl, mediaTpl, segments, maxSegDurSec } = targetSet.template;
  const initUri = segBase + applyMpdTemplate(initTpl, reprId);

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    `#EXT-X-TARGETDURATION:${Math.ceil(maxSegDurSec)}`,
    "#EXT-X-MEDIA-SEQUENCE:1",
    `#EXT-X-MAP:URI="${initUri}"`,
  ];

  for (const seg of segments) {
    lines.push(`#EXTINF:${seg.durSec.toFixed(6)},`);
    lines.push(segBase + applyMpdTemplate(mediaTpl, reprId, seg.num));
  }
  lines.push("#EXT-X-ENDLIST");
  return { content: lines.join("\n") + "\n", contentType };
}

// ─── END MPD → HLS helpers ────────────────────────────────────────────────────

function rewriteMpd(
  mpdText: string,
  cdnBase: string,
  cookie: string | undefined,
  segProxyBase: string,
): string {
  const b = encodeParam(cdnBase);
  const c = cookie ? encodeParam(cookie) : "_";
  const baseUrl = `${segProxyBase}/${b}/${c}/`;

  const cleaned = mpdText.replace(/<BaseURL[^>]*>.*?<\/BaseURL>/gs, "");
  const withBase = cleaned.replace(/(<MPD[^>]*>)/, `$1\n<BaseURL>${baseUrl}</BaseURL>`);

  // LG WebOS Chromium supports H.265 in MSE only via `hvc1` (hvcC box in init segment).
  // MovieBox CDN declares bare `hev1` (no profile/level suffix).
  //
  // Two rewrites needed:
  // 1. hev1.X.Y.LZ.W  → hvc1.X.Y.LZ.W  (codec type swap, profile info already present)
  // 2. bare hev1       → hvc1.1.6.LNN.90 (Main Profile; level inferred from height)
  //    LG WebOS Chromium rejects bare `hvc1` without profile/level via isTypeSupported.
  //    Android ExoPlayer accepts all forms.  Other clients are unaffected.
  //
  // HEVC level map (ITU-T H.265 Annex A):
  //   L60=2.0(240p) L90=3.0(480p) L93=3.1(720p) L120=4.0(1080p) L150=5.0(4K)
  const HEVC_LEVEL: Array<[number, string]> = [
    [240, "L60"], [480, "L90"], [720, "L93"], [1080, "L120"], [2160, "L150"],
  ];
  function hevcLevelForHeight(h: number): string {
    for (const [maxH, lvl] of HEVC_LEVEL) if (h <= maxH) return lvl;
    return "L180";
  }

  // Pass 1: hev1 WITH profile suffix → hvc1 (keep profile as-is)
  let result = withBase.replace(/\bhev1(\.[^\s"<]+)/g, "hvc1$1");

  // Pass 2: bare hev1 inside a <Representation> tag → hvc1.1.6.LNN.90
  result = result.replace(/<Representation([^>]*)>/g, (match, attrs: string) => {
    if (!attrs.includes('codecs="hev1"') && !attrs.includes('codecs="hvc1"')) return match;
    const hm = attrs.match(/height="(\d+)"/);
    const level = hevcLevelForHeight(hm ? parseInt(hm[1], 10) : 1080);
    return match
      .replace('codecs="hev1"', `codecs="hvc1.1.6.${level}.90"`)
      .replace('codecs="hvc1"', `codecs="hvc1.1.6.${level}.90"`);
  });

  return result;
}

async function handleMpd(
  req: Request,
  res: Response,
  targetUrl: string,
  cookie: string | undefined,
): Promise<void> {
  try {
    const upstreamHeaders: Record<string, string> = {
      "user-agent": UPSTREAM_UA,
      referer: "https://api3.aoneroom.com",
    };
    if (cookie) upstreamHeaders["cookie"] = cookie;

    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const mpdText = await upstream.text();
    const cdnBase = targetUrl.replace(/\/[^/]*$/, "/");

    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const host = req.headers["x-forwarded-host"] ?? req.headers["host"];
    const segProxyBase = `${proto}://${host}${BASE_PATH}/seg`;

    const rewritten = rewriteMpd(mpdText, cdnBase, cookie, segProxyBase);

    res.setHeader("Content-Type", "application/dash+xml");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewritten);
  } catch (err) {
    logger.error({ err, targetUrl }, "MPD proxy error");
    if (!res.headersSent) res.status(502).end();
  }
}

router.get("/stream.mpd", async (req, res) => {
  const { u, c } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).json({ error: "Missing u param" }); return; }

  let targetUrl: string;
  try {
    targetUrl = decodeParam(u);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid u param" });
    return;
  }

  const cookie = c ? decodeParam(c) : undefined;
  await handleMpd(req, res, targetUrl, cookie);
});

router.options("/stream.mpd", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── MPD → HLS route ──────────────────────────────────────────────────────────
// Converts a MovieBox DASH manifest into HLS CMAF playlists on the fly.
// Three sub-paths served from one route, distinguished by ?repr=:
//   (none)        → HLS master playlist (EXT-X-STREAM-INF + EXT-X-MEDIA)
//   repr=videoN   → video media playlist for representation N
//   repr=audio    → audio media playlist
// All segment URLs point to our existing /seg proxy so CloudFront cookies
// are forwarded transparently.
router.get("/stream.m3u8", async (req, res) => {
  const { u, c, repr } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).json({ error: "Missing u param" }); return; }

  let targetUrl: string;
  try {
    targetUrl = decodeParam(u);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid u param" });
    return;
  }

  const cookie = c && c !== "_" ? decodeParam(c) : undefined;

  try {
    const upstreamHeaders: Record<string, string> = {
      "user-agent": UPSTREAM_UA,
      "referer":    "https://api3.aoneroom.com",
      "origin":     "https://api3.aoneroom.com",
    };
    if (cookie) upstreamHeaders["cookie"] = cookie;

    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const mpdText    = await upstream.text();
    const cdnBase    = targetUrl.replace(/\/[^/]*$/, "/");
    const proto      = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const host       = req.headers["x-forwarded-host"] ?? req.headers["host"];
    const segBase    = `${proto}://${host}${BASE_PATH}/seg`;
    // Absolute base URL for variant references in master playlist
    const m3u8Base   = `${proto}://${host}${BASE_PATH}/stream.m3u8` +
                       `?u=${encodeURIComponent(u)}&c=${encodeURIComponent(c ?? "_")}`;

    const { content, contentType } = buildHlsFromMpd(
      mpdText, cdnBase, cookie, segBase, repr, m3u8Base,
    );

    res.setHeader("Content-Type",                contentType);
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Cache-Control",               "no-store");
    res.send(content);
  } catch (err) {
    logger.error({ err, targetUrl }, "MPD-to-HLS error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/stream.m3u8", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── HindMoviez / GDShine range-request proxy ────────────────────────────────
// Unlike /proxy (which injects CDN-specific Referer/Origin headers for
// aoneroom.com), this endpoint uses neutral headers so GDShine and other
// HindMoviez CDNs don't reject the request.  It properly forwards the
// Range header so Stremio can stream large files (>1 GB) in chunks.
router.get("/hmproxy", async (req: Request, res: Response) => {
  const { u } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).json({ error: "Missing u param" }); return; }

  let targetUrl: string;
  try {
    targetUrl = decodeParam(u);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid u param" });
    return;
  }

  const t0 = Date.now();
  const range = req.headers["range"];

  const upstreamHeaders: Record<string, string> = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "accept": "*/*",
  };
  if (range) upstreamHeaders["range"] = range;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    logger.error({ err, targetUrl }, "HMProxy: upstream fetch failed");
    if (!res.headersSent) res.status(502).end();
    return;
  }

  if (upstream.status >= 400) {
    logger.warn({ targetUrl, status: upstream.status }, "HMProxy: upstream error");
    res.status(upstream.status).end();
    return;
  }

  const contentType = upstream.headers.get("content-type") ?? "video/mp4";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");

  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);

  const contentRange = upstream.headers.get("content-range");
  if (contentRange) res.setHeader("Content-Range", contentRange);

  res.setHeader("Cache-Control", "no-store");
  res.status(upstream.status);

  if (!upstream.body) { res.end(); return; }

  const reader = upstream.body.getReader();
  req.on("close", () => reader.cancel().catch(() => {}));

  let bytesSent = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      res.write(Buffer.from(value));
      bytesSent += value.byteLength;
    }
  } catch (err) {
    logger.warn({ err, targetUrl }, "HMProxy: pipe interrupted");
  }

  logger.info({ targetUrl, status: upstream.status, bytesSent, durationMs: Date.now() - t0 }, "HMProxy: done");
  res.end();
});

router.options("/hmproxy", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

router.get("/proxy", async (req, res) => {
  const { u, c, ref, ori } = req.query as Record<string, string | undefined>;

  if (!u) { res.status(400).json({ error: "Missing u param" }); return; }

  let targetUrl: string;
  try {
    targetUrl = decodeParam(u);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid u param" });
    return;
  }

  const cookie = c ? decodeParam(c) : undefined;

  // Optional referer/origin override — used to satisfy hotlink protection on
  // Backblaze B2 / FSL / S3 buckets served via HubCloud.
  const extraHeaders: Record<string, string> | undefined = (ref || ori) ? {} : undefined;
  if (extraHeaders && ref) extraHeaders["referer"] = decodeParam(ref);
  if (extraHeaders && ori) extraHeaders["origin"] = decodeParam(ori);

  const isMpd = targetUrl.includes(".mpd") || targetUrl.includes("manifest");

  if (!isMpd) {
    try {
      await pipeUpstream(targetUrl, cookie, req, res, extraHeaders);
    } catch (err) {
      logger.error({ err, targetUrl }, "Proxy error");
      if (!res.headersSent) res.status(502).end();
    }
    return;
  }

  await handleMpd(req, res, targetUrl, cookie);
});

router.use("/seg/:b/:c", async (req: Request, res: Response) => {
  const { b, c } = req.params as Record<string, string>;
  const filename = req.path.replace(/^\//, "");

  if (!filename) { res.status(400).end(); return; }

  let cdnBase: string;
  let cookie: string | undefined;
  try {
    cdnBase = decodeParam(b);
    new URL(cdnBase);
    cookie = c !== "_" ? decodeParam(c) : undefined;
  } catch {
    res.status(400).end();
    return;
  }

  const targetUrl = cdnBase + filename;

  try {
    await pipeUpstream(targetUrl, cookie, req, res);
  } catch (err) {
    logger.error({ err, targetUrl }, "Segment proxy error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/proxy", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── DahmerMovies CDN proxy ────────────────────────────────────────────────────
// Proxies a.111477.xyz file URLs directly — no bulk proxy in the chain.
//
// p.111477.xyz/bulk has two problems:
//   1. redirect:manual + CDN redirect = "Download Locked" (two sessions)
//   2. piping through it = concurrency limit (30m wait)
// ─── DahmerMovies auto-fallback proxy ────────────────────────────────────────
// Encodes a priority-ordered list of file URLs. Tries each in sequence and
// streams from the first one that isn't locked/rate-limited. Caches the chosen
// file for 5 minutes so seeks always go to the same source file.
//
// GET /proxy/dahmer-auto?urls=<base64url(JSON string[])>
//
// Each element must start with https://a.111477.xyz/

const dahmerAutoCache = new Map<string, { url: string; ts: number }>();
const DAHMER_AUTO_TTL = 5 * 60 * 1000; // 5 minutes

const DAHMER_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Accept": "video/webm,video/ogg,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5",
  "Accept-Encoding": "identity",
  "Referer": "https://a.111477.xyz/",
  "Origin": "https://a.111477.xyz",
};

async function tryDahmerUrl(
  fileUrl: string,
  range: string | undefined,
): Promise<Response | null> {
  const hdrs: Record<string, string> = { ...DAHMER_FETCH_HEADERS };
  if (range) hdrs["Range"] = range;
  try {
    const res = await fetch(fileUrl, {
      headers: hdrs,
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    const ct = res.headers.get("content-type") ?? "";
    if (res.status >= 400 || ct.includes("text/html")) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    return res;
  } catch {
    return null;
  }
}

router.get("/proxy/dahmer-auto", async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const encoded = String(req.query["urls"] ?? "");
  if (!encoded) { res.status(400).send("Missing urls parameter"); return; }

  let fileUrls: string[];
  try {
    fileUrls = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as string[];
    if (!Array.isArray(fileUrls) || fileUrls.length === 0) throw new Error("empty");
  } catch {
    res.status(400).send("Invalid urls encoding"); return;
  }

  // Only allow the known DahmerMovies origin
  fileUrls = fileUrls.filter((u) => u.startsWith("https://a.111477.xyz/"));
  if (!fileUrls.length) { res.status(403).send("Forbidden"); return; }

  const range = req.headers["range"] as string | undefined;

  // Check selection cache (so seeks always go to the same file)
  const cacheKey = encoded;
  const cached = dahmerAutoCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DAHMER_AUTO_TTL) {
    const upstream = await tryDahmerUrl(cached.url, range);
    if (upstream) {
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
      const cl = upstream.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);
      const cr = upstream.headers.get("content-range");
      if (cr) res.setHeader("Content-Range", cr);
      res.status(upstream.status);
      if (!upstream.body) { res.end(); return; }
      const reader = upstream.body.getReader();
      req.on("close", () => reader.cancel().catch(() => {}));
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || res.destroyed) break;
          res.write(Buffer.from(value));
        }
      } catch { /* pipe interrupted */ }
      res.end();
      return;
    }
    // Cached file is now locked; fall through to retry all
    dahmerAutoCache.delete(cacheKey);
  }

  // Try each file URL in priority order
  for (const fileUrl of fileUrls) {
    const upstream = await tryDahmerUrl(fileUrl, range);
    if (!upstream) continue;

    // Found a working file — cache the selection
    dahmerAutoCache.set(cacheKey, { url: fileUrl, ts: Date.now() });

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    res.status(upstream.status);

    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || res.destroyed) break;
        res.write(Buffer.from(value));
      }
    } catch { /* pipe interrupted */ }
    res.end();
    return;
  }

  logger.warn({ count: fileUrls.length }, "dahmer-auto: all files locked/unavailable");
  res.status(502).send("Stream unavailable — all files are currently locked. Try again in 30 minutes.");
});

router.options("/proxy/dahmer-auto", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.status(204).end();
});

// GET|HEAD /proxy/dahmer?url=<base64url(workerUrl)>&size=<bytes>
//
// Proxy a DahmerMovies worker URL (p.111477.xyz/bulk?u=...) through our server
// so Cloudflare 1015 rate-limits hit our IP, not the user's device.
//
// Three-layer defence against rate-limiting:
//  1. HEAD requests: answered locally from the `size` param — zero upstream hits
//  2. Tiny GET probes (Range: bytes=0-N, N≤16): answered locally — zero upstream
//  3. Real play/seek requests: forwarded upstream; if we get 429, retry twice
//     with 1 s / 2 s backoff.  If still 429, issue a 302 redirect to the worker
//     URL directly so Stremio falls back to connecting from the user's device
//     (their IP will be clean since it hasn't hit the worker recently).

async function dahmerUpstreamFetch(
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  const DELAYS = [0, 1000, 2000];
  let last!: Response;
  for (const delay of DELAYS) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      last = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      logger.warn({ err, url }, "DahmerProxy: upstream fetch error");
      continue;
    }
    if (last.status !== 429) return last;
    last.body?.cancel().catch(() => {});
    logger.warn({ attempt: DELAYS.indexOf(delay) + 1, url }, "DahmerProxy: 429, will retry");
  }
  return last; // still 429 after all retries
}

router.all("/proxy/dahmer", async (req: Request, res: Response): Promise<void> => {
  const encodedUrl = String(req.query["url"] ?? "");
  if (!encodedUrl) { res.status(400).send("Missing url parameter"); return; }

  let originalUrl: string;
  try {
    originalUrl = Buffer.from(encodedUrl, "base64url").toString("utf8");
  } catch {
    res.status(400).send("Invalid url encoding"); return;
  }

  const isWorkerUrl = originalUrl.startsWith("https://p.111477.xyz/bulk?");
  const isFileUrl   = originalUrl.startsWith("https://a.111477.xyz/");
  if (!isWorkerUrl && !isFileUrl) {
    res.status(403).send("Forbidden"); return;
  }

  const rangeHeader = req.headers["range"] as string | undefined;
  const sizeParam   = req.query["size"] ? parseInt(String(req.query["size"]), 10) : 0;
  const contentType = originalUrl.toLowerCase().includes(".mp4") ? "video/mp4" : "video/x-matroska";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=300");

  // ── 1. HEAD requests — answer locally, never hit upstream ──────────────────
  if (req.method === "HEAD") {
    res.setHeader("Content-Type", contentType);
    if (sizeParam > 0) res.setHeader("Content-Length", String(sizeParam));
    res.status(200).end();
    return;
  }

  // ── 2. Tiny GET probes — answer locally if we know the file size ────────────
  if (rangeHeader && sizeParam > 0) {
    const rm = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (rm) {
      const start    = parseInt(rm[1]!, 10);
      const endRaw   = rm[2] ? parseInt(rm[2]!, 10) : sizeParam - 1;
      const end      = Math.min(endRaw, sizeParam - 1);
      const rangeLen = end - start + 1;
      if (start === 0 && rangeLen <= 16) {
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${sizeParam}`);
        res.setHeader("Content-Length", String(rangeLen));
        res.status(206).end(Buffer.alloc(rangeLen));
        return;
      }
    }
  }

  // ── 3. Real play / seek — forward to upstream with retry + 302 fallback ─────
  const fetchHeaders: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Accept": "video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5",
    "Accept-Encoding": "identity",
  };
  if (isFileUrl) {
    fetchHeaders["Referer"] = "https://a.111477.xyz/";
    fetchHeaders["Origin"]  = "https://a.111477.xyz";
  }
  if (rangeHeader) fetchHeaders["Range"] = rangeHeader;

  try {
    const upstream = await dahmerUpstreamFetch(originalUrl, fetchHeaders);

    // 429 after all retries — redirect to worker so Stremio tries from user's IP
    if (upstream.status === 429) {
      logger.warn({ url: originalUrl }, "DahmerProxy: rate-limited after retries, issuing 302");
      res.setHeader("Location", originalUrl);
      res.status(302).end();
      return;
    }

    const ct = upstream.headers.get("content-type") ?? "";
    if (upstream.status >= 400 || ct.includes("text/html")) {
      logger.warn({ status: upstream.status, ct, originalUrl }, "DahmerProxy: upstream error");
      res.status(502).send("Stream unavailable");
      return;
    }

    res.setHeader("Content-Type", ct || contentType);
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    res.status(upstream.status);

    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || res.destroyed) break;
        res.write(Buffer.from(value));
      }
    } catch { /* client disconnected */ }
    res.end();
  } catch (err: unknown) {
    logger.warn({ err, originalUrl }, "DahmerProxy: stream failed");
    if (!res.headersSent) res.status(502).send("Proxy error");
  }
});

// ─── Subtitle proxy — fetches yifysubtitles.ch ZIP files, extracts SRT ────────
// Stremio fetches subtitle URLs directly; this proxy handles ZIP decompression
// (using built-in DataView + DecompressionStream) and adds CORS headers.
router.get("/subtitle-proxy", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");

  const rawUrl = req.query["url"] as string | undefined;
  if (!rawUrl) return void res.status(400).send("Missing url param");

  let targetUrl: string;
  try {
    targetUrl = Buffer.from(rawUrl, "base64url").toString("utf8");
  } catch {
    return void res.status(400).send("Invalid url encoding");
  }

  // Safety: only allow known subtitle provider domains
  const allowed = /^https?:\/\/([a-z0-9-]+\.)*yifysubtitles\.(ch|com|org)\//i;
  if (!allowed.test(targetUrl)) {
    return void res.status(403).send("Disallowed host");
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://yifysubtitles.ch/",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) {
      return void res.status(502).send(`Upstream error: ${upstream.status}`);
    }
    if (!upstream.body) return void res.status(502).send("Empty upstream body");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");

    const ct = upstream.headers.get("content-type") ?? "";
    const isZip = ct.includes("zip") || targetUrl.endsWith(".zip");

    if (isZip) {
      const buf = await upstream.arrayBuffer();
      const srt = await extractSrtFromZip(new Uint8Array(buf));
      res.send(srt);
    } else {
      // Plain SRT / VTT served directly
      const text = await upstream.text();
      res.send(text);
    }
  } catch (err) {
    logger.warn({ err, targetUrl }, "subtitle-proxy: fetch error");
    if (!res.headersSent) res.status(502).send("Subtitle fetch failed");
  }
});

router.options("/subtitle-proxy", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

router.options("/seg/:b/:c", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── HLS proxy (generalized — supports AnimeSalt, AnimeDekho, and any CDN) ────
// Fetches the HLS playlist with caller-supplied headers, then rewrites all
// segment / sub-playlist lines to route through this server so that the player
// never needs to know the CDN's Referer/Origin requirements.

const AS_CDN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Safari/537.36";
const AS_CDN_REFERER = "https://animesalt.ac/";

// Extra browser-like headers that some CDNs (Cloudflare bot-mgmt) require
// to distinguish real browsers from bots/datacenter IPs.
const AS_BROWSER_EXTRA: Record<string, string> = {
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Connection": "keep-alive",
};

// /api/m3u8?url=<enc>&referer=<enc>&origin=<enc>
// referer and origin are optional — defaults keep AnimeSalt backward-compat.
router.get("/m3u8", async (req: Request, res: Response) => {
  const { url, referer: refParam, origin: originParam, audiopid: audiopidParam, pmtpid: pmtpidParam } =
    req.query as Record<string, string | undefined>;
  if (!url) { res.status(400).json({ error: "Missing url" }); return; }

  // When audiopid is set, the caller wants every TS segment filtered to keep
  // only that audio PID (+ video/PAT/PMT).  Segments go through /as-va instead
  // of /seg, and the inner synthetic-master logic is skipped.
  const filterAudioPidNum = audiopidParam ? parseInt(audiopidParam, 10) : undefined;
  const filterPmtPidNum   = pmtpidParam   ? parseInt(pmtpidParam, 10)   : undefined;
  const doAudioFilter = filterAudioPidNum !== undefined && isFinite(filterAudioPidNum) &&
                        filterPmtPidNum   !== undefined && isFinite(filterPmtPidNum);

  let targetUrl: string;
  try {
    targetUrl = decodeURIComponent(url);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid url" }); return;
  }

  const effectiveReferer = refParam ? decodeURIComponent(refParam) : AS_CDN_REFERER;
  let effectiveOrigin: string;
  if (originParam) {
    effectiveOrigin = decodeURIComponent(originParam);
  } else {
    try { effectiveOrigin = new URL(effectiveReferer).origin; } catch { effectiveOrigin = effectiveReferer; }
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": AS_CDN_UA,
        "Referer": effectiveReferer,
        "Origin": effectiveOrigin,
        ...AS_BROWSER_EXTRA,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const text = await upstream.text();

    const parsed = new URL(targetUrl);
    const segBase = parsed.origin + parsed.pathname.replace(/[^/]+$/, "");

    const publicUrl = process.env["PUBLIC_URL"];
    const replitDomains = process.env["REPLIT_DOMAINS"];
    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const host = (req.headers["x-forwarded-host"] as string | undefined) ?? (req.headers["host"] as string | undefined) ?? "localhost";
    const proxyBase = publicUrl
      ? publicUrl.replace(/\/$/, "") + BASE_PATH
      : replitDomains
        ? `https://${replitDomains.split(",")[0]}${BASE_PATH}`
        : `${proto}://${host}${BASE_PATH}`;

    const toAbsUrl = (rel: string): string => {
      if (rel.startsWith("http")) return rel;
      if (rel.startsWith("/")) return parsed.origin + rel;
      return segBase + rel;
    };

    // Encode referer/origin so sub-playlists and segments carry the same headers
    const refEnc = encodeURIComponent(effectiveReferer);
    const orgEnc = encodeURIComponent(effectiveOrigin);

    const proxyUrl = (absUrl: string, isPlaylist: boolean): string => {
      if (isPlaylist) {
        return `${proxyBase}/m3u8?url=${encodeURIComponent(absUrl)}&referer=${refEnc}&origin=${orgEnc}`;
      }
      // When audio-filtering is requested, route every TS segment through /as-va
      // so it strips all audio PIDs except the chosen one before delivery.
      if (doAudioFilter) {
        return (
          `${proxyBase}/as-va?url=${encodeURIComponent(absUrl)}` +
          `&audiopid=${filterAudioPidNum}&pmtpid=${filterPmtPidNum}` +
          `&ref=${refEnc}&org=${orgEnc}`
        );
      }
      return `${proxyBase}/seg?u=${encodeURIComponent(absUrl)}&ref=${refEnc}&org=${orgEnc}`;
    };

    // Detect whether the CDN returned a variant or master playlist.
    // A variant has #EXTINF segment entries directly; a master has #EXT-X-STREAM-INF.
    const isVariantPlaylist = /^#EXTINF:/m.test(text) && !/^#EXT-X-STREAM-INF/m.test(text);

    // For AnimeSalt CDN variant playlists, probe the first TS segment for muxed
    // audio PIDs and synthesise a proper HLS master with #EXT-X-MEDIA:TYPE=AUDIO
    // so LG TV's native player shows a language selector.
    // Only runs for AnimeSalt CDN hostnames AND when the caller did not already
    // request audio filtering (doAudioFilter means we're already serving filtered
    // segments — no need for another synthetic master layer).
    if (isVariantPlaylist && /as-cdn\d*\.top/i.test(parsed.hostname) && !doAudioFilter) {
      const firstSegRel = text.split("\n").find(l => { const t = l.trim(); return t && !t.startsWith("#"); });
      if (firstSegRel) {
        const firstSegUrl = firstSegRel.trim().startsWith("http") ? firstSegRel.trim()
          : firstSegRel.trim().startsWith("/") ? parsed.origin + firstSegRel.trim()
          : segBase + firstSegRel.trim();
        try {
          const segResp = await fetch(firstSegUrl, {
            headers: {
              "User-Agent": AS_CDN_UA,
              "Referer": effectiveReferer,
              "Origin": effectiveOrigin,
              "Range": "bytes=0-7519", // 40 TS packets — enough for PAT+PMT
              ...AS_BROWSER_EXTRA,
            },
            signal: AbortSignal.timeout(8_000),
            redirect: "follow",
          });
          if (segResp.ok || segResp.status === 206) {
            const segBuf = Buffer.from(await segResp.arrayBuffer());
            const { tracks, pmtPid } = probeAudioTracks(segBuf);
            logger.info(
              { targetUrl: targetUrl.slice(0, 80), tracks: tracks.map(t => `${t.name}(${t.pid})`), pmtPid },
              "M3U8 proxy: TS audio probe result"
            );
            if (tracks.length > 1) {
              const encVariant = encodeURIComponent(targetUrl);
              const pmtStr = String(pmtPid);
              const variantProxied = `${proxyBase}/m3u8?url=${encVariant}&referer=${refEnc}&origin=${orgEnc}`;

              const hindiIdxM3u8 = tracks.findIndex(
                t => /hindi/i.test(t.name) || t.language === "hin" || t.language === "hi"
              );
              const orderedM3u8 = hindiIdxM3u8 > 0
                ? [tracks[hindiIdxM3u8]!, ...tracks.filter((_, i) => i !== hindiIdxM3u8)]
                : tracks;

              const mediaLines = orderedM3u8.map((t, i) => {
                const audioPlUrl =
                  `${proxyBase}/as-audio-pl?variantUrl=${encVariant}` +
                  `&pid=${t.pid}&pmtpid=${pmtStr}&ref=${refEnc}&org=${orgEnc}`;
                return (
                  `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",` +
                  `LANGUAGE="${t.language || `und${i}`}",NAME="${t.name}",` +
                  `DEFAULT=${i === 0 ? "YES" : "NO"},AUTOSELECT=YES,` +
                  `URI="${audioPlUrl}"`
                );
              });

              const syntheticMaster = [
                "#EXTM3U",
                "#EXT-X-VERSION:3",
                "",
                ...mediaLines,
                "",
                `#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="audio"`,
                variantProxied,
              ].join("\n");

              res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
              res.setHeader("Access-Control-Allow-Origin", "*");
              res.setHeader("Cache-Control", "no-store");
              res.send(syntheticMaster);
              return;
            }
          }
        } catch (err) {
          logger.warn({ err, targetUrl: targetUrl.slice(0, 80) }, "M3U8 proxy: TS audio probe failed (non-fatal)");
        }
      }
    }

    let nextLineIsVariant = false;
    const rewritten = text.split("\n").map((line) => {
      const trimmed = line.trim();

      if (trimmed.startsWith("#EXT-X-MEDIA") && trimmed.includes('URI="')) {
        nextLineIsVariant = false;
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          const abs = toAbsUrl(uri);
          return `URI="${proxyUrl(abs, true)}"`;
        });
      }

      // Proxy AES-128 encryption key URIs so the player fetches keys through our
      // server (same IP as the CDN token was issued to) rather than directly from
      // the CDN. Without this, FileMoon and similar CDNs return 403 for key requests
      // made from the player's IP which differs from the server's IP.
      if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes('URI="')) {
        nextLineIsVariant = false;
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          const abs = toAbsUrl(uri);
          return `URI="${proxyUrl(abs, false)}"`;
        });
      }

      // Proxy fMP4/CMAF init segment URIs (#EXT-X-MAP:URI="...") through the
      // segment proxy so that the CDN's Referer/Origin token check is satisfied.
      // Without this, LG TV and other players fetch the init segment directly
      // from the CDN, get a 403, and audio renditions silently fail — meaning
      // the player never shows the audio track selector.
      if (trimmed.startsWith("#EXT-X-MAP") && trimmed.includes('URI="')) {
        nextLineIsVariant = false;
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          const abs = toAbsUrl(uri);
          return `URI="${proxyUrl(abs, false)}"`;
        });
      }

      if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
        nextLineIsVariant = true;
        return line;
      }

      if (!trimmed || trimmed.startsWith("#")) return line;

      const absUrl = toAbsUrl(trimmed);
      const isPlaylist = nextLineIsVariant || /\.m3u8/i.test(absUrl);
      nextLineIsVariant = false;
      return proxyUrl(absUrl, isPlaylist);
    }).join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewritten);
  } catch (err) {
    logger.error({ err, targetUrl }, "M3U8 proxy error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/m3u8", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// Generalized segment proxy — serves .ts / .aac / key segments with caller-supplied headers.
// /api/seg?u=<enc>&ref=<enc>&org=<enc>
// Kept at /seg (new); the old /as-seg is aliased below for backward compatibility.
function segmentContentType(targetUrl: string, cdnType: string | null): string {
  const u = targetUrl.split("?")[0].toLowerCase();
  if (u.endsWith(".ts") || u.includes(".ts?")) return "video/MP2T";
  if (u.endsWith(".aac") || u.includes(".aac?")) return "audio/aac";
  if (u.endsWith(".mp4") || u.includes(".mp4?")) return "video/mp4";
  if (u.endsWith(".m4s") || u.includes(".m4s?")) return "video/iso.segment";
  if (u.endsWith(".vtt") || u.includes(".vtt?")) return "text/vtt";
  if (u.endsWith(".key") || u.includes(".key?")) return "application/octet-stream";

  // Some CDNs (TikTok CDN, DooFlix) disguise video segments as image/png or image/jpeg
  // to prevent direct hotlinking. Detect and override these fake content types.
  if (cdnType && cdnType.startsWith("image/")) return "video/MP2T";

  return cdnType ?? "video/MP2T";
}

/**
 * Find the byte offset where real MPEG-TS data starts.
 * MPEG-TS packets are 188 bytes each, always starting with sync byte 0x47.
 * Some CDNs (TikTok/DooFlix) prepend a fake PNG header to obfuscate TS segments.
 * We scan for the first 0x47 that repeats consistently every 188 bytes.
 * Returns 0 if data already starts at a valid TS sync byte.
 */
function findTsStart(buf: Buffer): number {
  const SYNC = 0x47;
  const PKT  = 188;
  // Need at least 4 confirming packets to be sure we found the right offset
  for (let i = 0; i < Math.min(buf.length - PKT * 4, 4096); i++) {
    if (buf[i] === SYNC &&
        buf[i + PKT]     === SYNC &&
        buf[i + PKT * 2] === SYNC &&
        buf[i + PKT * 3] === SYNC) {
      return i;
    }
  }
  return 0; // no fake header found — pass through as-is
}

async function serveSegment(req: Request, res: Response, targetUrl: string, referer?: string, origin?: string) {
  try {
    const headers: Record<string, string> = {
      "User-Agent": AS_CDN_UA,
      ...AS_BROWSER_EXTRA,
    };
    if (referer) headers["Referer"] = referer;
    if (origin) headers["Origin"] = origin;

    const rangeHeader = req.headers["range"];
    if (rangeHeader) headers["Range"] = rangeHeader;

    const upstream = await fetch(targetUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });

    if (!upstream.ok && upstream.status !== 206) { res.status(upstream.status).end(); return; }

    const cdnContentType = upstream.headers.get("content-type");
    const hasFakeImageType = !!(cdnContentType && cdnContentType.startsWith("image/"));
    const contentType = segmentContentType(targetUrl, cdnContentType);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "bytes");

    // When the CDN disguises the segment as an image, buffer the whole response,
    // strip any fake header bytes before the real MPEG-TS sync pattern, then send.
    // This makes HLS.js (Stremio Web / browsers) accept the segment — it requires
    // TS data to start exactly with 0x47, unlike ExoPlayer which scans past garbage.
    if (hasFakeImageType && upstream.body) {
      const raw   = Buffer.from(await upstream.arrayBuffer());
      const start = findTsStart(raw);
      const body  = start > 0 ? raw.subarray(start) : raw;
      res.setHeader("Content-Length", body.length);
      res.status(upstream.status);
      res.end(body);
      return;
    }

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    const contentRange = upstream.headers.get("content-range");
    if (contentRange) res.setHeader("Content-Range", contentRange);

    res.status(upstream.status);

    if (!upstream.body) { res.end(); return; }

    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    logger.error({ err, targetUrl }, "Segment proxy error");
    if (!res.headersSent) res.status(502).end();
  }
}

router.get("/seg", async (req: Request, res: Response) => {
  const { u, ref, org } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).end(); return; }
  let targetUrl: string;
  try { targetUrl = decodeURIComponent(u); new URL(targetUrl); } catch { res.status(400).end(); return; }
  await serveSegment(req, res, targetUrl, ref ? decodeURIComponent(ref) : undefined, org ? decodeURIComponent(org) : undefined);
});

router.options("/seg", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// Backward-compat alias for AnimeSalt segments (old /as-seg path)
router.get("/as-seg", async (req: Request, res: Response) => {
  const { u } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).end(); return; }
  let targetUrl: string;
  try { targetUrl = decodeURIComponent(u); new URL(targetUrl); } catch { res.status(400).end(); return; }
  await serveSegment(req, res, targetUrl);
});

router.options("/as-seg", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── AnimeSalt fresh-relay ────────────────────────────────────────────────────
// Instead of embedding a pre-signed CDN URL in the stream response (which gets
// IP-checked against the server IP at FETCH time but then may be blocked by
// Cloudflare bot-mgmt on the next segment request), this endpoint:
//   1. Re-calls AnimeSalt's player API fresh on every playback start → gets a
//      brand-new signed m3u8 URL bound to OUR server IP right now.
//   2. Immediately fetches and proxies that m3u8 with full browser headers,
//      rewriting all sub-playlist / segment lines through /api/m3u8 and /api/seg.
// This makes every single CDN request originate from our server IP with the
// token that was literally just issued for that same IP seconds ago.
//
// The result is cached for 90 seconds and pre-warmed from the stream handler so
// Stremio gets an instant response instead of waiting 10-15 s for two sequential
// upstream fetches.
//
// GET /api/as-relay?hash=<videoHash>&player=<base64url-playerCdn>

interface RelayCache { m3u8: string; expiresAt: number }
const relayResultCache = new Map<string, RelayCache>();
const relayInFlight = new Map<string, Promise<string>>();
const RELAY_TTL_MS = 90_000;

/**
 * Post-processes a proxied HLS master playlist so that the Hindi audio
 * rendition is listed FIRST and has DEFAULT=YES, while all other audio
 * renditions have DEFAULT=NO.
 *
 * Why: AnimeSalt's CDN emits all three renditions (tel/tam/hin) with
 * DEFAULT=NO.  LG TV selects the first-listed rendition regardless of
 * DEFAULT= flags, so without this fix Telugu always plays on LG TV.
 * This is a no-op if the playlist has no Hindi #EXT-X-MEDIA:TYPE=AUDIO line.
 */
function putHindiFirstInMaster(m3u8: string): string {
  const isHindiLine = (line: string): boolean => {
    const lang = (line.match(/LANGUAGE="([^"]+)"/)?.[1] ?? "").toLowerCase();
    const name = (line.match(/NAME="([^"]+)"/)?.[1] ?? "").toLowerCase();
    return lang === "hin" || lang === "hi" || /hindi/.test(name);
  };

  const isAudioMedia = (line: string): boolean =>
    line.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/i.test(line);

  const lines = m3u8.split("\n");

  let hindiLine: string | null = null;
  const otherAudioLines: string[] = [];
  const rest: string[] = [];
  let firstAudioInsertIdx = -1;

  for (const line of lines) {
    if (isAudioMedia(line)) {
      if (firstAudioInsertIdx === -1) firstAudioInsertIdx = rest.length;
      const updated = line.replace(/DEFAULT=(YES|NO)/i, `DEFAULT=${isHindiLine(line) ? "YES" : "NO"}`);
      if (isHindiLine(line)) {
        hindiLine = updated;
      } else {
        otherAudioLines.push(updated);
      }
    } else {
      rest.push(line);
    }
  }

  if (hindiLine === null || firstAudioInsertIdx === -1) return m3u8;

  const ordered = [hindiLine, ...otherAudioLines];
  return [
    ...rest.slice(0, firstAudioInsertIdx),
    ...ordered,
    ...rest.slice(firstAudioInsertIdx),
  ].join("\n");
}

async function computeRelayM3u8(hash: string, playerCdn: string, proxyBase: string): Promise<string> {
  const playerUrl = `${playerCdn}/video/${hash}`;
  const animesaltBase = "https://animesalt.ac";

  // Step 1: Get the signed m3u8 URL.
  // Check the scraper's cache first — animesalt.ts already called the player API
  // during scraping and stored the result.  If it's there we skip a full round-trip.
  let m3u8Url: string | undefined = getPlayerApiResult(hash)?.m3u8Url;

  if (m3u8Url) {
    logger.info({ hash, m3u8Url: m3u8Url.slice(0, 80) }, "AnimeSalt relay: m3u8 from scraper cache (skip player API call)");
  } else {
    // Cache miss — call the player API fresh.
    logger.info({ hash }, "AnimeSalt relay: cache miss, calling player API");
    const apiResp = await fetch(
      `${playerCdn}/player/index.php?data=${hash}&do=getVideo`,
      {
        method: "POST",
        headers: {
          "User-Agent": AS_CDN_UA,
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": `${animesaltBase}/`,
          "Origin": playerCdn,
          "X-Requested-With": "XMLHttpRequest",
          ...AS_BROWSER_EXTRA,
        },
        body: `hash=${hash}&r=${encodeURIComponent(`${animesaltBase}/`)}`,
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      }
    );

    if (!apiResp.ok) {
      throw Object.assign(new Error("player API error"), { status: apiResp.status });
    }

    const json = (await apiResp.json()) as Record<string, unknown>;
    m3u8Url = (
      json["videoSource"] ?? json["securedLink"] ?? json["file"] ??
      json["url"] ?? json["hls"] ?? json["src"]
    ) as string | undefined;

    if (!m3u8Url) throw new Error("no m3u8 in player API response");
    logger.info({ hash, m3u8Url: m3u8Url.slice(0, 80) }, "AnimeSalt relay: fresh m3u8 obtained via player API");
  }

  // Step 2: Fetch the master m3u8 immediately from our server (same IP, fresh token)
  const upstream = await fetch(m3u8Url, {
    headers: {
      "User-Agent": AS_CDN_UA,
      "Referer": playerUrl,
      "Origin": playerCdn,
      ...AS_BROWSER_EXTRA,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });

  if (!upstream.ok) {
    throw Object.assign(new Error("CDN m3u8 fetch failed"), { status: upstream.status });
  }

  const text = await upstream.text();
  const parsed = new URL(m3u8Url);
  const segBase = parsed.origin + parsed.pathname.replace(/[^/]+$/, "");

  const refEnc = encodeURIComponent(playerUrl);
  const orgEnc = encodeURIComponent(playerCdn);

  // Detect whether the CDN returned a variant playlist (direct TS segments)
  // vs a master playlist (quality renditions with #EXT-X-STREAM-INF).
  // AnimeSalt's CDN returns a variant URL directly from the player API.
  const isVariant = /^#EXTINF:/m.test(text) && !/^#EXT-X-STREAM-INF/m.test(text);

  // If it's a variant, probe the first TS segment to find muxed audio PIDs.
  // This lets us synthesise a proper HLS master with #EXT-X-MEDIA:TYPE=AUDIO
  // entries so LG TV's native player shows a language selector.
  let detectedTracks: import("../lib/ts-audio.js").AudioTrack[] = [];
  let detectedPmtPid = -1;

  if (isVariant) {
    const firstSegRel = text.split("\n").find(l => { const t = l.trim(); return t && !t.startsWith("#"); });
    if (firstSegRel) {
      const firstSegUrl = firstSegRel.trim().startsWith("http")
        ? firstSegRel.trim()
        : firstSegRel.trim().startsWith("/")
          ? parsed.origin + firstSegRel.trim()
          : segBase + firstSegRel.trim();
      try {
        const segResp = await fetch(firstSegUrl, {
          headers: {
            "User-Agent": AS_CDN_UA,
            "Referer": playerUrl,
            "Origin": playerCdn,
            "Range": "bytes=0-7519", // 40 × 188 B TS packets is enough for PAT+PMT
            ...AS_BROWSER_EXTRA,
          },
          signal: AbortSignal.timeout(8_000),
          redirect: "follow",
        });
        if (segResp.ok || segResp.status === 206) {
          const buf = Buffer.from(await segResp.arrayBuffer());
          const probe = probeAudioTracks(buf);
          detectedTracks = probe.tracks;
          detectedPmtPid = probe.pmtPid;
          logger.info(
            { hash, tracks: detectedTracks.map(t => `${t.name}(pid=${t.pid})`), pmtPid: detectedPmtPid },
            "AnimeSalt relay: TS audio probe"
          );
        }
      } catch (err) {
        logger.warn({ hash, err }, "AnimeSalt relay: TS probe failed (non-fatal, falling back to plain variant)");
      }
    }
  }

  const toAbsUrl = (rel: string): string => {
    if (rel.startsWith("http")) return rel;
    if (rel.startsWith("/")) return parsed.origin + rel;
    return segBase + rel;
  };

  const proxyUrl = (absUrl: string, isPlaylist: boolean): string =>
    isPlaylist
      ? `${proxyBase}/m3u8?url=${encodeURIComponent(absUrl)}&referer=${refEnc}&origin=${orgEnc}`
      : `${proxyBase}/seg?u=${encodeURIComponent(absUrl)}&ref=${refEnc}&org=${orgEnc}`;

  let nextLineIsVariant = false;
  const rewritten = text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-MEDIA") && trimmed.includes('URI="')) {
      nextLineIsVariant = false;
      return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
        `URI="${proxyUrl(toAbsUrl(uri), true)}"`
      );
    }
    if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes('URI="')) {
      nextLineIsVariant = false;
      return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
        `URI="${proxyUrl(toAbsUrl(uri), false)}"`
      );
    }
    // Proxy fMP4/CMAF init segment URIs so the CDN's Referer/Origin token check
    // is satisfied for audio rendition init segments.  Without this the player
    // fetches init-audio.mp4 directly from the CDN (wrong IP/headers) → 403 →
    // the audio rendition silently fails and LG TV never shows the track selector.
    if (trimmed.startsWith("#EXT-X-MAP") && trimmed.includes('URI="')) {
      nextLineIsVariant = false;
      return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
        `URI="${proxyUrl(toAbsUrl(uri), false)}"`
      );
    }
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) { nextLineIsVariant = true; return line; }
    if (!trimmed || trimmed.startsWith("#")) return line;
    const absUrl = toAbsUrl(trimmed);
    const isPlaylist = nextLineIsVariant || /\.m3u8/i.test(absUrl);
    nextLineIsVariant = false;
    return proxyUrl(absUrl, isPlaylist);
  }).join("\n");

  // For master playlists that have real #EXT-X-MEDIA:TYPE=AUDIO renditions,
  // ensure Hindi is listed FIRST and has DEFAULT=YES.
  //
  // LG TV (and many TV players) select the audio rendition either by DEFAULT=YES
  // or simply by playing the first listed rendition.  The AnimeSalt CDN master
  // has all three tracks (tel/tam/hin) with DEFAULT=NO, so whichever comes first
  // (typically Telugu) is what LG TV plays.  Moving Hindi first + setting
  // DEFAULT=YES means LG TV plays Hindi out of the box regardless of its
  // selection strategy.  Android users can still switch via the normal track
  // selector — all three renditions remain in the playlist.
  const withHindiFirst = putHindiFirstInMaster(rewritten);
  if (withHindiFirst !== rewritten) {
    logger.info({ hash }, "AnimeSalt relay: reordered audio renditions — Hindi first, DEFAULT=YES");
  }

  // If we're wrapping a CDN variant and detected multiple audio tracks,
  // synthesise a proper HLS master playlist with #EXT-X-MEDIA:TYPE=AUDIO
  // entries pointing to our per-PID audio rendition proxy endpoints.
  // Video playback is fully unchanged — the variant URL is unmodified.
  if (isVariant && detectedTracks.length > 1) {
    const variantProxied = `${proxyBase}/m3u8?url=${encodeURIComponent(m3u8Url)}&referer=${refEnc}&origin=${orgEnc}`;
    const encVariant = encodeURIComponent(m3u8Url);
    const pmtStr = String(detectedPmtPid);

    // Move Hindi track to front. Also mark it DEFAULT=YES per the HLS spec.
    const hindiIdx = detectedTracks.findIndex(
      t => /hindi/i.test(t.name) || t.language === "hin" || t.language === "hi"
    );
    const orderedTracks = hindiIdx > 0
      ? [detectedTracks[hindiIdx]!, ...detectedTracks.filter((_, i) => i !== hindiIdx)]
      : detectedTracks;

    const hindiTrack = orderedTracks[0]!;

    // Route the main variant through /m3u8 with audiopid=<hindiPid> so that
    // the /m3u8 route rewrites every TS segment URL to /as-va, which strips
    // all audio PIDs except Hindi from each segment.  LG TV (which ignores
    // HLS DEFAULT= flags and just plays the first audio PID found in the TS)
    // therefore has no choice but to play Hindi.  Android users can still
    // switch via the #EXT-X-MEDIA renditions below.
    const variantWithHindi =
      `${proxyBase}/m3u8?url=${encVariant}&referer=${refEnc}&origin=${orgEnc}` +
      `&audiopid=${hindiTrack.pid}&pmtpid=${pmtStr}`;

    const mediaLines = orderedTracks.map((t, i) => {
      const audioPlUrl =
        `${proxyBase}/as-audio-pl?variantUrl=${encVariant}` +
        `&pid=${t.pid}&pmtpid=${pmtStr}&ref=${refEnc}&org=${orgEnc}`;
      return (
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",` +
        `LANGUAGE="${t.language || `und${i}`}",NAME="${t.name}",` +
        `DEFAULT=${i === 0 ? "YES" : "NO"},AUTOSELECT=YES,` +
        `URI="${audioPlUrl}"`
      );
    });

    logger.info({ hash, tracks: detectedTracks.length, defaultTrack: hindiTrack.name, hindiPid: hindiTrack.pid }, "AnimeSalt relay: serving synthetic HLS master with Hindi-filtered main variant");

    return [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "",
      ...mediaLines,
      "",
      `#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="audio"`,
      variantWithHindi,
    ].join("\n");
  }

  return withHindiFirst;
}

// Returns a promise that resolves to the rewritten m3u8, using the cache and
// in-flight dedup map to avoid redundant upstream calls.
async function getRelayM3u8(hash: string, playerCdn: string, proxyBase: string): Promise<string> {
  const key = `${hash}::${playerCdn}::${proxyBase}`;

  const cached = relayResultCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.m3u8;

  const inflight = relayInFlight.get(key);
  if (inflight) return inflight;

  const promise = computeRelayM3u8(hash, playerCdn, proxyBase).then((m3u8) => {
    relayResultCache.set(key, { m3u8, expiresAt: Date.now() + RELAY_TTL_MS });
    relayInFlight.delete(key);
    return m3u8;
  }).catch((err) => {
    relayInFlight.delete(key);
    throw err;
  });

  relayInFlight.set(key, promise);
  return promise;
}

/**
 * Pre-warm the relay cache in the background so that the first playback
 * request gets a cache-hit instead of waiting 10-15 s.  Call this from the
 * stream handler right after building the relay URL.
 */
export function prewarmAsRelay(hash: string, playerCdn: string, proxyBase: string): void {
  getRelayM3u8(hash, playerCdn, proxyBase).catch(() => {});
}

router.get("/as-relay", async (req: Request, res: Response) => {
  const { hash, player } = req.query as Record<string, string | undefined>;
  if (!hash || !player) {
    res.status(400).json({ error: "Missing hash or player" });
    return;
  }

  let playerCdn: string;
  try {
    playerCdn = decodeParam(player);
    new URL(playerCdn);
  } catch {
    res.status(400).json({ error: "Invalid player param" });
    return;
  }

  const publicUrl = process.env["PUBLIC_URL"];
  const replitDomains = process.env["REPLIT_DOMAINS"];
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? (req.headers["host"] as string | undefined) ?? "localhost";
  const proxyBase = publicUrl
    ? publicUrl.replace(/\/$/, "") + BASE_PATH
    : replitDomains
      ? `https://${replitDomains.split(",")[0]}${BASE_PATH}`
      : `${proto}://${host}${BASE_PATH}`;

  try {
    const m3u8 = await getRelayM3u8(hash, playerCdn, proxyBase);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(m3u8);
  } catch (err: unknown) {
    logger.error({ err, hash, playerCdn }, "AnimeSalt relay error");
    if (!res.headersSent) {
      const status = (err as { status?: number }).status;
      res.status(typeof status === "number" ? status : 502).end();
    }
  }
});

router.options("/as-relay", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// /as-audio-pl — audio rendition playlist proxy
//
// Fetches the original CDN variant playlist and rewrites every segment line
// to route through /as-audio, which strips all but the selected audio PID
// from the MPEG-TS packets.
//
// Query params:
//   variantUrl  — URL-encoded raw CDN variant m3u8 URL
//   pid         — the MPEG-TS audio elementary PID to keep
//   pmtpid      — the MPEG-TS PMT PID (needed so we keep PMT packets too)
//   ref         — URL-encoded Referer header to forward to CDN
//   org         — URL-encoded Origin header to forward to CDN
// ---------------------------------------------------------------------------
router.get("/as-audio-pl", async (req: Request, res: Response) => {
  const { variantUrl: variantUrlEnc, pid: pidStr, pmtpid: pmtpidStr, ref: refEnc, org: orgEnc } =
    req.query as Record<string, string | undefined>;

  if (!variantUrlEnc || !pidStr || !pmtpidStr) { res.status(400).end(); return; }

  const audioPid = parseInt(pidStr, 10);
  const pmtPid = parseInt(pmtpidStr, 10);
  if (!isFinite(audioPid) || !isFinite(pmtPid)) { res.status(400).end(); return; }

  let variantUrl: string;
  try { variantUrl = decodeURIComponent(variantUrlEnc); new URL(variantUrl); }
  catch { res.status(400).end(); return; }

  const referer = refEnc ? decodeURIComponent(refEnc) : undefined;
  const origin  = orgEnc ? decodeURIComponent(orgEnc)  : undefined;

  const publicUrl     = process.env["PUBLIC_URL"];
  const replitDomains = process.env["REPLIT_DOMAINS"];
  const proto  = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host   = (req.headers["x-forwarded-host"] as string | undefined) ?? (req.headers["host"] as string | undefined) ?? "localhost";
  const base   = publicUrl
    ? publicUrl.replace(/\/$/, "") + BASE_PATH
    : replitDomains
      ? `https://${replitDomains.split(",")[0]}${BASE_PATH}`
      : `${proto}://${host}${BASE_PATH}`;

  try {
    const upstream = await fetch(variantUrl, {
      headers: {
        "User-Agent": AS_CDN_UA,
        ...(referer ? { "Referer": referer } : {}),
        ...(origin  ? { "Origin":  origin  } : {}),
        ...AS_BROWSER_EXTRA,
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const text   = await upstream.text();
    const parsed = new URL(variantUrl);
    const segBase = parsed.origin + parsed.pathname.replace(/[^/]+$/, "");

    const rewritten = text.split("\n").map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const absUrl = trimmed.startsWith("http") ? trimmed
        : trimmed.startsWith("/") ? parsed.origin + trimmed
        : segBase + trimmed;
      return (
        `${base}/as-audio?url=${encodeURIComponent(absUrl)}&pid=${audioPid}&pmtpid=${pmtPid}` +
        (referer ? `&ref=${encodeURIComponent(referer)}` : "") +
        (origin  ? `&org=${encodeURIComponent(origin)}`  : "")
      );
    }).join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewritten);
  } catch (err) {
    logger.error({ err, variantUrl }, "as-audio-pl error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/as-audio-pl", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// /as-audio — filtered MPEG-TS segment endpoint
//
// Fetches a TS segment from the CDN and strips all packets except PAT, PMT,
// and the selected audio PID, producing an audio-only TS stream that LG TV's
// HLS player uses for the chosen language rendition.
//
// Query params:
//   url     — URL-encoded raw CDN segment URL
//   pid     — MPEG-TS audio elementary PID to keep
//   pmtpid  — MPEG-TS PMT PID to keep
//   ref     — URL-encoded Referer to forward to CDN
//   org     — URL-encoded Origin to forward to CDN
// ---------------------------------------------------------------------------
router.get("/as-audio", async (req: Request, res: Response) => {
  const { url: urlEnc, pid: pidStr, pmtpid: pmtpidStr, ref: refEnc, org: orgEnc } =
    req.query as Record<string, string | undefined>;

  if (!urlEnc || !pidStr || !pmtpidStr) { res.status(400).end(); return; }

  const audioPid = parseInt(pidStr, 10);
  const pmtPid   = parseInt(pmtpidStr, 10);
  if (!isFinite(audioPid) || !isFinite(pmtPid)) { res.status(400).end(); return; }

  let segUrl: string;
  try { segUrl = decodeURIComponent(urlEnc); new URL(segUrl); }
  catch { res.status(400).end(); return; }

  const referer = refEnc ? decodeURIComponent(refEnc) : undefined;
  const origin  = orgEnc ? decodeURIComponent(orgEnc)  : undefined;

  try {
    const upstream = await fetch(segUrl, {
      headers: {
        "User-Agent": AS_CDN_UA,
        ...(referer ? { "Referer": referer } : {}),
        ...(origin  ? { "Origin":  origin  } : {}),
        ...AS_BROWSER_EXTRA,
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const raw     = Buffer.from(await upstream.arrayBuffer());
    const filtered = filterAudioPid(raw, audioPid, pmtPid);

    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(filtered);
  } catch (err) {
    logger.error({ err, segUrl }, "as-audio error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/as-audio", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// /as-va-pl — video + single-audio playlist proxy
//
// Fetches the original CDN variant playlist and rewrites every segment URL
// to route through /as-va, which strips all audio PIDs except the chosen one.
// This is used as the main #EXT-X-STREAM-INF URL in the AnimeSalt synthetic
// HLS master so that LG TV (which ignores DEFAULT= flags and plays the first
// audio PID in the TS) always plays Hindi.
//
// Query params:
//   variantUrl  — URL-encoded raw CDN variant m3u8 URL
//   audiopid    — the MPEG-TS audio PID to KEEP (all others are dropped)
//   pmtpid      — the MPEG-TS PMT PID
//   ref         — URL-encoded Referer header to forward to CDN
//   org         — URL-encoded Origin header to forward to CDN
// ---------------------------------------------------------------------------
router.get("/as-va-pl", async (req: Request, res: Response) => {
  const { variantUrl: variantUrlEnc, audiopid: audiopidStr, pmtpid: pmtpidStr, ref: refEnc, org: orgEnc } =
    req.query as Record<string, string | undefined>;

  if (!variantUrlEnc || !audiopidStr || !pmtpidStr) { res.status(400).end(); return; }

  const audioPid = parseInt(audiopidStr, 10);
  const pmtPid   = parseInt(pmtpidStr,   10);
  if (!isFinite(audioPid) || !isFinite(pmtPid)) { res.status(400).end(); return; }

  let variantUrl: string;
  try { variantUrl = decodeURIComponent(variantUrlEnc); new URL(variantUrl); }
  catch { res.status(400).end(); return; }

  const referer = refEnc ? decodeURIComponent(refEnc) : undefined;
  const origin  = orgEnc ? decodeURIComponent(orgEnc) : undefined;

  const publicUrl     = process.env["PUBLIC_URL"];
  const replitDomains = process.env["REPLIT_DOMAINS"];
  const proto  = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host   = (req.headers["x-forwarded-host"] as string | undefined) ?? (req.headers["host"] as string | undefined) ?? "localhost";
  const base   = publicUrl
    ? publicUrl.replace(/\/$/, "") + BASE_PATH
    : replitDomains
      ? `https://${replitDomains.split(",")[0]}${BASE_PATH}`
      : `${proto}://${host}${BASE_PATH}`;

  try {
    const upstream = await fetch(variantUrl, {
      headers: {
        "User-Agent": AS_CDN_UA,
        ...(referer ? { "Referer": referer } : {}),
        ...(origin  ? { "Origin":  origin  } : {}),
        ...AS_BROWSER_EXTRA,
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const text   = await upstream.text();
    const parsed = new URL(variantUrl);
    const segBase = parsed.origin + parsed.pathname.replace(/[^/]+$/, "");

    const rewritten = text.split("\n").map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const absUrl = trimmed.startsWith("http") ? trimmed
        : trimmed.startsWith("/") ? parsed.origin + trimmed
        : segBase + trimmed;
      return (
        `${base}/as-va?url=${encodeURIComponent(absUrl)}&audiopid=${audioPid}&pmtpid=${pmtPid}` +
        (referer ? `&ref=${encodeURIComponent(referer)}` : "") +
        (origin  ? `&org=${encodeURIComponent(origin)}`  : "")
      );
    }).join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewritten);
  } catch (err) {
    logger.error({ err, variantUrl }, "as-va-pl error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/as-va-pl", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// /as-va — video + single-audio TS segment filter
//
// Fetches a TS segment and strips all audio PIDs except the selected one,
// while keeping video, PAT, PMT, and any other non-audio PIDs intact.
//
// Query params:
//   url       — URL-encoded raw CDN segment URL
//   audiopid  — MPEG-TS audio PID to keep
//   pmtpid    — MPEG-TS PMT PID to keep
//   ref       — URL-encoded Referer to forward to CDN
//   org       — URL-encoded Origin to forward to CDN
// ---------------------------------------------------------------------------
router.get("/as-va", async (req: Request, res: Response) => {
  const { url: urlEnc, audiopid: audiopidStr, pmtpid: pmtpidStr, ref: refEnc, org: orgEnc } =
    req.query as Record<string, string | undefined>;

  if (!urlEnc || !audiopidStr || !pmtpidStr) { res.status(400).end(); return; }

  const audioPid = parseInt(audiopidStr, 10);
  const pmtPid   = parseInt(pmtpidStr,   10);
  if (!isFinite(audioPid) || !isFinite(pmtPid)) { res.status(400).end(); return; }

  let segUrl: string;
  try { segUrl = decodeURIComponent(urlEnc); new URL(segUrl); }
  catch { res.status(400).end(); return; }

  const referer = refEnc ? decodeURIComponent(refEnc) : undefined;
  const origin  = orgEnc ? decodeURIComponent(orgEnc) : undefined;

  try {
    const upstream = await fetch(segUrl, {
      headers: {
        "User-Agent": AS_CDN_UA,
        ...(referer ? { "Referer": referer } : {}),
        ...(origin  ? { "Origin":  origin  } : {}),
        ...AS_BROWSER_EXTRA,
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const raw      = Buffer.from(await upstream.arrayBuffer());
    const filtered = filterVideoAndAudio(raw, audioPid, pmtPid);

    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(filtered);
  } catch (err) {
    logger.error({ err, segUrl }, "as-va error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/as-va", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

export default router;
