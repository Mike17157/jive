import { createClipboard, createHostClipboard, createRendererClipboardAdapter, type CliRenderer, type ClipboardService, type Selection } from "@opentui/core";

type Writer = Pick<ClipboardService,"writeText"|"dispose">;

type WriterFactory = () => Writer;

function defaultWriter(renderer: CliRenderer): Writer {
  return createClipboard({host:createHostClipboard({timeoutMs:1500}),terminal:createRendererClipboardAdapter(renderer)});
}

function copyFeedback(result: Awaited<ReturnType<Writer["writeText"]>>): string {
  return result.host.status==="written"?"Copied failure details":result.terminal.status==="attempted"?"Copy sent to terminal":"Clipboard unavailable";
}

/** Copy text from an explicit UI control, then release its clipboard transports. */
export async function copyText(renderer: CliRenderer, text: string, feedback: (text:string)=>void,
  createWriter:WriterFactory=()=>defaultWriter(renderer)): Promise<void> {
  const writer=createWriter();
  try {
    const result=await writer.writeText(text,{destination:"best-available"});
    feedback(copyFeedback(result));
  } catch(error) {
    feedback(`Could not copy: ${error instanceof Error?error.message:String(error)}`);
  } finally {
    await writer.dispose().catch(()=>{});
  }
}

/** Copy completed selections, using the local clipboard or terminal transport. */
export function attachSelectionCopy(renderer: CliRenderer, feedback: (text:string)=>void,
  createWriter:WriterFactory=()=>defaultWriter(renderer)) {
  let writer: Writer|undefined, pending: string|undefined, writing=false, disposed=false;
  const abort=new AbortController();
  const drain=async()=>{
    if(writing)return;
    writing=true;
    try {
      while(pending!==undefined&&!disposed){
        const text=pending;pending=undefined;
        writer??=createWriter();
        const result=await writer.writeText(text,{destination:"best-available",signal:abort.signal});
        if(disposed)break;
        feedback(result.host.status==="written"?"Copied selection":result.terminal.status==="attempted"?"Copy sent to terminal":"Clipboard unavailable");
      }
    }catch(error){if(!disposed)feedback(`Could not copy: ${error instanceof Error?error.message:String(error)}`);}
    finally{writing=false;}
  };
  const selected=(selection:Selection|null)=>{
    if(!selection||selection.isDragging||!selection.isActive)return;
    // OpenTUI emits selection before its final selectable notification.
    queueMicrotask(()=>{
      if(disposed)return;
      const text=selection.getSelectedText();
      if(!text)return;
      pending=text;void drain();
    });
  };
  renderer.on("selection",selected);
  return ()=>{disposed=true;pending=undefined;abort.abort();renderer.off("selection",selected);void writer?.dispose().catch(()=>{});};
}
