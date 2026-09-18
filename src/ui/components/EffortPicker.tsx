import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { ModelOption } from "../../core/types";
import { palette } from "../theme";

const order=["none","minimal","low","medium","high","xhigh","max"];
export function effortLevels(model?: ModelOption): string[] {
  const supported=new Set(model?.reasoningEfforts??[]);
  return ["auto",...order.filter(level=>supported.has(level)&&!(level==="none"&&model?.reasoningMandatory))];
}

/** Rows the inline effort panel occupies, so the conversation viewport can shrink for it. */
export const EFFORT_PANEL_ROWS = 6;

/**
 * Effort selector shown inline just above the composer, like the slash-command
 * popup: no modal overlay, the rest of the screen keeps its normal contrast.
 */
export function EffortPicker(props:{model?:ModelOption;current?:string;width:number;loading:boolean;error?:string;onChoose:(effort:string)=>void;onCancel:()=>void}) {
  const levels=effortLevels(props.model);
  const [cursor,setCursor]=useState(()=>Math.max(0,levels.indexOf(props.current??"auto")));
  const index=Math.min(cursor,levels.length-1);
  useKeyboard(key=>{
    const consume=()=>{key.preventDefault();key.stopPropagation();};
    if(key.name==="escape"){consume();props.onCancel();return;}
    if(props.loading)return;
    if(["left","down","right","up","home","end","return","kpenter"].includes(key.name))consume();
    if(key.name==="left"||key.name==="down")setCursor(value=>Math.max(0,value-1));
    if(key.name==="right"||key.name==="up")setCursor(value=>Math.min(levels.length-1,value+1));
    if(key.name==="home")setCursor(0);
    if(key.name==="end")setCursor(levels.length-1);
    if(key.name==="return"||key.name==="kpenter")props.onChoose(levels[index]!);
  });
  const width=Math.min(props.width-4,64);
  const current=levels[index]!;
  const message=props.loading?"Loading this model’s effort levels…"
    :props.error??(props.model?.reasoningEfforts===undefined?"Effort metadata unavailable; keep auto or retry /effort."
      :levels.length===1?"This model does not expose an effort control."
      :current==="auto"?"Use medium, or the nearest level this model supports."
      :`${current} reasoning effort`);
  const step=Math.max(2,Math.min(7,Math.floor((width-8)/Math.max(1,levels.length-1))));
  return <box flexDirection="column" flexShrink={0} marginX={2} width={width} border borderStyle="rounded"
    borderColor={palette.borderSoft} backgroundColor={palette.surface} paddingX={1}
    title=" effort " titleColor={palette.textDim}>
    <text fg={palette.textDim} wrapMode="none">{props.model?.name??"Current model"}</text>
    <text wrapMode="none">
      {levels.map((level,i)=><span key={level} fg={i<=index?palette.accent:palette.greyDim}>{i===index?"●":"○"}{i<levels.length-1?"─".repeat(step):""}</span>)}
    </text>
    <text wrapMode="none"><span fg={palette.accent}>{current}</span><span fg={palette.textDim}>{levels.length>1?`  ·  ${index+1}/${levels.length}`:""}</span></text>
    <text fg={props.error?palette.yellow:palette.textFaint} wrapMode="none">{message}</text>
    <text fg={palette.textFaint} wrapMode="none">←/→ adjust · Enter apply · Esc cancel</text>
  </box>;
}
