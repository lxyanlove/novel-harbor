export const builtins = [
  {id:'wiki-zh', bookSourceName:'维基文库 · 中文', bookSourceUrl:'https://zh.wikisource.org', adapter:'wiki', enabled:true, lang:'zh'},
  {id:'wiki-en', bookSourceName:'Wikisource · English', bookSourceUrl:'https://en.wikisource.org', adapter:'wiki', enabled:false, lang:'en'},
  {id:'gutenberg', bookSourceName:'Project Gutenberg', bookSourceUrl:'https://gutendex.com', adapter:'gutenberg', enabled:true}
];
export function safeURL(value, base) {
  const u = new URL(value, base); if (!['http:','https:'].includes(u.protocol)) throw new Error('非 HTTP(S) 链接'); u.hash=''; return u.href;
}
// 汇总自定义书源用到的域名。白名单是精确匹配，所以 www 与裸域会各占一条。
export function sourceHosts(list) {
  return [...new Set(list.filter(s => s && !s.adapter).map(s => {
    try { return new URL(s.bookSourceUrl).hostname.toLowerCase(); } catch { return null; }
  }).filter(Boolean))].sort();
}
// 归一化书名，用于把不同书源里的同一本书归到一组比较。
export function titleKey(title) {
  return String(title || '')
    .replace(/[《》〈〉「」『』【】\[\]()（）\s·・、,，.。:：!！?？\-—_~～"'"'']/g, '')
    .toLowerCase();
}
// 「阅读」默认规则的末尾关键字：只有这些才算属性名，其余整条都当选择器。
// 用白名单而不是「末尾任意单词」，否则 id.list@dd@a 会被误判成取属性 a。
const TERMINAL_ATTRS = new Set(['text','textnodes','owntext','html','outerhtml','all','content','value','href','src','alt','title','poster','data-src','data-original','data-url']);
// ## 是「阅读」的正则语法：规则##正则 表示删掉匹配到的内容，规则##正则##替换 表示替换（替换串支持 $1）。
function splitRuleRegex(rule) {
  const i = rule.indexOf('##');
  if (i < 0) return {body: rule, regex: null, replacement: null};
  const parts = rule.slice(i + 2).split('##');
  return {body: rule.slice(0, i), regex: parts[0], replacement: parts.length > 1 ? parts.slice(1).join('##') : null};
}
function applyRuleRegex(value, regex, replacement) {
  if (!regex || !value) return value;
  let re;
  try { re = new RegExp(regex, 'gs'); } catch { try { re = new RegExp(regex); } catch { return value; } }
  return replacement === null ? value.replace(re, '') : value.replace(re, replacement);
}
// 模板只允许 {{key}}、{{page}}、{{baseUrl}} 和四则运算，用手写解析器而不是 eval。
function evalExpr(src, vars) {
  const tokens = src.match(/\d+(?:\.\d+)?|[a-zA-Z_]\w*|[+\-*/()]/g) || [];
  if (!tokens.length || tokens.join('') !== src.replace(/\s+/g, '')) throw new Error('不支持的表达式');
  let i = 0;
  const factor = () => {
    const t = tokens[i];
    if (t === undefined) throw new Error('表达式不完整');
    if (t === '-') { i++; return -factor(); }
    if (t === '(') { i++; const v = expr(); if (tokens[i] !== ')') throw new Error('括号不匹配'); i++; return v; }
    if (/^\d/.test(t)) { i++; return Number(t); }
    if (/^[a-zA-Z_]/.test(t)) { i++; if (!(t in vars)) throw new Error(`未知变量 ${t}`); return Number(vars[t]) || 0; }
    throw new Error('表达式无效');
  };
  const term = () => { let v = factor(); while (tokens[i] === '*' || tokens[i] === '/') { const op = tokens[i++]; const r = factor(); v = op === '*' ? v * r : v / r; } return v; };
  const expr = () => { let v = term(); while (tokens[i] === '+' || tokens[i] === '-') { const op = tokens[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; };
  const value = expr();
  if (i !== tokens.length) throw new Error('表达式无效');
  return value;
}
export function fillTemplate(template, key, page, base) {
  return String(template).replace(/\{\{([^}]*)\}\}/g, (whole, raw) => {
    const e = raw.trim();
    if (e === 'key') return encodeURIComponent(key);
    if (e === 'page') return String(page);
    if (e === 'baseUrl' || e === 'host') { try { return new URL(base).origin; } catch { return ''; } }
    try { return String(evalExpr(e, {page:Number(page) || 1})); }
    catch { throw new Error(`searchUrl 里的模板 {{${e}}} 无法计算`); }
  });
}
export function templateSupported(value) {
  return (String(value).match(/\{\{([^}]*)\}\}/g) || []).every(m => {
    const e = m.slice(2, -2).trim();
    if (['key','page','baseUrl','host'].includes(e)) return true;
    try { evalExpr(e, {page:1}); return true; } catch { return false; }
  });
}

