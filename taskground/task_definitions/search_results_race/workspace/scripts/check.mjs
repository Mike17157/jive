import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const ownWorkspace = fileURLToPath(new URL('..', import.meta.url));
export async function runChecks({workspace = ownWorkspace, extraScenarios = [], output = join(workspace,'work','check')} = {}) {
  const {chromium} = createRequire(join(workspace,'package.json'))('playwright');
  await mkdir(output, {recursive:true});
  const server = await startServer({publicDir:join(workspace,'public')});
  let browser;
  const checks = {}, errors = {};
  const started = performance.now();
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({viewport:{width:1100,height:850}});
    await context.tracing.start({screenshots:true,snapshots:true,sources:true});
    const scenarios = ['single','empty','error','reversed', ...extraScenarios.map(scenario => scenario.name)];
    for (const scenario of scenarios) {
      const page = await context.newPage();
      page.setDefaultTimeout(1800);
      const pending = [];
      const pageErrors = [];
      page.on('pageerror', e => pageErrors.push(e.message));
      await page.route('**/api/search?*', route => {pending.push(route);});
      try {
        await page.goto(server.url);
        const input = page.getByLabel('Search equipment');
        const status = page.getByRole('status');
        const text = () => page.locator('#results').innerText();
        const issue = async query => {
          const index = pending.length;
          const request = page.waitForRequest(r => new URL(r.url()).pathname === '/api/search');
          await input.fill(query);
          await request;
          // Route dispatch may follow the request event by a microtask.
          const deadline = Date.now() + 1800;
          while (!pending[index]) {
            if (Date.now() > deadline) throw new Error('Request was not routed');
            await new Promise(r => setTimeout(r, 5));
          }
          return pending[index];
        };
        const release = async (route, name, code = 200) => {
          const request = route.request();
          const complete = new Promise(ok => {
            const finished = r => {if (r === request) {cleanup(); ok();}};
            const cleanup = () => {page.off('requestfinished',finished);page.off('requestfailed',finished);clearTimeout(timer);};
            const timer = setTimeout(() => {cleanup();ok();}, 1000);
            page.on('requestfinished',finished);page.on('requestfailed',finished);
          });
          await route.fulfill({status:code,contentType:'application/json',body:JSON.stringify({items:name ? [{id:1,name,category:'TEST COLLECTION'}] : []})}).catch(e => {
            if (!request.failure()) throw e;
          });
          if (!request.failure()) await complete;
          // Allow DOM work queued by the completed response to paint.
          await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        };
        const ready = async name => {
          await page.waitForFunction(name => document.querySelector('#results').textContent.includes(name), name, {timeout:1800});
          assert.ok((await text()).includes(name));
          assert.ok(!(await status.innerText()).includes('Searching'));
        };
        if (['single','empty','error'].includes(scenario)) {
          const request = await issue('camera');
          assert.equal(await status.innerText(), 'Searching…');
          await release(request, scenario === 'single' ? 'Camera result' : '', scenario === 'error' ? 503 : 200);
          if (scenario === 'single') await ready('Camera result');
          else {assert.equal(await text(),'');assert.match(await status.innerText(),scenario === 'error' ? /unavailable/i : /No results/);}
        } else if (scenario === 'reversed') {
          const old = await issue('camera');
          const latest = await issue('light');
          await release(latest,'Current result');
          await ready('Current result');
          await release(old,'Old camera');
          assert.ok((await text()).includes('Current result'));
          assert.ok(!(await text()).includes('Old camera'));
        } else {
          await extraScenarios.find(item => item.name === scenario).run({page,input,status,text,issue,release,ready});
        }
        assert.deepEqual(pageErrors, []);
        checks[scenario] = true;
      } catch (error) {checks[scenario] = false; errors[scenario] = error.message;}
      await page.screenshot({path:join(output,`${scenario}.png`),fullPage:true});
      await page.close();
    }
    await context.tracing.stop({path:join(output,'trace.zip')});
    await context.close();
  } finally {await browser?.close(); await server.close();}
  const report = {checks,errors,elapsedSeconds:Number(((performance.now()-started)/1000).toFixed(2))};
  await writeFile(join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runChecks();
  console.log(JSON.stringify(report,null,2));
  process.exitCode = Object.values(report.checks).every(Boolean) ? 0 : 1;
}
