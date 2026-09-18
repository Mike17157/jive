import { useEffect, useState } from "react";
import type { AgentSnapshot } from "../../core/types";
import { palette } from "../theme";

const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const labels = {idle:"Working",thinking:"Thinking",responding:"Writing",building:"Building graph",executing:"Running graph"};
export function ThinkingIndicator({snapshot}: {snapshot: AgentSnapshot}) {
  const [started] = useState(Date.now);
  const [now,setNow] = useState(Date.now);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),120);return()=>clearInterval(timer);},[]);
  const elapsed=Math.max(0,(now-(snapshot.activityStartedAt??started))/1000);
  return <box height={1} flexShrink={0} paddingX={3}>
    <text wrapMode="none">
      <span fg={palette.accent}>{frames[Math.floor(now/120)%frames.length]} </span>
      <span fg={palette.text}>{labels[snapshot.phase??"thinking"]}</span>
      <span fg={palette.textDim}> · {elapsed.toFixed(1)}s</span>
      {snapshot.effort?<span fg={palette.textFaint}> · {snapshot.effort} effort</span>:null}
    </text>
  </box>;
}
