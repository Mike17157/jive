// Persistent local browser session accessible through ordinary shell commands.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const root = fileURLToPath(new URL('..',import.meta.url));
const stateFile = join(root,'.cache/browser.json');
const [command = 'help', ...args] = process.argv.slice(2);
const state = async () => JSON.parse(await readFile(stateFile,'utf8'));
async function send(command,args=[]) {
  const {port,token} = await state();
  const response = await fetch(`http://127.0.0.1:${port}`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({command,args}),signal:AbortSignal.timeout(12000)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
async function serve() {
  await mkdir(join(root,'work'),{recursive:true});
  const app = await startServer();
  const browser = await chromium.launch({headless:!args.includes('--headed')});
  const context = await browser.newContext({viewport:{width:1100,height:850}});
  await context.tracing.start({screenshots:true,snapshots:true,sources:true});
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  const events = [];
  const log = event => {events.push({time:new Date().toISOString(),...event});if(events.length>500)events.shift();};
  page.on('request',r => log({type:'request',url:r.url()}));
  page.on('response',r => log({type:'response',url:r.url(),status:r.status()}));
  page.on('console',m => log({type:'console',text:m.text()}));
  page.on('pageerror',e => log({type:'error',text:e.message}));
  await page.goto(app.url);
  const token = randomBytes(24).toString('hex');
  let closing = false;
  async function close() {
    if(closing)return;closing=true;
    await writeFile(join(root,'work/browser-events.json'),JSON.stringify(events,null,2));
    await context.tracing.stop({path:join(root,'work/browser-trace.zip')});
    await browser.close();await app.close();
    api.close();api.closeAllConnections();
    await unlink(stateFile).catch(()=>{});
  }
  const snapshot = async () => ({url:page.url(),dom:await page.locator('body').ariaSnapshot()});
  let queue = Promise.resolve();
  const api = http.createServer(async(req,res) => {
    res.setHeader('Content-Type','application/json');
    if(req.method!=='POST'||req.headers.authorization!==`Bearer ${token}`){res.writeHead(403);res.end('{}');return;}
    let body='';for await(const part of req){body+=part;if(body.length>10000){res.writeHead(413);res.end('{}');return;}}
    queue = queue.then(async()=>{
      try {
        const {command,args=[]}=JSON.parse(body);
        let result;
        if(command==='snapshot'||command==='ping')result=await snapshot();
        else if(command==='fill'){await page.getByLabel('Search equipment').fill(args[0]??'');result=await snapshot();}
        else if(command==='clear'){await page.getByRole('button',{name:'Clear',exact:true}).click();result=await snapshot();}
        else if(command==='reload'){await page.reload();result=await snapshot();}
        else if(command==='wait'){await page.getByRole('status').filter({hasText:args[0]}).waitFor();result=await snapshot();}
        else if(command==='network')result={events};
        else if(command==='screenshot'){
          const name=args[0]??'browser';if(!/^[a-zA-Z0-9_-]+$/.test(name))throw new Error('Use a simple screenshot name');
          const path=join(root,'work',`${name}.png`);await page.screenshot({path,fullPage:true});result={path};
        }else if(command==='stop'){res.end(JSON.stringify({stopped:true}));await close();return;}
        else throw new Error('Unknown browser command');
        res.end(JSON.stringify(result));
      }catch(error){res.writeHead(400);res.end(JSON.stringify({error:error.message}));}
    });
  });
  await new Promise(r=>api.listen(0,'127.0.0.1',r));
  await writeFile(stateFile,JSON.stringify({port:api.address().port,token,url:app.url}),{mode:0o600});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>close().then(()=>process.exit(0)));
}
try {
  if(command==='_serve')await serve();
  else if(command==='start'){
    try{console.log(JSON.stringify(await send('ping')));process.exit(0);}catch{}
    await mkdir(join(root,'.cache'),{recursive:true});await mkdir(join(root,'work'),{recursive:true});
    await unlink(stateFile).catch(()=>{});
    const log=await open(join(root,'work/browser.log'),'a');
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'_serve',...args],{cwd:root,detached:true,stdio:['ignore',log.fd,log.fd]});
    child.unref();await log.close();
    const deadline=Date.now()+15000;let result;
    while(Date.now()<deadline){try{result=await send('ping');break;}catch{await new Promise(r=>setTimeout(r,100));}}
    if(!result)throw new Error('Browser did not start; inspect work/browser.log');
    console.log(JSON.stringify(result));
  }else if(command==='help')console.log('start [--headed] | snapshot | fill TEXT | clear | reload | wait STATUS_TEXT | network | screenshot [NAME] | stop');
  else console.log(JSON.stringify(await send(command,args)));
}catch(error){console.error(error.message);process.exitCode=1;}
