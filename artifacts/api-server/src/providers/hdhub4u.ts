import * as cheerio from "cheerio";
import { getHtml, getJson, BROWSER_HEADERS } from "../utils/request.js";
import {
  cleanTitle,
  getSearchQuality,
  encodeId,
  decodeId,
} from "../utils/index.js";
import { extractStreams } from "../extractors/index.js";
import type { Stream } from "../extractors/types.js";
import { logger } from "../lib/logger.js";
import {
  type ResolvedMeta,
  normalizeTitle,
  titleSimilarity,
} from "../lib/meta-resolver.js";

const TMDB_API_KEY = process.env["TMDB_API_KEY"] ?? "5f39fd16e987a9e3fce30d55cf09b438";
const TMDB_BASE = "https://image.tmdb.org/t/p/original";
const TMDB_API = "https://api.themoviedb.org/3";
// pingora.fyi is the current live Typesense endpoint (hdhub4u.glass is the old domain)
const SEARCH_URL = "https://search.pingora.fyi";
const SEARCH_URL_FALLBACK = "https://search.hdhub4u.glass";
const DOMAINS_URL =
  "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";

// Cookie required by HDHub4U to show download links
const HD_COOKIE = "xla=s4t";

// Redirect-wrapper domains: these pages embed the real CDN URL in obfuscated JS.
// They need fetchRedirectLink() to decode before extractStreams() can handle them.
const REDIRECT_WRAPPERS =
  /techyboy4u|gadgetsweb|cryptoinsights|bloggingvector|ampproject\.org/i;

