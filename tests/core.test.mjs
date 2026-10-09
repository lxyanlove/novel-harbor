import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker,{checkURL,proxy,limitedBody,safeHeaders,openProxy,allowedHosts,normalizeCharset} from '../src/worker.js';
import {chapterNumber,analyze,rankVersions,scanChapter} from '../public/quality.js';
import {validateSource,requestSpec,safeURL,titleKey,field,elements,fillTemplate,sourceHeaders,headerIssues,sourceHosts,splitIndex} from '../public/engine.js';
import {makeEPUB,makeTXT} from '../public/export.js';

const root = new URL('../', import.meta.url);
const paragraph = '他站在窗前，看着外面的雨。雨点敲打着玻璃，发出细碎的声音，像是谁在低声说着什么。';
const cleanChapter = Array.from({length:14}, (_, i) => paragraph + `他想起很多年前的那个下午，也是这样的天气。（第${i}段）`).join('\n');
function makeJob(texts, extra = {}) {
  return {book:{title:'测试书'}, tocComplete:true, chapters:texts.map((text, i) => ({title:`第${i+1}章 标题`, state:'done', text})), ...extra};
}
const repeat = (text, n) => Array.from({length:n}, () => text);
// 真实书籍不会每章正文一字不差；给每章插一个标记，避免测试自己触发“整章重复”检查。
const unique = (n, base = cleanChapter) => Array.from({length:n}, (_, i) => base.replace('（第0段）', `（第0段-${i}）`));
test('URL checks reject SSRF, credentials, nonstandard ports and disallowed redirects',async()=>{
  for(const u of ['http://127.0.0.1','https://localhost','file:///tmp/a','https://good.example@evil.example/','https://good.example:8080/'])assert.throws(()=>checkURL(u,['good.example','localhost','127.0.0.1']));
  assert.equal(checkURL('https://good.example/book',['good.example']).pathname,'/book');
  let calls=0;await assert.rejects(proxy({url:'https://good.example'},{ALLOWED_HOSTS:'good.example'},async()=>{calls++;return new Response('',{status:302,headers:{location:'http://127.0.0.1'}});}),/未获/);assert.equal(calls,1);
});
test('proxy preserves POST and decodes legacy text',async()=>{
  let request;const result=await proxy({url:'https://good.example/search',method:'POST',body:'q=book',charset:'gbk'},{ALLOWED_HOSTS:'good.example'},async(url,opts)=>{request=opts;return new Response(new Uint8Array([0xd6,0xd0,0xce,0xc4]),{headers:{'content-type':'text/plain'}});});
  assert.equal(request.body,'q=book');assert.equal(result.text,'中文');
});
test('bounded reads stop oversized chunked response',async()=>{await assert.rejects(limitedBody(new Response('123456'),5),/限制/);});
test('authentication and cross-origin writes are rejected',async()=>{
  let r=await worker.fetch(new Request('https://app.example/api/fetch',{method:'POST',body:'{}'}),{ACCESS_TOKEN:'secret'},{});assert.equal(r.status,401);
  r=await worker.fetch(new Request('https://app.example/api/fetch',{method:'POST',headers:{origin:'https://evil.example'},body:'{}'}),{},{});assert.equal(r.status,403);
});
test('chapter numbers and quality never certify proofreading',()=>{
  assert.equal(chapterNumber('第一百零二章 寻书'),102);assert.equal(chapterNumber('第十二回'),12);assert.equal(chapterNumber('第1001章'),1001);
  const job={book:{title:'精校版'},tocComplete:true,chapters:[{title:'第一章',state:'done',text:'好故事。'.repeat(40)},{title:'第三章',state:'done',text:'好故事。'.repeat(40)},{title:'第四章',state:'error',error:'失败'}]};const r=analyze(job);assert.equal(r.conclusion,'抓取不完整');assert.ok(r.issues.some(i=>i.message.includes('跳到')));assert.ok(r.issues.some(i=>i.message.includes('正文相同')));assert.match(r.proofread,/未独立验证/);
});
test('导入：拒绝脚本源，保留「阅读」规则子集，可选子规则只提示',()=>{
  const s={bookSourceName:'Test',bookSourceUrl:'https://good.example',searchUrl:'/search?q={{key}}',ruleSearch:{bookList:'.book',name:'a@text',bookUrl:'a@href'},ruleToc:{chapterList:'.chapters a',chapterName:'@text',chapterUrl:'@href'},ruleContent:{content:'#content@html'}};
  assert.deepEqual(validateSource(s).errors,[]);
  s.ruleContent.content='@js:java.ajax(url)';
  assert.ok(validateSource(s).errors.some(x=>x.includes('脚本')),'需要执行脚本的规则必须拒绝');
  s.ruleContent.content='id.content@html';
  assert.deepEqual(validateSource(s).errors,[]);
  // 用不上的可选子规则只记提示：一个 updateTime 不该让整条书源作废。
  s.ruleToc={...s.ruleToc,updateTime:'.time@text'};
  const report=validateSource(s);
  assert.deepEqual(report.errors,[]);
  assert.ok(report.warnings.some(x=>x.includes('ruleToc.updateTime')));
  assert.deepEqual(requestSpec('/search,{"method":"POST","body":"q={{key}}&page={{page}}"}','红楼梦',2,'https://good.example'),{url:'https://good.example/search',method:'POST',body:'q=%E7%BA%A2%E6%A5%BC%E6%A2%A6&page=2'});
  assert.throws(()=>safeURL('javascript:alert(1)'));
});
test('「阅读」规则：|| 取第一个非空、&& 拼接、## 替换、$.. 递归 JSONPath',()=>{
  const data={book:{name:'活着',status:'连载',id:7},list:[{title:'甲'},{title:'乙'}]};
  // || ：前面的取不到就用后面的
  assert.equal(field(data,'$.missing||$.book.name'),'活着');
  assert.equal(field(data,'$.book.name||$.book.status'),'活着');
  // && ：按顺序拼起来，这是「分类+状态+更新时间」这类字段的常见写法
  assert.equal(field(data,'$.book.name&&$.book.status'),'活着连载');
  // ## ：删掉匹配内容；##正则##替换 支持 $1
  assert.equal(field({x:'《活着》全本下载'},'$.x##《|》|全本下载'),'活着');
  assert.equal(field({x:'作者：余华'},'$.x##(.+)：(.*)##$2'),'余华');
  // $.. 递归查找 + [*] 展开
  assert.deepEqual(elements(data,'$..title[*]'),['甲','乙']);
  assert.equal(field(data,'$..name'),'活着');
  // 模板里的四则运算
  assert.equal(fillTemplate('/s?q={{key}}&p={{page}}&off={{(page-1)*10}}','红楼梦',3,'https://good.example'),'/s?q=%E7%BA%A2%E6%A5%BC%E6%A2%A6&p=3&off=20');
  assert.throws(()=>fillTemplate('/s?q={{key}}&x={{process.exit(1)}}','a',1,'https://good.example'),/无法计算/);
});
test('EPUB is real ZIP with uncompressed first mimetype; TXT preserves missing markers',async()=>{
  const job={book:{title:'甲 & 乙',url:'https://good.example/book',author:'作者',source:{lang:'zh'}},tocComplete:true,chapters:[{title:'第一章',state:'done',text:'中文 <内容>\n第二段'},{title:'第二章',state:'error',error:'超时'}]},report=analyze(job);
  const bytes=new Uint8Array(await makeEPUB(job,report).arrayBuffer()),v=new DataView(bytes.buffer);assert.equal(v.getUint32(0,true),0x04034b50);assert.equal(v.getUint16(8,true),0);
  const n=v.getUint16(26,true);assert.equal(new TextDecoder().decode(bytes.slice(30,30+n)),'mimetype');assert.equal(new TextDecoder().decode(bytes.slice(30+n,30+n+20)),'application/epub+zip');
  const text=new TextDecoder().decode(bytes);assert.ok(text.includes('甲 &amp; 乙'));assert.ok(text.includes('epub:type="toc"'));assert.ok(text.includes('[缺失章节：超时]'));
  assert.match(await makeTXT(job,report).text(),/\[缺失章节：超时\]/);
});

