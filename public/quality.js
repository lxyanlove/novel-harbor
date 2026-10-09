// 书港 · 完整性与文本质量评估
//
// 输出两组互相独立的信号：
//   completeness —— 抓取覆盖：目录有多少章、成功多少章、编号是否连续、目录范围是否确认。
//   quality      —— 正文表面症状：站点广告水印、乱码、重复段落、疑似截断、排版失范。
// 两者都是启发式检查，只能提示「像不像一份干净完整的文本」，用于在多个来源之间取舍；
// 不能证明作品已完结、无缺字或经过人工校对，界面与导出都会保留这句免责声明。

export function chapterNumber(title) {
  const m = String(title || '').match(/第\s*([零〇一二两三四五六七八九十百千万\d]+)\s*[章回节]/);
  if (!m) return null;
  if (/^\d+$/.test(m[1])) return Number(m[1]);
  const digits = {'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  const units = {'十':10,'百':100,'千':1000,'万':10000};
  let total = 0, part = 0, n = 0;
  for (const ch of m[1]) {
    if (ch in digits) n = digits[ch];
    else if (ch === '万') { total += (part + n) * 10000; part = 0; n = 0; }
    else { part += (n || 1) * units[ch]; n = 0; }
  }
  return total + part + n;
}

const RADIUS = 16;
function snippet(text, needle) {
  const i = text.indexOf(needle);
  if (i < 0) return needle;
  const start = Math.max(0, i - RADIUS), end = Math.min(text.length, i + needle.length + RADIUS);
  return (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
}

// 逐类统计命中的关键词。weight 是这一类最多能扣多少分，scale 是「平均每章命中多少次算满」。
const TEXT_GROUPS = [
  {id:'ad', name:'站点广告与水印', weight:32, scale:0.5, advice:'正文残留站点推广语、采集站名称或网址，通常说明这份文本是从采集站直接扒下来、没有清理过。', patterns:[
    {name:'站点推广语', re:/请?记住本站|一秒记住|记住本[书站]?(?:域名|网址|地址)?|最快更新|无弹窗|全文字|全文免费阅读|本书首发|首发于|最新网址|手机用户请(?:浏览|阅读)|手机(?:版)?阅读|请勿(?:转载|盗版)/g},
    {name:'残留网址', re:/(?:https?:\/\/|www\.|m\.|wap\.)[a-z0-9-]{2,}\.(?:com|net|org|cn|cc|info|xyz|top|vip|la|me|tv|name|biz)\b/gi},
    {name:'拆字域名', re:/\b[a-z]\s*[.．、]\s*[a-z]\s*[.．、]\s*[a-z]\s*[.．、]\s*[a-z]/gi},
    {name:'采集站标识', re:/笔趣阁|笔趣岛|笔趣读|顶点小说|飘天文学|书趣阁|全本小说网|落秋中文|看书网|小说阅读网|言情小说吧|得书网|快眼看书|云来阁|中文书库|全本免费/g},
  ]},
  {id:'garble', name:'乱码与错误转码', weight:40, scale:0.25, advice:'替换字符、错误转码特征或成片方框意味着编码处理出了问题，正文可能整段缺字。', patterns:[
    {name:'替换字符', re:/�/g},
    {name:'错误转码', re:/锟斤拷|烫烫烫|屯屯屯|锘匡|镓卞|一冠/g},
    {name:'占位方框', re:/[□■▪◾◼]/g},
    {name:'连续问号', re:/\?{4,}|？{4,}/g},
  ]},
  {id:'markup', name:'标记与隐形字符残留', weight:12, scale:0.5, advice:'HTML 标签、未解码实体或零宽字符没有被清理，属于未加工的原始网页文本。', patterns:[
    {name:'HTML 标签残留', re:/<\/?(?:br|p|div|span|font|b|i|u|a|img|script|table|tr|td|strong|em)\b[^>]*>/gi},
    {name:'HTML 实体未解码', re:/&(?:nbsp|amp|lt|gt|quot|apos|#\d{2,5}|#x[0-9a-f]{2,4});/gi},
    {name:'零宽与控制字符', re:/[\u200b\u200c\u200d\u200e\u200f\u2028\u2029\u00ad\ufeff]/g},
  ]},
  {id:'note', name:'作者感言与更新说明', weight:10, scale:0.8, advice:'正文混入作者求票、感言或「未完待续」。原创站连载本来就常带这些，因此只做提示、权重较低。', patterns:[
    {name:'求票与感言', re:/求(?:推荐票|月票|订阅|收藏|打赏|评价票)|感谢.{0,8}(?:打赏|月票|推荐票|投票)|月票.{0,4}(?:加更|感谢)|(?:读|书)者群|书友群|QQ群[:：]?\s*\d{5,}/g},
    {name:'更新说明', re:/本章未完|未完待续|下章(?:更精彩|预告)|且听下回分解|今天(?:两更|三更|一更|二更)/g},
  ]},
];

const INTERCEPT = /验证码|访问过于频繁|Just a moment|Access denied|请开启JavaScript|章节不存在|内容缺失|待补充|该页无法显示/i;
const ENDERS = '。！？…”’」』）】》].!?~～—';
const CLAIM = /已校[对對]|精校|校[对對]版|已[复複]核|无错别字|未校[对對]|校对过/g;

const pct = (n, d) => d > 0 ? n / d : 0;
const clamp01 = n => n < 0 ? 0 : n > 1 ? 1 : n;
// 饱和曲线：命中密度越高扣分越多，但永远不会因单章异常直接归零。
const saturate = (perChapter, scale) => perChapter <= 0 ? 0 : 1 - Math.exp(-perChapter / scale);

export function scanChapter(text) {
  const t = String(text || '').replace(/^\ufeff/, '');
  const groups = {};
  for (const g of TEXT_GROUPS) {
    let hits = 0; const samples = [];
    for (const p of g.patterns) {
      const m = t.match(p.re);
      if (!m) continue;
      hits += m.length;
      for (const s of m) { if (samples.length >= 3) break; samples.push(snippet(t, s)); }
    }
    groups[g.id] = {hits, samples};
  }
  const paras = t.split(/\n+/).map(s => s.trim()).filter(s => s.length >= 10);
  const seen = new Set(); let dup = 0;
  for (const p of paras) { const k = p.replace(/\s/g, ''); if (seen.has(k)) dup++; else seen.add(k); }
  const body = t.trim();
  const tail = body.slice(-1);
  return {
    chars: t.length,
    groups,
    paras: paras.length,
    dup,
    cut: body.length > 0 && !ENDERS.includes(tail),
    halfPunct: (t.match(/[一-龥][,;:!?](?=[一-龥]|\s|$)/g) || []).length,
    noBreak: t.length > 600 && (t.match(/\n/g) || []).length < 3,
  };
}

function textGroupScores(scans, chaptersTotal) {
  return TEXT_GROUPS.map(g => {
    let hits = 0, hitChapters = 0; const samples = [];
    for (const s of scans) {
      const h = s.groups[g.id].hits;
      if (!h) continue;
      hits += h; hitChapters++;
      for (const x of s.groups[g.id].samples) { if (samples.length < 3) samples.push(x); }
    }
    const severity = chaptersTotal ? saturate(hits / chaptersTotal, g.scale) : 0;
    return {id:g.id, name:g.name, weight:g.weight, severity, penalty:Math.round(g.weight * severity), hits, chaptersHit:hitChapters, samples, advice:g.advice};
  });
}

export function analyze(job, options = {}) {
  const chapters = Array.isArray(job.chapters) ? job.chapters : [];
  const sampled = !!job.sampled;
  const issues = [];
  const seen = new Map();
  const titleSeen = new Map();
  let previous = null, done = 0, chars = 0, failed = 0, pending = 0, interceptFound = false;
  const scans = [];
  const lengths = [];

  for (const [i, c] of chapters.entries()) {
    if (c.state === 'skipped') continue;
    if (c.state !== 'done') {
      if (c.state === 'error') failed++; else pending++;
      issues.push({kind:'coverage', level:'error', chapter:i + 1, message:`${c.title}：${c.error || '尚未抓取成功'}`});
      continue;
    }
    done++;
    const text = c.text || '';
    chars += text.length;
    lengths.push(text.trim().length);
    scans.push(scanChapter(text));

    if (text.trim().length < 80) issues.push({kind:'quality', level:'warning', chapter:i + 1, message:`${c.title}：正文不足 80 字，请检查是否为空章或短篇`});
    if (INTERCEPT.test(text)) { interceptFound = true; issues.push({kind:'coverage', level:'warning', chapter:i + 1, message:`${c.title}：疑似拦截页或缺失内容`}); }
    const fingerprint = text.replace(/\s/g, '');
    if (fingerprint.length > 100) {
      if (seen.has(fingerprint)) issues.push({kind:'quality', level:'warning', chapter:i + 1, message:`${c.title}：与第 ${seen.get(fingerprint)} 项正文相同`});
      else seen.set(fingerprint, i + 1);
    }
    const num = chapterNumber(c.title);
    if (num !== null) {
      if (previous !== null && num > previous + 1) issues.push({kind:'coverage', level:'warning', chapter:i + 1, message:`章节编号由 ${previous} 跳到 ${num}，疑似缺章（也可能为分卷或命名差异）`});
      previous = num;
    }
    const titleText = String(c.title || '').trim();
    if (titleText) { if (titleSeen.has(titleText)) issues.push({kind:'quality', level:'warning', chapter:i + 1, message:`目录中出现重复标题「${titleText}」（第 ${titleSeen.get(titleText)} 项），目录可能错乱`}); else titleSeen.set(titleText, i + 1); }
  }

  // —— 完整性 ——
  const total = chapters.filter(c => c.state !== 'skipped').length;
  const missing = failed + pending;
  const missingRatio = pct(missing, total);
  const coverageConfirmed = job.tocComplete !== false;
  const expectedMismatch = !!job.expectedCount && Number(job.expectedCount) !== chapters.length;
  if (expectedMismatch) issues.push({kind:'coverage', level:'error', message:`预期 ${job.expectedCount} 章，实际目录 ${chapters.length} 章`});
  if (!chapters.length) issues.push({kind:'coverage', level:'error', message:'目录为空'});
  if (!job.tocComplete) issues.push({kind:'coverage', level:'warning', message:'目录覆盖范围尚未确认，请对照原站目录核验。'});

  let completeness = null;
  if (!sampled) {
    let score = 100;
    if (total) score -= Math.round(100 * missingRatio);
    if (job.expectedCount && Number(job.expectedCount) > chapters.length) score -= 15;
    if (!job.tocComplete) score = Math.min(score, 60);
    completeness = {
      available: true, score: Math.max(0, Math.min(100, score)),
      total, done, failed, pending, expected: job.expectedCount || null, coverageConfirmed,
      label: missing ? `${missing} 章未抓取成功（${failed} 失败 / ${pending} 未抓）` : coverageConfirmed ? '目录章节已全部抓取，覆盖范围由来源确认' : '目录章节已全部抓取，但目录覆盖范围未经确认',
    };
  } else {
    completeness = {available:false, score:null, total, done, failed, pending, expected:null, coverageConfirmed:false, label:'体检只抽样了部分章节，未评估整体覆盖'};
  }

  // —— 文本质量 ——
  const sorted = [...lengths].sort((a, b) => a - b);
  const medianChars = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const groups = textGroupScores(scans, done);
  let dupParas = 0, cutChapters = 0, halfPunct = 0, noBreak = 0;
  for (const s of scans) {
    dupParas += s.dup; cutChapters += s.cut ? 1 : 0; halfPunct += s.halfPunct; noBreak += s.noBreak ? 1 : 0;
  }
  const allParas = scans.reduce((n, s) => n + s.paras, 0);
  // 短章以本书自身中位数为基准：诗集、散文集整本都短，不该因此被扣分。
  const shortFloor = Math.max(80, Math.round(medianChars * 0.15));
  const shortChapters = medianChars > 400 ? lengths.filter(n => n < shortFloor).length : 0;
  const structural = [
    {id:'dup', name:'重复段落', weight:20, severity:clamp01(pct(dupParas, Math.max(1, allParas)) / 0.25), advice:'同一章里出现完全相同的段落，常见于采集拼接出错或填充占位内容。', hits:dupParas, chaptersHit:scans.filter(s=>s.dup>0).length, samples:[]},
    {id:'cut', name:'疑似截断', weight:20, severity:clamp01(pct(cutChapters, done) / 0.5), advice:'章节结尾不是完整句子（没有句末标点），可能正文被截断——但也可能是连载悬念或场景分隔，需抽查。', hits:cutChapters, chaptersHit:cutChapters, samples:[]},
    {id:'short', name:'过短章节', weight:15, severity:clamp01(pct(shortChapters, done) / 0.3), advice:'明显短于本书其他章节的正文。少量可能是序章或分隔页，成片出现说明目录里混入了空章。', hits:shortChapters, chaptersHit:shortChapters, samples:[]},
    {id:'layout', name:'排版失范', weight:12, severity:clamp01(clamp01(pct(noBreak, done) / 0.3) * 0.6 + clamp01((halfPunct / Math.max(1, chars / 1000)) / 8) * 0.4), advice:'整章几乎不换行或中文里混用半角标点，说明文本没有经过排版整理。', hits:noBreak + halfPunct, chaptersHit:noBreak, samples:[]},
  ].map(g => ({...g, penalty:Math.round(g.weight * g.severity)}));
  for (const g of groups) if (g.chaptersHit > 0) issues.push({kind:'quality', level:g.penalty >= 20 ? 'error' : 'warning', message:`${g.chaptersHit} 章命中「${g.name}」（共 ${g.hits} 处）${g.samples.length ? '，例如 ' + g.samples[0] : ''}`});

  const allGroups = [...groups, ...structural];
  const qualityScore = Math.max(0, Math.min(100, 100 - allGroups.reduce((n, g) => n + g.penalty, 0)));
  // 「作者求票」「排版失范」这类轻量提示不参与封顶，只有实质性症状（广告、乱码、截断、重复、空章）才收紧分数。
  const worstGroup = allGroups.filter(g => g.weight >= 15).reduce((m, g) => g.severity > m.severity ? g : m, {severity:0, id:'', weight:0});
  const qualityError = issues.some(i => i.level === 'error' && i.kind === 'quality');
  const coverageError = issues.some(i => i.level === 'error' && i.kind === 'coverage');

  // —— 合计 ——
  // 只有「整页拦截」「目录为空」「预期章数不符」「文本大面积乱码」「≥5% 章节没抓到」这类硬伤才把总分压到 45；
  // 零星一两章失败只按比例扣完整性分，不因此否定整本书。
  const hardDefect = interceptFound || expectedMismatch || !chapters.length || missingRatio >= 0.05 || qualityError;
  let score = sampled ? qualityScore : Math.round(0.5 * completeness.score + 0.5 * qualityScore);
  // 抽样时一两章失败只说明「这个来源不稳」，不足以像整本下载那样直接判到 45。
  if (hardDefect) score = Math.min(score, sampled ? 60 : 45);
  // 单项症状拉满时总分不该因为其他项正常而被抬回来：乱码是废文本，截断/重复/广告至少是 warning。
  if (worstGroup.severity >= 0.9) score = Math.min(score, worstGroup.id === 'garble' ? 40 : 65);
  else if (worstGroup.severity >= 0.5) score = Math.min(score, 80);
  const grade = score >= 85 ? 'clean' : score >= 70 ? 'minor' : score >= 45 ? 'warning' : 'severe';
  const gradeLabel = sampled
    ? {clean:'抽样未发现明显问题', minor:'抽样发现轻微问题', warning:'抽样发现明显问题', severe:'抽样发现严重问题'}[grade]
    : {clean:'未发现明显问题', minor:'有轻微问题', warning:'问题较多，建议对比其他来源', severe:'不建议使用这个来源'}[grade];
  const topDeductions = allGroups.filter(g => g.penalty > 0).sort((a, b) => b.penalty - a.penalty).slice(0, 3).map(g => g.name);
  const deductionText = topDeductions.length ? '，主要扣分项：' + topDeductions.join('、') : '';
  const verdict = sampled
    ? `抽样 ${chapters.filter(c => c.state !== 'skipped').length} 章、成功 ${done} 章：文本质量 ${qualityScore} 分${deductionText}。`
    : `完整性 ${completeness.score} 分，文本质量 ${qualityScore} 分${deductionText}。`;

  const evidence = (((job.book || {}).title || '') + ' ' + (job.notes || []).join(' ')).match(CLAIM) || [];
  // 抽样体检只能谈「抽到的那几章」，不能拿样本断言整本书的完整性。
  const conclusion = sampled
    ? (failed ? '抽样中有章节抓取失败'
      : grade === 'severe' ? '抽样样本文本质量存疑'
      : grade !== 'clean' ? '抽样样本发现问题'
      : '抽样未发现明显问题')
    : coverageError && (missingRatio >= 0.05 || interceptFound || expectedMismatch || !chapters.length)
    ? '抓取不完整'
    : grade === 'severe' ? '文本质量存疑'
    : (grade !== 'clean' || issues.length) ? '需要人工核验'
    : '未发现明显抓取异常';

  return {
    at: new Date().toISOString(),
    sampled, done, total: chapters.length, chars, issues, conclusion,
    score, grade, gradeLabel, verdict,
    completeness,
    quality: {score:qualityScore, groups:allGroups},
    stats: {
      chapters: done,
      avgChars: lengths.length ? Math.round(chars / lengths.length) : 0,
      medianChars,
      shortest: sorted.length ? sorted[0] : 0,
      shortChapters: lengths.filter(n => n < 80).length,
      cutChapters,
    },
    proofread: evidence.length
      ? `来源文本出现「${[...new Set(evidence)].join('、')}」，属于来源自述、未独立验证`
      : '来源未声明校对信息，且无法从正文自动确认是否经过校对',
    disclaimer: '检查只能发现部分异常，不能证明作品已完结、全文无缺失或经过人工校对。',
  };
}

// 跨来源排序：先看抓取完整性，再看文本质量，最后看目录章数与最新章节。
export function rankVersions(items) {
  const scoreOf = value => typeof value === 'number' ? value : -1;
  const completeness = n => {
    const c = n.report && n.report.completeness;
    return c && c.available ? c.score : -1;
  };
  const quality = n => scoreOf(n.report && n.report.quality && n.report.quality.score);
  return [...items].sort((a, b) =>
    (b.chapters - a.chapters) || (completeness(b) - completeness(a)) || (quality(b) - quality(a)));
}
