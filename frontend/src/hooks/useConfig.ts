export interface FrontendConfig {
  taskLabel: string;
}

declare global {
  interface Window {
    __BRUNEL_CONFIG__?: FrontendConfig;
  }
}

const DEFAULT_CONFIG: FrontendConfig = { taskLabel: "brunel:ready" };

export function useConfig(): FrontendConfig {
  return window.__BRUNEL_CONFIG__ ?? DEFAULT_CONFIG;
}
