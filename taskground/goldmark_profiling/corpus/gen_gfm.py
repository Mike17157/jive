#!/usr/bin/env python3
"""Deterministic generator for corpus/gfm.md.

Exercises the extension package: tables, task lists, strikethrough, autolinks,
footnotes, typographer substitutions, heading attributes, nested lists, and
fenced code. No randomness: the same script always writes the same bytes.
"""
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gfm.md")
WORDS = ("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu "
         "xi omicron pi rho sigma tau upsilon phi chi psi omega").split()


def w(i, n=8):
    return " ".join(WORDS[(i * 7 + k * 3) % len(WORDS)] for k in range(n))


parts = []
for s in range(60):
    parts.append(f"## Section {s} {{#sec-{s}}}\n")
    parts.append(f'"Quoted" text with -- dashes... and <<guillemets>> in section {s}. '
                 f"See www.example.com/path{s} or https://example.org/{s}?q=1 for details.[^n{s}]\n")
    parts.append(f"This has ~~struck {w(s, 3)}~~ and **bold** with *emphasis* and `code{s}`.\n")
    # table
    cols = 3 + s % 4
    parts.append("| " + " | ".join(f"col{c}" for c in range(cols)) + " |")
    parts.append("|" + "|".join((":---", "---:", ":---:", "---")[c % 4] for c in range(cols)) + "|")
    for r in range(8):
        parts.append("| " + " | ".join(f"{w(s + r + c, 2)} \\| {r * c}" for c in range(cols)) + " |")
    parts.append("")
    # task list with nesting
    for t in range(6):
        mark = "x" if (s + t) % 3 == 0 else " "
        parts.append(f"- [{mark}] task {t}: {w(s + t, 5)}")
        if t % 2 == 0:
            parts.append(f"  - [ ] nested {w(t, 4)} ~~done~~")
            parts.append(f"    1. ordered {w(t + 1, 4)}")
    parts.append("")
    parts.append(f"```go\nfunc Section{s}() int {{\n\treturn {s} * 2 // {w(s, 4)}\n}}\n```\n")
    parts.append(f"> Block quote {s} with a [link](https://example.com/{s} \"title {s}\") and ![img](/i/{s}.png)\n> continued line {w(s, 6)}\n")
    parts.append(f"[^n{s}]: Footnote {s}: {w(s, 10)} with *emphasis*.\n")

with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(parts) + "\n")
print(OUT, os.path.getsize(OUT), "bytes")
