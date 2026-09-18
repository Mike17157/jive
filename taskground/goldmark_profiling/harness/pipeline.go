package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/yuin/goldmark/v2/ast"
	"github.com/yuin/goldmark/v2/extension"
	"github.com/yuin/goldmark/v2/parser"
	"github.com/yuin/goldmark/v2/renderer/html"
)

// Config names the two pipelines the harness measures.
//   plain: CommonMark only, XHTML + unsafe, same as goldmark's own _benchmark.
//   gfm:   plain + GFM (table, strikethrough, tasklist, linkify) + footnote +
//          typographer + heading attributes. Exercises the extension package.
var Configs = []string{"plain", "gfm"}

type Pipeline struct {
	Parser   parser.Parser
	Renderer html.Renderer
}

func NewPipeline(config string) (Pipeline, error) {
	switch config {
	case "plain":
		return Pipeline{
			Parser:   parser.New(),
			Renderer: html.New(html.WithXHTML(), html.WithUnsafe()),
		}, nil
	case "gfm":
		return Pipeline{
			Parser: parser.New(
				parser.WithAttribute(),
				parser.WithExtensions(
					extension.GFMParser,
					extension.FootnoteParser,
					extension.TypographerParser,
				),
			),
			Renderer: html.New(
				html.WithXHTML(), html.WithUnsafe(),
				html.WithExtensions(
					extension.GFMHTMLRenderer,
					extension.FootnoteHTMLRenderer,
				),
			),
		}, nil
	}
	return Pipeline{}, fmt.Errorf("unknown config %q (want one of %v)", config, Configs)
}

func (p Pipeline) Parse(src []byte) ast.Node { return p.Parser.Parse(src) }

func (p Pipeline) Render(out *bytes.Buffer, src []byte) error {
	out.Reset()
	return p.Renderer.Render(out, src, p.Parser.Parse(src))
}

type CorpusFile struct {
	Name string // base name without extension, e.g. "commonmark"
	Path string
	Src  []byte
}

// LoadCorpus reads every *.md under dir (or the single file at path), sorted by name.
func LoadCorpus(path string) ([]CorpusFile, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	var paths []string
	if st.IsDir() {
		paths, err = filepath.Glob(filepath.Join(path, "*.md"))
		if err != nil {
			return nil, err
		}
		sort.Strings(paths)
	} else {
		paths = []string{path}
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("no *.md files in %s", path)
	}
	var files []CorpusFile
	for _, p := range paths {
		src, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		name := filepath.Base(p)
		name = name[:len(name)-len(filepath.Ext(name))]
		files = append(files, CorpusFile{Name: name, Path: p, Src: src})
	}
	return files, nil
}
