import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from '../scripts/server.mjs';

test('single search shows matching equipment', async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.getByLabel('Search equipment').fill('light');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('2 results'));
    assert.match(await page.locator('#results').innerText(), /Portable panel/);
  } finally {await browser?.close();await server.close();}
});