test('文本质量体检：干净满分，广告/乱码/截断/重复各自扣分', () => {
  const clean = analyze(makeJob(unique(20)));
  assert.equal(clean.score, 100);
  assert.equal(clean.grade, 'clean');
  assert.equal(clean.issues.length, 0);
  assert.equal(clean.conclusion, '未发现明显抓取异常');

  const ad = analyze(makeJob(unique(20, cleanChapter + '\n一秒记住本站地址 www.biquge123.com 笔趣阁最新章节无弹窗！')));
  assert.ok(ad.quality.groups.find(g => g.id === 'ad').penalty >= 20, '整本带广告水印应判为硬伤');
  assert.notEqual(ad.grade, 'clean');
  assert.ok(ad.issues.some(i => i.kind === 'quality' && i.level === 'error'));
  assert.equal(ad.quality.groups.find(g => g.id === 'ad').chaptersHit, 20);

  const garbled = analyze(makeJob(unique(20, cleanChapter.replace(paragraph, '他站在窗前，����锟斤拷一片□□□□。'))));
  assert.equal(garbled.grade, 'severe');
  assert.equal(garbled.conclusion, '文本质量存疑');

  const cut = analyze(makeJob(unique(20, cleanChapter.slice(0, -1) + '于是他')));
  assert.ok(cut.quality.groups.find(g => g.id === 'cut').penalty >= 20, '每章都以非句末标点结尾应被扣分');
  assert.equal(cut.grade, 'warning');

  const dup = analyze(makeJob(unique(20, cleanChapter + '\n' + cleanChapter.split('\n').slice(0, 6).join('\n'))));
  assert.ok(dup.quality.groups.find(g => g.id === 'dup').penalty >= 20);
  assert.equal(dup.grade, 'warning');
});

