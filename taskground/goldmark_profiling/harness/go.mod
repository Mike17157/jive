module goldmark_profiling/harness

go 1.26.0

require github.com/yuin/goldmark/v2 v2.0.0

require (
	github.com/aclements/go-moremath v0.0.0-20210112150236-f10218a38794 // indirect
	golang.org/x/perf v0.0.0-20260908200009-22c9c6c9d4da // indirect
)

replace github.com/yuin/goldmark/v2 => ../goldmark

tool golang.org/x/perf/cmd/benchstat
