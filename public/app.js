import {builtins,validateSource,Engine,safeURL,titleKey,elements,field,parseDocument,requestSpec,sourceHosts} from './engine.js';
import {analyze} from './quality.js';
import {makeTXT,makeEPUB,download} from './export.js';
import {store} from './storage.js';
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let sources=[],jobs=[],results=[],statuses=[],query='',page=1,selectedJob=null,searchController,activeJob=null,jobController,concurrency=3,token=sessionStorage.getItem('harbor-token') || '',initialized=false;
let chapterPage=0,openProxy=false,allowedHosts=null;
const slots=new Map();
function sleep(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(new DOMException('已暂停','AbortError'));const stop=()=>{clearTimeout(t);reject(new DOMException('已暂停','AbortError'));};const t=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);signal?.addEventListener('abort',stop,{once:true});});}
function toast(message){$('#toast').textContent=message;$('#toast').classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.add('hidden'),6000);}
async function fetchPage(spec,signal){
  for(let attempt=0;attempt<3;attempt++){
    if(signal?.aborted)throw new DOMException('已暂停','AbortError');
    const host=new URL(spec.url).hostname,now=Date.now(),start=Math.max(now,slots.get(host)||0);slots.set(host,start+350);await sleep(start-now,signal);
    try {
      const response=await fetch('/api/fetch',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(spec),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000)});
      const data=await response.json();if(!response.ok){const e=new Error(data.error || '抓取失败');e.retry=response.status===429||response.status>=500||/超时|HTTP 5\d\d/.test(e.message);throw e;}return data;
    }catch(e){if(signal?.aborted)throw new DOMException('已暂停','AbortError');if(attempt===2 || e.retry===false)throw e;await sleep(1200*2**attempt,signal);}
  }
}
const engine=new Engine(fetchPage);
async function pool(items,count,fn){let index=0;await Promise.all(Array.from({length:Math.min(count,items.length)},async()=>{while(index<items.length){const i=index++;await fn(items[i],i);}}));}
// 抽样位置：首章、末章，其余在全书均匀铺开——首末章最能暴露截断和目录错位。
function sampleIndexes(total,count){
  if(total<=count)return Array.from({length:total},(_,i)=>i);
  const set=new Set();
  for(let i=0;i<count;i++)set.add(Math.round(i*(total-1)/(count-1)));
  return [...set].sort((a,b)=>a-b);
}
function scoreBar(label,value){
  if(value===null||value===undefined)return `<div class="score-row na"><span>${esc(label)}</span><b>未评估</b><div class="bar"><i></i></div></div>`;
  // 条形颜色跟着数值走，不跟卡片等级走：文本质量 100 分就该是绿的。
  const tier=value>=85?'good':value>=70?'ok':value>=45?'warn':'bad';
  return `<div class="score-row"><span>${esc(label)}</span><b>${value}</b><div class="bar"><i class="v-${tier}" style="width:${value}%"></i></div></div>`;
}
function reportHTML(report){
  const groups=report.quality.groups.filter(g=>g.penalty>0).sort((a,b)=>b.penalty-a.penalty);
  const complete=report.completeness.available?report.completeness.score:null;
  return `<div class="report-card grade-${report.grade}"><div class="score-head"><div class="score-num">${report.score}<small>/100</small></div><div><b>${esc(report.conclusion)}${report.grade==='clean'?'':` · ${esc(report.gradeLabel)}`}</b><p class="small">${esc(report.verdict)}</p></div></div>${scoreBar('抓取完整性',complete)}${scoreBar('文本质量',report.quality.score)}<p class="small">${esc(report.completeness.label)}</p>${groups.length?`<details open><summary>扣分项明细（${groups.length}）</summary><ul class="signal-list">${groups.map(g=>`<li><b>${esc(g.name)}</b><span class="penalty">-${g.penalty}</span><p>${esc(g.advice)}</p>${g.chaptersHit?`<p class="small">命中 ${g.chaptersHit} 章 / 共 ${g.hits} 处${g.samples.length?` · 例：${esc(g.samples[0])}`:''}</p>`:''}</li>`).join('')}</ul></details>`:'<p class="small">未发现需要扣分的文本症状。</p>'}<p class="small">校对声明：${esc(report.proofread)}</p><p class="small muted">${esc(report.disclaimer)}</p></div>`;
}
function issueList(report){
  if(!report.issues.length)return '';
  const errors=report.issues.filter(i=>i.level==='error');
  return `<details ${errors.length?'open':''}><summary>逐条检查记录（${report.issues.length} 条${errors.length?`，其中 ${errors.length} 条为错误`:''}）</summary><ul class="issue-list">${report.issues.slice(0,200).map(i=>`<li class="${i.level==='error'?'error':''}">${esc(i.message)}</li>`).join('')}</ul>${report.issues.length>200?'<p class="small">仅显示前 200 条，完整报告可下载。</p>':''}</details>`;
}
function blockingReport(report){return report.grade==='warning'||report.grade==='severe'||report.issues.some(i=>i.level==='error');}
function renderSources(){
  $('#source-count').textContent=sources.filter(s=>s.enabled).length;
  $('#source-list').innerHTML=sources.map((s,i)=>`<div class="source-row"><input type="checkbox" aria-label="启用 ${esc(s.bookSourceName)}" data-source-toggle="${i}" ${s.enabled?'checked':''}><label>${esc(s.bookSourceName)}<small>${esc(s.bookSourceUrl)} · ${s.adapter?'内置适配器':'自定义规则'}</small></label><button class="outline" data-source-edit="${i}">查看规则</button>${s.adapter?'':`<button class="outline danger" data-source-delete="${i}">删除</button>`}</div>`).join('');
  const selected=$('#source-filter').value;$('#source-filter').innerHTML='<option value="">全部书源</option>'+sources.map(s=>`<option value="${esc(s.id)}">${esc(s.bookSourceName)}</option>`).join('');$('#source-filter').value=selected;
}
function renderResults(){
  $('#results-title').textContent=query?`“${query}” · ${results.length} 个版本`:'寻找一个好版本';
  $('#search-status').innerHTML=statuses.length?`<details ${statuses.some(s=>s.error)?'open':''}><summary>${statuses.filter(s=>s.done).length} / ${statuses.length} 个书源已完成 · ${statuses.filter(s=>s.error).length} 个异常</summary>${statuses.map(s=>`<div class="${s.error?'error':''}">${esc(s.name)}：${esc(s.message)}</div>`).join('')}</details>`:'';
  const filter=$('#source-filter').value;const books=results.filter(b=>!filter||b.source.id===filter);
  if(query && !books.length){$('#results').innerHTML=`<div class="empty-state"><span class="empty-icon">⌕</span><h3>${statuses.some(s=>!s.done)?'正在各个书源寻找…':'暂未找到匹配版本'}</h3><p>可换用繁体书名、作者名，或添加新的书源。<br>来源异常的原因会显示在上方。</p></div>`;return;}
  if(!query)return;
  $('#results').innerHTML=books.map(b=>{const i=results.indexOf(b);const siblings=results.filter(x=>titleKey(x.title)===titleKey(b.title)).length;return `<article class="book-card"><div class="book-cover" aria-hidden="true">${esc(b.title.slice(0,12))}</div><div class="book-main"><h3>${esc(b.title)}</h3><div class="book-meta">${esc(b.author || '作者待核对')} · ${esc(b.source.bookSourceName)}${siblings>1?` <span class="badge">同书 ${siblings} 个来源</span>`:''}</div>${b.lastChapter?`<p class="small last-chapter">来源标注最新章节：${esc(b.lastChapter)}${b.wordCount?` · ${esc(b.wordCount)}`:''}</p>`:''}<p>${esc(b.intro || '先体检一次：抽样检查文本质量与章节完整度，再决定要不要整本下载。')}</p><div class="book-actions"><button class="primary" data-health="${i}">先体检</button><button class="outline" data-book="${i}">直接下载 ↓</button><a href="${esc(safeURL(b.url))}" target="_blank" rel="noopener noreferrer">查看原站 ↗</a></div></div></article>`;}).join('');
}
async function search(more=false){
  if(!initialized)return toast('本地存储正在初始化');
  const keyword=$('#query').value.trim();if(!keyword)return toast('请输入书名或作者');
  const enabled=sources.filter(s=>s.enabled);
  if(!enabled.length){toast('没有启用的书源，改用搜索引擎找站点');return discover(keyword);}
  searchController?.abort();const controller=new AbortController();searchController=controller;
  if(!more || keyword!==query){results=[];query=keyword;page=1;}else page++;
  const currentPage=page;
  statuses=enabled.map(s=>({id:s.id,name:s.bookSourceName,message:'正在搜索…',done:false}));renderResults();$('#search-btn').textContent='搜索中…';$('#more-btn').classList.add('hidden');
  await pool(enabled,4,async source=>{try{
    const found=await engine.search(source,keyword,currentPage,controller.signal);if(controller.signal.aborted)return;
    for(const b of found)if(!results.some(x=>x.url===b.url&&x.source.id===b.source.id))results.push(b);
    Object.assign(statuses.find(s=>s.id===source.id),{done:true,message:`本页找到 ${found.length} 个结果`});
  }catch(e){if(controller.signal.aborted)return;Object.assign(statuses.find(s=>s.id===source.id),{done:true,error:true,message:e.message});}renderResults();});
  if(controller.signal.aborted)return;$('#search-btn').innerHTML='搜索全书源 <span>→</span>';$('#more-btn').classList.remove('hidden');
}
function renderTasks(){
  $('#tasks-empty').classList.toggle('hidden',jobs.length>0);
  $('#task-list').innerHTML=jobs.map(j=>{const count=j.chapters.filter(c=>c.state==='done').length;return `<button class="task-item" data-job="${esc(j.id)}"><b>${esc(j.book.title)}</b><progress max="${j.chapters.length||1}" value="${count}"></progress><small>${j.id===activeJob?'抓取中':count===j.chapters.length?'抓取结束，待核验':'可续传'} · ${count} / ${j.chapters.length} 章</small></button>`;}).join('');
}
function jobById(){return jobs.find(j=>j.id===selectedJob);}
function renderJob(){
  const job=jobById();if(!job)return;const report=analyze(job),active=activeJob===job.id;
  const scrollTop=$('#job-detail .chapter-list')?.scrollTop || 0;
  const openChapters=[...$('#job-detail').querySelectorAll('details[open]')].map(e=>e.dataset.chapter);
  $('#job-title').textContent=job.book.title;
  $('#job-detail').innerHTML=`<p class="small job-source">${esc(job.book.source.bookSourceName)} · <a href="${esc(safeURL(job.book.url))}" target="_blank" rel="noopener noreferrer">核对原站 ↗</a></p><div class="stats"><div class="stat"><strong>${report.done} / ${report.total}</strong><span>成功抓取 / 目录章数</span></div><div class="stat"><strong>${(report.chars/10000).toFixed(1)} 万</strong><span>正文字符</span></div><div class="stat"><strong>${report.score}</strong><span>体检总分</span></div></div><div class="button-row"><button class="primary" id="run-job" ${activeJob?'disabled':''}>${report.done?'续传 / 重试失败章节':'开始抓取正文'}</button><button class="outline" id="pause-job" ${active?'':'disabled'}>暂停</button><button class="text-button danger" id="delete-job" ${active?'disabled':''}>删除本地任务</button></div><div class="expected"><label for="expected-count">预期章数（可选）</label><input type="number" min="1" max="5000" id="expected-count" placeholder="未知" value="${job.expectedCount || ''}" ${active?'disabled':''}><button class="outline" id="save-expected" ${active?'disabled':''}>核对</button></div><div class="report-wrap">${reportHTML(report)}${issueList(report)}${job.notes?.length?`<details><summary>来源与目录信息</summary>${job.notes.map(n=>`<p class="small">${esc(n)}</p>`).join('')}</details>`:''}</div><label><input id="allow-issues" type="checkbox" ${job.allowIssues?'checked':''} ${active?'disabled':''}> 我已核对来源，仍要导出有异常的版本（保留缺章标记）</label><div class="button-row"><button class="primary" id="export-txt" ${active?'disabled':''}>↓ TXT</button><button class="outline" id="export-epub" ${active?'disabled':''}>↓ EPUB</button><button class="outline" id="export-report">下载检查报告</button></div><h3>章节预览 <span class="small">点击展开正文；按原站目录顺序导出</span></h3><div class="button-row"><button class="outline" id="chapters-prev" ${chapterPage===0?'disabled':''}>上一组</button><span class="small">第 ${chapterPage+1} / ${Math.max(1,Math.ceil(job.chapters.length/100))} 组，每组 100 章</span><button class="outline" id="chapters-next" ${(chapterPage+1)*100>=job.chapters.length?'disabled':''}>下一组</button></div><div class="chapter-list">${job.chapters.slice(chapterPage*100,(chapterPage+1)*100).map((c,k)=>{const i=chapterPage*100+k;return `<details class="chapter-row" data-chapter="${i}" ${openChapters.includes(String(i))?'open':''}><summary>${c.state==='done'?'✓':c.state==='error'?'!':'○'} ${i+1}. ${esc(c.title)}</summary><pre>${esc(c.state==='done'?(c.text.length>8000?c.text.slice(0,8000)+'\n\n[预览仅显示前 8000 字，导出保留全文]':c.text):c.error || '尚未抓取')}</pre></details>`;}).join('')}</div>`;
  $('#job-detail .chapter-list').scrollTop=scrollTop;
}
async function createJob(index,button,preloaded){
  if(activeJob)return toast('请先暂停当前抓取任务，再读取新目录');
  if(button)button.disabled=true;const original=button?button.textContent:'';
  try{
    let book,toc;
    if(preloaded){book=preloaded.book;toc=preloaded.toc;}
    else{book=structuredClone(results[index]);toc=await engine.toc(book,undefined,msg=>{if(button)button.textContent=msg;});}
    if(!toc.chapters.length)throw new Error('未找到章节');
    // 体检时已经抓到的抽样章节直接带入任务，不重复请求同一批页面。
    const fetched=new Map((preloaded?.chapters||[]).filter(c=>c.state==='done').map(c=>[c.url,{text:c.text,revision:c.revision}]));
    const chapters=toc.chapters.map(c=>fetched.has(c.url)?{...c,...fetched.get(c.url),state:'done'}:{...c,state:'pending'});
    const job={id:crypto.randomUUID(),book,chapters,notes:toc.notes,tocComplete:toc.complete,createdAt:new Date().toISOString()};
    await store.saveJob(job);jobs.unshift(job);selectedJob=job.id;chapterPage=0;renderTasks();renderJob();$('#job-dialog').showModal();
  }catch(e){toast(e.message);}finally{if(button){button.disabled=false;button.textContent=original;}}
}
let health=null;
function renderHealth(){
  const s=health;if(!s)return;
  if(!s.toc){
    $('#health-body').innerHTML=`<div class="report-card grade-severe"><b>体检没能完成</b><p>${esc(s.error)}</p><p class="small">读不到目录，就无法判断这个版本完不完整。可以换一个来源，或先在「书源管理」里测试该书源是否可用。</p></div>`;
    return;
  }
  const {book,toc,chapters,report}=s;
  const sampled=chapters.filter(c=>c.state!=='skipped');
  $('#health-body').innerHTML=`<p class="small">目录共 <b>${toc.chapters.length}</b> 章${book.lastChapter?` · 来源标注最新章节：${esc(book.lastChapter)}`:''}${book.wordCount?` · ${esc(book.wordCount)}`:''}</p>${reportHTML(report)}<details><summary>抽查了哪 ${sampled.length} 章（全书共 ${toc.chapters.length} 章）</summary><div class="chapter-list">${sampled.map(c=>`<details class="chapter-row"><summary>${c.state==='done'?'✓':'!'} ${esc(c.title)}</summary><pre>${esc(c.state==='done'?(c.text.length>3000?c.text.slice(0,3000)+'\n\n[仅预览前 3000 字，下载会保留全文]':c.text):c.error||'抓取失败')}</pre></details>`).join('')}</div></details>${toc.notes?.length?`<details><summary>来源与目录信息</summary>${toc.notes.map(n=>`<p class="small">${esc(n)}</p>`).join('')}</details>`:''}<div class="button-row"><button class="primary" id="health-download">下载这个版本</button><button class="outline" id="health-compare">对比同书其他来源</button></div>`;
}
// 体检不落盘：只抽样 8 章判断“值不值得整本下载”，避免为了检验完整性反而先下一整本。
async function healthCheck(index,button){
  const book=results[index];if(!book)return;
  if(button)button.disabled=true;
  const dialog=$('#health-dialog');
  $('#health-title').textContent=book.title;
  $('#health-source').innerHTML=`${esc(book.author||'作者待核对')} · ${esc(book.source.bookSourceName)} · <a href="${esc(safeURL(book.url))}" target="_blank" rel="noopener noreferrer">核对原站 ↗</a>`;
  $('#health-body').innerHTML='<p class="muted">正在读取目录…</p>';
  $('#health-extra').innerHTML='';
  if(!dialog.open)dialog.showModal();
  try{
    const toc=await engine.toc(book,undefined,msg=>{$('#health-body').innerHTML=`<p class="muted">${esc(msg)}</p>`;});
    if(!toc.chapters.length)throw new Error('未找到章节');
    const picks=sampleIndexes(toc.chapters.length,8);
    const chapters=toc.chapters.map((c,i)=>picks.includes(i)?{...c,state:'pending'}:{...c,state:'skipped'});
    const todo=chapters.filter(c=>c.state==='pending');
    let finished=0;
    const progress=()=>{$('#health-body').innerHTML=`<p class="muted">目录共 ${toc.chapters.length} 章，正在抽查第 ${Math.min(finished+1,todo.length)} / ${todo.length} 章…</p>`;};
    progress();
    await pool(todo,3,async c=>{
      try{Object.assign(c,await engine.chapter(c,book.source,undefined),{state:'done'});}
      catch(e){c.state='error';c.error=e.message;}
      finished++;progress();
    });
    health={index,book,toc,chapters,error:null,report:analyze({book,chapters,notes:toc.notes,tocComplete:toc.complete,sampled:true})};
  }catch(e){
    health={index,book,toc:null,chapters:[],report:null,error:e.message};
  }finally{if(button)button.disabled=false;}
  renderHealth();
}
async function openCompare(button){
  const s=health;if(!s)return;
  if(button)button.disabled=true;
  const key=titleKey(s.book.title);
  const rows=results.map((b,i)=>({b,i})).filter(x=>x.i!==s.index&&titleKey(x.b.title)===key).map(x=>({...x,state:'pending'}));
  if(!rows.length){
    $('#health-extra').innerHTML=`<div class="report-card"><b>没有其他来源返回同名结果</b><p class="small">可以换关键词再搜一次（试试繁体书名、作者名或去掉书名号），或在「书源管理」里添加更多书源。</p></div>`;
    if(button)button.disabled=false;
    return;
  }
  const paint=()=>{
    $('#health-extra').innerHTML=`<h3>同一本书在其他来源</h3><p class="small">章节数越多、末章越靠后，说明这个来源跟得更全。可逐个体检，再挑最好的那个下载。</p><div class="compare-list">${rows.map(r=>`<div class="compare-row${r.best?' best':''}"><div><b>${esc(r.b.source.bookSourceName)}</b>${r.best?' <span class="badge">章数最多</span>':''}${r.i===s.index?' <span class="badge">当前</span>':''}<p class="small">${r.state==='done'?`目录 <b>${r.chapters}</b> 章${r.last?` · 末章：${esc(r.last)}`:''}`:r.state==='error'?esc(r.error):'正在读取目录…'}</p></div><div class="compare-actions"><button class="outline" data-compare-health="${r.i}">体检</button><button class="outline" data-compare-use="${r.i}">直接下载</button></div></div>`).join('')}</div>`;
  };
  paint();
  await pool(rows,3,async r=>{
    try{const toc=await engine.toc(r.b,undefined,()=>{});r.chapters=toc.chapters.length;r.last=toc.chapters[toc.chapters.length-1]?.title||'';r.state='done';}
    catch(e){r.state='error';r.error=e.message;}
    paint();
  });
  const mine=s.toc?s.toc.chapters.length:0;
  const best=rows.filter(r=>r.state==='done').sort((a,b)=>b.chapters-a.chapters)[0];
  if(best&&best.chapters>mine){best.best=true;paint();}
  if(button)button.disabled=false;
}
async function runJob(){
  const job=jobById();if(!job||activeJob)return;
  activeJob=job.id;jobController=new AbortController();const signal=jobController.signal;let storageError=null;
  renderTasks();renderJob();
  try{await pool(job.chapters.filter(c=>c.state!=='done'),concurrency,async c=>{
    if(signal.aborted)return;
    try{const data=await engine.chapter(c,job.book.source,signal);if(signal.aborted)return;
      const total=job.chapters.reduce((n,x)=>n+(x.text?.length||0),0)+data.text.length;if(total>20000000)throw new Error('此任务正文超过 2000 万字符限制，请分卷下载');
      if(!data.text.trim())throw new Error('正文为空');Object.assign(c,data,{state:'done',error:undefined});
    }catch(e){if(signal.aborted)return;c.state='error';c.error=e.message;}
    try{await store.saveChapter(job,c);}catch(e){storageError=e;jobController.abort();}
    renderTasks();if(selectedJob===job.id)renderJob();
  });}finally{activeJob=null;renderTasks();if(selectedJob===job.id)renderJob();toast(storageError?'本地存储空间不足，任务已暂停；未保存内容请先导出':signal.aborted?'已暂停，下次只抓取未完成的章节':'抓取结束，请查看质量报告后导出');}
}
// 导入后最现实的拦路虎：书源域名不在服务端 ALLOWED_HOSTS 里，抓取会被 Worker 直接拒绝。
// 设了访问口令时白名单已自动放开，不必再逐个加域名。
// 给出的这一行要能直接替换 ALLOWED_HOSTS，所以必须并上服务端当前已有的域名——
// 否则粘贴过去会把内置的维基文库、Gutenberg 和搜索引擎兜底一起挤掉。
function whitelistLine(){
  return [...new Set([...(allowedHosts || []),...sourceHosts(sources.filter(s=>s.enabled))])].sort();
}
function hostNotice(){
  // 设了口令就没有白名单这回事；后端没连上时读不到当前白名单，宁可不给也不给错。
  if(openProxy || !allowedHosts)return '';
  const hosts=whitelistLine();
  if(!hosts.length)return '';
  return `\n\n把下面这一行加进 Cloudflare 的 ALLOWED_HOSTS（共 ${hosts.length} 个域名，已含内置书源与搜索引擎），否则这些书源会被 Worker 拒绝：\n\n${hosts.join(',')}\n\n也可以在环境变量里设置 ACCESS_TOKEN，代理会自动放开任意公网域名，就不必维护这份名单了。`;
}
async function importSources(raw){
  try{if(raw.length>10000000)throw new Error('书源文件请限制在 10 MB 以内');let parsed=JSON.parse(raw.replace(/^﻿/,''));if(!Array.isArray(parsed))parsed=[parsed];if(parsed.length>1500)throw new Error('一次最多导入 1500 个书源');
    const report=[],errorCounts=new Map(),warnCounts=new Map();let count=0,skipped=0,warned=0;
    for(const s of parsed){
      const {errors,warnings}=validateSource(s);
      if(errors.length){skipped++;for(const e of errors)errorCounts.set(e,(errorCounts.get(e)||0)+1);if(report.length<30)report.push(`✕ ${s?.bookSourceName || '未命名'}\n  ${errors.slice(0,4).join('\n  ')}${errors.length>4?`\n  …另有 ${errors.length-4} 项`:''}`);continue;}
      if(warnings.length){warned++;for(const w of warnings)warnCounts.set(w,(warnCounts.get(w)||0)+1);}
      const existing=sources.findIndex(x=>x.bookSourceUrl===s.bookSourceUrl);
      const clean={...s,id:existing>=0?sources[existing].id:crypto.randomUUID(),enabled:s.enabled!==false,warnings:[...new Set(warnings)]};
      if(existing>=0)sources[existing]=clean;else sources.push(clean);count++;
      report.push(`✓ ${s.bookSourceName}${warnings.length?`（${warnings.length} 项提示）`:''}：已导入，请测试站点可用性`);
    }
    const top=[...errorCounts].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([reason,n])=>`• ${n} 个：${reason}`);
    const topWarn=[...warnCounts].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([reason,n])=>`• ${n} 个：${reason}`);
    await store.set('sources',sources);renderSources();
    // 摘要 → 域名白名单 → 跳过原因 → 逐条示例：先给能立刻照做的那一件事。
    $('#import-report').textContent=`已读取 ${parsed.length} 个书源；导入 ${count} 个（其中 ${warned} 个带提示），跳过 ${skipped} 个。${hostNotice()}\n${skipped?'\n跳过项需要执行脚本、登录，或缺少必需规则——纯 HTTP 引擎无法运行。\n':'\n'}${top.join('\n')}${topWarn.length?`\n\n可以导入但需留意：\n${topWarn.join('\n')}`:''}\n\n示例（最多显示 30 个）：\n${report.slice(0,30).join('\n')}`;
  }catch(e){$('#import-report').textContent='导入失败：'+e.message;}
}
// —— 没加书源时用搜索引擎找站点 ——
// 只负责「找到可能提供这本书的网站」，把域名列成候选；真正的抓取仍然要有一条书源规则。
// 实测：必应（中国）对数据中心 IP 比较友好，百度/搜狗也能返回，其他的多半直接 403。
const ENGINES=[
  {id:'bing',name:'必应（中国）',host:'cn.bing.com',url:'https://cn.bing.com/search?q={{key}}&setlang=zh-CN',item:'li.b_algo',title:'h2 a@text',link:'h2 a@href',snippet:'.b_caption p@text'},
  {id:'baidu',name:'百度',host:'www.baidu.com',url:'https://www.baidu.com/s?wd={{key}}',item:'.result,.c-container',title:'h3 a@text',link:'h3 a@href',snippet:'@text'},
  {id:'sogou',name:'搜狗',host:'www.sogou.com',url:'https://www.sogou.com/web?query={{key}}',item:'.vrwrap,.rb',title:'h3 a@text',link:'h3 a@href',snippet:'@text'},
];
// 百科、社区、影视、电商这些结果里没有可下载的正文，先滤掉。
const SKIP_HOST=/(?:^|\.)(baidu|zhihu|douban|wikipedia|wikimedia|wikiwand|fandom|wikia|bilibili|weibo|jianshu|csdn|youtube|youku|iqiyi|taobao|tmall|jd|amazon|dangdang|toutiao|xiaohongshu|360doc|juejin|cnblogs|qq|163|sina|sohu|ifeng|gov|edu|org)\.[a-z.]*$/i;
const ENGINE_HOSTS=/^(?:www\.)?(?:bing|baidu|sogou|so|google)\.com$/i;
// 常见搜索页写法：后两条是笔趣阁系站点最常见的入口。
const PROBE_PATTERNS=['/modules/article/search.php?searchkey={{key}}','/search.php?q={{key}}','/search.php?keyword={{key}}','/search.html?searchkey={{key}}','/?s={{key}}','/search?q={{key}}','/s?q={{key}}'];
let engineId='bing',discoverRows=[],discoverFiltered=0;
function currentEngine(){return ENGINES.find(e=>e.id===engineId)||ENGINES[0];}
async function discover(keyword){
  if(!keyword)return toast('先输入书名再找站点');
  const engine=currentEngine();
  const dialog=$('#discover-dialog');
  $('#discover-title').textContent=`在「${engine.name}」上找《${keyword}》`;
  $('#discover-body').innerHTML='<p class="muted">正在搜索…</p>';
  discoverRows=[];discoverFiltered=0;
  if(!dialog.open)dialog.showModal();
  try{
    const page=await fetchPage(requestSpec(engine.url,keyword,1,`https://${engine.host}`));
    const doc=parseDocument(page.text);
    const rows=[];
    for(const el of elements(doc,engine.item)){
      const title=field(el,engine.title,page.url),link=field(el,engine.link,page.url),snippet=field(el,engine.snippet,page.url);
      if(!title||!link)continue;
      let host='';try{host=new URL(link).hostname.replace(/^www\./,'').toLowerCase();}catch{}
      // 百度/搜狗给的是跳转地址，这里退回用结果里显示出来的域名。
      if(!host||SKIP_HOST.test(host)||ENGINE_HOSTS.test(host)){
        const m=(snippet+' '+title).match(/[\w-]{2,}\.(?:com|net|org|cc|cn|xyz|top|vip|la|me|tv|info|biz|site|club|wang|us)\b/i);
        if(m)host=m[0].toLowerCase();
      }
      if(!host)continue;
      if(SKIP_HOST.test(host)||ENGINE_HOSTS.test(host)){discoverFiltered++;continue;}
      if(rows.some(r=>r.host===host))continue;
      rows.push({host,title,link,snippet:snippet.slice(0,180)});
      if(rows.length>=20)break;
    }
    discoverRows=rows;renderDiscover();
  }catch(e){
    $('#discover-body').innerHTML=`<div class="report-card grade-warning"><b>搜索没有完成</b><p>${esc(e.message)}</p><p class="small">搜索引擎可能拒绝了 Cloudflare 的出口 IP，也可能它的域名还没加进 ALLOWED_HOSTS。可以在「设置」里换一个引擎，或者直接在浏览器里搜书名，再把找到的站点做成书源。</p></div>`;
  }
}
function renderDiscover(){
  const engine=currentEngine(),rows=discoverRows;
  $('#discover-body').innerHTML=rows.length
    ?`<p class="small">从「${esc(engine.name)}」找到 ${rows.length} 个候选站点${discoverFiltered?`，已过滤 ${discoverFiltered} 个百科/社区/影视/电商结果`:''}。这些只是候选，能不能当书源要逐个探测。</p><div class="compare-list">${rows.map((r,i)=>`<div class="compare-row"><div><b>${esc(r.host)}</b><p class="small">${esc(r.title)}</p>${r.snippet?`<p class="small muted">${esc(r.snippet)}</p>`:''}${r.probe?`<p class="small">${esc(r.probe)}</p>`:''}</div><div class="compare-actions"><button class="outline" data-probe="${i}">探测搜索页</button><button class="outline" data-template="${i}">建书源</button><a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">打开 ↗</a></div></div>`).join('')}</div>`
    :'<p class="muted">没有找到候选站点。可以换一个搜索引擎，或者直接在浏览器里搜书名。</p>';
}
// 探测：按常见写法试着搜一次，看哪个地址真的能搜出这本书。
async function probeSite(index,button){
  const row=discoverRows[index];if(!row)return;
  const keyword=(query||$('#query').value).trim();
  button.disabled=true;button.textContent='探测中…';
  // 很多站点只有带 www 的域名能访问，两种都要试。
  const hosts=row.host.startsWith('www.')?[row.host]:[row.host,`www.${row.host}`];
  let reachable=false,blocked=false,tried=0;
  outer: try{
    for(const host of hosts){
      for(const pattern of PROBE_PATTERNS){
        const url=`https://${host}${pattern.replace('{{key}}',encodeURIComponent(keyword))}`;
        tried++;
        try{
          const page=await fetchPage({url});
          reachable=true;
          const links=(page.text.match(/<a[\s>]/gi)||[]).length;
          if(page.text.includes(keyword)&&links>=5){row.probe=`看起来可用：${url}（命中书名，${links} 个链接）`;row.searchUrl=pattern;row.probeHost=host;break outer;}
        }catch(e){
          // 域名没进 ALLOWED_HOSTS 时 Worker 直接拒绝，这不是网站的问题。
          if(/ALLOWED_HOSTS|未获站点配置允许/.test(e.message))blocked=true;
        }
      }
    }
    if(!row.probe)row.probe=reachable
      ?`试了 ${tried} 种写法都没搜出这本书，建议打开原站看看它的搜索页长什么样`
      :blocked?`还没探测：${row.host} 不在 ALLOWED_HOSTS 里。把它加进 Cloudflare 的环境变量并重新部署，或者设置 ACCESS_TOKEN 让代理自动放开。`
      :`这 ${tried} 种写法都没能访问到，网站可能挂了或有反爬限制`;
  }finally{button.disabled=false;button.textContent='探测搜索页';}
  renderDiscover();
}
// 生成的书源只是个起点：选择器是按常见模板猜的，必须按目标网站改过才能用。
function sourceTemplateFor(row){
  // 用探测时真正通的那个域名（带不带 www 差别很大）。
  const host=row.probeHost||row.host;
  return {bookSourceName:host,bookSourceUrl:`https://${host}`,bookSourceGroup:'搜索引擎发现',enabled:true,
    searchUrl:row.searchUrl?`https://${host}${row.searchUrl}`:`https://${host}/search?q={{key}}`,
    ruleSearch:{bookList:'.result-list li',name:'a@text',author:'.author@text',bookUrl:'a@href',intro:'.intro@text'},
    ruleBookInfo:{tocUrl:'.toc@href'},
    ruleToc:{chapterList:'#list dd a',chapterName:'@text',chapterUrl:'@href'},
    ruleContent:{content:'#content@text'}};
}

