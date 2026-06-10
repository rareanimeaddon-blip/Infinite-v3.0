/**
 * Minimal MPEG-TS PAT/PMT parser and audio PID packet filter.
 *
 * Used by the /as-audio-pl and /as-audio proxy endpoints to expose
 * muxed MPEG-TS audio tracks as separate HLS audio rendition playlists,
 * enabling LG TV's native HLS player to show an audio language selector.
 */

export const TS_PACKET_SIZE = 188;
const SYNC = 0x47;

export interface AudioTrack {
  pid: number;
  pmtPid: number;
  language: string;
  name: string;
}

export interface ProbeResult {
  tracks: AudioTrack[];
  pmtPid: number;
}

const LANG_NAMES: Record<string, string> = {
  hin: "Hindi",
  eng: "English",
  jpn: "Japanese",
  tel: "Telugu",
  tam: "Tamil",
  kan: "Kannada",
  mal: "Malayalam",
  ben: "Bengali",
  mar: "Marathi",
  urd: "Urdu",
  chi: "Chinese",
  kor: "Korean",
  ara: "Arabic",
  fre: "French",
  spa: "Spanish",
  por: "Portuguese",
  ger: "German",
  ita: "Italian",
  rus: "Russian",
  dut: "Dutch",
};

const AUDIO_STREAM_TYPES = new Set([
  0x03, // ISO/IEC 11172-3 MPEG-1 Audio
  0x04, // ISO/IEC 13818-3 MPEG-2 Audio
  0x0f, // ISO/IEC 13818-7 AAC
  0x11, // ISO/IEC 14496-3 HE-AAC
  0x81, // AC-3 (Dolby Digital)
  0x82, // DTS
  0x83, // Dolby TrueHD
  0x84, // Dolby Digital Plus
  0x87, // Dolby Digital Plus (atsc)
]);

function adaptationPayloadStart(buf: Buffer, pktOff: number): number {
  const adaptCtrl = (buf[pktOff + 3]! >> 4) & 0x03;
  if (adaptCtrl === 0x01) return pktOff + 4;
  if (adaptCtrl === 0x02) return pktOff + TS_PACKET_SIZE; // adaptation only, no payload
  if (adaptCtrl === 0x03) return pktOff + 4 + 1 + buf[pktOff + 4]!;
  return pktOff + 4;
}

function hasPUSI(buf: Buffer, pktOff: number): boolean {
  return !!(buf[pktOff + 1]! & 0x40);
}

function readPid(buf: Buffer, pktOff: number): number {
  return ((buf[pktOff + 1]! & 0x1f) << 8) | buf[pktOff + 2]!;
}

function parsePAT(buf: Buffer, pktOff: number): number | null {
  try {
    const payStart = adaptationPayloadStart(buf, pktOff);
    if (payStart >= pktOff + TS_PACKET_SIZE) return null;

    let pos = payStart;
    if (hasPUSI(buf, pktOff)) pos += 1 + buf[pos]!;
    if (pos + 8 >= pktOff + TS_PACKET_SIZE) return null;

    if (buf[pos] !== 0x00) return null;
    const secLen = ((buf[pos + 1]! & 0x0f) << 8) | buf[pos + 2]!;
    const contentEnd = Math.min(pos + 3 + secLen - 4, pktOff + TS_PACKET_SIZE - 4);
    pos += 8;

    while (pos + 4 <= contentEnd) {
      const progNum = (buf[pos]! << 8) | buf[pos + 1]!;
      const pid = ((buf[pos + 2]! & 0x1f) << 8) | buf[pos + 3]!;
      if (progNum !== 0) return pid;
      pos += 4;
    }
  } catch { /* bounds error */ }
  return null;
}