test('短章判定以本书自身为基准，不误伤短篇文集', () => {
  const anthology = analyze(makeJob(repeat(paragraph, 20)));
  assert.equal(anthology.quality.groups.find(g => g.id === 'short').penalty, 0, '整本都是短章不应按“空章”扣分');
  assert.equal(anthology.score, 100);
  assert.ok(anthology.issues.some(i => i.message.includes('不足 80 字')), '仍应逐条提示但不定性');
});

test('零星章节失败不否定整本，成片失败才判为抓取不完整', () => {
  const build = failFrom => ({book:{title:'测试书'}, tocComplete:true, chapters:Array.from({length:100}, (_, i) => i >= failFrom
    ? {title:`第${i+1}章 标题`, state:'error', error:'超时'}
    : {title:`第${i+1}章 标题`, state:'done', text:cleanChapter})});
  const one = analyze(build(99));
  assert.equal(one.completeness.score, 99);
  assert.equal(one.conclusion, '需要人工核验');
  assert.ok(one.score > 90, '单章失败不应把总分压到 45');
  const many = analyze(build(80));
  assert.equal(many.completeness.score, 80);
  assert.equal(many.conclusion, '抓取不完整');
  assert.ok(many.score <= 45);
});

test('抽样体检不冒充完整性结论', () => {
  const sampled = analyze({book:{title:'测试书'}, tocComplete:true, sampled:true, chapters:[
    {title:'第1章', state:'done', text:cleanChapter},
    {title:'第2章', state:'skipped'},
    {title:'第3章', state:'done', text:cleanChapter + '\n一秒记住本站 笔趣阁最新章节无弹窗！'},
  ]});
  assert.equal(sampled.completeness.available, false);
  assert.equal(sampled.completeness.score, null);
  assert.match(sampled.verdict, /抽样 2 章/);
  assert.notEqual(sampled.conclusion, '未发现明显抓取异常');
});

test('书名里的“精校版”只作为来源自述，不加分', () => {
  const claimed = analyze({...makeJob(repeat(cleanChapter, 20)), book:{title:'某某小说（精校版）'}});
  const plain = analyze(makeJob(repeat(cleanChapter, 20)));
  assert.equal(claimed.score, plain.score);
  assert.match(claimed.proofread, /未独立验证/);
  assert.match(plain.proofread, /无法从正文自动确认/);
});

