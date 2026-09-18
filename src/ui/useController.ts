import { useEffect, useState } from "react";
import type { AgentController, AgentSnapshot } from "../core/types.ts";

/**
 * Subscribe to the controller with a plain effect. `getSnapshot()` may return a
 * fresh object on every call, so we deliberately avoid useSyncExternalStore
 * (which would loop on unstable snapshots) and only re-read after a notify.
 */
export function useAgentSnapshot(controller: AgentController): AgentSnapshot {
  const [snapshot, setSnapshot] = useState<AgentSnapshot>(() => controller.getSnapshot());
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active) setSnapshot(controller.getSnapshot());
    };
    const unsubscribe = controller.subscribe(refresh);
    refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [controller]);
  return snapshot;
}
