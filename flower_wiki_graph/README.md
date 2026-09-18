# English Wikipedia flower Steiner graph

One-off extraction artifacts. Flower terminals are English-Wikipedia sitelinks for Wikidata items typed via `P31/P279*` as `Q506` (flower). Wikipedia links are treated as undirected. The result minimizes the practical connector count with terminal cost 0 and non-flower cost 1.

Result: **4 terminals + 3 connectors = 7 nodes**, 6 edges. Connector objective: **3**.

Final data: `nodes.csv`, `nodes.json`, `edges.csv`, `edges.json`, and combined metadata/data in `graph.json`. Raw API evidence is in `raw/`. Open `index.html` through a local HTTP server to view the Three.js rendering (for example, `python3 -m http.server` from this directory).

Approximation: node-cost shortest paths + terminal metric-closure MST, then a shared-connector local improvement and leaf pruning. The selected shared backbone is `ISBN (identifier)`, with `Banana` and `Asteraceae` as branch connectors. Every final edge records its observed directed hyperlink and raw evidence file.