function parsePMT(buf: Buffer, pktOff: number, pmtPid: number): AudioTrack[] {
  const tracks: AudioTrack[] = [];
  try {
    const payStart = adaptationPayloadStart(buf, pktOff);
    if (payStart >= pktOff + TS_PACKET_SIZE) return tracks;

    let pos = payStart;
    if (hasPUSI(buf, pktOff)) pos += 1 + buf[pos]!;
    if (pos + 12 >= pktOff + TS_PACKET_SIZE) return tracks;

    if (buf[pos] !== 0x02) return tracks;
    const secLen = ((buf[pos + 1]! & 0x0f) << 8) | buf[pos + 2]!;
    const contentEnd = Math.min(pos + 3 + secLen - 4, pktOff + TS_PACKET_SIZE - 4);

    const progInfoLen = ((buf[pos + 10]! & 0x0f) << 8) | buf[pos + 11]!;
    pos += 12 + progInfoLen;

    while (pos + 5 <= contentEnd) {
      const streamType = buf[pos]!;
      const esPid = ((buf[pos + 1]! & 0x1f) << 8) | buf[pos + 2]!;
      const esInfoLen = ((buf[pos + 3]! & 0x0f) << 8) | buf[pos + 4]!;
      pos += 5;

      if (AUDIO_STREAM_TYPES.has(streamType)) {
        let lang = "";
        let dp = pos;
        while (dp + 2 <= pos + esInfoLen && dp + 2 <= pktOff + TS_PACKET_SIZE) {
          const tag = buf[dp]!;
          const dlen = buf[dp + 1]!;
          if (tag === 0x0a && dlen >= 3 && dp + 5 <= pktOff + TS_PACKET_SIZE) {
            lang = String.fromCharCode(buf[dp + 2]!, buf[dp + 3]!, buf[dp + 4]!)
              .toLowerCase()
              .replace(/[^a-z]/g, "");
          }
          dp += 2 + dlen;
        }
        const name = LANG_NAMES[lang] ?? (lang ? lang.toUpperCase() : `Audio ${tracks.length + 1}`);
        tracks.push({ pid: esPid, pmtPid, language: lang, name });
      }
      pos += esInfoLen;
    }
  } catch { /* bounds error */ }
  return tracks;
}

/**
 * Scan up to `maxPackets` TS packets in `buf` to find PAT and PMT,
 * then return all detected audio elementary streams.
 */
export function probeAudioTracks(buf: Buffer, maxPackets = 40): ProbeResult {
  const limit = Math.min(buf.length, maxPackets * TS_PACKET_SIZE);
  let pmtPid: number | null = null;

  for (let i = 0; i + TS_PACKET_SIZE <= limit; i += TS_PACKET_SIZE) {
    if (buf[i] !== SYNC) continue;
    if (readPid(buf, i) === 0 && hasPUSI(buf, i)) {
      pmtPid = parsePAT(buf, i);
      if (pmtPid !== null) break;
    }
  }

  if (pmtPid === null) return { tracks: [], pmtPid: -1 };

  for (let i = 0; i + TS_PACKET_SIZE <= limit; i += TS_PACKET_SIZE) {
    if (buf[i] !== SYNC) continue;
    if (readPid(buf, i) === pmtPid && hasPUSI(buf, i)) {
      const tracks = parsePMT(buf, i, pmtPid);
      if (tracks.length > 0) return { tracks, pmtPid };
    }
  }

  return { tracks: [], pmtPid };
}

/**
 * Filter an MPEG-TS buffer to keep only:
 *   - PAT packets (PID 0) — program association table
 *   - PMT packets (pmtPid) — program map table
 *   - Packets for the selected audioPid
 *
 * All other PID packets are dropped. Continuity counters for the
 * kept PIDs remain intact because we keep ALL their packets.
 *
 * Returns a new Buffer containing only the kept packets.
 */
export function filterAudioPid(
  buf: Buffer,
  audioPid: number,
  pmtPid: number,
): Buffer {
  const chunks: Buffer[] = [];

  for (let i = 0; i + TS_PACKET_SIZE <= buf.length; i += TS_PACKET_SIZE) {
    if (buf[i] !== SYNC) continue;
    const pid = readPid(buf, i);
    if (pid === 0 || pid === pmtPid || pid === audioPid) {
      chunks.push(buf.subarray(i, i + TS_PACKET_SIZE));
    }
  }

  return chunks.length === 0 ? buf : Buffer.concat(chunks);
}
