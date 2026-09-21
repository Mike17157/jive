import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const workspace = fileURLToPath(new URL('..', import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, {cwd:workspace, stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('npm', ['ci','--ignore-scripts','--no-audit','--no-fund']);
const {chromium} = await import('playwright');
if (!existsSync(chromium.executablePath())) run(process.execPath, ['node_modules/playwright/cli.js','install','chromium']);
// Verify the headless executable and host libraries as well as the full browser.
try { const browser = await chromium.launch(); await browser.close(); }
catch { run(process.execPath, ['node_modules/playwright/cli.js','install','chromium']); const browser = await chromium.launch(); await browser.close(); }
console.log('Browser task ready. No network is needed during the demo.');
