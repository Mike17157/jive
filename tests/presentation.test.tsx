import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { TextAttributes, type Selection } from "@opentui/core";
import { setRendererCapabilities } from "@opentui/core/testing";
import { Lexer } from "marked";
import { attachSelectionCopy } from "../src/ui/clipboard";
import { inlineMarkdown, MarkdownMessage } from "../src/ui/components/MarkdownMessage";

test("Markdown renders headings, lists, links, tables and code immediately", async () => {
  const content=["# Overview","","**Ready** with `inline code` and [Docs](https://example.com).","",
    "- First item","- [x] Verified","","1. Run the agent","2. Inspect output","",
    "> Quoted evidence","","```ts","const answer = 42;","```","",
    "| Node | State |","| --- | --- |","| scan | done |"].join("\n");
  const setup=await testRender(<MarkdownMessage content={content}/>,{width:72,height:34});
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
  try{
    await setup.flush();const frame=setup.captureCharFrame();
    for(const text of ["Overview","Ready","inline code","Docs","https://example.com","First item","Verified","1. Run the agent","Quoted evidence","const answer = 42;","scan","done"])expect(frame).toContain(text);
    expect(frame).not.toContain("# Overview");expect(frame).not.toContain("**Ready**");expect(frame).not.toContain("```ts");
    const styled=inlineMarkdown(Lexer.lexInline("**bold** and [link](https://example.com)"));
    expect(styled.chunks.find(chunk=>chunk.text==="bold")!.attributes! & TextAttributes.BOLD).not.toBe(0);
    expect(styled.chunks.find(chunk=>chunk.text==="link")?.link?.url).toBe("https://example.com");
  }finally{setup.renderer.destroy();}
});

test("a link drops its address once the terminal reports hyperlink support", async()=>{
  const setup=await testRender(<MarkdownMessage content={"Read the [Docs](https://example.com) first."}/>,{width:60,height:10});
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
  try{
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("(https://example.com)");
    // Capabilities can land after the first frame, so the reply has to re-render.
    setup.renderer.emit("capabilities",setRendererCapabilities(setup.renderer,{hyperlinks:true}));
    await setup.flush();
    const frame=setup.captureCharFrame();
    expect(frame).toContain("Read the Docs first.");
    expect(frame).not.toContain("example.com");
  }finally{setup.renderer.destroy();}
});

test("an unfinished Markdown response remains visible while streaming", async()=>{
  const setup=await testRender(<MarkdownMessage content={'## In progress\n\n- Collecting **evidence\n\n```sh\nprintf hello'} streaming/>,{width:44,height:18});
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
  try{
    await setup.flush();const frame=setup.captureCharFrame();
    expect(frame).toContain("In progress");expect(frame).toContain("Collecting");expect(frame).toContain("printf hello");
    expect(frame.split("\n").every(line=>line.length<=44)).toBe(true);
  }finally{setup.renderer.destroy();}
});

test("completed mouse selections copy automatically without writing to the real clipboard in tests",async()=>{
  const setup=await testRender(<text selectable>Hello clipboard</text>,{width:40,height:8,useMouse:true});
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
  const copied:string[]=[],notices:string[]=[];let disposed=false;
  const detach=attachSelectionCopy(setup.renderer,text=>notices.push(text),()=>({
    async writeText(text){copied.push(text);return {host:{status:"written"},terminal:{status:"not-attempted",capability:"unknown"}};},
    async dispose(){disposed=true;},
  }));
  try{
    await setup.flush();
    await setup.mockMouse.drag(0,0,4,0);
    await Bun.sleep(10);
    expect(copied).toEqual(["Hello"]);
    expect(notices).toEqual(["Copied selection"]);
    const select=(text:string,dragging=false)=>({isActive:true,isDragging:dragging,getSelectedText:()=>text}) as Selection;
    setup.renderer.emit("selection",select("ignored",true));
    setup.renderer.emit("selection",select(""));
    await Bun.sleep(5);expect(copied).toHaveLength(1);
    setup.renderer.emit("selection",select("  exact whitespace  "));
    await Bun.sleep(5);expect(copied.at(-1)).toBe("  exact whitespace  ");
  }finally{detach();setup.renderer.destroy();}
  expect(disposed).toBe(true);
});
