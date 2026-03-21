import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useAdminWs } from "../src/hooks/useAdminWs.ts";
import type { AdminMessage } from "../src/types.ts";

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = WebSocket.CONNECTING;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }

  simulateOpen() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  simulateClose() {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("useAdminWs", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("opens a WebSocket connection on mount", () => {
    const onMessage = vi.fn();
    renderHook(() => useAdminWs(onMessage));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toMatch(/\/admin\/ws$/);
  });

  it("calls onMessage when a valid AdminMessage arrives", () => {
    const onMessage = vi.fn();
    renderHook(() => useAdminWs(onMessage));

    const ws = MockWebSocket.instances[0];
    const msg: AdminMessage = { type: "snapshot", tasks: [], workers: [] };
    act(() => ws.simulateMessage(msg));

    expect(onMessage).toHaveBeenCalledWith(msg);
  });

  it("ignores malformed JSON messages", () => {
    const onMessage = vi.fn();
    renderHook(() => useAdminWs(onMessage));

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.onmessage?.({ data: "not-json" } as MessageEvent);
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("reconnects after connection closes", () => {
    const onMessage = vi.fn();
    renderHook(() => useAdminWs(onMessage));

    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => MockWebSocket.instances[0].simulateClose());
    act(() => vi.advanceTimersByTime(1000));

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("resets reconnect delay to 1s after successful open", () => {
    const onMessage = vi.fn();
    renderHook(() => useAdminWs(onMessage));

    // First close — triggers reconnect after 1000ms
    act(() => MockWebSocket.instances[0].simulateClose());
    act(() => vi.advanceTimersByTime(1000));
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second close — triggers reconnect after 2000ms (doubled)
    act(() => MockWebSocket.instances[1].simulateClose());
    act(() => vi.advanceTimersByTime(1999));
    expect(MockWebSocket.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(MockWebSocket.instances).toHaveLength(3);

    // Open resets delay — next reconnect back to 1000ms
    act(() => MockWebSocket.instances[2].simulateOpen());
    act(() => MockWebSocket.instances[2].simulateClose());
    act(() => vi.advanceTimersByTime(999));
    expect(MockWebSocket.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it("stops reconnecting after unmount", () => {
    const onMessage = vi.fn();
    const { unmount } = renderHook(() => useAdminWs(onMessage));

    unmount();
    act(() => vi.advanceTimersByTime(5000));

    // No additional connections after unmount
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("closes the WebSocket on unmount", () => {
    const onMessage = vi.fn();
    const { unmount } = renderHook(() => useAdminWs(onMessage));

    const ws = MockWebSocket.instances[0];
    const closeSpy = vi.spyOn(ws, "close");
    unmount();

    expect(closeSpy).toHaveBeenCalled();
  });
});