const sourceTemplate={bookSourceName:'我的书源（替换为真实站点）',bookSourceUrl:'https://example.com',enabled:true,searchUrl:'/search?q={{key}}&page={{page}}',ruleSearch:{bookList:'.book-list .book',name:'.title@text',author:'.author@text',bookUrl:'a@href',intro:'.intro@text'},ruleBookInfo:{tocUrl:'.toc-link@href'},ruleToc:{chapterList:'.chapters li',chapterName:'a@text',chapterUrl:'a@href',nextTocUrl:'a.next@href'},ruleContent:{content:'#content@text',nextContentUrl:''}};
$('#search-form').addEventListener('submit',e=>{e.preventDefault();search();});
$('#more-btn').onclick=()=>search(true);$('#source-filter').onchange=renderResults;
$('#sources-btn').onclick=()=>$('#sources-dialog').showModal();$('#empty-import').onclick=()=>$('#sources-dialog').showModal();
$('#quality-help').onclick=()=>$('#help-dialog').showModal();$('#settings-btn').onclick=()=>{$('#access-token').value=token;$('#settings-dialog').showModal();};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>document.getElementById(b.dataset.close).close());
document.querySelectorAll('[data-query]').forEach(b=>b.onclick=()=>{$('#query').value=b.dataset.query;search();});
$('#results').addEventListener('click',e=>{const h=e.target.closest('[data-health]');if(h)return healthCheck(Number(h.dataset.health),h);const button=e.target.closest('[data-book]');if(button)createJob(Number(button.dataset.book),button);});
$('#health-dialog').addEventListener('click',e=>{const button=e.target.closest('button');if(!button)return;
  if(button.id==='health-download'){if(!health?.toc)return;$('#health-dialog').close();createJob(health.index,null,{book:health.book,toc:health.toc,chapters:health.chapters});return;}
  if(button.id==='health-compare')return openCompare(button);
  if(button.dataset.compareUse!==undefined){if(activeJob)return toast('请先暂停当前抓取任务');$('#health-dialog').close();createJob(Number(button.dataset.compareUse),null);return;}
  if(button.dataset.compareHealth!==undefined){$('#health-extra').innerHTML='';healthCheck(Number(button.dataset.compareHealth),button);}
});
$('#task-list').addEventListener('click',e=>{const button=e.target.closest('[data-job]');if(button){selectedJob=button.dataset.job;chapterPage=0;renderJob();$('#job-dialog').showModal();}});
$('#source-list').addEventListener('change',async e=>{if(e.target.dataset.sourceToggle!==undefined){sources[Number(e.target.dataset.sourceToggle)].enabled=e.target.checked;await store.set('sources',sources);renderSources();}});
$('#source-list').addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.sourceDelete!==undefined){sources.splice(Number(b.dataset.sourceDelete),1);await store.set('sources',sources);renderSources();}if(b.dataset.sourceEdit!==undefined)$('#source-json').value=JSON.stringify(sources[Number(b.dataset.sourceEdit)],null,2);});
$('#import-source').onclick=()=>importSources($('#source-json').value);
$('#source-file').onchange=async e=>{const file=e.target.files[0];if(file){if(file.size>10000000)return toast('文件超过 10 MB');await importSources(await file.text());e.target.value='';}};
$('#example-source').onclick=()=>{$('#source-json').value=JSON.stringify(sourceTemplate,null,2);$('#import-report').textContent='这是结构模板，example.com 不是真实书源。请按目标网站的网页结构修改选择器。';};
$('#export-sources').onclick=()=>download(new Blob([JSON.stringify(sources,null,2)],{type:'application/json'}),'书港-书源.json');
$('#builtin-collection').onclick=async()=>{
  const b=$('#builtin-collection');if(b.disabled)return;b.disabled=true;const label=b.textContent;b.textContent='读取中…';
  $('#import-report').textContent='正在读取内置合集（约 6 MB，首次加载稍慢）…';
  try{const res=await fetch('/examples/bookSource.json');if(!res.ok)throw new Error('HTTP '+res.status);await importSources(await res.text());}
  catch(e){$('#import-report').textContent=`内置合集读取失败：${e.message}。\n可以在仓库的 public/examples/bookSource.json 下载这个文件，再用「导入 JSON 文件」选择它。`;}
  finally{b.disabled=false;b.textContent=label;}
};
$('#copy-hosts').onclick=async()=>{
  if(openProxy)return toast('已设置访问口令，代理自动放开，不需要白名单');
  if(!allowedHosts)return toast('后端未连接，读不到当前白名单');
  const hosts=sources.filter(s=>s.enabled).length?whitelistLine():allowedHosts;
  const text=hosts.join(',');
  try{await navigator.clipboard.writeText(text);toast(`已复制 ${hosts.length} 个域名，粘贴进 Cloudflare 的 ALLOWED_HOSTS`);}
  catch{$('#sources-dialog').showModal();$('#import-report').textContent=`复制失败，请手动选取下面这一行（共 ${hosts.length} 个域名）：\n\n${text}`;}
};
$('#test-sources').onclick=async()=>{const key=$('#query').value.trim();if(!key)return toast('先在首页填写一个测试书名');const b=$('#test-sources');b.disabled=true;const messages=[];$('#import-report').textContent='测试中…';await pool(sources.filter(s=>s.enabled),3,async s=>{const now=Date.now();try{const found=await engine.search(s,key);messages.push(`✓ ${s.bookSourceName}：${found.length} 个结果，${((Date.now()-now)/1000).toFixed(1)} 秒（仅验证搜索）`);}catch(e){messages.push(`✕ ${s.bookSourceName}：${e.message}`);}$('#import-report').textContent=messages.join('\n');});b.disabled=false;};
$('#concurrency').oninput=e=>$('#concurrency-value').textContent=e.target.value;
$('#save-settings').onclick=async()=>{token=$('#access-token').value.trim();sessionStorage.setItem('harbor-token',token);concurrency=Number($('#concurrency').value);engineId=$('#engine').value;await store.set('concurrency',concurrency);await store.set('engine',engineId);toast('设置已保存');$('#settings-dialog').close();};
$('#discover-btn').onclick=()=>discover($('#query').value.trim());
$('#empty-discover').onclick=()=>discover($('#query').value.trim());
$('#discover-dialog').addEventListener('click',e=>{
  const button=e.target.closest('button');if(!button)return;
  if(button.dataset.probe!==undefined)return probeSite(Number(button.dataset.probe),button);
  if(button.dataset.template!==undefined){
    const row=discoverRows[Number(button.dataset.template)];if(!row)return;
    $('#discover-dialog').close();
    $('#source-json').value=JSON.stringify(sourceTemplateFor(row),null,2);
    $('#import-report').textContent=`这是按 ${row.host} 猜出来的书源模板：搜索地址来自探测结果，选择器只是常见写法的猜测，必须打开网站按实际页面结构改过才能用。改完点「检查并导入」。`;
    $('#sources-dialog').showModal();
    return;
  }
});
$('#deploy-btn').onclick=()=>{try{const u=new URL($('#repo-url').value);if(u.origin!=='https://github.com'||!/^\/[\w.-]+\/[\w.-]+\/?$/.test(u.pathname))throw new Error('请输入完整 GitHub 仓库地址');$('#deploy-link').href='https://deploy.workers.cloudflare.com/?url='+encodeURIComponent(u.origin+u.pathname.replace(/\/$/,''));$('#deploy-link').classList.remove('hidden');}catch(e){toast('请输入 https://github.com/账号/仓库 格式的地址');}};
$('#job-detail').addEventListener('change',async e=>{if(e.target.id==='allow-issues'){const j=jobById();j.allowIssues=e.target.checked;await store.saveJob(j);}});
$('#job-detail').addEventListener('click',async e=>{const id=e.target.closest('button')?.id,job=jobById();if(!job)return;
  if(id==='chapters-prev'){chapterPage=Math.max(0,chapterPage-1);renderJob();return;}if(id==='chapters-next'){chapterPage++;renderJob();return;}
  if(id==='run-job')return runJob();if(id==='pause-job'){jobController?.abort();return;}
  if(id==='save-expected'){const v=$('#expected-count').value;if(v&&(!Number.isInteger(Number(v))||Number(v)<1||Number(v)>5000))return toast('预期章数应为 1 到 5000 的整数');job.expectedCount=v?Number(v):null;await store.saveJob(job);renderJob();return;}
  if(id==='delete-job'){if(!confirm('删除此任务及保存在浏览器中的正文？'))return;await store.deleteJob(job.id);jobs=jobs.filter(j=>j.id!==job.id);$('#job-dialog').close();renderTasks();return;}
  if(!['export-txt','export-epub','export-report'].includes(id))return;
  const report=analyze(job);
  if(id==='export-report'){download(new Blob([JSON.stringify({title:job.book.title,source:job.book.url,notes:job.notes,...report},null,2)],{type:'application/json'}),job.book.title+'-质量报告.json');return;}
  if(activeJob===job.id)return toast('请先暂停抓取');
  if(!report.done)return toast('还没有成功抓取正文');
  const blocked=blockingReport(report);
  if(blocked&&!job.allowIssues)return toast(`体检结果：${report.gradeLabel}。请先核验报告，或勾选允许带异常导出`);
  const button=e.target.closest('button');button.disabled=true;try{await sleep(30);download(id==='export-txt'?makeTXT(job,report):makeEPUB(job,report),job.book.title+(blocked?'_待核验':'')+(id==='export-txt'?'.txt':'.epub'));toast('文件已生成');}catch(err){toast('生成失败：'+err.message);}finally{button.disabled=false;}
});
window.addEventListener('unhandledrejection',e=>{toast('操作失败：'+(e.reason?.message || '请重试'));});
async function init(){try{sources=await store.get('sources') || structuredClone(builtins);jobs=(await store.jobs()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));concurrency=await store.get('concurrency') || 3;engineId=await store.get('engine') || 'bing';$('#concurrency').value=concurrency;$('#concurrency-value').textContent=concurrency;$('#engine').innerHTML=ENGINES.map(e=>`<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');$('#engine').value=engineId;renderSources();renderTasks();initialized=true;}catch(e){toast('无法打开本地存储，请允许此网站使用浏览器存储后刷新');}
  try{const config=await (await fetch('/api/config')).json();openProxy=!!config.openProxy;allowedHosts=config.hosts || null;$('#host-info').textContent=config.openProxy?`访问口令：已启用\n代理放行：已自动放开\n\n因为设置了访问口令，只有带口令的请求能用这个代理，所以任意公网域名都能抓，不用再逐个加域名。IP 地址、localhost、内网域名仍然会被拒绝。\n\n请确认上面的口令框里填的就是这个令牌，否则所有抓取都会返回 401。`:`访问口令：未设置\n代理放行：白名单（只允许下列域名）\n\n${config.hosts.join('\n')}\n\n加书源时要把它的域名加进 Cloudflare 的 ALLOWED_HOSTS（逗号分隔、不含 https://、精确匹配，www 也要单独列一条）。\n\n设了 ACCESS_TOKEN 之后代理会自动放开，就不用再逐个加域名——记得同时在本页「设置」里填入同一个口令。`;}catch{$('#host-info').textContent='后端未连接。请通过本地服务器或 Cloudflare Workers 打开网页。';}
}init();
