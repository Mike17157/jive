import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runChecks } from '../workspace/scripts/check.mjs';
import { scenarios } from './scenarios.mjs';

export async function verify(workspace, definition, output) {
  const checks = {}, metrics = {};
  let error;
  try {
    async function unchanged(relative='') {
      for(const entry of await readdir(join(definition,'workspace',relative),{withFileTypes:true})) {
        if(['node_modules','.cache','__pycache__','work','.git'].includes(entry.name))continue;
        const path=join(relative,entry.name);
        if(path==='tests'||path==='public/app.js'||path==='README.md'||path==='.gitignore')continue;
        if(entry.isDirectory())await unchanged(path);
        else if(!(await readFile(join(definition,'workspace',path))).equals(await readFile(join(workspace,path))))throw new Error(`Protected fixture changed: ${path}`);
      }
    }
    await unchanged();checks.fixture_integrity=true;
    const result=await runChecks({workspace,extraScenarios:scenarios,output:output+'.artifacts'});
    Object.assign(checks,result.checks);metrics.browserSeconds=result.elapsedSeconds;metrics.errors=result.errors;
    const tests=(await readdir(join(workspace,'tests'))).filter(name=>name.endsWith('.test.mjs'));
    checks.added_regression_test=tests.some(name=>name!=='smoke.test.mjs');
    const testRun=spawnSync(process.execPath,['--test',...tests.map(name=>join(workspace,'tests',name))],{cwd:workspace,encoding:'utf8',timeout:12000,maxBuffer:1024*1024});
    checks.agent_tests_pass=testRun.status===0;
    metrics.agentTests=(testRun.stdout??'')+(testRun.stderr??'');
    for(const name of ['before.png','after.png','browser-trace.zip','report.md']) {
      const file=join(workspace,'work',name);
      try {
        const data=await readFile(file);
        checks[name]=data.length>24 && (name.endsWith('.png') ? data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : name.endsWith('.zip') ? data.subarray(0,2).toString()==='PK' : true);
      }catch{checks[name]=false;}
    }
  }catch(e){checks.valid_submission=false;error=e.message;}
  const report={schemaVersion:1,task:'search_results_race',status:Object.values(checks).every(Boolean)?'passed':'failed',checks,metrics,error,limitations:['Evidence presence and automated behavior checks; reproduction method and added regression test quality require trace review. Local folder separation is not a sandbox.']};
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  return report;
}
if(process.env.TASKGROUND_WORKSPACE) {
  const report=await verify(process.env.TASKGROUND_WORKSPACE,process.env.TASKGROUND_DEFINITION,process.env.TASKGROUND_RESULT);
  console.log(JSON.stringify(report));process.exitCode=report.status==='passed'?0:1;
}
