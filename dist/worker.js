var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
var DEFAULT_HOSTS = ["zh.wikisource.org", "en.wikisource.org", "gutendex.com", "www.gutenberg.org", "gutenberg.org"];
var MAX_BYTES = 8 * 1024 * 1024;
var json = /* @__PURE__ */ __name((data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }), "json");
function checkURL(value, hosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("\u7F51\u5740\u65E0\u6548");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port && !["80", "443"].includes(url.port)) throw new Error("\u53EA\u652F\u6301\u65E0\u7528\u6237\u540D\u5BC6\u7801\u7684 HTTP(S) \u6807\u51C6\u7AEF\u53E3\u7F51\u5740");
  if (!hosts.includes(url.hostname.toLowerCase())) throw new Error(`\u4E66\u6E90\u57DF\u540D ${url.hostname} \u672A\u83B7\u7AD9\u70B9\u914D\u7F6E\u5141\u8BB8\uFF0C\u8BF7\u5C06\u5B83\u52A0\u5165 Cloudflare \u7684 ALLOWED_HOSTS \u540E\u91CD\u65B0\u90E8\u7F72`);
  if (!url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname) || /[\[\]:]/.test(url.hostname) || /\.(local|localhost|internal|test)$/.test(url.hostname)) throw new Error("\u4E0D\u652F\u6301\u672C\u5730\u6216 IP \u5730\u5740\u4E66\u6E90");
  return url;
}
__name(checkURL, "checkURL");
async function limitedBody(response, limit = MAX_BYTES) {
  if (Number(response.headers.get("content-length")) > limit) throw new Error("\u9875\u9762\u8D85\u8FC7 8 MB \u9650\u5236");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  const parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("\u9875\u9762\u8D85\u8FC7 8 MB \u9650\u5236");
      parts.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
__name(limitedBody, "limitedBody");
async function proxy(input, env = {}, fetcher = fetch) {
  const hosts = (env.ALLOWED_HOSTS || DEFAULT_HOSTS.join(",")).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  let url = checkURL(input.url, hosts), method = input.method || "GET";
  if (!["GET", "POST"].includes(method)) throw new Error("\u53EA\u652F\u6301 GET / POST \u4E66\u6E90");
  if (input.body && (typeof input.body !== "string" || input.body.length > 16e3)) throw new Error("\u8BF7\u6C42\u5185\u5BB9\u8FC7\u957F");
  const charset = input.charset || "utf-8";
  if (!["utf-8", "gbk", "gb18030", "big5"].includes(charset.toLowerCase())) throw new Error("\u4E0D\u652F\u6301\u7684\u7F16\u7801");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2e4);
  try {
    for (let i = 0; i < 5; i++) {
      const response = await fetcher(url.href, {
        method,
        body: method === "POST" ? input.body || "" : void 0,
        headers: { "User-Agent": "NovelHarbor/1.0 (personal reading tool)", "Accept": "text/html,application/json,text/plain;q=0.9", ...method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {} },
        redirect: "manual",
        signal: controller.signal
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("\u4E66\u6E90\u8FD4\u56DE\u4E86\u65E0\u6548\u8DF3\u8F6C");
        url = checkURL(new URL(location, url).href, hosts);
        if ([301, 302, 303].includes(response.status)) method = "GET";
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const err = new Error(`\u4E66\u6E90\u8FD4\u56DE HTTP ${response.status}\uFF0C\u53EF\u80FD\u6682\u65F6\u4E0D\u53EF\u7528\u6216\u9650\u5236\u8BBF\u95EE`);
        err.status = response.status;
        throw err;
      }
      const type = response.headers.get("content-type") || "";
      if (type && !/text\/|json|xml|octet-stream/.test(type)) {
        await response.body?.cancel();
        throw new Error("\u6B64\u5730\u5740\u6CA1\u6709\u8FD4\u56DE\u53EF\u89E3\u6790\u7684\u6587\u672C");
      }
      const bytes = await limitedBody(response);
      const detected = type.match(/charset=["']?([\w-]+)/i)?.[1];
      let text;
      try {
        text = new TextDecoder(input.charset || detected || "utf-8").decode(bytes);
      } catch {
        throw new Error("\u65E0\u6CD5\u89E3\u7801\u4E66\u6E90\u9875\u9762");
      }
      return { url: url.href, text, bytes: bytes.length, fetchedAt: (/* @__PURE__ */ new Date()).toISOString() };
    }
    throw new Error("\u4E66\u6E90\u8DF3\u8F6C\u6B21\u6570\u8FC7\u591A");
  } finally {
    clearTimeout(timer);
  }
}
__name(proxy, "proxy");
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/config" && request.method === "GET") return json({ requiresToken: !!env.ACCESS_TOKEN, hosts: (env.ALLOWED_HOSTS || DEFAULT_HOSTS.join(",")).split(",").map((x) => x.trim()) });
    if (url.pathname !== "/api/fetch") return json({ error: "\u63A5\u53E3\u4E0D\u5B58\u5728" }, 404);
    if (request.method !== "POST") return json({ error: "\u8BF7\u4F7F\u7528 POST" }, 405);
    if (request.headers.get("origin") && request.headers.get("origin") !== url.origin) return json({ error: "\u4E0D\u5141\u8BB8\u8DE8\u7AD9\u8BF7\u6C42" }, 403);
    if (env.ACCESS_TOKEN && request.headers.get("authorization") !== `Bearer ${env.ACCESS_TOKEN}`) return json({ error: "\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u586B\u5199\u6B63\u786E\u7684\u8BBF\u95EE\u53E3\u4EE4" }, 401);
    try {
      const raw = new TextDecoder().decode(await limitedBody(request, 32e3));
      const input = JSON.parse(raw);
      checkURL(input.url, (env.ALLOWED_HOSTS || DEFAULT_HOSTS.join(",")).split(",").map((x) => x.trim().toLowerCase()));
      const cache = globalThis.caches?.default;
      const key = new Request(`${url.origin}/__cache/${encodeURIComponent(input.charset || "auto")}/${encodeURIComponent(input.url)}`);
      if ((!input.method || input.method === "GET") && cache) {
        const hit = await cache.match(key);
        if (hit) return hit;
      }
      const data = await proxy(input, env);
      const result = json(data);
      if ((!input.method || input.method === "GET") && cache) {
        const stored = json(data);
        stored.headers.set("Cache-Control", "public, max-age=300");
        ctx.waitUntil(cache.put(key, stored));
      }
      return result;
    } catch (e) {
      return json({ error: e.name === "AbortError" ? "\u4E66\u6E90\u54CD\u5E94\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" : e.message }, e.status === 429 ? 429 : 400);
    }
  }
};
export {
  checkURL,
  worker_default as default,
  limitedBody,
  proxy
};
//# sourceMappingURL=worker.js.map
