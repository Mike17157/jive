// Command harness renders the corpus through goldmark for timing, profiling,
// and golden-output checks. Run it from the harness directory:
//
//	go run . -config plain -n 300 -cpuprofile ../work/cpu.pprof
//	go run . -config gfm   -check ../golden
//	go run . -write-golden ../golden          # all configs
//
// Authoritative timing numbers come from `go test -bench` (see bench_test.go
// and scripts/bench.sh); the -n loop here is for quick signal and profiles.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"sort"
	"strings"
	"time"
)

func main() {
	var (
		config      = flag.String("config", "", "pipeline: plain | gfm (default: all)")
		corpus      = flag.String("corpus", "../corpus", "corpus dir or single .md file")
		n           = flag.Int("n", 100, "iterations per file for timing")
		cpuprofile  = flag.String("cpuprofile", "", "write CPU profile to file")
		memprofile  = flag.String("memprofile", "", "write allocation profile to file")
		writeGolden = flag.String("write-golden", "", "write rendered HTML to DIR/<config>/<name>.html")
		check       = flag.String("check", "", "compare rendered HTML against DIR/<config>/<name>.html; exit 1 on mismatch")
		asJSON      = flag.Bool("json", false, "print timing as JSON")
	)
	flag.Parse()

	configs := Configs
	if *config != "" {
		configs = []string{*config}
	}
	files, err := LoadCorpus(*corpus)
	if err != nil {
		fatal(err)
	}

	if *writeGolden != "" {
		for _, c := range configs {
			p := mustPipeline(c)
			for _, f := range files {
				var out bytes.Buffer
				if err := p.Render(&out, f.Src); err != nil {
					fatal(err)
				}
				dst := filepath.Join(*writeGolden, c, f.Name+".html")
				if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
					fatal(err)
				}
				if err := os.WriteFile(dst, out.Bytes(), 0o644); err != nil {
					fatal(err)
				}
				fmt.Printf("wrote %s (%d bytes)\n", dst, out.Len())
			}
		}
		return
	}

	if *check != "" {
		failed := 0
		for _, c := range configs {
			p := mustPipeline(c)
			for _, f := range files {
				var out bytes.Buffer
				if err := p.Render(&out, f.Src); err != nil {
					fatal(err)
				}
				gp := filepath.Join(*check, c, f.Name+".html")
				want, err := os.ReadFile(gp)
				if err != nil {
					fatal(fmt.Errorf("missing golden %s (run scripts/baseline.sh first): %w", gp, err))
				}
				if bytes.Equal(want, out.Bytes()) {
					fmt.Printf("ok    %s/%s\n", c, f.Name)
					continue
				}
				failed++
				actual := filepath.Join(*check, c, f.Name+".actual.html")
				_ = os.WriteFile(actual, out.Bytes(), 0o644)
				line, col := firstDiff(want, out.Bytes())
				fmt.Printf("FAIL  %s/%s: output differs from golden at line %d col %d (golden %d bytes, got %d)\n"+
					"      diff: diff %s %s\n", c, f.Name, line, col, len(want), out.Len(), gp, actual)
			}
		}
		if failed > 0 {
			os.Exit(1)
		}
		return
	}

	if *cpuprofile != "" {
		f, err := os.Create(*cpuprofile)
		if err != nil {
			fatal(err)
		}
		defer f.Close()
		if err := pprof.StartCPUProfile(f); err != nil {
			fatal(err)
		}
		defer pprof.StopCPUProfile()
	}

	type result struct {
		Config  string  `json:"config"`
		File    string  `json:"file"`
		Bytes   int     `json:"bytes"`
		Iters   int     `json:"iters"`
		MinMS   float64 `json:"min_ms"`
		MedMS   float64 `json:"median_ms"`
		MeanMS  float64 `json:"mean_ms"`
		MBPerS  float64 `json:"mb_per_s_at_median"`
	}
	var results []result
	for _, c := range configs {
		p := mustPipeline(c)
		for _, f := range files {
			var out bytes.Buffer
			durs := make([]time.Duration, 0, *n)
			var total time.Duration
			for i := 0; i < *n; i++ {
				start := time.Now()
				if err := p.Render(&out, f.Src); err != nil {
					fatal(err)
				}
				d := time.Since(start)
				durs = append(durs, d)
				total += d
			}
			sort.Slice(durs, func(i, j int) bool { return durs[i] < durs[j] })
			med := durs[len(durs)/2]
			results = append(results, result{
				Config: c, File: f.Name, Bytes: len(f.Src), Iters: *n,
				MinMS:  ms(durs[0]),
				MedMS:  ms(med),
				MeanMS: ms(total / time.Duration(*n)),
				MBPerS: float64(len(f.Src)) / 1e6 / med.Seconds(),
			})
		}
	}
	if *memprofile != "" {
		runtime.GC()
		f, err := os.Create(*memprofile)
		if err != nil {
			fatal(err)
		}
		defer f.Close()
		if err := pprof.Lookup("allocs").WriteTo(f, 0); err != nil {
			fatal(err)
		}
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(results)
		return
	}
	fmt.Printf("%-6s %-12s %9s %6s %10s %10s %10s %8s\n", "config", "file", "bytes", "iters", "min_ms", "median_ms", "mean_ms", "MB/s")
	for _, r := range results {
		fmt.Printf("%-6s %-12s %9d %6d %10.3f %10.3f %10.3f %8.1f\n",
			r.Config, r.File, r.Bytes, r.Iters, r.MinMS, r.MedMS, r.MeanMS, r.MBPerS)
	}
}

func mustPipeline(c string) Pipeline {
	p, err := NewPipeline(c)
	if err != nil {
		fatal(err)
	}
	return p
}

func ms(d time.Duration) float64 { return float64(d) / 1e6 }

func firstDiff(a, b []byte) (line, col int) {
	line, col = 1, 1
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return line, col
		}
		if a[i] == '\n' {
			line++
			col = 1
		} else {
			col++
		}
	}
	return line, col
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "harness:", strings.TrimSpace(err.Error()))
	os.Exit(2)
}
