import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
// 默认启动本地 Chromium。设置 CDP_ENDPOINT 可以复用一个已经开着的浏览器
// （例如 Windows 上的 Chrome --remote-debugging-port=9222），在无法安装
// Chromium 系统依赖的环境里同样能跑完整流程。
const remote=process.env.CDP_ENDPOINT;
const browser=remote ? await chromium.connectOverCDP(remote) : await chromium.launch({channel:'chrome',headless:true});
// 每次都用全新的浏览器上下文：书源、任务和设置都存在 IndexedDB 里，
// 复用旧配置文件会让下一次运行从一个被污染的状态开始。
let context;
try{context=await browser.newContext({viewport:{width:1440,height:1050}});}
catch{context=browser.contexts()[0]||await browser.newContext();}
const page=await context.newPage();
await mkdir('test-results',{recursive:true});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
// 逐步打印进度：浏览器集成测试一旦卡住，没有标记就只能靠猜。
const step=name=>console.log('· '+name);
try{
  step('打开首页');
  await page.goto('http://127.0.0.1:8787/');await page.waitForFunction(()=>document.querySelector('#source-count').textContent==='2');
  await page.setViewportSize({width:1440,height:1050});
  await page.screenshot({path:'test-results/home-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/home-mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1440,height:1050});
  let failSecond=true;
  const long='这是测试章节中的一段完整正文，用来核对抓取和导出流程。'.repeat(9);
  // 搜索引擎兜底用的固定响应：两条同域结果（应合并成 1 个候选）、一条百科（应被过滤）。
  const bingFixture='<ol id="b_results">'
    +'<li class="b_algo"><h2><a href="https://www.novel.example/book/1">测试小说 在线阅读</a></h2><div class="b_caption"><p>测试免费阅读站点</p></div><cite>https://www.novel.example › book</cite></li>'
    +'<li class="b_algo"><h2><a href="https://www.novel.example/book/2">测试小说 全集</a></h2><div class="b_caption"><p>另一个页面</p></div><cite>https://www.novel.example › book</cite></li>'
    +'<li class="b_algo"><h2><a href="https://baike.baidu.com/item/测试">测试_百度百科</a></h2><div class="b_caption"><p>百科条目</p></div><cite>https://baike.baidu.com</cite></li>'
    +'</ol>';
  const probeFixture='<html><body><h1>测试 搜索结果</h1>'+Array.from({length:8},(_,i)=>`<a href="/book/${i}">测试小说 ${i}</a>`).join('')+'</body></html>';
  const pages={
    '/search?q=%E6%B5%8B%E8%AF%95&page=1':'<div class="book"><a href="/book">测试小说</a><span class="author">测试作者</span></div>',
    '/book':'<a class="toc" href="/toc">目录</a>',
    '/toc':'<ul class="chapters"><li><a href="/c1">第一章 初见</a></li></ul><a class="next" href="/toc2">下一页</a>',
    '/toc2':'<ul class="chapters"><li><a href="/c2">第二章 归来</a></li></ul>',
    '/c1':`<article id="content"><p>${long}</p></article><a class="next" href="/c1-2">下一页</a>`,
    '/c1-2':'<article id="content"><p>第一页之后的第二页内容，不能遗漏。</p></article>',
    '/c2':`<article id="content"><p>另一段故事。${long}</p></article>`
  };
  await page.route('**/api/fetch',async route=>{const input=route.request().postDataJSON(),u=new URL(input.url);
    if(u.hostname==='cn.bing.com')return route.fulfill({json:{text:bingFixture,url:input.url}});
    // 只让 ?s= 这一种搜索写法命中，其余返回“能访问但没有这本书”的页面——用来验证逐个尝试的逻辑。
    if(u.hostname.endsWith('novel.example'))return route.fulfill({json:{text:u.searchParams.has('s')?probeFixture:'<html><body><a href="/a">首页</a><a href="/b">分类</a><a href="/c">排行</a><a href="/d">书架</a><a href="/e">关于</a></body></html>',url:input.url}});
    if(u.pathname==='/c2'&&failSecond)return route.fulfill({status:400,json:{error:'书源返回 HTTP 403，测试失败恢复'}});const text=pages[u.pathname+u.search];await route.fulfill(text?{json:{text,url:input.url}}:{status:400,json:{error:'测试未配置：'+u.href}});});
  await page.getByRole('button',{name:/书源管理/}).click();
  const enabledIndexes=await page.locator('[data-source-toggle]:checked').evaluateAll(nodes=>nodes.map(n=>n.dataset.sourceToggle));
  for(const index of enabledIndexes)await page.locator(`[data-source-toggle="${index}"]`).uncheck();
  const source={bookSourceName:'集成测试书源',bookSourceUrl:'https://fixture.example',searchUrl:'/search?q={{key}}&page={{page}}',ruleSearch:{bookList:'.book',name:'a@text',author:'.author@text',bookUrl:'a@href'},ruleBookInfo:{tocUrl:'.toc@href'},ruleToc:{chapterList:'.chapters li',chapterName:'a@text',chapterUrl:'a@href',nextTocUrl:'.next@href'},ruleContent:{content:'#content@html',nextContentUrl:'.next@href'}};
  await page.locator('#source-json').fill(JSON.stringify(source));await page.locator('#import-source').click();await page.waitForFunction(()=>document.querySelector('#import-report').textContent.includes('已读取 1 个书源；导入 1 个'));
  await page.locator('[data-close="sources-dialog"]').click();await page.locator('#query').fill('测试');await page.locator('#search-btn').click();
  await page.locator('[data-health="0"]').waitFor();
  assert.match(await page.locator('.book-card').first().innerText(),/先体检/, '每张结果卡片都应提供下载前体检入口');
  // 下载前体检：只抽样几章，就能看清文本质量与章节完整度，不必先下一整本。
  await page.locator('[data-health="0"]').click();
  await page.locator('#health-body .report-card').waitFor({timeout:20000});
  step('下载前体检完成');
  const healthText=await page.locator('#health-body').innerText();
  assert.match(healthText,/抽样 2 章/,'体检结论必须说明只抽样了部分章节');
  assert.match(healthText,/文本质量/);
  assert.match(healthText,/校对声明/);
  await page.screenshot({path:'test-results/health-desktop.png',fullPage:true});
  // 同书对比：这里只有一个来源，应给出明确说明而不是留一片空白。
  await page.locator('#health-compare').click();
  await page.locator('#health-extra .report-card, #health-extra .compare-list').waitFor();
  assert.match(await page.locator('#health-extra').innerText(),/没有其他来源/);
  await page.locator('[data-close="health-dialog"]').click();
  step('同书对比');
  // 搜索引擎兜底：列出候选站点 → 探测搜索页 → 生成书源模板。
  await page.locator('#discover-btn').click();
  await page.locator('#discover-body .compare-list').waitFor({timeout:20000});
  assert.deepEqual(await page.locator('#discover-body .compare-row b').allInnerTexts(),['novel.example'],'同域结果应合并成一个候选，百科结果应被过滤');
  assert.match(await page.locator('#discover-body').innerText(),/已过滤 1 个/);
  await page.locator('[data-probe="0"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-probe="0"]')?.disabled,undefined,{timeout:30000});
  assert.match(await page.locator('#discover-body').innerText(),/看起来可用：https:\/\/novel\.example\/\?s=.*命中书名，8 个链接/,'探测应逐个尝试并报告真正可用的搜索地址');
  await page.locator('[data-template="0"]').click();
  await page.locator('#sources-dialog[open]').waitFor();
  const template=JSON.parse(await page.locator('#source-json').inputValue());
  assert.equal(template.bookSourceUrl,'https://novel.example');
  assert.equal(template.searchUrl,'https://novel.example/?s={{key}}','模板应使用探测到的搜索地址');
  assert.match(await page.locator('#import-report').innerText(),/必须打开网站按实际页面结构改过/);
  await page.locator('[data-close="sources-dialog"]').click();
  step('搜索引擎找站点');
  await page.locator('[data-book="0"]').click();await page.locator('#run-job').waitFor();
  assert.match(await page.locator('#job-detail').innerText(),/0 \/ 2/);
  await page.locator('#run-job').click();await page.waitForFunction(()=>!document.querySelector('#run-job').disabled);assert.match(await page.locator('#job-detail').innerText(),/抓取不完整/);
  await page.locator('#export-txt').click();assert.match(await page.locator('#toast').innerText(),/体检结果/);
  // Reload to confirm completed chapters survive and only failed chapters are retried.
  await page.reload();await page.locator('[data-job]').first().click();assert.match(await page.locator('#job-detail').innerText(),/1 \/ 2/);
  failSecond=false;await page.locator('#run-job').click();await page.waitForFunction(()=>!document.querySelector('#run-job').disabled);assert.match(await page.locator('#job-detail').innerText(),/未发现明显抓取异常/);
  await page.screenshot({path:'test-results/job-desktop.png',fullPage:true});
  step('抓取与续传完成');
  // 用真实抓到的正文在页面里重建一次导出，直接校验 EPUB 的 ZIP 字节与 TXT 内容。
  const exported=await Promise.race([
    page.evaluate(async()=>{const {store}=await import('/storage.js');const {analyze}=await import('/quality.js');const {makeEPUB,makeTXT}=await import('/export.js');const job=(await store.jobs())[0];if(!job)return {error:'没有任务'};const report=analyze(job);const buf=new Uint8Array(await makeEPUB(job,report).arrayBuffer());const v=new DataView(buf.buffer);const n=v.getUint16(26,true);const dec=new TextDecoder();return {sig:v.getUint32(0,true),first:dec.decode(buf.slice(30,30+n)),method:v.getUint16(8,true),type:dec.decode(buf.slice(30+n,30+n+20)),all:dec.decode(buf),txt:(await makeTXT(job,report).text()).slice(0,4000),score:report.score};}),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('页面内导出校验超时')),30000)),
  ]);
  step('导出字节校验');
  assert.equal(exported.error,undefined);
  assert.equal(exported.sig,0x04034b50,'EPUB 应当是真实 ZIP');
  assert.equal(exported.first,'mimetype','首个 ZIP 条目必须是 mimetype');
  assert.equal(exported.method,0,'mimetype 必须保持不压缩');
  assert.equal(exported.type,'application/epub+zip');
  assert.equal(exported.score,100);
  assert.match(exported.all,/第二章 归来/);
  assert.match(exported.all,/体检报告/);
  assert.match(exported.txt,/体检结论：/);
  assert.match(exported.txt,/第二章 归来/);
  // 两个导出按钮都要真的触发下载。远程 CDP 浏览器会把文件写在自己的磁盘上，
  // 这种模式下只校验文件名与触发，字节校验由上面那段覆盖。
  for(const [button,ext] of [['#export-txt','.txt'],['#export-epub','.epub']]){
    const pending=page.waitForEvent('download');await page.locator(button).click();const file=await pending;
    assert.ok(file.suggestedFilename().endsWith(ext),`导出文件名应以 ${ext} 结尾，实际 ${file.suggestedFilename()}`);
    if(remote)await file.cancel().catch(()=>{});else await file.saveAs('test-results/fixture'+ext);
  }
  const engineResults=await page.evaluate(async()=>{const e=await import('/engine.js');const doc=e.parseDocument('<div class="a"><a href="/x">正文</a></div><div class="a"><a href="/y">第二项</a></div>');return {css:e.field(doc,'class.a.1@tag.a@text'),xpath:e.field(doc,'//a/@href'),json:e.elements({data:[{name:'甲'},{name:'乙'}]},'$.data[*]').length};});
  assert.deepEqual(engineResults,{css:'第二项',xpath:'/x\n/y',json:2});
  assert.deepEqual(errors,[]);console.log('PASS: responsive layout, source import, search, pre-download health check, cross-source compare, search-engine source discovery, paginated TOC/content, partial-download gate, persisted resume, TXT & EPUB downloads, CSS/XPath/JSON selectors, no browser exceptions.');
}finally{await page.close().catch(()=>{});await context.close?.().catch(()=>{});if(!remote)await browser.close();}