test('版本对比按章数优先，其次完整性与文本质量', () => {
  const report = makeJob(repeat(cleanChapter, 20));
  const rank = rankVersions([
    {label:'少章', chapters:100, report:analyze(report)},
    {label:'全本干净', chapters:500, report:analyze(report)},
    {label:'全本带广告', chapters:500, report:analyze(makeJob(repeat(cleanChapter + '\n一秒记住本站 笔趣阁最新章节无弹窗！', 20)))},
  ]);
  assert.equal(rank[0].label, '全本干净');
  assert.equal(rank[1].label, '全本带广告');
  assert.equal(rank[2].label, '少章');
});

test('书名归一化把不同书源的同名书归到一组', () => {
  assert.equal(titleKey('《凡人修仙传》'), titleKey('凡人修仙传'));
  assert.equal(titleKey('斗 破 苍 穹'), titleKey('斗破苍穹'));
  assert.notEqual(titleKey('斗破苍穹'), titleKey('斗破苍穹II'));
});

test('老书源的 JS 对象字面量请求选项能被解析，真正的脚本选项仍然拒绝', () => {
  // 单引号 + 换行，这是合集里最常见的写法，严格 JSON.parse 会直接判为「不是合法 JSON」
  assert.deepEqual(requestSpec("/search/result.html,{\n  'method': 'post',\n  'body': 'searchkey={{key}}'\n}", '斗破苍穹', 1, 'https://good.example'),
    {url:'https://good.example/search/result.html', method:'POST', body:'searchkey=%E6%96%97%E7%A0%B4%E8%8B%8D%E7%A9%B9'});
  // 键名不加引号也常见
  assert.equal(requestSpec('/s,{method:"POST",body:"q=1"}', 'a', 1, 'https://good.example').method, 'POST');
  // webView 是脚本能力，转成 JSON 之后要落到「只支持 method/body/charset」，不能悄悄放行
  assert.throws(() => requestSpec("/s,{'webView': true}", 'a', 1, 'https://good.example'), /只支持 method、body、charset/);
});

test('编码名别名：gb2312 按 gbk 处理，不认识的名字要报错而不是当 UTF-8 解', () => {
  assert.equal(normalizeCharset('gb2312'), 'gbk');
  assert.equal(normalizeCharset('GB-2312'), 'gbk');
  assert.equal(normalizeCharset(' ansi '), 'gbk');
  assert.equal(normalizeCharset('UTF-8'), 'utf-8');
  assert.equal(normalizeCharset('Big5'), 'big5');
  assert.equal(normalizeCharset('rot13'), '');
  assert.equal(normalizeCharset(undefined), '');
});

test('索引三种写法都能拆出来，class.x 里的点不会被当成索引', () => {
  // 老书源的 tr!0 与 div.2、li:eq(-1) 等价；漏掉 ! 会让整条选择器直接报无效。
  assert.deepEqual(splitIndex('tr!0'), ['tr', 0]);
  assert.deepEqual(splitIndex('#list tr!1'), ['#list tr', 1]);
  assert.deepEqual(splitIndex('div.2'), ['div', 2]);
  assert.deepEqual(splitIndex('li:eq(-1)'), ['li', -1]);
  assert.deepEqual(splitIndex('tag.div!3'), ['tag.div', 3]);
  // 这些点是类名/属性的一部分，不是索引
  assert.deepEqual(splitIndex('class.book-list'), ['class.book-list', undefined]);
  assert.deepEqual(splitIndex('a[href$=".html"]'), ['a[href$=".html"]', undefined]);
  assert.deepEqual(splitIndex('#content'), ['#content', undefined]);
  // .A:B 取一段（合集里只出现在 kind 这类展示字段），顺序写反也要给出同一段
  assert.deepEqual(splitIndex('td.5:4'), ['td', {from:4, to:5}]);
  assert.deepEqual(splitIndex('p.4:5'), ['p', {from:4, to:5}]);
  // CSS 伪类不能被当成范围
  assert.deepEqual(splitIndex('.list:hover'), ['.list:hover', undefined]);
});

