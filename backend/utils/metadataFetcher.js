import * as cheerio from 'cheerio';
import dns from 'dns/promises';
import net from 'net';
import http from 'http';
import https from 'https';
import zlib from 'zlib';

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 1024 * 1024; // 1 MB is plenty for <head> metadata

/** True for loopback, private, link-local, CGNAT, multicast and other non-public IPv4 addresses. */
function isBlockedIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;        // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true;        // 100.64.0.0/10 carrier-grade NAT
  if (a === 169 && b === 254) return true;                  // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;         // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                  // 192.168.0.0/16
  if (a === 192 && b === 0) return true;                    // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;     // benchmarking
  if (a >= 224) return true;                                // multicast and reserved
  return false;
}

/** True for loopback, unique-local, link-local, multicast and IPv4-mapped-private IPv6 addresses. */
function isBlockedIPv6(ip) {
  const addr = ip.toLowerCase().split('%')[0];
  if (addr === '::' || addr === '::1') return true;
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  if (addr.startsWith('::ffff:')) return true;              // hex-form IPv4-mapped: refuse rather than parse
  if (addr.startsWith('64:ff9b:')) return true;             // NAT64
  const first = parseInt(addr.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true;             // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true;             // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true;             // ff00::/8 multicast
  return false;
}

export function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true;
}

/**
 * Validates that a URL is safe to fetch from the server: http(s) on a standard
 * port, and a hostname that resolves ONLY to public addresses. Returns the
 * parsed URL together with the address that was validated, or throws.
 *
 * The caller must connect to exactly that address (see requestPinned). Fetching
 * by name afterwards would resolve the name a second time, and a hostile DNS
 * server can answer the second query with an internal address (DNS rebinding).
 */
export async function resolvePublicTarget(rawUrl, lookup = dns.lookup) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed');
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new Error('Only standard web ports are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }

  // URL.hostname keeps the brackets around IPv6 literals ("[::1]").
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Host is not allowed');
  }

  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error('Host resolves to a non-public address');
    const family = net.isIP(hostname);
    return { url: parsed, address: hostname, family, addresses: [{ address: hostname, family }] };
  }

  // Resolve every address: a name with one public and one private record must be refused.
  const records = await lookup(hostname, { all: true });
  if (!records || records.length === 0) throw new Error('Host could not be resolved');
  if (records.some(r => isBlockedAddress(r.address))) {
    throw new Error('Host resolves to a non-public address');
  }
  // Every record was validated, so all of them may be used for the connection
  // (IPv4 first: many hosts have no IPv6 route).
  const addresses = records
    .map(r => ({ address: r.address, family: net.isIP(r.address) }))
    .sort((a, b) => a.family - b.family);
  return { url: parsed, address: addresses[0].address, family: addresses[0].family, addresses };
}

/** Same checks as resolvePublicTarget; returns only the parsed URL. */
export async function assertPublicUrl(rawUrl, lookup = dns.lookup) {
  return (await resolvePublicTarget(rawUrl, lookup)).url;
}

/**
 * A `lookup` function for http(s).request that never asks DNS: it always answers
 * with the address that was already validated.
 */
export function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const wantsAll = typeof options === 'object' && options !== null && options.all;
    if (wantsAll) cb(null, addresses.map(a => ({ address: a.address, family: a.family })));
    else cb(null, addresses[0].address, addresses[0].family);
  };
}

/**
 * One HTTP(S) GET to `url`, connecting to the pinned address(es) instead of
 * resolving the hostname again. The hostname is still used for the Host header,
 * TLS SNI and certificate verification. Redirects are not followed.
 * Resolves with { status, headers, body } where body is a readable stream
 * (already decompressed).
 */
export function requestPinned({ url, address, family, addresses, headers = {}, signal }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'GET',
      headers: { ...headers, 'Accept-Encoding': 'gzip, deflate, br' },
      lookup: pinnedLookup(addresses && addresses.length ? addresses : [{ address, family }]),
      agent: false,   // one connection per request: a pooled socket could belong to another address
      signal
    }, (res) => {
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      let body = res;
      if (encoding === 'gzip' || encoding === 'x-gzip') body = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') body = res.pipe(zlib.createInflate());
      else if (encoding === 'br') body = res.pipe(zlib.createBrotliDecompress());
      if (body !== res) res.on('error', (e) => body.destroy(e));
      resolve({ status: res.statusCode, headers: res.headers, body, raw: res });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Reads at most MAX_HTML_BYTES of the response body as text. */
async function readLimitedText(res) {
  if (!res.body) return '';
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for await (const chunk of res.body) {
      received += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (received >= MAX_HTML_BYTES) break;
    }
  } catch (e) {
    // A body cut off at the size cap (or a truncated compressed stream) still has a usable <head>.
    if (!text) throw e;
  } finally {
    discardBody(res);
  }
  return text + decoder.decode();
}

