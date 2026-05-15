import { DEFAULT_TASK_LABEL } from "../../../shared/wire.ts";

export interface FrontendConfig {
  taskLabel: string;
}

declare global {
  interface Window {
    __BRUNEL_CONFIG__?: FrontendConfig;
  }
}

export function useConfig(): FrontendConfig {
  return window.__BRUNEL_CONFIG__ ?? { taskLabel: DEFAULT_TASK_LABEL };
}
