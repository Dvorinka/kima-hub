/**
 * SpotiFLAC Download Service — Zero Configuration
 * Faithful TS port of Go SpotiFLAC. NO user setup, NO API keys, NO env vars.
 */
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { getSystemSettings } from "../utils/systemSettings";
import { eventBus } from "./eventBus";
import axios from "axios";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";

// ── CONSTANTS (hardcoded from Go impl) ──
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const SPOTIFY_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const TOTP_SECRET = "GM3TMMJTGYZTQNZVGM4DINJZHA4TGOBYGMZTCMRTGEYDSMJRHE4TEOBUG4YTCMRUGQ4DQOJUGQYTAMRRGA2TCMJSHE3TCMBY";
const TOTP_VER = 61;
const SPOTIFY_TOKEN_URL = "https://open.spotify.com/api/token";
const SPOTIFY_PARTNER_URL = "https://api-partner.spotify.com/pathfinder/v2/query";
const SPOTIFY_CLIENT_TOKEN_URL = "https://clienttoken.spotify.com/v1/clienttoken";
const QOBUZ_API_BASE = "https://www.qobuz.com/api.json/0.2";
const QOBUZ_APP_ID = "712109809";
const QOBUZ_APP_SECRET = "589be88e4538daea11f509d29e4a23b1";
const MUSICDL_URL = "https://www.musicdl.me/api/qobuz/download";
const STREAM_APIS = ["https://dab.yeet.su/api/stream?trackId=", "https://dabmusic.xyz/api/stream?trackId="];
const AMAZON_API_BASE = "https://amazon.spotbye.qzz.io";
const TIDAL_GIST_URL = "https://gist.githubusercontent.com/afkarxyz/2ce772b943321b9448b454f39403ce25/raw";
const TIDAL_API_FALLBACKS = [
    "https://api.tidal.com/v1",
    "https://tidal.com/browse/album",
    "https://dab.yeet.su/api/tidal",
    "https://dabmusic.xyz/api/tidal",
];
const SONGLINK_API = "https://api.song.link/v1-alpha.1/links";
const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ISRC_RE = /\b([A-Z]{2}[A-Z0-9]{3}\d{7})\b/;
const MUSICDL_SEED = [Buffer.from([0x73,0x70,0x6f,0x74,0x69,0x66]), Buffer.from([0x6c,0x61,0x63,0x3a,0x71,0x6f]), Buffer.from([0x62,0x75,0x7a,0x3a,0x6d,0x75,0x73,0x69,0x63,0x64,0x6c,0x3a,0x76,0x31])];
const MUSICDL_AAD = Buffer.from([0x71,0x6f,0x62,0x75,0x7a,0x7c,0x6d,0x75,0x73,0x69,0x63,0x64,0x6c,0x7c,0x64,0x65,0x62,0x75,0x67,0x7c,0x76,0x31]);
const MUSICDL_NONCE = Buffer.from([0x91,0x2a,0x5c,0x77,0x0f,0x33,0xa8,0x14,0x62,0x9d,0xce,0x41]);
const MUSICDL_CT = Buffer.from([0xf3,0x4a,0x83,0x45,0x24,0xb6,0x22,0xaf,0xd6,0xc3,0x6e,0x2d,0x56,0xd1,0xbb,0x0b,0xe9,0x1b,0x4f,0x1c,0x5f,0x41,0x55,0xc2,0xc6,0xdf,0xad,0x21,0x58,0xfe,0xd5,0xb8,0x2d,0x29,0xf9,0x9e,0x6f,0xd6]);
const MUSICDL_TAG = Buffer.from([0x69,0x0c,0x42,0x70,0x14,0x83,0xff,0x14,0xc8,0xbe,0x17,0x00,0x69,0xb1,0xfe,0xbb]);
const AMAZON_SEED = [Buffer.from([0x73,0x70,0x6f,0x74,0x69,0x66]), Buffer.from([0x6c,0x61,0x63,0x3a,0x61,0x6d]), Buffer.from([0x61,0x7a,0x6f,0x6e,0x3a,0x73,0x70,0x6f,0x74,0x62,0x79,0x65,0x3a,0x61,0x70,0x69,0x3a,0x76,0x31])];
const AMAZON_AAD = Buffer.from([0x61,0x6d,0x61,0x7a,0x6f,0x6e,0x7c,0x73,0x70,0x6f,0x74,0x62,0x79,0x65,0x7c,0x64,0x65,0x62,0x75,0x67,0x7c,0x76,0x31]);
const AMAZON_NONCE = Buffer.from([0x52,0x1f,0xa4,0x9c,0x13,0x77,0x5b,0xe2,0x81,0x44,0x90,0x6d]);
const AMAZON_CT = Buffer.from([0x5b,0xf9,0xc1,0x2e,0x58,0xf8,0x5b,0xc0,0x04,0x68,0x7e,0xff,0x3d,0xd6,0x8b,0xe3,0x86,0x49,0x6c,0xfd,0xc1,0x49,0x0b,0xfb]);
const AMAZON_TAG = Buffer.from([0x6c,0x21,0x98,0x51,0xf2,0x38,0x4b,0x4a,0x23,0xe1,0xc6,0xd7,0x65,0x7f,0xfb,0xa1]);

// ── TYPES ──
interface ResolvedLinks { tidalURL: string; amazonURL: string; deezerURL: string; isrc: string; }
interface QobuzCreds { appId: string; appSecret: string; source: string; fetchedAt: number; }
interface BatchResult { total: number; successful: number; failed: number; errors: string[]; outputDir: string; }
interface DLOptions { outputDir?: string; quality?: string; preferSource?: string; jobId?: string; maxAlbums?: number; }

// ── SPOTIFY TOTP (spotify_totp.go) ──
function b32decode(s: string): Buffer {
    const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const buf: number[] = []; let bits = 0, acc = 0;
    for (const c of s.replace(/=+$/, "")) {
        const v = alpha.indexOf(c.toUpperCase()); if (v < 0) continue;
        acc = (acc << 5) | v; bits += 5;
        if (bits >= 8) { bits -= 8; buf.push((acc >> bits) & 0xff); }
    }
    return Buffer.from(buf);
}

function genTOTP(): { code: string; version: number } {
    const key = b32decode(TOTP_SECRET);
    const step = Math.floor(Math.floor(Date.now() / 1000) / 30);
    const tBuf = Buffer.alloc(8); tBuf.writeUInt32BE(0, 0); tBuf.writeUInt32BE(step, 4);
    const hmac = crypto.createHmac("sha1", key).update(tBuf).digest();
    const off = hmac[hmac.length - 1] & 0x0f;
    const code = (((hmac[off] & 0x7f) << 24) | ((hmac[off+1] & 0xff) << 16) | ((hmac[off+2] & 0xff) << 8) | (hmac[off+3] & 0xff)) % 1000000;
    return { code: code.toString().padStart(6, "0"), version: TOTP_VER };
}

