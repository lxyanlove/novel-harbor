import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
// Verify the actual downloaded store-only EPUB without sharing the writer implementation.
const bytes=await readFile('test-results/fixture.epub');const entries=new Map();let offset=0;
while(bytes.readUInt32LE(offset)===0x04034b50){const compression=bytes.readUInt16LE(offset+8),len=bytes.readUInt32LE(offset+18),nameLen=bytes.readUInt16LE(offset+26),extraLen=bytes.readUInt16LE(offset+28),name=bytes.subarray(offset+30,offset+30+nameLen).toString('utf8'),start=offset+30+nameLen+extraLen;assert.equal(compression,0);entries.set(name,bytes.subarray(start,start+len).toString('utf8'));offset=start+len;}
assert.equal([...entries.keys()][0],'mimetype');assert.equal(entries.get('mimetype'),'application/epub+zip');assert.ok(entries.get('OEBPS/c0.xhtml').includes('第一页之后的第二页内容'));
assert.ok(entries.get('OEBPS/c1.xhtml').includes('另一段故事'));
for(const match of entries.get('OEBPS/package.opf').matchAll(/<item[^>]+href="([^"]+)"/g))assert.ok(entries.has('OEBPS/'+match[1]),'manifest target exists: '+match[1]);
const txt=await readFile('test-results/fixture.txt','utf8');assert.ok(txt.includes('第一页之后的第二页内容'));assert.ok(txt.includes('第二章 归来'));
console.log(`PASS: actual EPUB contains ${entries.size} ZIP entries, manifest links resolve, paginated Unicode content retained in both TXT and EPUB.`);
