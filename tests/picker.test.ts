import { describe, it, expect, vi, afterEach } from "vitest";
import { Picker } from "../src/agent/views/picker.js";

// ── Bar management ────────────────────────────────────────────────────────────

describe("Picker bar management", () => {
  afterEach(() => {
    process.stdin.removeAllListeners("data");
  });

  it("calls clearBar synchronously before rendering the menu", () => {
    const display = { clearBar: vi.fn(), drawBar: vi.fn() };
    const picker = new Picker(display);

    // Don't await — we only care about what happens synchronously up front.
    void picker.pick(["A", "B"]);

    expect(display.clearBar).toHaveBeenCalledOnce();
    expect(display.drawBar).not.toHaveBeenCalled();
  });

  it("calls drawBar after pick resolves", async () => {
    const display = { clearBar: vi.fn(), drawBar: vi.fn() };
    const picker = new Picker(display);

    const promise = picker.pick(["A", "B"]);
    process.stdin.emit("data", "\r"); // Enter — selects first option
    await promise;

    expect(display.drawBar).toHaveBeenCalledOnce();
  });

  it("calls clearBar synchronously before rendering in pickMultiple", () => {
    const display = { clearBar: vi.fn(), drawBar: vi.fn() };
    const picker = new Picker(display);

    void picker.pickMultiple(["A", "B"]);

    expect(display.clearBar).toHaveBeenCalledOnce();
    expect(display.drawBar).not.toHaveBeenCalled();
  });

  it("calls drawBar after pickMultiple resolves", async () => {
    const display = { clearBar: vi.fn(), drawBar: vi.fn() };
    const picker = new Picker(display);

    const promise = picker.pickMultiple(["A", "B"]);
    process.stdin.emit("data", "\r");
    await promise;

    expect(display.drawBar).toHaveBeenCalledOnce();
  });

  it("calls clearBar synchronously before rendering in pickQuestion", () => {
    const display = { clearBar: vi.fn(), drawBar: vi.fn() };
    const picker = new Picker(display);
    const opts = [{ label: "Yes", description: "Do it" }];

    void picker.pickQuestion(opts);

    expect(display.clearBar).toHaveBeenCalledOnce();
    expect(display.drawBar).not.toHaveBeenCalled();
  });

  it("calls drawBar after pickQuestion resolves", async () => {
    const display = { clearBar: vi.fn(), drawBar: vi.fn() };
    const picker = new Picker(display);
    const opts = [{ label: "Yes", description: "Do it" }];

    const promise = picker.pickQuestion(opts);
    process.stdin.emit("data", "\r");
    await promise;

    expect(display.drawBar).toHaveBeenCalledOnce();
  });

  it("works with no display (no-op)", async () => {
    const picker = new Picker();

    const promise = picker.pick(["A", "B"]);
    process.stdin.emit("data", "\r");
    await expect(promise).resolves.toBe(0);
  });
});
