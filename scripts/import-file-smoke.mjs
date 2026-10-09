import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const sourcePath=process.argv[2];
if(!sourcePath)throw new Error('Usage: node scripts/import-file-smoke.mjs <bookSource.json>');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8787/');await page.waitForFunction(()=>document.querySelector('#source-count').textContent!=='—');
  await page.locator('#sources-btn').click();await page.locator('#source-file').setInputFiles(sourcePath);
  await page.waitForFunction(()=>document.querySelector('#import-report').textContent.includes('已读取 931 个书源'),null,{timeout:30000});
  const report=await page.locator('#import-report').innerText();
  assert.match(report,/导入 2 个，跳过 929 个/);assert.deepEqual(errors,[]);
  console.log(report.split('\n').slice(0,14).join('\n'));
  console.log('PASS: 6.6 MB / 931-source file was accepted and classified without a browser exception.');
}finally{await browser.close();}
