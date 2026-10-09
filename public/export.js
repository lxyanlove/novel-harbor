const encoder=new TextEncoder();
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
// Store-only ZIP: EPUB requires mimetype to be the first, uncompressed entry.
export function zipStore(files){
  const output=[],central=[];let offset=0;
  for(const [name,text] of files){const n=encoder.encode(name),data=encoder.encode(text),crc=crc32(data);const head=new Uint8Array(30+n.length),v=new DataView(head.buffer);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(12,33,true);v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,n.length,true);head.set(n,30);
    const entry=new Uint8Array(46+n.length),e=new DataView(entry.buffer);e.setUint32(0,0x02014b50,true);e.setUint16(4,20,true);e.setUint16(6,20,true);e.setUint16(8,0x800,true);e.setUint16(14,33,true);e.setUint32(16,crc,true);e.setUint32(20,data.length,true);e.setUint32(24,data.length,true);e.setUint16(28,n.length,true);e.setUint32(42,offset,true);entry.set(n,46);
    output.push(head,data);central.push(entry);offset+=head.length+data.length;
  }
  const size=central.reduce((n,x)=>n+x.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,size,true);e.setUint32(16,offset,true);
  return new Blob([...output,...central,end],{type:'application/epub+zip'});
}
export const xml=s=>String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const xhtml=(title,body,lang)=>`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xml(lang)}"><head><title>${xml(title)}</title><meta charset="UTF-8"/><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;
function reportText(report){
  const lines=[`体检结论：${report.conclusion} · 总分 ${report.score}/100（${report.gradeLabel}）`,report.verdict];
  if(report.completeness.available)lines.push(`抓取完整性：${report.completeness.score}/100 — ${report.completeness.label}`);
  lines.push(`文本质量：${report.quality.score}/100`);
  const groups=report.quality.groups.filter(g=>g.penalty>0).sort((a,b)=>b.penalty-a.penalty);
  if(groups.length)lines.push('扣分项：'+groups.map(g=>`${g.name}(-${g.penalty}，命中 ${g.hits} 处)`).join('；'));
  lines.push(`校对声明：${report.proofread}`,report.disclaimer);
  return lines;
}
export function makeTXT(job,report){return new Blob(['﻿',`${job.book.title}\r\n${job.book.author || '作者未提供'}\r\n来源：${job.book.url}\r\n${reportText(report).join('\r\n')}\r\n\r\n`,...job.chapters.map(c=>`${c.title}\r\n\r\n${c.state==='done'?c.text:'[缺失章节：'+(c.error || '未完成')+']'}\r\n\r\n`)],{type:'text/plain;charset=utf-8'});}
function reportHTML(report){
  const groups=report.quality.groups.filter(g=>g.penalty>0).sort((a,b)=>b.penalty-a.penalty);
  return `<h2>体检报告</h2><p><b>${xml(report.gradeLabel)}</b> · 总分 ${report.score}/100</p><p>${xml(report.verdict)}</p><ul><li>抓取完整性：${report.completeness.available?report.completeness.score+'/100 — '+xml(report.completeness.label):'未评估（抽样体检）'}</li><li>文本质量：${report.quality.score}/100</li></ul>${groups.length?`<table><tr><th>扣分项</th><th>扣分</th><th>命中</th></tr>${groups.map(g=>`<tr><td>${xml(g.name)}</td><td>-${g.penalty}</td><td>${g.hits} 处 / ${g.chaptersHit} 章</td></tr>`).join('')}</table>`:''}<p>${xml(report.proofread)}</p><p><i>${xml(report.disclaimer)}</i></p>${report.issues.length?`<p>逐条检查记录（${report.issues.length} 条）：</p><ul>${report.issues.slice(0,300).map(i=>`<li>${xml(i.message)}</li>`).join('')}</ul>`:''}`;
}
export function makeEPUB(job,report){
  const {book,chapters}=job,lang=book.lang || book.source?.lang || 'zh',id=`urn:uuid:${crypto.randomUUID()}`;
  const files=[['mimetype','application/epub+zip'],['META-INF/container.xml','<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>']];
  const manifest=chapters.map((c,i)=>`<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  files.push(['OEBPS/package.opf',`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${xml(lang)}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${id}</dc:identifier><dc:title>${xml(book.title)}</dc:title><dc:creator>${xml(book.author || '作者未提供')}</dc:creator><dc:language>${xml(lang)}</dc:language><dc:source>${xml(book.url)}</dc:source><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/,'Z')}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="info" href="info.xhtml" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/>${manifest}</manifest><spine><itemref idref="info"/>${chapters.map((_,i)=>`<itemref idref="c${i}"/>`).join('')}</spine></package>`]);
  files.push(['OEBPS/nav.xhtml',xhtml('目录',`<nav epub:type="toc" id="toc"><h1>目录</h1><ol><li><a href="info.xhtml">来源与检查报告</a></li>${chapters.map((c,i)=>`<li><a href="c${i}.xhtml">${xml(c.title)}</a></li>`).join('')}</ol></nav>`,lang)]);
  files.push(['OEBPS/style.css','body{line-height:1.8;font-family:serif;margin:5%;}p{text-indent:2em;}h1{font-size:1.5em;}h2{font-size:1.2em;}a{color:inherit;}table{border-collapse:collapse;font-size:.9em;}th,td{border:1px solid #999;padding:.2em .5em;text-align:left;}']);
  files.push(['OEBPS/info.xhtml',xhtml(book.title,`<h1>${xml(book.title)}</h1><p>${xml(book.author)}</p><p>来源：<a href="${xml(book.url)}">${xml(book.source?.bookSourceName || book.url)}</a></p>${reportHTML(report)}${(job.notes || []).map(n=>`<p>${xml(n)}</p>`).join('')}`,lang)]);
  chapters.forEach((c,i)=>files.push([`OEBPS/c${i}.xhtml`,xhtml(c.title,`<h1>${xml(c.title)}</h1>${(c.state==='done'?c.text:'[缺失章节：'+(c.error || '未完成')+']').split(/\n+/).filter(Boolean).map(p=>`<p>${xml(p)}</p>`).join('')}`,lang)]));return zipStore(files);
}
export function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_');a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
