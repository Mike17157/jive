import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const catalog = [
  {id:1,name:'Camera · Pocket cinema',category:'CAMERAS'},
  {id:2,name:'Camera · Studio digital',category:'CAMERAS'},
  {id:3,name:'Light · Portable panel',category:'LIGHTING'},
  {id:4,name:'Light · Softbox kit',category:'LIGHTING'},
  {id:5,name:'Tripod · Travel carbon',category:'SUPPORT'},
  {id:6,name:'Microphone · Field recorder',category:'AUDIO'},
];
export async function startServer({publicDir = fileURLToPath(new URL('../public', import.meta.url)), port = 0} = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        // Stable local service latency, independent of network conditions.
        await new Promise(r => setTimeout(r, q === 'camera' ? 900 : 60));
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = q === 'offline' ? 503 : 200;
        res.end(JSON.stringify({items: catalog.filter(item => item.name.toLowerCase().includes(q))}));
        return;
      }
      const files = {'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
      const file = files[url.pathname];
      if (!file) { res.writeHead(404); res.end('Not found'); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await readFile(resolve(publicDir, file)));
    } catch { res.writeHead(500); res.end('Server error'); }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
  return {url:`http://127.0.0.1:${server.address().port}`, close:() => new Promise(r => {server.close(r); server.closeAllConnections();})};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer({port:Number(process.env.PORT ?? 4173)});
  console.log(server.url);
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => {await server.close(); process.exit(0);});
}
