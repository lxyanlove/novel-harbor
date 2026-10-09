import {proxy} from '../src/worker.js';
for(const url of ['https://gutendex.com/books/?search=pride&copyright=false','https://zh.wikisource.org/w/api.php?action=query&list=search&srsearch=%E7%B4%85%E6%A8%93%E5%A4%A2&srnamespace=0&srlimit=2&format=json&formatversion=2']){
  try{const result=await proxy({url});const json=JSON.parse(result.text);console.log(new URL(url).hostname,JSON.stringify({results:json.count || json.query?.search?.length,first:json.results?.[0]?.title || json.query?.search?.[0]?.title,error:json.error}));}catch(e){console.log(new URL(url).hostname,'FAILED',e.message,e.cause?.code || '');}
}
