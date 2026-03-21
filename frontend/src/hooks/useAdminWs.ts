import { useEffect, useRef, useCallback } from "react";
import type { AdminMessage } from "../types.ts";

export function useAdminWs(onMessage: (msg: AdminMessage) => void) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const reconnectDelay = useRef(1000);
  const stopped = useRef(false);

  const connect = useCallback(() => {
    if (stopped.current) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/admin/ws`);

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as AdminMessage;
        onMessageRef.current(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onopen = () => {
      reconnectDelay.current = 1000;
    };

    ws.onclose = () => {
      if (!stopped.current) {
        setTimeout(connect, reconnectDelay.current);
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
      }
    };

    return ws;
  }, []);

  useEffect(() => {
    stopped.current = false;
    const ws = connect();
    return () => {
      stopped.current = true;
      ws?.close();
    };
  }, [connect]);
}
