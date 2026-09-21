# Search results jump backwards

Fieldwork is a small equipment library. Users say results sometimes jump back to an earlier search when they type quickly. Investigate in the browser and fix the client.

## Ready to run

Taskground setup installs pinned Playwright and Chromium before the agent starts. The first preparation needs npm/network access; subsequent browser operations and checks are entirely local. Requires Node 20+ and npm. For a manually copied workspace run `node scripts/setup.mjs` once. On Linux, install Chromium's OS dependencies if Playwright reports missing libraries.

```sh
node scripts/browser.mjs start --headed  # omit --headed in a headless environment
node scripts/browser.mjs fill camera
node scripts/browser.mjs fill light
node scripts/browser.mjs snapshot
node scripts/browser.mjs network
node scripts/browser.mjs screenshot before
```

The session persists between commands. `start` prints the local page URL; you can also open it in your preferred browser. Run the two fill commands back-to-back to reproduce the report, then inspect after responses finish. The local service has reproducible latency. `offline` exercises an error; an unmatched term exercises empty results.

Commands: `start [--headed]`, `fill TEXT`, `clear`, `snapshot`, `network`, `reload`, `wait STATUS_TEXT`, `screenshot NAME`, `stop`. `wait` waits for matching status text, with a short timeout. After edits, `reload` loads the changed client. Use `screenshot after` for the fixed result and `stop` to save `work/browser-trace.zip` and `work/browser-events.json` and close the browser/server. Stop sessions when finished. Commands return DOM/accessibility text and events for agents that cannot consume images.

Alternatively `npm start` serves the page on http://127.0.0.1:4173 (`PORT` overrides it). This is independent of the browser session's dynamically assigned port. Ctrl+C stops that server.

## Quick checks

```sh
npm test                    # supplied single-query smoke test; add your regression tests here
npm run check               # browser checks, including a failing reproduction
```

The check controls response delivery instead of depending on arbitrary sleeps. It writes `work/check/results.json`, screenshots, and a Playwright `trace.zip`. Expect a few seconds per check after setup. Inspect a saved trace with `npx --no-install playwright show-trace work/check/trace.zip`.

## Contract and deliverables

- Edit `public/app.js` and add regression coverage in `tests/*.test.mjs`. Do not modify other starting files, supplied harnesses, or package configuration.
- Every nonblank input searches `/api/search?q=...`; keep the input interactive while a request is pending. Whitespace-only input resets the view. Results must always correspond to the latest input, including when the same query is entered again later.
- Preserve the initial, loading, success, empty, and error states, plus the Clear button. Both successful and failed obsolete requests must leave the current state intact. Clearing must invalidate pending work.
- Save `work/before.png`, `work/after.png`, `work/browser-trace.zip`, and `work/report.md`. Explain the reproduction, root cause, fix, and test results. The report should identify your regression test.
- The grader serves your client with a frozen server/check harness and exercises additional response orders. It checks fixture integrity, runs your tests, and checks evidence presence. Browser evidence and test quality still need trace review; artifact presence alone does not prove method.

The task is complete when public checks and your tests pass, held-out verification passes, and the report explains the evidence. Do not read anything outside this workspace to find hidden checks or solutions.
