import { MAX_LINK_URL_BYTES, RGBA, StyledText, TextAttributes, TextTableRenderable, type TextChunk, type TextTableContent } from "@opentui/core";
import { extend, useRenderer } from "@opentui/react";
import { Lexer, type Token, type Tokens } from "marked";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { palette } from "../theme";

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "text-table": typeof TextTableRenderable;
  }
}

extend({"text-table":TextTableRenderable});

const colors=Object.fromEntries(Object.entries(palette).map(([key,value])=>[key,RGBA.fromHex(value)]));
function decode(text:string):string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(raw,entity:string)=>{
    const names:Record<string,string>={amp:"&",lt:"<",gt:">",quot:'"',apos:"'"};
    if(!entity.startsWith("#"))return names[entity.toLowerCase()]??raw;
    const value=entity[1]?.toLowerCase()==="x"?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);
    return value>0&&value<=0x10ffff?String.fromCodePoint(value):raw;
  });
}

const encoder=new TextEncoder();
/**
 * A link only survives as an OSC 8 escape when the terminal advertises
 * hyperlinks and the target fits the renderer's URL budget. When it does, the
 * label alone carries the destination; otherwise the address has to stay
 * visible as text or the reader loses it entirely.
 */
function clickable(href:string,hyperlinks:boolean):boolean {
  return hyperlinks&&encoder.encode(href).byteLength<=MAX_LINK_URL_BYTES;
}

/** True once the terminal has told us it renders OSC 8 hyperlinks. The answer
 *  can arrive after the first frame, so the reply re-renders when it lands. */
function useHyperlinks():boolean {
  const renderer=useRenderer();
  return useSyncExternalStore(
    useCallback((notify:()=>void)=>{renderer.on("capabilities",notify);return()=>{renderer.off("capabilities",notify);};},[renderer]),
    ()=>renderer.capabilities?.hyperlinks===true,
  );
}

/**
 * Markdown becomes native styled, selectable terminal text immediately.
 * Body copy sits at `prose`, a step below the warm white of the chrome, and
 * emphasis (bold, links) picks up `proseAccent` — the baby blue washed over
 * that grey, so it reads as a tint rather than competing with the orb and
 * focus borders, which keep the full accent.
 */
export function inlineMarkdown(tokens:Token[],attributes=0,color=colors.prose,hyperlinks=false):StyledText {
  const chunks:TextChunk[]=[];
  const walk=(parts:Token[],attrs:number,fg:RGBA,link?:{url:string})=>{
    const push=(text:string,extra:Partial<TextChunk>={})=>chunks.push({__isChunk:true,text,fg,attributes:attrs,...(link?{link}:{}),...extra});
    for(const token of parts){
      if(token.type==="strong"||token.type==="em"||token.type==="del"){
        walk(token.tokens??Lexer.lexInline(token.text),attrs|(token.type==="strong"?TextAttributes.BOLD:token.type==="em"?TextAttributes.ITALIC:TextAttributes.STRIKETHROUGH),token.type==="strong"?colors.proseAccent!:fg,link);
      }else if(token.type==="codespan")push(token.text,{fg:colors.text,bg:colors.surface});
      else if(token.type==="link"){
        const destination=/^(https?:|mailto:|file:)/i.test(token.href)?{url:token.href}:undefined;
        walk(token.tokens??Lexer.lexInline(token.text),attrs|TextAttributes.UNDERLINE,colors.proseAccent!,destination);
        if(token.text!==token.href&&!(destination&&clickable(token.href,hyperlinks)))push(` (${token.href})`,{fg:colors.textDim});
      }else if(token.type==="image")push(`${token.text||"image"} (${token.href})`,{fg:colors.textDim});
      else if(token.type==="br")push("\n");
      else if("tokens" in token&&Array.isArray(token.tokens))walk(token.tokens,attrs,fg,link);
      else push(decode("text" in token?String(token.text):token.raw));
    }
  };
  walk(tokens,attributes,color!);return new StyledText(chunks);
}

function Blocks({tokens,hyperlinks,compact=false,depth=0}:{tokens:Token[];hyperlinks:boolean;compact?:boolean;depth?:number}) {
  return <box width="100%" flexDirection="column" flexShrink={0}>
    {tokens.filter(token=>token.type!=="space").map((token,index)=>{
      const margin=index===0||compact?0:1;
      if(depth>24)return <text key={index} wrapMode="word" fg={palette.prose}>{token.raw}</text>;
      if(token.type==="heading")return <text key={index} marginTop={margin} content={inlineMarkdown(token.tokens??Lexer.lexInline(token.text),TextAttributes.BOLD,colors.text,hyperlinks)} wrapMode="word"/>;
      if(token.type==="code")return <box key={index} marginTop={margin} width="100%" flexDirection="column" border={["left"]} borderColor={palette.borderSoft} backgroundColor={palette.surface} paddingX={1}>
        <text content={token.text} fg={palette.text} wrapMode="word" selectable/>
      </box>;
      if(token.type==="blockquote")return <box key={index} marginTop={margin} width="100%" flexDirection="column" border={["left"]} borderColor={palette.borderSoft} paddingLeft={1}><Blocks tokens={token.tokens??Lexer.lex(token.text)} hyperlinks={hyperlinks} depth={depth+1}/></box>;
      if(token.type==="list")return <box key={index} marginTop={margin} width="100%" flexDirection="column">
        {token.items.map((item:Tokens.ListItem,i:number)=><box key={i} width="100%" flexDirection="row">
          <text fg={palette.textDim}>{item.task?(item.checked?"☑ ":"☐ "):token.ordered?`${Number(token.start)+i}. `:"• "}</text>
          <box flexGrow={1} minWidth={0} flexDirection="column"><Blocks tokens={item.tokens} hyperlinks={hyperlinks} compact={!token.loose} depth={depth+1}/></box>
        </box>)}
      </box>;
      if(token.type==="table"){
        const content:TextTableContent=[token.header,...token.rows].map((row:Tokens.TableCell[],rowIndex:number)=>
          row.map(cell=>inlineMarkdown(cell.tokens,rowIndex===0?TextAttributes.BOLD:0,rowIndex===0?colors.proseAccent:colors.prose,hyperlinks).chunks),
        );
        return <text-table key={index} marginTop={margin} width="100%" content={content} columnWidthMode="content" columnFitter="proportional" wrapMode="word" columnGap={2} cellPadding={0} border={false} outerBorder={false} showBorders={false} selectable/>;
      }
      if(token.type==="hr")return <box key={index} marginY={1} width="100%" height={1} border={["top"]} borderColor={palette.borderSoft}/>;
      if(token.type==="def")return null;
      const text="text" in token?String(token.text):token.raw;
      const inline="tokens" in token&&Array.isArray(token.tokens)?token.tokens:Lexer.lexInline(text);
      return <text key={index} marginTop={margin} content={inlineMarkdown(inline,0,colors.prose,hyperlinks)} wrapMode="word" selectable/>;
    })}
  </box>;
}

export function MarkdownMessage({content}:{content:string;streaming?:boolean}) {
  // Local parsing keeps partial and completed replies visible without waiting
  // for a grammar download or a syntax-highlighting worker.
  const tokens=useMemo(()=>Lexer.lex(content,{gfm:true,breaks:false}),[content]);
  const hyperlinks=useHyperlinks();
  return <Blocks tokens={tokens} hyperlinks={hyperlinks}/>;
}