test('必需规则的模板算不出来就是错误，可选子规则只提示', () => {
  const base = {bookSourceName:'测试', bookSourceUrl:'https://good.example',
    ruleSearch:{bookList:'.book', name:'.name', bookUrl:'a@href'}, ruleToc:{chapterList:'.ch', chapterName:'a@text', chapterUrl:'a@href'}, ruleContent:{content:'#content'}};
  // 老书源常见的 {{cookie.removeCookie(...)}}：导入成功也永远搜不到，必须在导入时就拦下
  const broken = {...base, searchUrl:'/search?q={{key}}&c={{cookie.removeCookie(source.getKey())}}'};
  assert.match(validateSource(broken).errors.join(), /searchUrl 含无法计算的模板表达式/);
  // 同样算不出来的表达式出现在可选子规则里，只是少一个字段，仍然导入
  const optional = {...base, searchUrl:'/search?q={{key}}', ruleBookInfo:{kind:'{{whatever.thing}}'}};
  assert.deepEqual(validateSource(optional).errors, []);
  assert.match(validateSource(optional).warnings.join(), /ruleBookInfo.kind 含无法计算的模板表达式/);
  // ## 后面是正则，里面的花括号不是模板，不能误判
  const regexy = {...base, searchUrl:'/search?q={{key}}', ruleToc:{...base.ruleToc, chapterName:'a@text##\\{\\{.*?\\}\\}'}};
  assert.deepEqual(validateSource(regexy).errors, []);
});

test('域名白名单：去重排序、www 与裸域分开、内置适配器和坏网址都排除', () => {
  assert.deepEqual(sourceHosts([
    {bookSourceUrl:'https://www.a.com/search'},
    {bookSourceUrl:'https://a.com/search'},      // 与 www.a.com 是两条，白名单精确匹配
    {bookSourceUrl:'https://www.a.com/other'},   // 重复
    {bookSourceUrl:'https://b.com/'},
    {bookSourceUrl:'https://gutendex.com', adapter:'gutenberg'}, // 内置适配器自带域名
    {bookSourceUrl:'不是网址'},
    {adapter:'wiki', bookSourceUrl:'https://zh.wikisource.org'},
  ]), ['a.com','b.com','www.a.com']);
});

test('导出的 TXT 与 EPUB 都带上体检报告', async () => {
  const job = {book:{title:'甲 & 乙', url:'https://good.example/book', author:'作者', source:{lang:'zh'}}, tocComplete:true,
    chapters:[{title:'第一章', state:'done', text:cleanChapter}, {title:'第二章', state:'done', text:cleanChapter}]};
  const report = analyze(job);
  const txt = await makeTXT(job, report).text();
  assert.match(txt, /体检结论：/);
  assert.match(txt, /文本质量：100\/100/);
  assert.match(txt, /校对声明：/);
  const epub = new TextDecoder().decode(new Uint8Array(await makeEPUB(job, report).arrayBuffer()));
  assert.match(epub, /体检报告/);
  assert.match(epub, /抓取完整性/);
});

test('app.js 引用的元素 id 与 data-close 目标都存在于 index.html', () => {
  const app = readFileSync(new URL('public/app.js', root), 'utf8');
  const html = readFileSync(new URL('public/index.html', root), 'utf8');
  const ids = [...new Set([...app.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]))];
  assert.ok(ids.length > 10, `应提取到若干元素 id，实际 ${ids.length}`);
  // 有些元素（例如任务详情里的“预期章数”输入框）由 app.js 自己生成，因此也接受它出现在模板里。
  assert.deepEqual(ids.filter(id => !html.includes(`id="${id}"`) && !app.includes(`id="${id}"`)), [], 'app.js 引用了不存在的元素');
  const targets = [...new Set([...html.matchAll(/data-close="([\w-]+)"/g)].map(m => m[1]))];
  assert.deepEqual(targets.filter(id => !html.includes(`id="${id}"`)), [], 'data-close 指向了不存在的 dialog');
});

