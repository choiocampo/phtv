#!/usr/bin/env node
/**
 * PH Live TV — HTTPS stream proxy (local Node version, zero dependencies)
 *
 * Same API as proxy/worker.js:
 *   http://localhost:8787/http://host:6610/live/manifest.mpd?AuthInfo=...
 *   http://localhost:8787/?url=<encoded absolute url>
 *
 * Run:  node proxy/proxy.mjs            (defaults to port 8787)
 *       PORT=9000 node proxy/proxy.mjs
 *
 * Use this when a channel is locked to your home ISP: run it on a machine on that network,
 * then expose it over HTTPS with a tunnel, e.g.
 *       cloudflared tunnel --url http://localhost:8787
 * and paste the resulting https://... hostname into the app's Settings dialog.
 */

import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const MANIFEST_RE = /\.(m3u8|mpd)(\?|$)/i;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD,OPTIONS",
  "access-control-allow-headers": "range,accept,content-type,origin,x-requested-with",
  "access-control-expose-headers": "content-length,content-range,accept-ranges,etag,last-modified",
};

http
  .createServer(async (req, res) => {
    if (req.method === "OPTIONS") return end(res, 204, "");
    if (!/^(GET|HEAD)$/.test(req.method)) return end(res, 405, "Only GET/HEAD are proxied\n");

    const here = new URL(req.url, "http://" + (req.headers.host || ("localhost:" + PORT)));
    let target = here.searchParams.get("url");
    if (!target) {
      target = here.pathname.slice(1) + (here.search || "");
      target = target.replace(/^(https?):\/?\/?/i, "$1://");
    }
    if (!target || target === "/") return end(res, 200, "PH Live TV stream proxy is running.\nUsage: /<stream-url>\n");
    if (!/^https?:\/\//i.test(target)) return end(res, 400, `Bad target URL: ${target}\n`);

    let upstreamUrl;
    try {
      upstreamUrl = new URL(target);
    } catch {
      return end(res, 400, "Unparsable target URL\n");
    }

    const headers = { "user-agent": req.headers["user-agent"] || "Mozilla/5.0", referer: `${upstreamUrl.origin}/` };
    for (const h of ["range", "accept", "accept-language"]) if (req.headers[h]) headers[h] = req.headers[h];

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, { method: req.method, headers, redirect: "follow" });
    } catch (err) {
      return end(res, 502, `Upstream fetch failed: ${err?.message}\n`);
    }

    const ctype = upstream.headers.get("content-type") || "";
    const isManifest = /mpegurl|dash\+xml|application\/xml|text\/xml/i.test(ctype) || MANIFEST_RE.test(upstreamUrl.pathname);
    const proxyRoot = `${here.origin}/`;
    const abs = (u) => {
      try {
        return proxyRoot + new URL(u, upstreamUrl).toString();
      } catch {
        return u;
      }
    };

    if (req.method === "GET" && isManifest) {
      const body = await upstream.text();
      const out = /mpegurl/i.test(ctype) || /\.m3u8/i.test(upstreamUrl.pathname) ? rewriteHls(body, abs) : rewriteDash(body, abs);
      res.writeHead(upstream.status, {
        ...CORS,
        "content-type": ctype || "application/vnd.apple.mpegurl",
        "cache-control": "no-store",
      });
      return res.end(out);
    }

    const passthrough = { ...CORS, "cache-control": "no-store" };
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const v = upstream.headers.get(h);
      if (v) passthrough[h] = v;
    }
    res.writeHead(upstream.status, passthrough);
    if (req.method === "HEAD" || !upstream.body) return res.end();

    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) await new Promise((r) => res.once("drain", r));
      }
    } catch {
      /* client disconnected */
    }
    res.end();
  })
  .listen(PORT, () => {
    console.log(`PH Live TV stream proxy listening on http://localhost:${PORT}`);
    console.log(`Example: http://localhost:${PORT}/https://streams.comclark.com/pknsd/tv5/playlist.m3u8`);
  });

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

function rewriteDash(body, abs) {
  return body
    .replace(/(<BaseURL[^>]*>)\s*([^<\s]+)\s*(<\/BaseURL>)/gi, (_, a, u, b) => a + abs(u) + b)
    .replace(/\b(initialization|media|sourceURL|index)="([^"]+)"/gi, (_, key, u) => `${key}="${abs(u)}"`);
}

function end(res, status, body) {
  res.writeHead(status, { ...CORS, "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}
