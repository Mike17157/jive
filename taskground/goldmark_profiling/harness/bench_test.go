package main

import (
	"bytes"
	"testing"
)

// BenchmarkRender is the authoritative timing. Sub-benchmarks are named
// <config>/<corpus file>. Run through scripts/bench.sh, which uses -count and
// benchstat so run-to-run noise is visible.
func BenchmarkRender(b *testing.B) {
	files, err := LoadCorpus("../corpus")
	if err != nil {
		b.Fatal(err)
	}
	for _, c := range Configs {
		p, err := NewPipeline(c)
		if err != nil {
			b.Fatal(err)
		}
		for _, f := range files {
			b.Run(c+"/"+f.Name, func(b *testing.B) {
				var out bytes.Buffer
				b.SetBytes(int64(len(f.Src)))
				b.ReportAllocs()
				for b.Loop() {
					if err := p.Render(&out, f.Src); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}

// BenchmarkParse and BenchmarkRenderOnly split the two phases so a profile
// can be attributed to the parser or the renderer package.
func BenchmarkParse(b *testing.B) {
	files, err := LoadCorpus("../corpus")
	if err != nil {
		b.Fatal(err)
	}
	for _, c := range Configs {
		p, _ := NewPipeline(c)
		for _, f := range files {
			b.Run(c+"/"+f.Name, func(b *testing.B) {
				b.SetBytes(int64(len(f.Src)))
				b.ReportAllocs()
				for b.Loop() {
					_ = p.Parse(f.Src)
				}
			})
		}
	}
}

func BenchmarkRenderOnly(b *testing.B) {
	files, err := LoadCorpus("../corpus")
	if err != nil {
		b.Fatal(err)
	}
	for _, c := range Configs {
		p, _ := NewPipeline(c)
		for _, f := range files {
			doc := p.Parse(f.Src)
			b.Run(c+"/"+f.Name, func(b *testing.B) {
				var out bytes.Buffer
				b.SetBytes(int64(len(f.Src)))
				b.ReportAllocs()
				for b.Loop() {
					out.Reset()
					if err := p.Renderer.Render(&out, f.Src, doc); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}
