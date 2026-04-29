import { expect, afterEach, vi } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";

expect.extend(matchers);
afterEach(cleanup);

// jsdom doesn't implement IntersectionObserver
class IntersectionObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(_cb: unknown, _opts?: unknown) {}
}
vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