function rot13(str: string): string {
  return str.replace(/[a-zA-Z]/g, (c) => {
    const code = c.charCodeAt(0);
    const base = code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

function b64d(str: string): string {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/**
 * Fetches a redirect-wrapper page and decodes the embedded multi-layer
 * obfuscated URL to get the real CDN/HubCloud link.
 *
 * Reference algorithm:
 *   s('o', '<encoded>') or ck('_wp_http_N', '<encoded>')
 *   → atob(rot13(atob(atob(encoded)))) → JSON → atob(json.o)
 */
async function fetchRedirectLink(url: string, depth = 0): Promise<string | null> {
  if (depth > 3) return null;
  try {
    const res = await fetch(url, {
      headers: {
        ...BROWSER_HEADERS,
        "Cookie": HD_COOKIE,
        "Referer": url,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Find obfuscated encoded payload
    const pattern =
      /s\s*\(\s*['"]o['"]\s*,\s*['"]([A-Za-z0-9+/=]+)['"]|ck\s*\(\s*['"]_wp_http_\d+['"]\s*,\s*['"]([^'"]+)['"]/g;
    let encoded = "";
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(html)) !== null) {
      encoded += m[1] ?? m[2] ?? "";
    }

    if (encoded) {
      try {
        const decoded = b64d(rot13(b64d(b64d(encoded))));
        const json = JSON.parse(decoded) as { o?: string; data?: string; blog_url?: string };
        const oUrl = json.o ? b64d(json.o).trim() : "";
        if (oUrl) return oUrl;
        const data = json.data ? b64d(json.data).trim() : "";
        const blogUrl = (json.blog_url ?? "").trim();
        if (blogUrl && data) {
          const res2 = await fetch(`${blogUrl}?re=${data}`, {
            headers: { ...BROWSER_HEADERS, "Cookie": HD_COOKIE },
            signal: AbortSignal.timeout(8_000),
          });
          const text = (await res2.text()).trim();
          if (text) return text;
        }
      } catch {
        // decode failed — fall through to other strategies
      }
    }

    // Fallback: window.location.href redirect
    const locMatch = /window\.location\.href\s*=\s*['"]([^'"]+)['"]/.exec(html);
    if (locMatch?.[1] && locMatch[1] !== url && !locMatch[1].includes(url)) {
      return fetchRedirectLink(locMatch[1], depth + 1);
    }

    return null;
  } catch {
    return null;
  }
}

export let MAIN_URL =
  process.env["HDHUB4U_URL"] ?? "https://new1.hdhub4u.limo";

async function resolveDomain(): Promise<void> {
  try {
    const data = await getJson<{ HDHUB4u?: string }>(DOMAINS_URL, {}, 8000);
    if (data.HDHUB4u) {
      MAIN_URL = data.HDHUB4u;
      logger.info({ MAIN_URL }, "HDHub4U: resolved live domain");
    }
  } catch (e) {
    logger.warn({ err: e }, "HDHub4U: domain resolution failed, using default");
  }
}

// ── Sitemap-based search (full background pre-warm) ────────────────────────────
// The Typesense search API (search.hdhub4u.glass) is dead. We fall back to the
// WordPress post sitemaps (server-rendered XML). The sitemaps are ordered
// oldest-first, so we must load ALL pages to cover the full content library.
//
// Strategy: kick off a background pre-warm right after domain resolution.
// Fetch all pages in parallel batches of 20; stop when a full batch comes back
// empty (soft-404 returns HTML with no <loc> tags). Cache for 2 hours.
//
// IMPORTANT: the server returns HTTP 200 for ANY URL (soft-404). We detect
// valid sitemaps by checking for <loc> in the body, not by HTTP status.

let _sitemapUrls: string[] | null = null;
let _sitemapCacheTime = 0;
const SITEMAP_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const SITEMAP_BATCH = 20; // pages fetched in parallel per round
const SITEMAP_UA = BROWSER_HEADERS["User-Agent"] ?? "Mozilla/5.0";

// Promise that resolves when the current build finishes (null = no build running)
let _sitemapBuildPromise: Promise<void> | null = null;

async function fetchSitemapPage(pageNum: number, baseUrl: string): Promise<string[]> {
  const url =
    pageNum === 1
      ? `${baseUrl}/post-sitemap.xml`
      : `${baseUrl}/post-sitemap${pageNum}.xml`;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, {
      // Must NOT send "Accept: text/html" — WordPress will serve the homepage
      // instead of XML when the browser Accept header is preferred.
      headers: {
        "User-Agent": SITEMAP_UA,
        "Accept": "application/xml, text/xml, */*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const xml = await res.text();
    if (!xml.includes("<loc>")) return []; // HTML soft-404
    const urls: string[] = [];
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const loc = m[1];
      if (loc && !loc.includes("sitemap")) urls.push(loc);
    }
    return urls;
  } catch {
    return [];
  }
}

async function buildSitemapCache(): Promise<void> {
  const baseUrl = MAIN_URL;
  logger.info({ baseUrl }, "HDHub4U: sitemap pre-warm started");

  const allUrls: string[] = [];
  let batchStart = 1;

  for (;;) {
    const pageNums = Array.from({ length: SITEMAP_BATCH }, (_, i) => batchStart + i);
    const results = await Promise.all(
      pageNums.map((p) => fetchSitemapPage(p, baseUrl)),
    );

    const validCount = results.filter((r) => r.length > 0).length;
    for (const r of results) allUrls.push(...r);

    logger.debug(
      { batchStart, validCount, totalSoFar: allUrls.length },
      "HDHub4U: sitemap batch done",
    );

    // Stop when fewer than 2 pages in the batch had real content
    // (means we've passed the last real sitemap page)
    if (validCount < 2) break;

    batchStart += SITEMAP_BATCH;
    if (batchStart > 300) break; // safety cap
  }

  _sitemapUrls = allUrls;
  _sitemapCacheTime = Date.now();
  logger.info({ count: allUrls.length }, "HDHub4U: sitemap pre-warm complete");
}

function startSitemapPrewarm(): void {
  if (_sitemapBuildPromise) return;
  _sitemapBuildPromise = buildSitemapCache()
    .catch((e) => logger.warn({ err: e }, "HDHub4U: sitemap pre-warm failed"))
    .finally(() => { _sitemapBuildPromise = null; });
}

async function getSitemapUrls(): Promise<string[]> {
  const now = Date.now();
  if (_sitemapUrls && now - _sitemapCacheTime < SITEMAP_CACHE_TTL_MS) {
    return _sitemapUrls;
  }
  // Build is in progress — wait for it
  if (_sitemapBuildPromise) {
    await _sitemapBuildPromise;
    return _sitemapUrls ?? [];
  }
  // Nothing running — kick off a fresh build and wait
  _sitemapBuildPromise = buildSitemapCache()
    .catch((e) => logger.warn({ err: e }, "HDHub4U: sitemap build failed"))
    .finally(() => { _sitemapBuildPromise = null; });
  await _sitemapBuildPromise;
  return _sitemapUrls ?? [];
}

// Kick off the pre-warm after domain is resolved so we use the right URL
resolveDomain().then(() => startSitemapPrewarm());

function titleFromSitemapUrl(url: string): string {
  const path = url
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/\/$/, "")
    .slice(1);
  const parts = path.split("-");
  let cutIdx = -1;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i] ?? "";
    if (
      /^(19|20)\d{2}$/.test(p) ||
      /^(480p?|720p?|1080p?|2160p?|4k|dual|hindi|english|tamil|telugu|korean|japanese|bluray|dvdrip|webrip|hdrip|hdcam|web|pdvd|bdrip)$/i.test(p)
    ) {
      cutIdx = i;
      break;
    }
  }
  const titleParts =
    cutIdx > 0
      ? parts.slice(0, cutIdx)
      : parts.slice(0, Math.min(8, parts.length));
  return titleParts
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
    .join(" ")
    .trim();
}

async function searchContentViaSitemap(
  query: string,
  meta: ResolvedMeta,
): Promise<CatalogItem[]> {
  let urls: string[];
  try {
    urls = await getSitemapUrls();
  } catch (e) {
    logger.warn({ err: e, query }, "HDHub4U: sitemap fetch failed");
    return [];
  }

  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const significant = words.filter((w) => w.length >= 3);
  const checkWords = significant.length > 0 ? significant : words;
  const yearStr = meta.year ? String(meta.year) : "";

  if (checkWords.length === 0 && !yearStr) return [];

  const matched = urls.filter((url) => {
    const slug = url.toLowerCase();
    if (yearStr && !slug.includes(yearStr)) return false;
    if (checkWords.length === 0) return true;
    const matchCount = checkWords.filter((w) => slug.includes(w)).length;
    return matchCount >= Math.ceil(checkWords.length * 0.6);
  });

  // Reverse so newest posts come first — the sitemap is oldest-first, but we
  // want to try the most recent re-upload (which is more likely to have fresh,
  // working download links) before older posts with potentially dead links.
  const newest = [...matched].reverse().slice(0, 15);
  return newest.map((url) => ({
    id: itemIdFromUrl(url),
    type: "movie" as const,
    name: titleFromSitemapUrl(url),
  }));
}

export interface CatalogItem {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  description?: string;
  year?: number;
  genres?: string[];
  imdbRating?: string;
  releaseInfo?: string;
  links?: string[];
}

export interface MetaItem {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  year?: number;
  genres?: string[];
  cast?: string[];
  imdbRating?: string;
  videos?: EpisodeItem[];
  links?: string[];
}

export interface EpisodeItem {
  id: string;
  title: string;
  season: number;
  episode: number;
  overview?: string;
  thumbnail?: string;
  released?: string;
  links?: string[];
}

function itemIdFromUrl(url: string): string {
  return encodeId(url);
}

export async function getHomepage(
  categoryPath: string,
  page: number,
): Promise<CatalogItem[]> {
  const base = categoryPath ? `${MAIN_URL}/${categoryPath}` : `${MAIN_URL}/`;
  const url = `${base}page/${page}/`;
  logger.info({ url }, "HDHub4U: fetching homepage");
  try {
    const html = await getHtml(url, { "Cookie": HD_COOKIE, "Referer": `${MAIN_URL}/` });
    const $ = cheerio.load(html);
    const items: CatalogItem[] = [];

    const isSeriesCategory = /web.?series|series|episode/i.test(categoryPath);

    $(".recent-movies > li.thumb").each((_, el) => {
      const titleRaw = $(el)
        .find("figcaption:nth-child(2) > a:nth-child(1) > p:nth-child(1)")
        .text()
        .trim();
      const title = cleanTitle(titleRaw);
      const itemUrl = $(el)
        .find("figure:nth-child(1) > a:nth-child(2)")
        .attr("href") ?? "";
      const poster = $(el)
        .find("figure:nth-child(1) > img:nth-child(1)")
        .attr("src") ?? "";

      if (!itemUrl || !title) return;

      const id = itemIdFromUrl(itemUrl);
      const quality = getSearchQuality(titleRaw);

      const inferredType: "movie" | "series" =
        isSeriesCategory ||
        /\bseries\b|\bseason\b|\bs\d{2}e\d{2}\b/i.test(titleRaw)
          ? "series"
          : "movie";

      items.push({
        id,
        type: inferredType,
        name: title,
        poster,
        releaseInfo: quality ?? undefined,
      });
    });

    logger.info({ count: items.length }, "HDHub4U: homepage fetched");
    return items;
  } catch (e) {
    logger.error({ err: e, url }, "HDHub4U: homepage error");
    return [];
  }
}

function toAbsoluteUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return "https:" + url;
  return MAIN_URL.replace(/\/$/, "") + (url.startsWith("/") ? url : "/" + url);
}

function buildSearchUrl(base: string, query: string, page: number): string {
  return (
    `${base}/collections/post/documents/search` +
    `?q=${encodeURIComponent(query)}` +
    `&query_by=post_title,category` +
    `&query_by_weights=4,2` +
    `&sort_by=sort_by_date:desc` +
    `&limit=15` +
    `&highlight_fields=none` +
    `&use_cache=true` +
    `&page=${page}`
  );
}

export async function searchContent(
  query: string,
  page: number,
): Promise<CatalogItem[]> {
  logger.info({ query, page }, "HDHub4U: searching");

  async function trySearch(base: string): Promise<CatalogItem[] | null> {
    try {
      const data = await getJson<SearchResponse>(buildSearchUrl(base, query, page), BROWSER_HEADERS, 8000);
      const hits = data.hits ?? [];
      if (hits.length === 0 && base === SEARCH_URL) return null; // try fallback
      return hits.map((hit) => {
        const permalink = toAbsoluteUrl(hit.document.permalink);
        return {
          id: itemIdFromUrl(permalink),
          type: "movie" as const,
          name: hit.document.post_title,
          poster: hit.document.post_thumbnail,
        };
      });
    } catch {
      return null;
    }
  }

  const primary = await trySearch(SEARCH_URL);
  if (primary !== null) return primary;

  // Fallback to old domain
  const fallback = await trySearch(SEARCH_URL_FALLBACK);
  if (fallback !== null) return fallback;

  logger.warn({ query }, "HDHub4U: both search endpoints failed");
  return [];
}

export async function getMeta(pageUrl: string): Promise<MetaItem | null> {
  const absoluteUrl = toAbsoluteUrl(pageUrl);
  logger.info({ pageUrl: absoluteUrl }, "HDHub4U: fetching meta");
  try {
    const html = await getHtml(absoluteUrl, { "Cookie": HD_COOKIE, "Referer": `${MAIN_URL}/` });
    const $ = cheerio.load(html);

    let title = $(
      'h2[data-ved="2ahUKEwjL0NrBk4vnAhWlH7cAHRCeAlwQ3B0oATAfegQIFBAM"], ' +
        'h2[data-ved="2ahUKEwiP0pGdlermAhUFYVAKHV8tAmgQ3B0oATAZegQIDhAM"]',
    )
      .first()
      .text()
      .trim();
    if (!title) title = $("h1.page-title").first().text().trim();

    const seasonMatch = /\bSeason\s*(\d+)\b/i.exec(title);
    const seasonNumber = seasonMatch ? parseInt(seasonMatch[1]) : null;

    const image = $("meta[property='og:image']").attr("content") ?? "";
    const plot = $(".kno-rdesc .kno-rdesc").first().text().trim();
    const poster =
      $("main.page-body img.aligncenter").first().attr("src") ??
      $(".page-body img").first().attr("src") ?? "";

    const tvtype: "movie" | "series" =
      /season|series|episode|web.?series/i.test(title) ||
      /season|series|episode/i.test(absoluteUrl)
        ? "series"
        : "movie";

    let background = image;
    let description = plot || undefined;
    let year: number | undefined;
    const cast: string[] = [];
    const genres: string[] = [];
    const videos: EpisodeItem[] = [];

    const imdbUrl = $("div span a[href*='imdb.com']").attr("href") ?? "";
    const tmdbHref =
      $("div span a[href*='themoviedb.org']").attr("href") ?? "";
    let tmdbId = tmdbHref.split("/").pop()?.split("-")[0]?.split("?")[0] ?? "";
    const isTv = tmdbHref.includes("/tv/");

    if (!tmdbId && imdbUrl) {
      const imdbIdOnly = imdbUrl.split("title/")[1]?.split("/")[0] ?? "";
      if (imdbIdOnly) {
        try {
          const findData = await getJson<TmdbFindResponse>(
            `${TMDB_API}/find/${imdbIdOnly}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
          );
          const res =
            tvtype === "movie"
              ? findData.movie_results?.[0]
              : findData.tv_results?.[0];
          if (res?.id) tmdbId = String(res.id);
        } catch {
          // ignore
        }
      }
    }

    if (tmdbId) {
      try {
        const type = isTv || tvtype === "series" ? "tv" : "movie";
        const detailsData = await getJson<TmdbDetails>(
          `${TMDB_API}/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=credits,external_ids`,
        );

        let metaName = detailsData.name ?? detailsData.title ?? title;
        if (
          seasonNumber &&
          !metaName.toLowerCase().includes(`season ${seasonNumber}`)
        ) {
          metaName = `${metaName} (Season ${seasonNumber})`;
        }

        description = detailsData.overview || description;
        const yearRaw =
          detailsData.release_date ?? detailsData.first_air_date ?? "";
        year = yearRaw ? parseInt(yearRaw.slice(0, 4)) : undefined;
        title = metaName;

        if (detailsData.backdrop_path) {
          background = TMDB_BASE + detailsData.backdrop_path;
        }

        detailsData.genres?.forEach((g) => genres.push(g.name));
        detailsData.credits?.cast?.slice(0, 10).forEach((c) => {
          if (c.name) cast.push(c.name);
        });

        if (tvtype === "series" && seasonNumber) {
          try {
            const seasonData = await getJson<TmdbSeason>(
              `${TMDB_API}/tv/${tmdbId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}`,
            );
            seasonData.episodes?.forEach((ep) => {
              videos.push({
                id: `${encodeId(absoluteUrl)}:${seasonNumber}:${ep.episode_number}`,
                title: ep.name,
                season: seasonNumber,
                episode: ep.episode_number,
                overview: ep.overview,
                thumbnail: ep.still_path ? TMDB_BASE + ep.still_path : undefined,
                released: ep.air_date,
              });
            });
          } catch {
            // ignore
          }
        }
      } catch (e) {
        logger.warn({ err: e, tmdbId }, "HDHub4U: TMDB details failed");
      }
    }

    const allPageLinks = extractAllLinks($);
    logger.info({ count: allPageLinks.length }, "HDHub4U: page links extracted");

    if (tvtype === "series") {
      const epLinksMap = extractEpisodeLinks($);
      const hasEpisodeLinks = Object.keys(epLinksMap).length > 0;

      if (hasEpisodeLinks) {
        const existingEpNums = new Set(videos.map((v) => v.episode));
        for (const [epNumStr, epLinks] of Object.entries(epLinksMap)) {
          const epNum = parseInt(epNumStr);
          if (epNum < 0) continue;
          if (!existingEpNums.has(epNum)) {
            videos.push({
              id: `${encodeId(absoluteUrl)}:${seasonNumber ?? 1}:${epNum}`,
              title: `Episode ${epNum}`,
              season: seasonNumber ?? 1,
              episode: epNum,
              links: epLinks,
            });
          } else {
            const ep = videos.find((v) => v.episode === epNum);
            if (ep) ep.links = epLinks;
          }
        }
      }

      // Only assign page-wide links as episode fallback when NO structured episode
      // sections exist on the page. If episode sections DO exist, using allPageLinks
      // as fallback would pollute episodes with unrelated movie download links that
      // appear on the same page (e.g. Shinchan movies on a Shinchan series page).
      if (!hasEpisodeLinks && videos.length > 0 && allPageLinks.length > 0) {
        for (const ep of videos) {
          if (!ep.links?.length) ep.links = allPageLinks;
        }
      }

      videos.sort((a, b) => a.episode - b.episode);
    }

    return {
      id: encodeId(absoluteUrl),
      type: tvtype,
      name: title,
      poster: poster || image,
      background,
      description,
      year,
      genres,
      cast,
      videos: videos.length > 0 ? videos : undefined,
      links: allPageLinks.length > 0 ? allPageLinks : undefined,
    };
  } catch (e) {
    logger.error({ err: e, pageUrl: absoluteUrl }, "HDHub4U: getMeta error");
    return null;
  }
}

// Keywords that indicate a candidate is a TV series / multi-episode release
const SERIES_INDICATORS = /\b(season|series|complete|episode|s\d{2}e\d{2}|s\d{2}\b|web.?series|hindi dubbed series)\b/i;

function scoreCandidateForMeta(
  candidateName: string,
  meta: ResolvedMeta,
  season: number,
): number {
  const isSeries = meta.type === "series";
  const nc = normalizeTitle(candidateName);

  let titleScore = titleSimilarity(meta.title, candidateName);
  for (const alias of meta.aliases) {
    const aliasScore = titleSimilarity(alias, candidateName);
    if (aliasScore > titleScore) titleScore = aliasScore;
  }

  if (titleScore < 0.2) {
    logger.debug({ candidateName, titleScore }, "HDHub4U: candidate rejected (low title score)");
    return 0;
  }

  // When searching for a MOVIE, outright reject any candidate that has series/season
  // indicators — e.g. searching "Obsession" (movie) must not match "Obsession Season 1"
  if (!isSeries && SERIES_INDICATORS.test(candidateName)) {
    logger.debug({ candidateName }, "HDHub4U: movie search, candidate has series indicators — rejecting");
    return 0;
  }

  let seasonBonus = 0;
  if (isSeries && season > 0) {
    const hasSeason = new RegExp(`season\\s*0*${season}\\b`, "i").test(nc);
    const hasAnyOtherSeason = /season\s*\d+/i.test(nc) && !hasSeason;
    const looksLikeSeries = SERIES_INDICATORS.test(candidateName);

    if (hasSeason) {
      // Candidate explicitly names the right season — strong positive signal
      seasonBonus = 0.35;
    } else if (!looksLikeSeries) {
      // No series indicators at all — this is a movie, not a series result.
      // Reject it outright regardless of title similarity: a movie named after
      // a series character (e.g. "Crayon Shinchan Our Dinosaur Diary 2024")
      // should NEVER match a series search, even with a high title score.
      logger.debug({ candidateName }, "HDHub4U: candidate rejected (series search, no series indicators — looks like a movie)");
      return 0;
    } else if (looksLikeSeries && !hasAnyOtherSeason) {
      // Has series indicators but no season number — mild positive (e.g. "Complete Series")
      seasonBonus = 0.05;
    } else if (hasAnyOtherSeason) {
      // Wrong season number — strong negative
      seasonBonus = -0.5;
    }
  }

  let yearBonus = 0;
  if (meta.year) {
    const yearMatch = /\b(19|20)\d{2}\b/.exec(candidateName);
    if (yearMatch) {
      const diff = Math.abs(parseInt(yearMatch[0]) - meta.year);
      if (diff === 0) yearBonus = 0.15;
      else if (diff === 1) yearBonus = 0.05;
      else if (diff > 3) yearBonus = -0.15;
    }
  }

  const total = titleScore + (isSeries ? seasonBonus : 0) + yearBonus;
  logger.debug({ candidateName, titleScore, seasonBonus, yearBonus, total }, "HDHub4U: candidate score");
  return Math.min(1.0, Math.max(0, total));
}

// Shared helper: collect and score all candidates from Typesense + sitemap.
// Returns candidates sorted by score descending, filtered by minimum threshold.
async function gatherCandidates(
  meta: ResolvedMeta,
  season: number,
): Promise<Array<{ item: CatalogItem; score: number }>> {
  const isSeries = meta.type === "series";

  const queries: string[] = [];
  if (isSeries && season > 0) {
    queries.push(`${meta.title} Season ${season}`);
    queries.push(`${meta.title} S${String(season).padStart(2, "0")}`);
    for (const alias of meta.aliases.slice(0, 2)) {
      queries.push(`${alias} Season ${season}`);
    }
  }
  queries.push(meta.title);
  if (meta.year) queries.push(`${meta.title} ${meta.year}`);
  for (const alias of meta.aliases.slice(0, 3)) {
    queries.push(alias);
  }
  const stripped = meta.title.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (stripped && stripped !== meta.title) queries.push(stripped);
  const words = meta.title.split(/\s+/);
  if (words.length > 3) queries.push(words.slice(0, 2).join(" "));

  const seen = new Set<string>();
  const uniqueQueries = queries.filter((q) => {
    if (seen.has(q)) return false;
    seen.add(q);
    return true;
  });

  const seenIds = new Set<string>();
  const candidates: Array<{ item: CatalogItem; score: number }> = [];

  for (const query of uniqueQueries.slice(0, 6)) {
    let results: CatalogItem[];
    try {
      results = await searchContent(query, 1);
    } catch {
      continue;
    }
    for (const item of results) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      const score = scoreCandidateForMeta(item.name, meta, season);
      if (score > 0) candidates.push({ item, score });
    }
    if (candidates.some((c) => c.score >= 0.8)) break;
  }

  // Sitemap fallback when Typesense returns nothing
  if (!candidates.length) {
    logger.info({ imdbId: meta.imdbId, title: meta.title }, "HDHub4U: Typesense empty, trying sitemap fallback");
    const sitemapQueries = [meta.title, ...meta.aliases.slice(0, 2)];
    for (const query of sitemapQueries) {
      const results = await searchContentViaSitemap(query, meta);
      for (const item of results) {
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        const score = scoreCandidateForMeta(item.name, meta, season);
        if (score > 0) candidates.push({ item, score });
      }
      if (candidates.some((c) => c.score >= 0.8)) break;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.filter((c) => c.score >= 0.42);
}

// Exported: returns sorted page URLs for all good candidates (for stream retrying).
export async function findCandidatePageUrls(
  meta: ResolvedMeta,
  season: number,
): Promise<string[]> {
  const candidates = await gatherCandidates(meta, season);
  return candidates.map((c) => decodeId(c.item.id));
}

export async function findByMeta(
  meta: ResolvedMeta,
  season: number,
): Promise<MetaItem | null> {
  logger.info(
    { imdbId: meta.imdbId, title: meta.title, year: meta.year, type: meta.type, season },
    "HDHub4U: findByMeta start",
  );

  const candidates = await gatherCandidates(meta, season);

  if (!candidates.length) {
    logger.warn({ imdbId: meta.imdbId, title: meta.title }, "HDHub4U: no candidates found");
    return null;
  }

  const best = candidates[0]!;
  logger.info(
    { imdbId: meta.imdbId, candidateName: best.item.name, score: best.score },
    "HDHub4U: best candidate",
  );

  const pageUrl = decodeId(best.item.id);
  return getMeta(pageUrl);
}

const STREAM_DOMAINS =
  /hubcdn|hubdrive|hubcloud|hblinks|hdstream4u|hubstream|pixeldrain|streamtape|gadgetsweb|hbstream|techyboy4u|cryptoinsights|bloggingvector/i;
const QUALITY_TEXT = /480p?|720p?|1080p?|2160p?|4[Kk]|WATCH|STREAM/i;
// Skip same-domain links (hdhub4u.*) — they are movie-page links, not stream hosts.
// A "WATCH" button pointing back to hdhub4u.cl is not a downloadable stream.
const SKIP_HREFS = /catimages|hdhub4u\.|wp-content|javascript:|#$/;

function extractAllLinks($: cheerio.CheerioAPI): string[] {
  const links: string[] = [];

  $("h3 a, h4 a, h5 a, p a, div a")
    .toArray()
    .forEach((el) => {
      const href = ($(el).attr("href") ?? "").trim();
      if (!href || href.startsWith("#") || SKIP_HREFS.test(href)) return;
      const text = $(el).text().trim();
      if (STREAM_DOMAINS.test(href) || QUALITY_TEXT.test(text)) {
        links.push(href);
      }
    });

  return [...new Set(links)];
}

function extractEpisodeLinks($: cheerio.CheerioAPI): Record<number, string[]> {
  const epLinksMap: Record<number, string[]> = {};
  const episodeRegex = /EPi?SODE\s*[–\-—]?\s*(\d+)/i;

  let currentEpisode: number | null = null;

  $("h3, h4, h5").each((_, el) => {
    const element = $(el);
    const text = element.text().trim();

    const epNumMatch = episodeRegex.exec(text);
    if (epNumMatch) {
      currentEpisode = parseInt(epNumMatch[1]);
      element.find("a[href]").each((_, a) => {
        const href = ($(a).attr("href") ?? "").trim();
        if (!href || SKIP_HREFS.test(href)) return;
        if (STREAM_DOMAINS.test(href) || QUALITY_TEXT.test($(a).text())) {
          if (currentEpisode !== null) {
            if (!epLinksMap[currentEpisode]) epLinksMap[currentEpisode] = [];
            epLinksMap[currentEpisode].push(href);
          }
        }
      });
      return;
    }

    const links: string[] = [];
    element.find("a[href]").each((_, a) => {
      const href = ($(a).attr("href") ?? "").trim();
      if (!href || SKIP_HREFS.test(href)) return;
      const linkText = $(a).text().trim();
      if (STREAM_DOMAINS.test(href) || QUALITY_TEXT.test(linkText)) {
        links.push(href);
      }
    });

    if (links.length > 0) {
      const key = currentEpisode ?? -1;
      if (!epLinksMap[key]) epLinksMap[key] = [];
      epLinksMap[key].push(...links);
    }
  });

  return epLinksMap;
}

export async function getStreams(
  pageUrl: string,
  links: string[],
): Promise<Stream[]> {
  logger.info({ pageUrl, linkCount: links.length }, "HDHub4U: getting streams");
  const allStreams: Stream[] = [];

  const tasks = links.map(async (link) => {
    try {
      let finalLink = link;
      // Redirect-wrapper domains (techyboy4u, gadgetsweb, ?id= links, etc.) embed
      // the real CDN/HubCloud URL in multi-layer obfuscated JS. Decode first.
      if (link.includes("?id=") || REDIRECT_WRAPPERS.test(link)) {
        const resolved = await fetchRedirectLink(link);
        if (resolved && resolved !== link) {
          logger.info({ link, resolved }, "HDHub4U: redirect resolved");
          finalLink = resolved;
        }
      }
      return await extractStreams(finalLink);
    } catch (e) {
      logger.error({ err: e, link }, "HDHub4U: stream extraction failed");
      return [];
    }
  });

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "fulfilled") {
      allStreams.push(...result.value);
    }
  }

  return allStreams;
}

interface SearchResponse {
  hits: Array<{
    document: {
      id: string;
      permalink: string;
      post_title: string;
      post_thumbnail: string;
      category: string[];
    };
  }>;
}

interface TmdbFindResponse {
  movie_results?: Array<{ id: number; title?: string; name?: string }>;
  tv_results?: Array<{ id: number; title?: string; name?: string }>;
}

interface TmdbDetails {
  id: number;
  name?: string;
  title?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  backdrop_path?: string;
  genres?: Array<{ name: string }>;
  credits?: {
    cast?: Array<{ name: string; character?: string }>;
  };
  external_ids?: {
    imdb_id?: string;
  };
}

interface TmdbSeason {
  episodes?: Array<{
    episode_number: number;
    name: string;
    overview?: string;
    still_path?: string;
    air_date?: string;
    vote_average?: number;
  }>;
}
