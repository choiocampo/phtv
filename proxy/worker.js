/**
 * PH Live TV — HTTPS stream proxy (Cloudflare Worker)
 *
 * Why this exists: GitHub Pages serves your app over https://, and browsers refuse to load
 * plain http:// media inside an https:// page ("mixed content"). This Worker re-serves those
 * streams over HTTPS and adds the CORS headers hls.js / dash.js need.
 *
 * Usage (path style, so relative playlist paths keep working):
 *   https://YOUR-WORKER.workers.dev/http://host:6610/live/manifest.mpd?AuthInfo=...
 *   https://YOUR-WORKER.workers.dev/?url=<encoded absolute url>      (also supported)
 *
 * Deploy: Cloudflare dashboard -> Workers & Pages -> Create Worker -> paste this file -> Deploy.
 * Then paste the worker URL into the app's Settings dialog.
 */

// Optional hardening. Leave empty to allow any upstream host.
const ALLOWED_HOSTS = [
  // "streams.comclark.com",
  // "136.239.173.2",
];

// Optional: restrict who may use the proxy (browser Origin header). Empty = allow all.
const ALLOWED_ORIGINS = [
  // "https://choiocampo.github.io",
];

const MANIFEST_RE = /\.(m3u8|mpd)(\?|$)/i;

export default {
  async fetch(request) {
    const here = new URL(request.url);

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (!/^(GET|HEAD)$/.test(request.method)) return cors(text("Only GET/HEAD are proxied", 405));

    const origin = request.headers.get("origin");
    if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
      return cors(text("Origin not allowed", 403));
    }

    // Accept both /?url=<encoded> and /<absolute-url>
    let target = here.searchParams.get("url");
    if (!target) {
      target = here.pathname.slice(1) + (here.search || "");
      target = target.replace(/^(https?):\/?\/?/i, "$1://"); // repair collapsed slashes
    }
    if (!target || target === "/") {
      return cors(text("PH Live TV stream proxy is running.\nUsage: /<http-or-https-stream-url>", 200));
    }
    if (!/^https?:\/\//i.test(target)) return cors(text("Bad target URL: " + target, 400));

    let upstreamUrl;
    try {
      upstreamUrl = new URL(target);
    } catch {
      return cors(text("Unparsable target URL", 400));
    }
    if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(upstreamUrl.hostname)) {
      return cors(text("Upstream host not allowed: " + upstreamUrl.hostname, 403));
    }

    // Forward only what streaming servers care about.
    const fwd = new Headers();
    for (const h of ["range", "accept", "accept-language", "if-none-match", "if-modified-since"]) {
      const v = request.headers.get(h);
      if (v) fwd.set(h, v);
    }
    fwd.set("user-agent", request.headers.get("user-agent") || "Mozilla/5.0");
    fwd.set("referer", upstreamUrl.origin + "/");

    let upstream;
    try {
      upstream = await fetch(upstreamUrl.toString(), {
        method: request.method,
        headers: fwd,
        redirect: "follow",
      });
    } catch (err) {
      return cors(text("Upstream fetch failed: " + (err && err.message), 502));
    }

    const ctype = upstream.headers.get("content-type") || "";
    const isManifest =
      /mpegurl|dash\+xml|application\/xml|text\/xml/i.test(ctype) || MANIFEST_RE.test(upstreamUrl.pathname);

    // Manifests are rewritten so every segment also travels through the proxy.
    if (request.method === "GET" && isManifest) {
      const body = await upstream.text();
      const proxyRoot = here.origin + "/";
      const abs = (u) => {
        try {
          return proxyRoot + new URL(u, upstreamUrl).toString();
        } catch {
          return u;
        }
      };
      const rewritten = /mpegurl/i.test(ctype) || /\.m3u8/i.test(upstreamUrl.pathname)
        ? rewriteHls(body, abs)
        : rewriteDash(body, abs);

      return cors(
        new Response(rewritten, {
          status: upstream.status,
          headers: {
            "content-type": ctype || "application/vnd.apple.mpegurl",
            "cache-control": "no-store",
          },
        })
      );
    }

    // Media segments stream straight through.
    const out = new Headers();
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set("cache-control", "no-store");
    return cors(new Response(upstream.body, { status: upstream.status, headers: out }));
  },
};

/** Rewrite HLS playlist URIs (segments, variants, keys, maps). */
function rewriteHls(body, abs) {
  return body
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${abs(u)}"`);
      return abs(t);
    })
    .join("\n");
}

/** Rewrite DASH manifest URLs, leaving $Number$/$Time$ templates intact. */
function rewriteDash(body, abs) {
  return body
    .replace(/(<BaseURL[^>]*>)\s*([^<\s]+)\s*(<\/BaseURL>)/gi, (_, a, u, b) => a + abs(u) + b)
    .replace(/\b(initialization|media|sourceURL|index)="([^"]+)"/gi, (m, key, u) =>
      /^https?:\/\//i.test(u) || !/^[.a-zA-Z0-9$_\/-]/.test(u) ? `${key}="${abs(u)}"` : `${key}="${abs(u)}"`
    );
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,HEAD,OPTIONS");
  h.set("access-control-allow-headers", "range,accept,content-type,origin,x-requested-with");
  h.set("access-control-expose-headers", "content-length,content-range,accept-ranges,etag,last-modified");
  h.set("timing-allow-origin", "*");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function text(msg, status) {
  return new Response(msg + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
