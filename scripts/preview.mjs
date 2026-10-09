import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import worker from '../src/worker.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','public');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
const env={ALLOWED_HOSTS:process.env.ALLOWED_HOSTS,ACCESS_TOKEN:process.env.ACCESS_TOKEN,ASSETS:{async fetch(req){
  const pathname=decodeURIComponent(new URL(req.url).pathname),file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep))return new Response('Forbidden',{status:403});
  try{return new Response(await readFile(file),{headers:{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'}});}catch{return new Response('Not found',{status:404});}
}}};
const server=http.createServer(async(req,res)=>{try{
  const request=new Request(`http://127.0.0.1:${process.env.PORT||8787}${req.url}`,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:req,duplex:'half'})});
  const response=await worker.fetch(request,env,{waitUntil:p=>p.catch(console.error)});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
server.listen(Number(process.env.PORT||8787),'127.0.0.1',()=>console.log(`Local: http://127.0.0.1:${process.env.PORT||8787}`));