// 规则里出现这些，说明必须执行脚本或带登录态，纯 HTTP 引擎无法复刻。
const SCRIPT_ONLY = /@js:|<js>|@put:|@get:|@web|\bjava\.[a-zA-Z]/;
// 只转发这些请求头。Cookie / Authorization 是凭据，Host 能改请求指向，
// 都不在白名单里——书源需要登录态的话本引擎也跑不了。
const ALLOWED_HEADERS = new Set(['user-agent','referer','accept','accept-language','content-type','x-requested-with','origin','cache-control','pragma']);
export function headerIssues(source) {
  if (!source || !source.header) return [];
  let raw = source.header;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return ['header 不是合法 JSON']; } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['header 必须是 JSON 对象'];
  const bad = Object.keys(raw).map(k => String(k).toLowerCase())
    .filter(n => !ALLOWED_HEADERS.has(n) && n !== 'user-agents' && !n.startsWith('x-'));
  return bad.length ? [`自定义请求头暂不支持：${bad.join('、')}（Cookie、Authorization 这类凭据头不会转发）`] : [];
}
export function sourceHeaders(source) {
  if (!source || !source.header) return null;
  let raw = source.header;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return null; } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    let name = String(key).toLowerCase();
    if (name === 'user-agents') name = 'user-agent';
    if (!ALLOWED_HEADERS.has(name) && !name.startsWith('x-')) continue;
    if (typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 500) continue;
    out[name] = value;
  }
  return Object.keys(out).length ? out : null;
}

const REQUIRED_RULES = [['searchUrl','搜索地址'],['ruleSearch.bookList','搜索结果列表'],['ruleSearch.name','书名'],['ruleSearch.bookUrl','书籍链接'],['ruleToc.chapterList','章节目录'],['ruleToc.chapterName','章节名'],['ruleToc.chapterUrl','章节链接'],['ruleContent.content','正文']];
const REQUIRED_PATHS = new Set(REQUIRED_RULES.map(([path]) => path));
const KNOWN_SUB_RULES = {ruleSearch:['bookList','name','author','bookUrl','intro','coverUrl','kind','wordCount','lastChapter','checkKeyWord'],ruleBookInfo:['name','author','intro','tocUrl','coverUrl','kind','wordCount','lastChapter'],ruleToc:['chapterList','chapterName','chapterUrl','nextTocUrl'],ruleContent:['content','nextContentUrl']};
const DANGEROUS_FIELDS = ['jsLib','loginUrl','webJs','loginUi','loginCheckJs','coverDecodeJs'];

