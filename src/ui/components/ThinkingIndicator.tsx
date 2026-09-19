import { useEffect, useState } from "react";
import type { AgentSnapshot } from "../../core/types";
import { palette } from "../theme";

const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const labels = {idle:"Working",thinking:"Thinking",responding:"Writing",building:"Assembling execution",executing:"Running graph"};
export function ThinkingIndicator({snapshot}: {snapshot: AgentSnapshot}) {
  const [started] = useState(Date.now);
  const [now,setNow] = useState(Date.now);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),120);return()=>clearInterval(timer);},[]);
  const elapsed=Math.max(0,(now-(snapshot.activityStartedAt??started))/1000);
  const retry=snapshot.retry;
  // A retry is the only thing worth interrupting the line for: it says why the turn is waiting.
  const waiting=retry?Math.max(0,(retry.resumesAt-now)/1000):0;
  return <box height={1} flexShrink={0} paddingX={3}>
    <text wrapMode="none">
      <span fg={palette.accent}>{frames[Math.floor(now/120)%frames.length]} </span>
      <span fg={palette.text}>{labels[snapshot.phase??"thinking"]}</span>
      <span fg={palette.textDim}> · {elapsed.toFixed(1)}s</span>
      {retry?<span fg={palette.yellow}> · {retry.reason} · retry {retry.attempt+1}/{retry.attempts}{waiting>0.1?` in ${waiting.toFixed(1)}s`:""}</span>:null}
      {snapshot.effort?<span fg={palette.textFaint}> · {snapshot.effort} effort</span>:null}
    </text>
  </box>;
}
