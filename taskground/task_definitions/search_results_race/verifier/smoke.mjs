// Maintainer-only validation. Never copied into agent workspaces.
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from './verify.mjs';

const definition=fileURLToPath(new URL('..',import.meta.url));
const root=await mkdtemp(join(tmpdir(),'taskground-browser-smoke-'));
const workspace=join(root,'workspace');
try {
  await cp(join(definition,'workspace'),workspace,{recursive:true,filter:path=>!path.includes('/work/')&&!path.endsWith('/work')&&!path.includes('/.cache/')&&!path.endsWith('/.cache')});
  await mkdir(join(workspace,'work'),{recursive:true});
  const baseline=await verify(workspace,definition,join(root,'baseline.json'));
  assert.equal(baseline.status,'failed');
  assert.equal(baseline.checks.single,true);
  assert.equal(baseline.checks.reversed,false);
  assert.equal(baseline.checks.clear,false);
  let source=await readFile(join(workspace,'public/app.js'),'utf8');
  source=source.replace('async function search() {','let generation = 0;\nasync function search() {\n  const current = ++generation;');
  source=source.replace('    render(items);','    if (current !== generation) return;\n    render(items);');
  source=source.replace('  } catch (error) {','  } catch (error) {\n    if (current !== generation) return;');
  await writeFile(join(workspace,'public/app.js'),source);
  await writeFile(join(workspace,'tests/regression.test.mjs'),`import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {runChecks} from '../scripts/check.mjs';\ntest('latest search wins',async()=>{const r=await runChecks();assert.equal(r.checks.reversed,true);});\n`);
  await copyFile(join(root,'baseline.json.artifacts/reversed.png'),join(workspace,'work/before.png'));
  // Oracle artifacts validate grading plumbing; this is not an agent demonstration.
  await copyFile(join(root,'baseline.json.artifacts/single.png'),join(workspace,'work/after.png'));
  await copyFile(join(root,'baseline.json.artifacts/trace.zip'),join(workspace,'work/browser-trace.zip'));
  await writeFile(join(workspace,'work/report.md'),'Maintainer oracle: generation ownership invalidates stale successes, errors, and cleared queries.');
  const fixed=await verify(workspace,definition,join(root,'fixed.json'));
  assert.equal(fixed.status,'passed',JSON.stringify(fixed,null,2));
  // A superficially plausible guard on success alone must still fail.
  await writeFile(join(workspace,'public/app.js'),source.replace('  } catch (error) {\n    if (current !== generation) return;','  } catch (error) {'));
  const partial=await verify(workspace,definition,join(root,'partial.json'));
  assert.equal(partial.checks['stale-error'],false);
  assert.equal(partial.status,'failed');
  await writeFile(join(workspace,'scripts/server.mjs'),'// modified harness');
  const tampered=await verify(workspace,definition,join(root,'tampered.json'));
  assert.equal(tampered.status,'failed');
  console.log(JSON.stringify({baseline:baseline.status,fixed:fixed.status,partial:partial.status,tampered:tampered.status,browserSeconds:fixed.metrics.browserSeconds}));
}finally{await rm(root,{recursive:true,force:true});}
