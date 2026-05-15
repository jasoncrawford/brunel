import { useState, useEffect } from "react";

export interface FrontendConfig {
  taskLabel: string;
}

const DEFAULT_CONFIG: FrontendConfig = { taskLabel: "brunel:ready" };

export function useConfig(): FrontendConfig {
  const [config, setConfig] = useState<FrontendConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json() as Promise<FrontendConfig>)
      .then(setConfig)
      .catch(() => {});
  }, []);

  return config;
}
