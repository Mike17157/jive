// Held-out scenarios stay in the runner's definition snapshot, outside the workspace.
import assert from 'node:assert/strict';

export const scenarios = ['clear','blank','stale-error','loading','same-query','latest-error','latest-empty','three-requests'].map(name => ({
  name,
  async run({page,input,status,text,issue,release,ready}) {
    if (name === 'clear' || name === 'blank') {
      const old = await issue('tripod');
      if (name === 'clear') await page.getByRole('button',{name:'Clear',exact:true}).click();
      else await input.fill('   ');
      await release(old,'Old tripod');
      assert.equal((await input.inputValue()).trim(),'');
      assert.equal(await text(),'');
      assert.match(await status.innerText(),/Start typing/);
      return;
    }
    const old = await issue('camera');
    let middle;
    if (name === 'three-requests' || name === 'same-query') middle = await issue('tripod');
    const latest = await issue(name === 'same-query' ? 'camera' : 'light');
    if (name === 'loading') {
      await release(old,'Old camera');
      assert.equal(await status.innerText(),'Searching…');
      assert.equal(await text(),'');
      await release(latest,'Current light');
      await ready('Current light');
    } else {
      await release(latest,name === 'latest-empty' ? '' : 'Current result',name === 'latest-error' ? 503 : 200);
      if (!['latest-error','latest-empty'].includes(name)) await ready('Current result');
      if (middle) await release(middle,'Middle result');
      await release(old,'Old camera',name === 'stale-error' ? 503 : 200);
      if (name === 'latest-error') {assert.equal(await text(),'');assert.match(await status.innerText(),/unavailable/i);}
      else if (name === 'latest-empty') {assert.equal(await text(),'');assert.match(await status.innerText(),/No results/);}
      else {assert.ok((await text()).includes('Current result'));assert.ok(!(await text()).includes('Old camera'));assert.ok(!(await status.innerText()).includes('unavailable'));}
    }
  },
}));
