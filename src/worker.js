// 三个搜索域用于「没加书源时用搜索引擎找站点」；它们只被当作候选来源发现用。
const DEFAULT_HOSTS = ['zh.wikisource.org', 'en.wikisource.org', 'gutendex.com', 'www.gutenberg.org', 'gutenberg.org', 'cn.bing.com', 'www.baidu.com', 'www.sogou.com'];
const MAX_BYTES = 8 * 1024 * 1024;
const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
export function allowedHosts(env = {}) {
  return (env.ALLOWED_HOSTS || DEFAULT_HOSTS.join(',')).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}
// 设了 ACCESS_TOKEN 就自动放开到任意公网域名：此时只有持令牌的请求能走到代理，
// 白名单就从「防陌生人拿它当代理」退化成了纯手续。想保留白名单就设 STRICT_ALLOWED_HOSTS=1。
// 无论是否放开，IP 字面量、localhost 和内网域名始终会被拒绝（见 checkURL）。
export function openProxy(env = {}) {
  if (/^(1|true|yes)$/i.test(String(env.STRICT_ALLOWED_HOSTS || ''))) return false;
  return !!env.ACCESS_TOKEN;
}
export function checkURL(value, hosts, open = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error('网址无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new Error('只支持无用户名密码的 HTTP(S) 标准端口网址');
  if (!open && !hosts.includes(url.hostname.toLowerCase())) throw new Error(`书源域名 ${url.hostname} 未获站点配置允许：把它加进 Cloudflare 的 ALLOWED_HOSTS，或者设置 ACCESS_TOKEN 让代理自动放开`);
  // Even a misconfigured host list must not grant access to literal IPs or local names.
  if (!url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || /[\[\]:]/.test(url.hostname) || /\.(local|localhost|internal|test)$/.test(url.hostname)) throw new Error('不支持本地或 IP 地址书源');
  return url;
}
export async function limitedBody(response, limit = MAX_BYTES) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('页面超过 8 MB 限制');
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  let size = 0; const parts = [];
  try { while (true) { const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error('页面超过 8 MB 限制'); parts.push(value); } }
  catch (e) { await reader.cancel(); throw e; }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) {bytes.set(part, offset); offset += part.length;} return bytes;
}
// 书源可以要求特定的 User-Agent / Referer。这里再过滤一遍，不依赖前端已经筛过：
// Cookie、Authorization 是凭据，Host 会改变请求指向，一律不转发。
const HEADER_NAME = /^(user-agent|referer|accept|accept-language|content-type|x-requested-with|origin|cache-control|pragma|x-[\w-]+)$/;
export function safeHeaders(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= 12) break;
    const name = String(key).toLowerCase();
    if (!HEADER_NAME.test(name) || name === 'host') continue;
    if (typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 512) continue;
    out[name] = value; count++;
  }
  return out;
}
// 书源里的编码名写法很杂。gb2312 在 WHATWG 标准里本就是 gbk 的别名，ansi 在中文站点上
// 基本也都指 gbk；不认这些写法会让一批老书源直接卡在「不支持的编码」。
const CHARSETS = {'utf-8':'utf-8', utf8:'utf-8', 'utf8n':'utf-8', 'utf-8n':'utf-8', gbk:'gbk', 'gb-2312':'gbk', gb2312:'gbk', 'gb_2312':'gbk', ansi:'gbk', gb18030:'gb18030', big5:'big5', 'big-5':'big5'};
export function normalizeCharset(value) {
  return CHARSETS[String(value || '').trim().toLowerCase()] || '';
}
export async function proxy(input, env = {}, fetcher = fetch) {
  const hosts = allowedHosts(env), open = openProxy(env);
  let url = checkURL(input.url, hosts, open), method = input.method || 'GET';
  if (!['GET','POST'].includes(method)) throw new Error('只支持 GET / POST 书源');
  if (input.body && (typeof input.body !== 'string' || input.body.length > 16000)) throw new Error('请求内容过长');
  const charset = normalizeCharset(input.charset);
  if (input.charset && !charset) throw new Error(`不支持的编码：${input.charset}`);
  const custom = safeHeaders(input.headers);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
  try {
    for (let i = 0; i < 5; i++) {
      const response = await fetcher(url.href, {method, body: method === 'POST' ? input.body || '' : undefined,
        headers: {'User-Agent':'NovelHarbor/1.0 (personal reading tool)', 'Accept':'text/html,application/json,text/plain;q=0.9', ...(method === 'POST' ? {'Content-Type': 'application/x-www-form-urlencoded'} : {}), ...custom},
        redirect:'manual', signal:controller.signal});
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new Error('书源返回了无效跳转');
        url = checkURL(new URL(location, url).href, hosts, open);
        if ([301,302,303].includes(response.status)) method = 'GET'; continue;
      }
      if (!response.ok) {await response.body?.cancel(); const err = new Error(`书源返回 HTTP ${response.status}，可能暂时不可用或限制访问`); err.status = response.status; throw err;}
      const type = response.headers.get('content-type') || '';
      if (type && !/text\/|json|xml|octet-stream/.test(type)) {await response.body?.cancel(); throw new Error('此地址没有返回可解析的文本');}
      const bytes = await limitedBody(response);
      const detected = type.match(/charset=["']?([\w-]+)/i)?.[1];
      // 书源显式指定的编码优先，其次响应头里声明的，最后按 UTF-8。
      // 响应头里可能有 shift_jis 这类我们不认但 TextDecoder 认的名字，所以原样再兜一层。
      const label = charset || normalizeCharset(detected) || detected || 'utf-8';
      let text; try {text = new TextDecoder(label).decode(bytes);} catch {throw new Error('无法解码书源页面');}
      return {url:url.href, text, bytes:bytes.length, fetchedAt:new Date().toISOString()};
    }
    throw new Error('书源跳转次数过多');
  } finally {clearTimeout(timer);}
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/config' && request.method === 'GET') return json({requiresToken:!!env.ACCESS_TOKEN, openProxy:openProxy(env), hosts:allowedHosts(env)});
    if (url.pathname !== '/api/fetch') return json({error:'接口不存在'},404);
    if (request.method !== 'POST') return json({error:'请使用 POST'},405);
    if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return json({error:'不允许跨站请求'},403);
    if (env.ACCESS_TOKEN && request.headers.get('authorization') !== `Bearer ${env.ACCESS_TOKEN}`) return json({error:'请在设置中填写正确的访问口令'},401);
    try {
      const raw = new TextDecoder().decode(await limitedBody(request, 32000));
      const input = JSON.parse(raw);
      checkURL(input.url, allowedHosts(env), openProxy(env));
      // Only successful GETs are cached; POST results and failures are never cached.
      // 带自定义请求头的请求也不缓存：同样的 URL 换个 UA 可能拿到不同内容。
      const cache = globalThis.caches?.default;
      const cacheable = (!input.method || input.method === 'GET') && !input.headers;
      const key = new Request(`${url.origin}/__cache/${encodeURIComponent(input.charset || 'auto')}/${encodeURIComponent(input.url)}`);
      if (cacheable && cache) {const hit = await cache.match(key); if (hit) return hit;}
      const data = await proxy(input, env);
      const result = json(data);
      if (cacheable && cache) {const stored = json(data); stored.headers.set('Cache-Control','public, max-age=300'); ctx.waitUntil(cache.put(key, stored));}
      return result;
    } catch (e) {return json({error:e.name === 'AbortError' ? '书源响应超时，请稍后重试' : e.message}, e.status === 429 ? 429 : 400);}
  }
};
