/** Verbose output mode — set once at startup from config, read by display and status-bar. */
export let verbose = false;
export function setVerbose(v: boolean): void { verbose = v; }