// ── SPOTIFY CLIENT (spotfetch.go) ──
class SpotifyClient {
    private at = ""; private ct = ""; private cid = ""; private did = ""; private cv = "";
    private cookies: Record<string, string> = {}; private atExpiry = 0;
    private anonToken = ""; private anonExpiry = 0;

    async init() { await this.session(); await this.accessToken(); await this.clientToken(); }

    private async session() {
        const r = await axios.get("https://open.spotify.com", { headers: { "User-Agent": SPOTIFY_UA }, validateStatus: () => true });
        if (r.status !== 200) throw new Error(`Spotify session failed: ${r.status}`);
        const m = r.data?.toString?.().match(/<script id="appServerConfig" type="text\/plain">([^<]+)<\/script>/);
        if (m?.[1]) { try { this.cv = JSON.parse(Buffer.from(m[1], "base64").toString()).clientVersion || ""; } catch {} }
        this.collectCookies(r);
    }

    private async accessToken() {
        const { code, version } = genTOTP();
        const p = new URLSearchParams({ reason:"init", productType:"web-player", totp:code, totpVer:String(version), totpServer:code });
        const ck = Object.entries(this.cookies).map(([k,v])=>`${k}=${v}`).join("; ");
        const r = await axios.get(`${SPOTIFY_TOKEN_URL}?${p}`, { headers: { "User-Agent": SPOTIFY_UA, Cookie: ck }, validateStatus: () => true });
        if (r.status !== 200) throw new Error(`Spotify token failed: ${r.status}`);
        this.at = r.data.accessToken || ""; this.cid = r.data.clientId || "";
        this.atExpiry = r.data.accessTokenExpirationTimestampMs || 0;
        this.collectCookies(r);
    }

    private async clientToken() {
        if (!this.cid || !this.did || !this.cv) { await this.session(); await this.accessToken(); }
        const r = await axios.post(SPOTIFY_CLIENT_TOKEN_URL, {
            client_data: { client_version: this.cv, client_id: this.cid, js_sdk_data: { device_brand:"unknown", device_model:"unknown", os:"windows", os_version:"NT 10.0", device_id:this.did, device_type:"computer" } }
        }, { headers: { Authority:"clienttoken.spotify.com", "Content-Type":"application/json", Accept:"application/json", "User-Agent": SPOTIFY_UA }, validateStatus: () => true });
        if (r.status !== 200) throw new Error(`Spotify client token failed: ${r.status}`);
        if (r.data.response_type !== "RESPONSE_GRANTED_TOKEN_RESPONSE") throw new Error("Bad client token response");
        this.ct = r.data.granted_token?.token || "";
    }

    async query(payload: any): Promise<any> {
        if (!this.at || !this.ct || this.isExpired()) await this.init();
        const r = await axios.post(SPOTIFY_PARTNER_URL, payload, {
            headers: { Authorization:`Bearer ${this.at}`, "Client-Token":this.ct, "Spotify-App-Version":this.cv, "Content-Type":"application/json", "User-Agent": SPOTIFY_UA },
            validateStatus: () => true,
        });
        if (r.status !== 200) throw new Error(`Spotify query failed: ${r.status}`);
        return r.data;
    }

    async getAnonToken(): Promise<string> {
        if (this.anonToken && Date.now() < this.anonExpiry - 30000) return this.anonToken;
        // Need session cookies to avoid 403 URL Blocked
        if (!this.cookies?.sp_t) await this.session();
        const { code, version } = genTOTP();
        const p = new URLSearchParams({ reason:"init", productType:"web-player", totp:code, totpServer:code, totpVer:String(version) });
        const ck = Object.entries(this.cookies).map(([k,v])=>`${k}=${v}`).join("; ");
        const r = await axios.get(`${SPOTIFY_TOKEN_URL}?${p}`, { headers: { "User-Agent": SPOTIFY_UA, Cookie: ck }, validateStatus: () => true });
        if (r.status !== 200) throw new Error(`Anon token failed: ${r.status}`);
        this.anonToken = r.data.accessToken || ""; this.anonExpiry = r.data.accessTokenExpirationTimestampMs || 0;
        this.collectCookies(r);
        return this.anonToken;
    }

    private isExpired() { return this.atExpiry > 0 && Date.now() > this.atExpiry - 30000; }
    private collectCookies(r: any) {
        const sc = r.headers?.["set-cookie"] as string[] | undefined;
        if (!sc) return;
        for (const c of sc) { const [nv] = c.split(";"); const [n,v] = nv.split("="); if (n&&v) { this.cookies[n.trim()]=v.trim(); if (n.trim()==="sp_t") this.did=v.trim(); } }
    }
}

// ── ISRC FINDER (isrc_finder.go) ──
function idToGID(id: string): string {
    let v = BigInt(0); const b = BigInt(62);
    for (const c of id) { const i = BASE62.indexOf(c); if (i < 0) throw new Error(`Invalid base62: ${c}`); v = v * b + BigInt(i); }
    let h = v.toString(16); while (h.length < 32) h = "0" + h; return h;
}