function discardBody(res) {
  try { res.body?.destroy?.(); } catch { /* already closed */ }
  try { res.raw?.destroy?.(); } catch { /* already closed */ }
}

/**
 * Fetches Open Graph / Twitter Card / HTML metadata for a given URL.
 * Emulates WhatsApp link-preview bot to retrieve rich cards from Amazon, Flipkart, Google Maps, etc.
 *
 * The target is user supplied, so every hop (including redirects) is checked
 * against private/internal addresses, the whole exchange is time-boxed, and the
 * body is size-capped.
 *
 * @param {string} targetUrl - The target URL to fetch metadata for.
 * @param {{ lookup?: Function, request?: Function }} [deps] - injectable DNS lookup and transport (tests)
 * @returns {Promise<{ url: string, title: string, description: string, image: string, siteName: string } | null>}
 */
export async function fetchUrlMetadata(targetUrl, { lookup = dns.lookup, request = requestPinned } = {}) {
  if (!targetUrl || typeof targetUrl !== 'string' || targetUrl.length > 2048) return null;

  const controller = new AbortController();
  // The timer stays armed until the body has been read, not just until headers arrive.
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let url = targetUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    let res;
    for (let hop = 0; ; hop++) {
      let target;
      try {
        target = await resolvePublicTarget(url, lookup);
      } catch (e) {
        console.warn(`[metadataFetcher] Blocked request to disallowed target: ${e.message}`);
        return null;
      }

      // The connection goes to the address validated above; the name is not
      // resolved a second time. Redirects are followed manually so each hop is
      // validated and pinned the same way.
      res = await request({
        url: target.url,
        address: target.address,
        family: target.family,
        addresses: target.addresses,
        signal: controller.signal,
        headers: {
          'User-Agent': 'WhatsApp/2.21.12.21 A',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });

      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && location) {
        discardBody(res);
        if (hop >= MAX_REDIRECTS) {
          console.warn(`[metadataFetcher] Too many redirects for ${targetUrl}`);
          return null;
        }
        url = new URL(location, url).href;
        continue;
      }
      break;
    }

    if (res.status >= 400 && res.status !== 403) {
      console.warn(`[metadataFetcher] HTTP ${res.status} for ${url}`);
    }

    const contentType = String(res.headers['content-type'] || '');
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      discardBody(res);
      return null;
    }

    const finalUrl = url;
    const html = await readLimitedText(res);
    const $ = cheerio.load(html);

    // Extract Title: prefer Open Graph title or Twitter title, fallback to HTML <title>
    let title = $('meta[property="og:title"]').attr('content') ||
                $('meta[name="twitter:title"]').attr('content') ||
                $('title').first().text() ||
                '';

    // Extract Description: prefer Open Graph description or Twitter description, fallback to meta description
    let description = $('meta[property="og:description"]').attr('content') ||
                      $('meta[name="twitter:description"]').attr('content') ||
                      $('meta[name="description"]').attr('content') ||
                      '';

    // Extract Image: prefer Open Graph image, Twitter image, or link rel="image_src"
    let image = $('meta[property="og:image"]').attr('content') ||
                $('meta[property="og:image:secure_url"]').attr('content') ||
                $('meta[name="twitter:image"]').attr('content') ||
                $('meta[name="twitter:image:src"]').attr('content') ||
                $('link[rel="image_src"]').attr('href') ||
                '';

    // Resolve relative image URLs to absolute; only http(s) images are returned.
    if (image) {
      try {
        const resolved = new URL(image, finalUrl);
        image = (resolved.protocol === 'http:' || resolved.protocol === 'https:') ? resolved.href : '';
      } catch {
        image = '';
      }
    }

    // Extract Site / Domain Name
    let siteName = $('meta[property="og:site_name"]').attr('content') || '';
    if (!siteName || siteName.length > 50) {
      try {
        siteName = new URL(finalUrl).hostname.replace(/^www\./, '');
      } catch {
        siteName = '';
      }
    }

    // Clean up title and description (strip newlines, collapse extra spaces, bound length)
    title = title.replace(/\s+/g, ' ').trim().slice(0, 300);
    description = description.replace(/\s+/g, ' ').trim().slice(0, 1000);

    return {
      url: finalUrl,
      title,
      description,
      image,
      siteName
    };
  } catch (err) {
    console.error(`[metadataFetcher] Error fetching metadata for ${targetUrl}:`, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
