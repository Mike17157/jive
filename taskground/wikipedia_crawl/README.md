# wikipedia_crawl

A scratch area for the English-Wikipedia flower-graph task, plus `wikigraph`: a
small CLI that owns every network detail (Wikidata SPARQL, the Wikipedia link
API, redirects, batching, caching, rate limits) so the task itself stays about
the graph.

```
taskground/wikipedia_crawl/
  wikigraph     the CLI — python3 (3.9+), standard library only, no install
  work/         put artifacts here
  .cache/       response cache + the shared rate-limiter state
  README.md
```

Run it from anywhere: `taskground/wikipedia_crawl/wikigraph <command> [...]`. Every subcommand
has `--help`. From a `execute_graph` bash node, remember each node is its own
process in the session working directory, so use the path above and pass
`--out` so results land in a file instead of the planner's context.

## Quickstart

```sh
cd taskground/wikipedia_crawl
./wikigraph flowers --resolve --out work/flowers.json                 # terminals, from Wikidata
./wikigraph expand --titles-file work/flowers.json --direction out \
                   --hops 1 --out work/hop1.json                      # 1-hop link graph
./wikigraph induced --nodes-file work/final_nodes.csv \
                    --out work/final_edges.json                       # edges among your answer
```

## Commands

| command | what it does | notes |
| --- | --- | --- |
| `flowers` | flower articles from Wikidata, with the enwiki title for each | `--mode any` (default) = `P31/P279* Q506` ∪ `P279* Q506`; also `instances`, `instance-tree`, `subclasses`. `--resolve` adds the article each sitelink actually lands on. 1 request. |
| `sparql` | raw Wikidata SPARQL (`--query` / `--query-file`) | for anything `flowers` does not cover |
| `resolve` | normalise titles, follow redirects, flag missing pages | 50 titles per request |
| `neighbors TITLE` | one page's undirected neighbourhood | returns `out`, `in`, and `neighbors` (each labelled `out` / `in` / `both`) |
| `expand` | BFS crawl from seeds into a node + edge list | `--hops`, `--direction`, `--max-per-page`, `--max-nodes`; edges carry the observed directed links |
| `induced` | the edges among a fixed node set | verification pass for a final answer; maps redirect aliases back to your nodes |
| `check-links A --to B --to C [--both]` | does A link to B, C? | targeted, 1–2 requests |
| `cache stats\|clear\|path` | inspect or drop the cache | |

## Output convention

stdout is always one compact JSON summary line, with a 10-item `preview` and
the request/cache-hit count. The full result goes to `--out FILE`, or to stdout
with `--print`. Progress goes to stderr. Failures exit non-zero and print
`{"ok": false, "error": ...}` on stderr.

## Rate limits — the binding constraint

Measured against this IP: anonymous Wikipedia API access allows a burst of about
10 requests, then throttles to roughly one request every 4–6 seconds; a 429
carries `Retry-After: 20`. So `wikigraph`:

- batches up to 50 titles per request and follows continuation to exhaustion,
- caches every complete per-page result in `.cache/` (a repeat call costs 0 requests),
- shares one token bucket across separate invocations via `.cache/ratelimit.json`
  (`--rps`, default 0.15; `--burst`, default 6),
- honours `Retry-After` on 429, and aborts at `--max-requests` (default 400)
  rather than grinding for an hour.

Budget roughly one request per 500 links. Out-links are cheap; in-links on a hub
page (`Flower` has tens of thousands) cost dozens of requests. Export
`WIKIGRAPH_TOKEN` with a Wikimedia OAuth bearer token, or `WIKIGRAPH_UA` with a
contact address, if you have either.

## Gotchas this CLI already handles, and ones it does not

- **Redirects.** Several Wikidata sitelinks are redirects: `Banana flower` →
  `Banana`, `Disk flowers` and `Ray florets` → `Asteraceae`. Resolve terminals
  before treating them as nodes, and note that two terminals can collapse onto one.
- **`X (identifier)` pseudo-articles.** `ISBN (identifier)` and friends come from
  citation templates and are linked from tens of thousands of pages, so leaving
  them in makes every shortest path run through a citation. Dropped by default;
  `--keep-identifiers` restores them.
- **Alias targets.** A page often links to a redirect rather than to the canonical
  title. `induced` maps those back (`--no-aliases` to skip); `expand` does not, so
  compare canonical titles carefully.
- **Undirected edges.** `neighbors` and `expand` merge both directions and record
  which direction was actually observed, so the evidence survives the merge.
- **Depth.** Two hops from ~25 terminals is thousands of pages and is not
  affordable under the rate limit. One hop plus intersections is.
- **Viewing a three.js page.** `file://` cannot fetch a local JSON file; serve the
  directory (`python3 -m http.server`) or inline the data as a `.js` file.

## Not included, on purpose

No graph algorithms and no rendering: no shortest paths, no metric closure, no
Steiner approximation, no viewer. `wikigraph` only fetches, normalises and caches.