test('书源自定义请求头：只转发白名单，凭据头与换行一律挡住',async()=>{
  assert.deepEqual(safeHeaders({'User-Agent':'X','Referer':'https://a.example/','Cookie':'a=b','Authorization':'Bearer t','Host':'evil.example','X-Custom':'1','Bad Name':'x'}),
    {'user-agent':'X','referer':'https://a.example/','x-custom':'1'});
  assert.deepEqual(safeHeaders({'A':'x\r\nInjected: 1'}),{});
  assert.deepEqual(safeHeaders({'Cookie':'secret'}),{});
  assert.deepEqual(sourceHeaders({header:'{"User-Agents":"UA","Cookie":"x","X-Need":"1"}'}),{'user-agent':'UA','x-need':'1'});
  assert.ok(headerIssues({header:'{"Cookie":"x"}'}).length,'Cookie 应当被明确拒绝而不是静默忽略');
  assert.deepEqual(headerIssues({header:'{"User-Agent":"UA"}'}),[]);
  let seen;
  await proxy({url:'https://good.example/book',headers:{'User-Agent':'SourceUA','Cookie':'secret'}},{ALLOWED_HOSTS:'good.example'},
    async(url,opts)=>{seen=opts.headers;return new Response('ok',{headers:{'content-type':'text/html'}});});
  assert.equal(seen['user-agent'],'SourceUA','书源指定的 UA 要真的作用到上游请求');
  assert.equal(seen.cookie,undefined,'Cookie 不能透传到上游');
});

test('设了访问口令就放开域名白名单，但 IP 与内网地址始终拦',async()=>{
  assert.equal(openProxy({}),false);
  assert.equal(openProxy({ACCESS_TOKEN:'t'}),true);
  assert.equal(openProxy({ACCESS_TOKEN:'t',STRICT_ALLOWED_HOSTS:'1'}),false,'想强制白名单时 STRICT_ALLOWED_HOSTS 必须能覆盖');
  assert.deepEqual(allowedHosts({ALLOWED_HOSTS:'A.example, b.example'}),['a.example','b.example']);
  // 白名单模式：没列出来的域名拒绝
  assert.throws(()=>checkURL('https://novel.example/book',['good.example']),/未获站点配置允许/);
  // 放开模式：任意公网域名都行
  assert.equal(checkURL('https://novel.example/book',[],true).hostname,'novel.example');
  // 但两种模式下 IP 和内网名字都不能碰
  for(const u of ['http://127.0.0.1','https://localhost/a','https://foo.internal/a','https://169.254.169.254/latest/meta-data/','https://novel.example:8080/a'])
    assert.throws(()=>checkURL(u,[],true),/不支持本地或 IP|只支持无用户名密码/);
  // 真的能通过代理抓一个没列出的域名；同样的请求在没设口令时会被挡下
  let called=0;
  const r=await proxy({url:'https://novel.example/book'},{ACCESS_TOKEN:'t'},async()=>{called++;return new Response('ok',{headers:{'content-type':'text/html'}});});
  assert.equal(called,1);assert.equal(r.text,'ok');
  await assert.rejects(proxy({url:'https://novel.example/book'},{},async()=>new Response('ok')),/未获站点配置允许/);
  await assert.rejects(proxy({url:'https://novel.example/book'},{ACCESS_TOKEN:'t',STRICT_ALLOWED_HOSTS:'1'},async()=>new Response('ok')),/未获站点配置允许/);
});
test('/api/config 报告当前的放行模式',async()=>{
  let body=await (await worker.fetch(new Request('https://app.example/api/config'),{ALLOWED_HOSTS:'good.example'},{})).json();
  assert.equal(body.openProxy,false);assert.equal(body.requiresToken,false);assert.deepEqual(body.hosts,['good.example']);
  body=await (await worker.fetch(new Request('https://app.example/api/config'),{ALLOWED_HOSTS:'good.example',ACCESS_TOKEN:'t'},{})).json();
  assert.equal(body.openProxy,true);assert.equal(body.requiresToken,true);
});