// 返回 {errors, warnings}：errors 非空就不导入；多余的可选子规则、算不出来的模板只记 warning——
// 因为一个用不上的 updateTime 字段就把整个书源拒之门外，会把大量本来能用的书源白白丢掉。
export function validateSource(source) {
  const errors = [], warnings = [];
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {errors:['书源必须是 JSON 对象'], warnings};
  if (!source.bookSourceName || !source.bookSourceUrl) errors.push('缺少书源名称或网址');
  else { try { safeURL(source.bookSourceUrl); } catch { errors.push('书源网址无效'); } }
  if (source.adapter) {
    const official = builtins.find(s=>s.adapter===source.adapter && s.bookSourceUrl===source.bookSourceUrl);
    if (!official) errors.push('内置适配器与网址不匹配');
    return {errors, warnings};
  }
  if (source.bookSourceType && source.bookSourceType !== 0) errors.push('目前只支持文本小说源（bookSourceType 为 0）');
  for (const k of DANGEROUS_FIELDS) if (source[k]) errors.push(`${k} 需要执行脚本或登录，纯 HTTP 引擎无法复刻`);
  if (source.header && !['','null','{}'].includes(String(source.header).trim())) errors.push(...headerIssues(source));
  for (const [path, label] of REQUIRED_RULES) {
    const value = path.split('.').reduce((o, k) => o && o[k], source);
    if (!value) errors.push(`缺少${label}规则（${path}）`);
  }
  const inspect = (value, path) => {
    if (typeof value !== 'string' || !value) return;
    // 模板检查只看选择器部分：## 后面是正则，里面的 {{ }} 不是模板。
    const { body: selector } = splitRuleRegex(value);
    if (SCRIPT_ONLY.test(value)) errors.push(`${path} 需要执行脚本，纯 HTTP 引擎无法复刻`);
    else if (/\{\$|\{\{\$|\[[^\]]*:[^\]]*\]|^text\./.test(value)) warnings.push(`${path} 的 JSONPath 写法可能取不到内容`);
    // 必需规则里的模板算不出来，这个书源每次请求都会失败——那是错误，不是提示。
    // 可选子规则（updateTime、kind 之类）算不出来只是少显示一个字段，仍然导入。
    else if (!templateSupported(selector)) (REQUIRED_PATHS.has(path) ? errors : warnings).push(`${path} 含无法计算的模板表达式`);
  };
  for (const group of Object.keys(KNOWN_SUB_RULES)) {
    for (const [key, value] of Object.entries(source[group] || {})) {
      if (!value) continue;
      if (!KNOWN_SUB_RULES[group].includes(key)) warnings.push(`已忽略不支持的 ${group}.${key}`);
      else inspect(value, `${group}.${key}`);
    }
  }
  inspect(source.searchUrl, 'searchUrl');
  if (source.ruleContent?.replaceRegex) warnings.push('已忽略 ruleContent.replaceRegex');
  return {errors:[...new Set(errors)], warnings:[...new Set(warnings)]};
}
export function parseDocument(text) {
  // Parse in an inert document. Remote resources and scripts are stripped before DOM parsing.
  const cleaned = text.replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<(img|link|source|video|audio)\b[^>]*>/gi,'');
  return new DOMParser().parseFromString(cleaned,'text/html');
}
export function readable(node) {
  if (typeof node === 'string') return node.trim();
  if (!node) return '';
  const el = node.cloneNode(true);
  el.querySelectorAll?.('script,style,nav,header,footer,.mw-editsection,.noprint,.ws-noexport,.printfooter,.catlinks,.mw-cite-backlink').forEach(x=>x.remove());
  el.querySelectorAll?.('br').forEach(x=>x.replaceWith('\n'));
  el.querySelectorAll?.('p,div,li,h1,h2,h3,h4,tr,section').forEach(x=>x.append('\n'));
  return (el.textContent || '').replace(/\u00a0/g,' ').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
// 递归查找：$..key 在任意深度找同名字段，和「阅读」的 JSONPath 一致。
function deepFind(node, key, out = [], depth = 0) {
  if (depth > 12 || node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const item of node) deepFind(item, key, out, depth + 1); return out; }
  if (key in node) out.push(node[key]);
  for (const value of Object.values(node)) if (value && typeof value === 'object') deepFind(value, key, out, depth + 1);
  return out;
}
function jsonNodes(root, rule) {
  const value = typeof root === 'string' ? JSON.parse(root) : root;
  const path = rule.replace(/^@json:/i, '').replace(/^\$/, '');
  const tokens = path.match(/\.\.[\w$-]+|\.[\w$-]+|\[\*\]|\[-?\d+\]/g) || [];
  if (!tokens.length) {
    if (path.replace(/[\s.]/g, '')) throw new Error(`不支持此 JSONPath：${rule}`);
    return [value];
  }
  let current = [value];
  for (const token of tokens) {
    if (token === '[*]') current = current.flatMap(x => Array.isArray(x) ? x : [x]);
    else if (/^\[-?\d+\]$/.test(token)) {
      const index = Number(token.slice(1, -1));
      current = current.map(x => Array.isArray(x) ? (index < 0 ? x[x.length + index] : x[index]) : undefined);
    } else if (token.startsWith('..')) current = current.flatMap(x => deepFind(x, token.slice(2)));
    else {
      const key = token.slice(1);
      current = current.map(x => x && typeof x === 'object' ? x[key] : undefined);
    }
    current = current.filter(x => x !== undefined && x !== null);
  }
  return current.flatMap(x => Array.isArray(x) ? x : [x]);
}
// 「阅读」里索引有三种写法：:eq(N)、.N，以及老书源里常见的 !N（例：tr!0 取第一个 tr）。
// 另有 .A:B 取一段（各书源里只出现在 kind 这类展示字段上，见 README 的取舍说明）。
// 返回 [选择器, 索引]；索引为 undefined 表示不限制。注意 class.x 里的 . 不是索引，必须有数字。
export function splitIndex(step) {
  const s = String(step);
  const range = s.match(/\.(-?\d+):(-?\d+)$/);
  if (range) { const a = Number(range[1]), b = Number(range[2]); return [s.slice(0, range.index), {from: Math.min(a, b), to: Math.max(a, b)}]; }
  const m = s.match(/(?::eq\((-?\d+)\)|\.(-?\d+)|!(-?\d+))$/);
  return m ? [s.slice(0, m.index), Number(m[1] ?? m[2] ?? m[3])] : [s, undefined];
}
// 「阅读」用 || 表示「或」、&& 表示「与」。作用在列表规则上时两者都是取并集：
// 两个容器里都可能装着书或章节，只取第一个会静默丢一半。
export function elements(root, raw) {
  const rule = String(raw || '').trim(); if (!rule) return [root];
  if (rule.includes('||') || rule.includes('&&')) {
    const seen = new Set(), out = [];
    for (const part of rule.split(/\|\||&&/)) {
      const branch = part.trim(); if (!branch) continue;
      for (const node of elements(root, branch)) { if (seen.has(node)) continue; seen.add(node); out.push(node); }
    }
    return out;
  }
  if (/^(\$|@json:)/i.test(rule)) return jsonNodes(root, rule);
  if (/^(\/\/|\.\/|@xpath:)/i.test(rule)) {
    const xpath=rule.replace(/^@xpath:/i,'');
    const doc=root.ownerDocument || root; const res=doc.evaluate(xpath,root,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);
    return Array.from({length:res.snapshotLength},(_,i)=>res.snapshotItem(i));
  }
  let current=[root]; const steps=rule.replace(/^@css:/i,'').split('@');
  for (let step of steps) {
    // 「阅读」里索引有三种写法：:eq(N)、.N，以及老书源里常见的 !N（例：tr!0）。
    let idx; [step, idx] = splitIndex(step);
    step=step.replace(/^id\./,'#').replace(/^class\./,'.').replace(/^tag\./,'');
    const next=current.flatMap(x=>Array.from(x.querySelectorAll(step || '*')));
    current = idx===undefined ? next
      : typeof idx==='number' ? (next.at(idx) ? [next.at(idx)] : [])
      : next.slice(idx.from, idx.to + 1);
  }
  return current;
}
function ownTextOf(el) {
  return Array.from(el.childNodes || []).filter(n => n.nodeType === 3).map(n => n.nodeValue).join('').trim();
}
function extractOne(root, rule, base) {
  if (!rule) return '';
  if (/^(\$|@json:)/i.test(rule)) return String(elements(root, rule)[0] ?? '');
  if (/^(\/\/|\.\/|@xpath:)/i.test(rule)) return elements(root, rule).map(n => n.nodeValue ?? n.textContent ?? '').join('\n').trim();
  const segments = rule.split('@');
  const last = segments[segments.length - 1].trim().toLowerCase();
  let attr = 'text', selector = rule;
  // 只有末尾是「阅读」的保留关键字才当属性名，否则整条都是选择器。
  if (segments.length === 1 && TERMINAL_ATTRS.has(last)) { attr = last; selector = ''; }
  else if (segments.length > 1 && TERMINAL_ATTRS.has(last)) { attr = last; selector = segments.slice(0, -1).join('@'); }
  const nodes = elements(root, selector);
  const asText = ['text', 'html', 'outerhtml', 'all', 'textnodes'].includes(attr);
  const text = nodes.map(n => {
    if (asText) return readable(n);
    if (attr === 'owntext') return ownTextOf(n);
    return n.getAttribute?.(attr) || n.nodeValue || '';
  }).join(asText ? '\n' : '').trim();
  return ['href', 'src'].includes(attr) && text ? safeURL(text, base) : text;
}
export function field(root, rule, base) {
  if (!rule) return '';
  const {body, regex, replacement} = splitRuleRegex(String(rule));
  let value = '';
  // || 在标量规则上是「取第一个非空」；&& 是把几段拼起来（分类+状态+更新时间这种）。
  for (const branch of body.split('||')) {
    const joined = branch.split('&&').map(p => extractOne(root, p.trim(), base)).filter(Boolean).join('');
    if (joined) { value = joined; break; }
  }
  return applyRuleRegex(value, regex, replacement).trim();
}
// 展示用的可选字段：取不到只是少显示一列，绝不能因为它的选择器写错就让整条书源的搜索失败。
// 书名和链接是必需的，仍然走 field() 直接抛错——那种失败要让人看见。
function safeField(root, rule, base) { try { return field(root, rule, base); } catch { return ''; } }
function rootFor(text, rule) {return /^(\$|@json:)/i.test(rule || '') ? JSON.parse(text) : parseDocument(text);}
// 老书源里的请求选项常写成 JS 对象字面量（单引号、键名不加引号、换行），不是严格 JSON。
// 先按 JSON 试，失败再补引号重试；仍然失败就按原样报错，不做 eval。
function parseOptions(src) {
  try { return JSON.parse(src); } catch {}
  const json = src
    .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
    .replace(/'((?:[^'\\]|\\.)*)'/g, '"$1"');
  return JSON.parse(json);
}
export function requestSpec(template, key='', page=1, base) {
  // 先摘末尾的请求选项再填模板：否则关键词里带 ,{ 会把选项解析带偏。
  const raw=String(template);
  const match=raw.match(/,\s*(\{[\s\S]*\})\s*$/);
  let options={}; let url=raw;
  if(match){ try{options=parseOptions(match[1]);}catch{throw new Error('searchUrl 末尾的请求选项不是合法 JSON');} url=raw.slice(0,match.index); }
  if(Object.keys(options).some(k=>!['method','body','charset'].includes(k))) throw new Error('请求规则只支持 method、body、charset');
  if(options.body!==undefined && typeof options.body!=='string') throw new Error('POST body 必须是表单字符串');
  const spec={url:safeURL(fillTemplate(url.trim(),key,page,base),base)};
  spec.method=(options.method ? String(options.method) : 'GET').toUpperCase();
  if(options.body!==undefined) spec.body=fillTemplate(options.body,key,page,base);
  if(options.charset) spec.charset=options.charset;
  return spec;
}
export class Engine {
  constructor(fetchPage) {this.fetchPage=fetchPage;}
  async get(url, source, signal) {return this.fetchPage({url,charset:source.charset || undefined,headers:sourceHeaders(source) || undefined},signal);}
  async wiki(source, params, signal) {
    const u=new URL('/w/api.php',source.bookSourceUrl); u.search=new URLSearchParams({...params,format:'json',formatversion:'2',maxlag:'5'});
    const page=await this.get(u.href,source,signal); const data=JSON.parse(page.text);
    if(data.error) throw new Error(data.error.info || '维基文库接口错误'); return data;
  }
  async search(source, keyword, page=1, signal) {
    if(source.adapter==='wiki') {
      const data=await this.wiki(source,{action:'query',list:'search',srsearch:keyword,srnamespace:'0',srlimit:'20',sroffset:String((page-1)*20)},signal);
      return (data.query?.search || []).map(b=>({title:b.title,author:'',intro:readable(parseDocument(b.snippet)),url:`${source.bookSourceUrl}/wiki/${encodeURIComponent(b.title)}`,wikiTitle:b.title,source}));
    }
    if(source.adapter==='gutenberg') {
      const p=await this.get(`https://gutendex.com/books/?search=${encodeURIComponent(keyword)}&copyright=false&page=${page}`,source,signal); const data=JSON.parse(p.text);
      return (data.results || []).map(b=>({title:b.title,author:b.authors.map(a=>a.name).join(' / '),intro:(b.summaries || b.subjects || []).join(' '),url:`https://www.gutenberg.org/ebooks/${b.id}`,formats:b.formats,lang:b.languages?.[0] || 'und',source}));
    }
    const response=await this.fetchPage(requestSpec(source.searchUrl,keyword,page,source.bookSourceUrl),signal);
    const r=source.ruleSearch, root=rootFor(response.text,r.bookList);
    return elements(root,r.bookList).slice(0,100).map(el=>({title:field(el,r.name,response.url),author:safeField(el,r.author,response.url),intro:safeField(el,r.intro,response.url),url:field(el,r.bookUrl,response.url),kind:safeField(el,r.kind,response.url),wordCount:safeField(el,r.wordCount,response.url),lastChapter:safeField(el,r.lastChapter,response.url),source})).filter(b=>b.title && b.url).map(b=>({...b,url:safeURL(b.url,response.url)}));
  }
  async toc(book, signal, progress=()=>{}) {
    const source=book.source, notes=[];
    if(source.adapter==='gutenberg') {
      const formats=Object.entries(book.formats || {}); const text=formats.find(([k])=>k==='text/plain; charset=utf-8') || formats.find(([k])=>k.startsWith('text/plain'));
      if(!text) throw new Error('该版本没有可用的 TXT 正文，请查看原站其他版本');
      return {chapters:[{title:book.title,url:text[1]}],notes:['来源标注为美国公版；请核对所在地适用情况。单一全文文件，无法独立核对章数。'],complete:true};
    }
    if(source.adapter==='wiki') {
      const data=await this.wiki(source,{action:'parse',page:book.wikiTitle,prop:'text|categories|revid'},signal);
      const doc=parseDocument(data.parse.text); const prefix=book.wikiTitle+'/'; const seen=new Set(); const chapters=[];
      for(const a of doc.querySelectorAll('a[href]')) {
        let u; try {u=new URL(a.getAttribute('href'),source.bookSourceUrl);} catch {continue;}
        if(u.origin!==new URL(source.bookSourceUrl).origin || !u.pathname.startsWith('/wiki/') || a.classList.contains('new')) continue;
        const title=decodeURIComponent(u.pathname.slice(6)).replace(/_/g,' ');
        if(title.startsWith(prefix) && !seen.has(title)){seen.add(title);chapters.push({title:a.textContent.trim() || title,wikiTitle:title,url:u.href});}
      }
      const categories=(data.parse.categories || []).map(c=>c.category || c['*']).filter(Boolean);
      notes.push(`来源页面修订号：${data.parse.revid}；分类：${categories.join('、') || '无'}`);
      notes.push('维基文库仅自动识别书名/子页面链接；目录可能含其他命名方式或版本，需与原站核对。');
      return {chapters:chapters.length?chapters:[{title:book.title,url:book.url,wikiTitle:book.wikiTitle}],notes,complete:false};
    }
    let response=await this.get(book.url,source,signal); const info=source.ruleBookInfo || {};
    const infoRoot=rootFor(response.text,info.tocUrl || info.name);
    if(info.author) book.author=safeField(infoRoot,info.author,response.url) || book.author;
    const tocURL=field(infoRoot,info.tocUrl,response.url);
    if(tocURL && safeURL(tocURL,response.url)!==response.url) response=await this.get(safeURL(tocURL,response.url),source,signal);
    const chapters=[], visited=new Set(), urls=new Set(); const r=source.ruleToc;
    for(let n=0;n<50;n++) {
      if(visited.has(response.url)) throw new Error('目录分页循环，已停止以避免遗漏或重复'); visited.add(response.url);
      const root=rootFor(response.text,r.chapterList); const rows=elements(root,r.chapterList);
      if(!rows.length) throw new Error('目录规则没有匹配到章节，可能是网站改版或拦截页');
      for(const el of rows){const raw=field(el,r.chapterUrl,response.url),title=field(el,r.chapterName,response.url);if(!raw||!title) throw new Error('目录存在缺少标题或链接的条目，请修正规则');const url=safeURL(raw,response.url); if(urls.has(url)){notes.push(`重复目录链接：${title}`);continue;}urls.add(url);chapters.push({title,url});}
      if(chapters.length>5000) throw new Error('超过 5000 章限制，请分卷抓取');
      progress(`已识别 ${chapters.length} 章，目录第 ${n+1} 页`);
      const next=field(root,r.nextTocUrl,response.url);
      if(!next) return {chapters,notes:[...new Set(notes)],complete:true};
      response=await this.get(safeURL(next,response.url),source,signal);
    }
    throw new Error('目录超过 50 页，未获取完整目录，已停止');
  }
  async chapter(chapter, source, signal) {
    if(source.adapter==='wiki') {
      const data=await this.wiki(source,{action:'parse',page:chapter.wikiTitle,prop:'text|revid'},signal);
      const doc=parseDocument(data.parse.text);
      // Child catalogues cannot silently be treated as chapter prose.
      const deeper=[...doc.querySelectorAll('a[href]')].some(a=>{try{return decodeURIComponent(a.getAttribute('href')).includes('/wiki/'+chapter.wikiTitle+'/');}catch{return false;}});
      if(deeper) throw new Error('此项可能是下一级目录，请打开原站并单独选择对应分卷');
      return {text:readable(doc.querySelector('.mw-parser-output') || doc.body),revision:data.parse.revid};
    }
    if(source.adapter==='gutenberg') {const p=await this.get(chapter.url,source,signal);return {text:p.text};}
    const r=source.ruleContent, visited=new Set(), chunks=[]; let url=chapter.url;
    for(let page=0;page<20;page++) {
      if(visited.has(url)) throw new Error('正文分页循环');visited.add(url);
      const response=await this.get(url,source,signal); const root=rootFor(response.text,r.content);
      const text=field(root,r.content,response.url);if(!text.trim()) throw new Error('正文为空，请检查正文规则或访问限制'); chunks.push(text);
      const next=field(root,r.nextContentUrl,response.url);if(!next) return {text:chunks.join('\n\n')};url=safeURL(next,response.url);
    }
    throw new Error('单章超过 20 页，已停止以避免不完整下载');
  }
}