async function fetchRawMeta(client: SpotifyClient, type: string, id: string): Promise<any> {
    const gid = idToGID(id); const at = await client.getAnonToken();
    const r = await axios.get(`https://spclient.wg.spotify.com/metadata/4/${type}/${gid}?market=from_token`, {
        headers: { authorization:`Bearer ${at}`, accept:"application/json", "user-agent": SPOTIFY_UA }, validateStatus: () => true,
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`Meta fetch failed: ${r.status}`);
    return r.data;
}

function extractISRC(p: any): string {
    if (Array.isArray(p?.external_id)) for (const e of p.external_id) if (e.type?.toLowerCase()==="isrc") { const m = (e.id||"").toUpperCase().match(ISRC_RE); if (m) return m[1]; }
    const m = JSON.stringify(p).toUpperCase().match(ISRC_RE); return m?.[1] || "";
}

function extractUPC(p: any): string {
    if (Array.isArray(p?.external_id)) for (const e of p.external_id) if (e.type?.toLowerCase()==="upc") { const u = (e.id||"").trim(); if (u) return u; }
    return "";
}

async function getTrackIDs(client: SpotifyClient, trackId: string): Promise<{isrc:string;upc:string}> {
    const r = { isrc: "", upc: "" };
    try {
        const t = await fetchRawMeta(client, "track", trackId);
        r.isrc = extractISRC(t);
        const agid = t?.album?.gid;
        if (agid) { try { const a = await fetchRawMeta(client, "album", agid); r.upc = extractUPC(a); } catch {} }
    } catch (e: any) { logger.debug(`[SpotiFLAC] ISRC lookup: ${e.message}`); }
    return r;
}

function parseSpotifyId(input: string, expectedType?: string): {type:string;id:string}|null {
    input = input.trim();
    let m = input.match(/open\.spotify\.com\/(?:embed\/)?(track|album|artist|playlist)\/([a-zA-Z0-9]+)/);
    if (m) return { type: m[1], id: m[2] };
    m = input.match(/spotify:(track|album|artist|playlist):([a-zA-Z0-9]+)/);
    if (m) return { type: m[1], id: m[2] };
    if (/^[a-zA-Z0-9]{22}$/.test(input) && expectedType) return { type: expectedType, id: input };
    return null;
}

// ── SONGLINK CLIENT (songlink.go + link_resolver.go + songstats.go) ──
class SongLinkClient {
    async resolveLinks(trackId: string, region = ""): Promise<ResolvedLinks> {
        const links: ResolvedLinks = { tidalURL: "", amazonURL: "", deezerURL: "", isrc: "" };
        const ids = await getTrackIDs(spotifyClient, trackId);
        if (ids.isrc) links.isrc = ids.isrc;

        if (links.isrc) {
            try { await this.songstats(links); } catch {}
            if (!links.tidalURL || !links.amazonURL) try { await this.deezerSongLink(links, region); } catch {}
            if (links.tidalURL && links.amazonURL) return links;
        }
        if (!links.tidalURL && !links.amazonURL && !links.deezerURL) {
            try { await this.songLinkDirect(trackId, links); } catch {}
        }
        if (links.tidalURL || links.amazonURL || links.deezerURL) return links;
        throw new Error("No streaming URLs found");
    }

    private async songstats(links: ResolvedLinks) {
        if (!links.isrc) return false;
        const r = await axios.get(`https://songstats.com/${links.isrc.toUpperCase()}?ref=ISRCFinder`, { headers:{"User-Agent":SPOTIFY_UA}, timeout:15000, validateStatus:()=>true });
        if (r.status !== 200) throw new Error(`Songstats ${r.status}`);
        const html = typeof r.data==="string"?r.data:JSON.stringify(r.data);
        const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis;
        let m; while ((m = re.exec(html)) !== null) { try { this.collectLinks(JSON.parse(m[1]), links); } catch {} }
        return true;
    }

    private collectLinks(v: any, l: ResolvedLinks) {
        if (typeof v !== "object" || !v) return;
        if (v.sameAs) this.applySameAs(v.sameAs, l);
        for (const k of Object.keys(v)) { if (k !== "sameAs") this.collectLinks(v[k], l); }
    }

    private applySameAs(v: any, l: ResolvedLinks) {
        if (typeof v === "string") this.assignLink(v, l);
        else if (Array.isArray(v)) for (const i of v) if (typeof i === "string") this.assignLink(i, l);
    }

    private assignLink(link: string, l: ResolvedLinks) {
        link = link.trim(); if (!link) return;
        if (link.includes("listen.tidal.com/track") && !l.tidalURL) l.tidalURL = link;
        else if (link.includes("deezer.com") && !l.deezerURL) l.deezerURL = this.normDeezer(link);
    }

    private async deezerSongLink(links: ResolvedLinks, region: string) {
        if (!links.isrc) return;
        if (!links.deezerURL) { try { const u = await this.deezerISRC(links.isrc); links.deezerURL = u; } catch {} }
        if (links.deezerURL) await this.songLinkByURL(links.deezerURL, region, links);
    }

    private async deezerISRC(isrc: string): Promise<string> {
        const r = await axios.get(`https://api.deezer.com/track/isrc:${isrc.toUpperCase().trim()}`, { headers:{"User-Agent":SPOTIFY_UA}, timeout:10000, validateStatus:()=>true });
        if (r.status !== 200) throw new Error(`Deezer ${r.status}`);
        if (r.data.link) return this.normDeezer(r.data.link);
        if (r.data.id) return `https://www.deezer.com/track/${r.data.id}`;
        throw new Error("Deezer not found");
    }

    private async songLinkByURL(url: string, region: string, links: ResolvedLinks) {
        const api = `${SONGLINK_API}?url=${encodeURIComponent(url)}${region?`&userCountry=${encodeURIComponent(region)}`:""}`;
        const r = await axios.get(api, { headers:{"User-Agent":SPOTIFY_UA}, timeout:30000, validateStatus:()=>true });
        if (r.status !== 200) throw new Error(`song.link ${r.status}`);
        const d = r.data?.linksByPlatform;
        if (d?.tidal?.url && !links.tidalURL) links.tidalURL = d.tidal.url.trim();
        if (d?.deezer?.url && !links.deezerURL) links.deezerURL = this.normDeezer(d.deezer.url);
    }

    private async songLinkDirect(trackId: string, links: ResolvedLinks) {
        await this.songLinkByURL(`https://open.spotify.com/track/${trackId}`, "", links);
    }

    private normDeezer(u: string): string { const m = u.match(/\/track\/(\d+)/); return m ? `https://www.deezer.com/track/${m[1]}` : u.trim(); }
}

// ── QOBUZ DOWNLOADER (qobuz.go + qobuz_api.go) ──
class QobuzDownloader {
    private creds: QobuzCreds | null = null; private credsExpiry = 0; private debugKey = "";

    async getCreds(force = false): Promise<QobuzCreds> {
        if (!force && this.creds && Date.now() < this.credsExpiry) return this.creds;
        try {
            const scraped = await this.scrapeCreds();
            if (scraped && await this.validCreds(scraped)) {
                this.creds = scraped; this.credsExpiry = Date.now() + 86400000;
                logger.debug(`[SpotiFLAC/Qobuz] Scraped creds app_id=${scraped.appId}`);
                return scraped;
            }
        } catch (e: any) { logger.debug(`[SpotiFLAC/Qobuz] Scrape failed: ${e.message}`); }
        const fb: QobuzCreds = { appId: QOBUZ_APP_ID, appSecret: QOBUZ_APP_SECRET, source: "embedded-default", fetchedAt: Date.now() };
        if (this.creds) return this.creds;
        this.creds = fb; return fb;
    }

    private async scrapeCreds(): Promise<QobuzCreds | null> {
        const r1 = await axios.get("https://open.qobuz.com/track/1", { headers:{"User-Agent":UA}, timeout:30000, validateStatus:()=>true });
        if (r1.status !== 200) return null;
        const html = typeof r1.data==="string"?r1.data:JSON.stringify(r1.data);
        const sm = html.match(/<script[^>]+src="([^"]+\/js\/main\.js|\/resources\/[^"]+\/js\/main\.js)"/);
        if (!sm?.[1]) return null;
        let burl = sm[1].trim(); if (burl.startsWith("/")) burl = `https://open.qobuz.com${burl}`;
        const r2 = await axios.get(burl, { headers:{"User-Agent":UA}, timeout:30000, validateStatus:()=>true });
        if (r2.status !== 200) return null;
        const body = typeof r2.data==="string"?r2.data:JSON.stringify(r2.data);
        const cm = body.match(/app_id:"(\d{9})",app_secret:"([a-f0-9]{32})"/);
        if (!cm?.[1] || !cm?.[2]) return null;
        return { appId: cm[1].trim(), appSecret: cm[2].trim(), source: burl, fetchedAt: Date.now() };
    }

    private async validCreds(c: QobuzCreds): Promise<boolean> {
        try { const r = await this.signedReq("track/search", { query:"USUM71703861", limit:"1" }, c); return r?.tracks?.total > 0; } catch { return false; }
    }

    async signedReq(apiPath: string, params: Record<string,string>, creds?: QobuzCreds): Promise<any> {
        if (!creds) creds = await this.getCreds();
        const np = apiPath.replace(/^\/+|\/+$/g, "");
        const ts = Math.floor(Date.now()/1000).toString();
        const keys = Object.keys(params).filter(k=>k!=="app_id"&&k!=="request_ts"&&k!=="request_sig").sort();
        let sig = np.replace(/\//g,""); for (const k of keys) sig += k + params[k]; sig += ts + creds.appSecret;
        const sigHash = crypto.createHash("md5").update(sig).digest("hex");
        const all = { ...params, app_id: creds.appId, request_ts: ts, request_sig: sigHash };
        const url = `${QOBUZ_API_BASE}/${np}?${new URLSearchParams(all)}`;
        const r = await axios.get(url, { headers:{"User-Agent":UA, Accept:"application/json", "X-App-Id":creds.appId}, timeout:20000, validateStatus:()=>true });
        if (r.status === 400 || r.status === 401) { const fc = await this.getCreds(true); if (fc !== creds) return this.signedReq(apiPath, params, fc); }
        if (r.status !== 200) throw new Error(`Qobuz ${r.status}`);
        return r.data;
    }

    async searchISRC(isrc: string): Promise<{id:number;title:string}|null> {
        if (isrc.startsWith("qobuz_")) { const d = await this.signedReq("track/get", {track_id:isrc.slice(6)}); return d ? {id:d.id,title:d.title} : null; }
        const d = await this.signedReq("track/search", {query:isrc,limit:"1"});
        if (d?.tracks?.items?.length > 0) return { id: d.tracks.items[0].id, title: d.tracks.items[0].title };
        return null;
    }

    async getDLUrl(trackId: number, quality = "6", fallback = true): Promise<string> {
        const q = (!quality || quality==="5") ? "6" : quality;
        const tryDL = async (ql: string): Promise<string> => {
            try { return await this.musicDL(trackId, ql); } catch {}
            for (const api of STREAM_APIS) { try { return await this.streamAPI(api, trackId, ql); } catch {} }
            throw new Error("All Qobuz APIs failed");
        };
        try { return await tryDL(q); } catch {}
        if (q==="27" && fallback) try { return await tryDL("7"); } catch {}
        if ((q==="27"||q==="7") && fallback) try { return await tryDL("6"); } catch {}
        throw new Error("All Qobuz APIs and fallbacks failed");
    }

    private async musicDL(trackId: number, quality: string): Promise<string> {
        const dk = this.getDebugKey();
        const r = await axios.post(MUSICDL_URL, { url:`https://open.qobuz.com/track/${trackId}`, quality:quality.trim()||"6" }, {
            headers:{"User-Agent":UA, "Content-Type":"application/json", "X-Debug-Key":dk, Accept:"application/json, text/plain, */*"}, timeout:60000, validateStatus:()=>true,
        });
        if (r.status !== 200) throw new Error(`MusicDL ${r.status}`);
        if (!r.data.success) throw new Error(r.data.error || r.data.message || "MusicDL failed");
        const u = (r.data.download_url||"").trim(); if (!u) throw new Error("No download_url"); return u;
    }

    private async streamAPI(base: string, trackId: number, quality: string): Promise<string> {
        const r = await axios.get(`${base}${trackId}&quality=${quality}`, { headers:{"User-Agent":UA, Accept:"application/json, text/plain, */*"}, timeout:60000, validateStatus:()=>true });
        if (r.status !== 200) throw new Error(`Stream ${r.status}`);
        if (r.data?.url) return r.data.url; if (r.data?.data?.url) return r.data.data.url;
        throw new Error("Bad stream response");
    }

    private getDebugKey(): string {
        if (this.debugKey) return this.debugKey;
        const h = crypto.createHash("sha256"); for (const p of MUSICDL_SEED) h.update(p); const key = h.digest();
        const sealed = Buffer.concat([MUSICDL_CT, MUSICDL_TAG]);
        const d = crypto.createDecipheriv("aes-256-gcm", key, MUSICDL_NONCE); d.setAAD(MUSICDL_AAD);
        this.debugKey = Buffer.concat([d.update(sealed), d.final()]).toString("utf8"); return this.debugKey;
    }
}

// ── TIDAL DOWNLOADER (tidal.go + tidal_api_list.go) ──
class TidalDownloader {
    private urls: string[] = [];

    async getAPIs(): Promise<string[]> {
        if (this.urls.length > 0) return this.urls;
        try {
            const r = await axios.get(TIDAL_GIST_URL, { headers:{"User-Agent":UA, Accept:"application/json, text/plain, */*"}, timeout:12000, validateStatus:()=>true });
            if (r.status === 200 && Array.isArray(r.data)) {
                const u = [...new Set((r.data as string[]).map((x)=>(x||"").trim().replace(/\/+$/,"")).filter((x)=>x))];
                if (u.length > 0) { this.urls = u; return u; }
            }
        } catch (e: any) { logger.debug(`[SpotiFLAC/Tidal] Gist failed: ${e.message}`); }
        // Fallback to hardcoded APIs if gist fails
        logger.debug(`[SpotiFLAC/Tidal] Using fallback APIs`);
        this.urls = TIDAL_API_FALLBACKS;
        return TIDAL_API_FALLBACKS;
    }

    async getDLUrl(trackId: number, quality: string): Promise<string> {
        const apis = await this.getAPIs(); if (!apis.length) throw new Error("No Tidal APIs");
        for (const api of apis) {
            try {
                const r = await axios.get(`${api}/track/?id=${trackId}&quality=${quality}`, { headers:{"User-Agent":UA, Accept:"application/json, text/plain, */*"}, timeout:10000, validateStatus:()=>true });
                if (r.status !== 200) continue;
                if (r.data?.data?.manifest) return "MANIFEST:" + r.data.data.manifest;
                if (Array.isArray(r.data)) for (const i of r.data) if (i.OriginalTrackUrl) return i.OriginalTrackUrl;
                if (r.data?.OriginalTrackUrl) return r.data.OriginalTrackUrl;
            } catch {}
        }
        throw new Error("All Tidal APIs failed");
    }

    async trackIdFromURL(url: string): Promise<number> {
        const p = url.split("/track/"); if (p.length < 2) throw new Error("Bad Tidal URL");
        const id = parseInt(p[1].split("?")[0].trim(), 10); if (isNaN(id)) throw new Error("Bad Tidal ID"); return id;
    }
}

// ── AMAZON DOWNLOADER (amazon.go) ──
class AmazonDownloader {
    private debugKey = "";

    private getDebugKey(): string {
        if (this.debugKey) return this.debugKey;
        const h = crypto.createHash("sha256"); for (const p of AMAZON_SEED) h.update(p); const key = h.digest();
        const sealed = Buffer.concat([AMAZON_CT, AMAZON_TAG]);
        const d = crypto.createDecipheriv("aes-256-gcm", key, AMAZON_NONCE); d.setAAD(AMAZON_AAD);
        this.debugKey = Buffer.concat([d.update(sealed), d.final()]).toString("utf8"); return this.debugKey;
    }

    async getDLUrl(trackId: string, quality = "lossless"): Promise<string> {
        const dk = this.getDebugKey();
        const r = await axios.post(`${AMAZON_API_BASE}/stream`, { trackId, quality }, {
            headers:{"User-Agent":UA, "Content-Type":"application/json", "X-Debug-Key":dk, Accept:"application/json, text/plain, */*"}, timeout:60000, validateStatus:()=>true,
        });
        if (r.status !== 200) throw new Error(`Amazon ${r.status}`);
        if (!r.data?.streamUrl) throw new Error("No streamUrl from Amazon");
        return r.data.streamUrl;
    }

    async trackIdFromURL(url: string): Promise<string> {
        const m = url.match(/tracks\/([A-Z0-9]+)/); if (!m?.[1]) throw new Error("Bad Amazon URL");
        return m[1];
    }
}

// ── SINGLETONS ──
const spotifyClient = new SpotifyClient();
const songLinkClient = new SongLinkClient();
const qobuzDL = new QobuzDownloader();
const tidalDL = new TidalDownloader();
const amazonDL = new AmazonDownloader();

// ── FILE DOWNLOAD + METADATA ──
async function downloadFile(url: string, filePath: string): Promise<void> {
    if (url.startsWith("MANIFEST:")) { await downloadManifest(url.slice(9), filePath); return; }
    const r = await axios.get(url, { responseType: "arraybuffer", timeout: 300000, headers:{"User-Agent":UA}, validateStatus:()=>true });
    if (r.status !== 200) throw new Error(`Download HTTP ${r.status}`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, r.data);
}

async function downloadManifest(b64: string, filePath: string): Promise<void> {
    const decoded = JSON.parse(Buffer.from(b64, "base64").toString());
    const mimeType = decoded.mimeType || "";
    const urls = decoded.urls || [];

    if (decoded.encryptionType === "NOT_ENCRYPTED" && urls.length > 0) {
        const isFlac = mimeType.toLowerCase().includes("flac") || mimeType === "";
        if (isFlac) { await downloadFile(urls[0], filePath); return; }
    }

    // Fallback: try first URL
    if (urls.length > 0) { await downloadFile(urls[0], filePath); return; }
    throw new Error("No download URL in manifest");
}

async function embedMetadata(filePath: string, meta: { title:string; artist:string; album:string; albumArtist:string; isrc?:string; upc?:string; coverUrl?:string; trackNo?:number; discNo?:number; year?:string }) {
    const args = ["-y", "-i", filePath];
    if (meta.coverUrl) {
        try {
            const coverResp = await axios.get(meta.coverUrl, { responseType: "arraybuffer", timeout: 15000 });
            const coverPath = filePath + ".cover.jpg";
            await fs.writeFile(coverPath, coverResp.data);
            args.push("-i", coverPath, "-map", "0:a", "-map", "1:0", "-c:a", "copy", "-c:v", "copy");
        } catch { args.push("-c:a", "copy"); }
    } else { args.push("-c:a", "copy"); }

    args.push("-metadata", `title=${meta.title}`, "-metadata", `artist=${meta.artist}`, "-metadata", `album=${meta.album}`, "-metadata", `album_artist=${meta.albumArtist}`);
    if (meta.isrc) args.push("-metadata", `ISRC=${meta.isrc}`);
    if (meta.upc) args.push("-metadata", `BARCODE=${meta.upc}`);
    if (meta.trackNo) args.push("-metadata", `track=${meta.trackNo}`);
    if (meta.discNo) args.push("-metadata", `disc=${meta.discNo}`);
    if (meta.year) args.push("-metadata", `date=${meta.year}`);

    const tmpPath = filePath + ".tmp.flac";
    args.push(tmpPath);

    await new Promise<void>((resolve, reject) => {
        const proc = spawn("ffmpeg", args, { stdio: "pipe" });
        let errOut = "";
        proc.stderr.on("data", (d: Buffer) => { errOut += d.toString(); });
        proc.on("close", (code) => { if (code === 0) resolve(); else reject(new Error(`ffmpeg ${code}: ${errOut.slice(0,200)}`)); });
    });

    await fs.rename(tmpPath, filePath);
    try { await fs.unlink(filePath + ".cover.jpg"); } catch {}
}

function sanitize(name: string): string { return name.replace(/[<>:"/\\|?*]/g, "_").substring(0, 100); }

// ── CORE DOWNLOAD: SINGLE TRACK ──
async function downloadTrackById(spotifyTrackId: string, opts: DLOptions = {}): Promise<{success:boolean;filePath?:string;error?:string;isrc?:string}> {
    try {
        logger.debug(`[SpotiFLAC] Resolving track: ${spotifyTrackId}`);

        // 1. Get ISRC + identifiers from Spotify metadata
        const ids = await getTrackIDs(spotifyClient, spotifyTrackId);
        if (!ids.isrc) throw new Error("Could not extract ISRC from Spotify");

        // 2. Resolve links via SongLink/Songstats/Deezer
        const links = await songLinkClient.resolveLinks(spotifyTrackId);

        // 3. Try Qobuz first (via ISRC search)
        let downloadURL = "";
        let source = "";
        const quality = opts.quality || "6";

        if (!opts.preferSource || opts.preferSource === "auto" || opts.preferSource === "qobuz") {
            try {
                const qobuzTrack = await qobuzDL.searchISRC(ids.isrc);
                if (qobuzTrack) {
                    downloadURL = await qobuzDL.getDLUrl(qobuzTrack.id, quality);
                    source = "qobuz";
                    logger.debug(`[SpotiFLAC] Got Qobuz download URL for track ${qobuzTrack.id}`);
                }
            } catch (e: any) { logger.debug(`[SpotiFLAC] Qobuz failed: ${e.message}`); }
        }

        // 4. Try Tidal if Qobuz failed
        if (!downloadURL && (!opts.preferSource || opts.preferSource === "auto" || opts.preferSource === "tidal") && links.tidalURL) {
            try {
                const tidalTrackId = await tidalDL.trackIdFromURL(links.tidalURL);
                downloadURL = await tidalDL.getDLUrl(tidalTrackId, quality === "6" ? "LOSSLESS" : quality);
                source = "tidal";
                logger.debug(`[SpotiFLAC] Got Tidal download URL for track ${tidalTrackId}`);
            } catch (e: any) { logger.debug(`[SpotiFLAC] Tidal failed: ${e.message}`); }
        }

        // 5. Try Amazon if Qobuz/Tidal failed
        if (!downloadURL && (!opts.preferSource || opts.preferSource === "auto" || opts.preferSource === "amazon") && links.amazonURL) {
            try {
                const amazonTrackId = await amazonDL.trackIdFromURL(links.amazonURL);
                downloadURL = await amazonDL.getDLUrl(amazonTrackId, quality === "6" ? "lossless" : quality);
                source = "amazon";
                logger.debug(`[SpotiFLAC] Got Amazon download URL for track ${amazonTrackId}`);
            } catch (e: any) { logger.debug(`[SpotiFLAC] Amazon failed: ${e.message}`); }
        }

        if (!downloadURL) throw new Error("No download URL obtained from any source");

        // 5. Determine output path
        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath || "/music";
        const outputDir = opts.outputDir || musicPath;

        // Get track metadata for filename
        let trackName = spotifyTrackId;
        let artistName = "Unknown";
        let albumName = "Unknown";
        let coverUrl = "";

        try {
            const trackMeta = await fetchRawMeta(spotifyClient, "track", spotifyTrackId);
            trackName = trackMeta?.name || spotifyTrackId;
            const artists = trackMeta?.artists?.items || trackMeta?.firstArtist?.items || [];
            artistName = artists.map((a: any) => a.profile?.name || a.name || "").filter(Boolean).join("; ") || "Unknown";
            albumName = trackMeta?.album?.name || "Unknown";
            const sources = trackMeta?.visualIdentity?.sources || trackMeta?.album?.coverArt?.sources || [];
            coverUrl = sources.find((s: any) => s.width >= 300)?.url || sources[0]?.url || "";
        } catch {}

        const fileName = `${sanitize(artistName)} - ${sanitize(trackName)}.flac`;
        const filePath = path.join(outputDir, fileName);

        // 6. Download file
        logger.debug(`[SpotiFLAC] Downloading from ${source} to ${filePath}`);
        await downloadFile(downloadURL, filePath);

        // 7. Embed metadata
        try {
            await embedMetadata(filePath, {
                title: trackName, artist: artistName, album: albumName, albumArtist: artistName,
                isrc: ids.isrc, upc: ids.upc, coverUrl, trackNo: 1, year: "",
            });
        } catch (e: any) { logger.debug(`[SpotiFLAC] Metadata embed failed: ${e.message}`); }

        // 8. Update job if provided
        if (opts.jobId) {
            await prisma.downloadJob.update({ where: { id: opts.jobId }, data: { status: "completed", metadata: { source, isrc: ids.isrc, filePath } } }).catch(() => {});
        }

        logger.debug(`[SpotiFLAC] Track downloaded: ${filePath}`);
        return { success: true, filePath, isrc: ids.isrc };
    } catch (error: any) {
        logger.error(`[SpotiFLAC] Track download failed: ${error.message}`);
        if (opts.jobId) {
            await prisma.downloadJob.update({ where: { id: opts.jobId }, data: { status: "failed", metadata: { error: error.message } } }).catch(() => {});
        }
        return { success: false, error: error.message };
    }
}

// ── ALBUM DOWNLOAD ──
async function downloadAlbumById(spotifyAlbumId: string, opts: DLOptions = {}): Promise<BatchResult> {
    const result: BatchResult = { total: 0, successful: 0, failed: 0, errors: [], outputDir: opts.outputDir || "" };
    try {
        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath || "/music";

        // Get album metadata from Spotify partner API
        const payload = {
            operationName: "getAlbum",
            variables: { uri: `spotify:album:${spotifyAlbumId}` },
            extensions: { persistedQuery: { version: 1, sha256Hash: "0" } },
        };

        let albumData: any;
        try { albumData = await spotifyClient.query(payload); } catch { albumData = null; }

        const album = albumData?.data?.albumUnion || {};
        const albumName = album.name || "Unknown Album";
        const albumArtists = (album.artists?.items || []).map((a: any) => a.profile?.name || "").filter(Boolean);
        const artistName = albumArtists[0] || "Unknown Artist";
        const coverSources = album.coverArt?.sources || [];
        const coverUrl = coverSources.find((s: any) => s.width >= 640)?.url || coverSources[0]?.url || "";
        const releaseDate = album.date?.isoString?.split("T")[0] || "";

        const outputDir = opts.outputDir || path.join(musicPath, sanitize(artistName), sanitize(albumName));
        result.outputDir = outputDir;

        // Get track list
        const trackItems = album.tracks?.items || [];
        result.total = trackItems.length || 0;

        if (result.total === 0) {
            // Fallback: try to get tracks from raw metadata
            try {
                const rawAlbum = await fetchRawMeta(spotifyClient, "album", spotifyAlbumId);
                const discList = rawAlbum?.disc || [];
                for (const disc of discList) {
                    for (const track of (disc.track || [])) {
                        trackItems.push({ track: { id: track.track_uri?.split(":").pop() || "", name: track.title || "", trackNumber: track.number || 0, discNumber: disc.number || 1 } });
                    }
                }
                result.total = trackItems.length;
            } catch {}
        }

        if (result.total === 0) throw new Error("No tracks found in album");

        await fs.mkdir(outputDir, { recursive: true });

        // Download each track
        for (const item of trackItems) {
            const track = item.track || item;
            const trackId = track.id;
            if (!trackId) { result.failed++; result.errors.push("Missing track ID"); continue; }

            try {
                const dlResult = await downloadTrackById(trackId, { ...opts, outputDir });
                if (dlResult.success) result.successful++;
                else { result.failed++; result.errors.push(dlResult.error || "Unknown error"); }
            } catch (e: any) {
                result.failed++; result.errors.push(e.message);
            }
        }

        logger.debug(`[SpotiFLAC] Album done: ${result.successful}/${result.total} tracks`);
    } catch (error: any) {
        result.errors.push(error.message);
        logger.error(`[SpotiFLAC] Album download failed: ${error.message}`);
    }
    return result;
}

// ── ARTIST DOWNLOAD ──
async function downloadArtistById(spotifyArtistId: string, opts: DLOptions = {}): Promise<BatchResult> {
    const result: BatchResult = { total: 0, successful: 0, failed: 0, errors: [], outputDir: opts.outputDir || "" };
    try {
        const payload = {
            operationName: "queryArtistDiscography",
            variables: { uri: `spotify:artist:${spotifyArtistId}` },
            extensions: { persistedQuery: { version: 1, sha256Hash: "0" } },
        };

        const data = await spotifyClient.query(payload);
        const albums = data?.data?.artistUnion?.discography?.items || [];
        const maxAlbums = opts.maxAlbums || albums.length;

        for (let i = 0; i < Math.min(albums.length, maxAlbums); i++) {
            const albumItem = albums[i];
            const albumId = albumItem?.id || albumItem?.releases?.items?.[0]?.id;
            if (!albumId) continue;

            try {
                const albumResult = await downloadAlbumById(albumId, opts);
                result.total += albumResult.total;
                result.successful += albumResult.successful;
                result.failed += albumResult.failed;
                result.errors.push(...albumResult.errors);
            } catch (e: any) {
                result.errors.push(e.message);
            }
        }
    } catch (error: any) {
        result.errors.push(error.message);
        logger.error(`[SpotiFLAC] Artist download failed: ${error.message}`);
    }
    return result;
}

// ── PLAYLIST DOWNLOAD ──
async function downloadPlaylistById(spotifyPlaylistId: string, opts: DLOptions = {}): Promise<BatchResult> {
    const result: BatchResult = { total: 0, successful: 0, failed: 0, errors: [], outputDir: opts.outputDir || "" };
    try {
        const payload = {
            operationName: "fetchPlaylist",
            variables: { uri: `spotify:playlist:${spotifyPlaylistId}` },
            extensions: { persistedQuery: { version: 1, sha256Hash: "0" } },
        };

        const data = await spotifyClient.query(payload);
        const tracks = data?.data?.playlistV2?.content?.items || [];
        result.total = tracks.length;

        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath || "/music";
        const playlistName = data?.data?.playlistV2?.name || "Playlist";
        const outputDir = opts.outputDir || path.join(musicPath, "Playlists", sanitize(playlistName));
        result.outputDir = outputDir;
        await fs.mkdir(outputDir, { recursive: true });

        for (const item of tracks) {
            const trackId = item?.itemV2?.id || item?.track?.id;
            if (!trackId) { result.failed++; continue; }
            try {
                const dlResult = await downloadTrackById(trackId, { ...opts, outputDir });
                if (dlResult.success) result.successful++;
                else { result.failed++; result.errors.push(dlResult.error || "Unknown"); }
            } catch (e: any) { result.failed++; result.errors.push(e.message); }
        }
    } catch (error: any) {
        result.errors.push(error.message);
        logger.error(`[SpotiFLAC] Playlist download failed: ${error.message}`);
    }
    return result;
}

// ── SPOTIFY SEARCH (enables SpotiFLAC without Spotify URLs) ──
async function searchSpotify(query: string, type: "album" | "track" | "artist", limit = 5): Promise<Array<{id:string;name:string;artists:string[]}>> {
    try {
        const token = await spotifyClient.getAnonToken();
        const r = await axios.get("https://api.spotify.com/v1/search", {
            params: { q: query, type, limit, market: "US" },
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            validateStatus: () => true,
        });
        if (r.status !== 200) return [];
        const items = r.data?.[type + "s"]?.items || [];
        return items.filter((i: any) => i?.id).map((i: any) => ({
            id: i.id,
            name: i.name,
            artists: (i.artists || []).map((a: any) => a.name || "").filter(Boolean),
        }));
    } catch (e: any) {
        logger.debug(`[SpotiFLAC] Spotify search failed: ${e.message}`);
        return [];
    }
}

async function searchSpotifyAlbum(artistName: string, albumTitle: string): Promise<string | null> {
    // Strategy 1: Exact search "artist:XXX album:YYY"
    if (artistName) {
        const exact = await searchSpotify(`artist:${artistName} album:${albumTitle}`, "album", 3);
        // Prefer exact name match
        const exactMatch = exact.find(r => r.name.toLowerCase() === albumTitle.toLowerCase() && r.artists.some(a => a.toLowerCase() === artistName.toLowerCase()));
        if (exactMatch) return exactMatch.id;
        // Broader: first result
        if (exact.length > 0) return exact[0].id;
    }

    // Strategy 2: Loose search (artist + album as plain text)
    const looseQuery = artistName ? `${artistName} ${albumTitle}` : albumTitle;
    const loose = await searchSpotify(looseQuery, "album", 5);
    if (loose.length > 0) {
        // Prefer exact album name match
        const nameMatch = loose.find(r => r.name.toLowerCase() === albumTitle.toLowerCase());
        if (nameMatch) return nameMatch.id;
        return loose[0].id;
    }

    return null;
}

async function searchSpotifyTrack(artistName: string, trackTitle: string): Promise<string | null> {
    if (artistName) {
        const results = await searchSpotify(`artist:${artistName} track:${trackTitle}`, "track", 3);
        if (results.length > 0) return results[0].id;
    }
    const looseQuery = artistName ? `${artistName} ${trackTitle}` : trackTitle;
    const loose = await searchSpotify(looseQuery, "track", 5);
    return loose[0]?.id || null;
}

async function searchSpotifyArtist(artistName: string): Promise<string | null> {
    const results = await searchSpotify(`artist:${artistName}`, "artist", 3);
    const exact = results.find(r => r.name.toLowerCase() === artistName.toLowerCase());
    if (exact) return exact.id;
    return results[0]?.id || null;
}

// Download a track by ISRC directly (no Spotify ID needed)
async function downloadTrackByISRC(isrc: string, opts: DLOptions = {}): Promise<{success:boolean;filePath?:string;error?:string;isrc?:string}> {
    try {
        logger.debug(`[SpotiFLAC] Downloading track by ISRC: ${isrc}`);
        const quality = opts.quality || "6";
        let downloadURL = "";
        let source = "";

        // Try Qobuz by ISRC
        if (!opts.preferSource || opts.preferSource === "auto" || opts.preferSource === "qobuz") {
            try {
                const qobuzTrack = await qobuzDL.searchISRC(isrc);
                if (qobuzTrack) {
                    downloadURL = await qobuzDL.getDLUrl(qobuzTrack.id, quality);
                    source = "qobuz";
                }
            } catch (e: any) { logger.debug(`[SpotiFLAC] Qobuz ISRC search failed: ${e.message}`); }
        }

        if (!downloadURL) throw new Error(`No download URL for ISRC ${isrc}`);

        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath || "/music";
        const outputDir = opts.outputDir || musicPath;
        const fileName = `${sanitize(isrc)}.flac`;
        const filePath = path.join(outputDir, fileName);

        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await downloadFile(downloadURL, filePath);

        // Try to get metadata from Qobuz track info
        let trackName = isrc, artistName = "Unknown", albumName = "Unknown", coverUrl = "";
        try {
            const qobuzTrack = await qobuzDL.searchISRC(isrc);
            if (qobuzTrack) trackName = qobuzTrack.title || isrc;
        } catch {}

        try {
            await embedMetadata(filePath, { title: trackName, artist: artistName, album: albumName, albumArtist: artistName, isrc });
        } catch {}

        if (opts.jobId) {
            await prisma.downloadJob.update({ where: { id: opts.jobId }, data: { status: "completed", metadata: { source, isrc, filePath } } }).catch(() => {});
        }

        return { success: true, filePath, isrc };
    } catch (error: any) {
        logger.error(`[SpotiFLAC] ISRC download failed: ${error.message}`);
        if (opts.jobId) {
            await prisma.downloadJob.update({ where: { id: opts.jobId }, data: { status: "failed", metadata: { error: error.message } } }).catch(() => {});
        }
        return { success: false, error: error.message, isrc };
    }
}

// Download an album by UPC directly via Qobuz (no Spotify ID needed)
async function downloadAlbumByUPC(upc: string, opts: DLOptions = {}): Promise<BatchResult> {
    const result: BatchResult = { total: 0, successful: 0, failed: 0, errors: [], outputDir: opts.outputDir || "" };
    try {
        logger.debug(`[SpotiFLAC] Downloading album by UPC: ${upc}`);
        const quality = opts.quality || "6";

        // Search Qobuz by UPC
        const albumData = await qobuzDL.signedReq("album/get", { album_id: upc, extra: "trackIds" });
        if (!albumData?.id) throw new Error(`Qobuz album not found for UPC: ${upc}`);

        const trackIds: number[] = albumData.tracks?.items?.map((t: any) => t.id) || [];
        result.total = trackIds.length;
        if (result.total === 0) throw new Error("No tracks in Qobuz album");

        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath || "/music";
        const albumName = albumData.title || "Unknown Album";
        const artistName = albumData.artist?.name || "Unknown Artist";
        const coverUrl = albumData.image?.large || "";
        const outputDir = opts.outputDir || path.join(musicPath, sanitize(artistName), sanitize(albumName));
        result.outputDir = outputDir;
        await fs.mkdir(outputDir, { recursive: true });

        for (let i = 0; i < trackIds.length; i++) {
            try {
                const dlUrl = await qobuzDL.getDLUrl(trackIds[i], quality);
                if (!dlUrl) { result.failed++; continue; }
                const trackInfo = albumData.tracks.items[i];
                const trackName = trackInfo?.title || `Track ${i + 1}`;
                const fileName = `${String(i + 1).padStart(2, "0")} - ${sanitize(trackName)}.flac`;
                const filePath = path.join(outputDir, fileName);
                await downloadFile(dlUrl, filePath);
                try {
                    await embedMetadata(filePath, {
                        title: trackName, artist: trackInfo?.artist?.name || artistName,
                        album: albumName, albumArtist: artistName, coverUrl,
                        trackNo: i + 1, upc,
                    });
                } catch {}
                result.successful++;
            } catch (e: any) { result.failed++; result.errors.push(e.message); }
        }
    } catch (error: any) {
        result.errors.push(error.message);
        logger.error(`[SpotiFLAC] UPC album download failed: ${error.message}`);
    }
    return result;
}

// ── EXPORTED SERVICE ──
export const spotiflacService = {
    async isAvailable(): Promise<boolean> {
        try { await spotifyClient.init(); return true; } catch { return false; }
    },

    async downloadTrack(spotifyUrlOrId: string, opts: DLOptions = {}): Promise<{success:boolean;filePath?:string;error?:string;isrc?:string}> {
        const parsed = parseSpotifyId(spotifyUrlOrId, "track");
        const trackId = parsed?.type === "track" ? parsed.id : spotifyUrlOrId;
        return downloadTrackById(trackId, opts);
    },

    async downloadAlbum(spotifyUrlOrId: string, opts: DLOptions = {}): Promise<BatchResult> {
        const parsed = parseSpotifyId(spotifyUrlOrId, "album");
        const albumId = parsed?.type === "album" ? parsed.id : spotifyUrlOrId;
        return downloadAlbumById(albumId, opts);
    },

    async downloadArtist(spotifyUrlOrId: string, opts: DLOptions = {}): Promise<BatchResult> {
        const parsed = parseSpotifyId(spotifyUrlOrId, "artist");
        const artistId = parsed?.type === "artist" ? parsed.id : spotifyUrlOrId;
        return downloadArtistById(artistId, opts);
    },

    async downloadPlaylist(spotifyUrlOrId: string, opts: DLOptions = {}): Promise<BatchResult> {
        const parsed = parseSpotifyId(spotifyUrlOrId, "playlist");
        const playlistId = parsed?.type === "playlist" ? parsed.id : spotifyUrlOrId;
        return downloadPlaylistById(playlistId, opts);
    },

    // Search Spotify by name (no URL/ID needed)
    searchSpotifyAlbum,
    searchSpotifyTrack,
    searchSpotifyArtist,

    // Download without Spotify ID
    downloadTrackByISRC,
    downloadAlbumByUPC,

    parseSpotifyId,
};

export default spotiflacService;
