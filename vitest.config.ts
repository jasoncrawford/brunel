import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    globalSetup: "./tests/globalSetup.ts",
    testTimeout: 15000,
    exclude: ["node_modules", "frontend/**", ".worktrees/**", ".claude/**", "tests/browser/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
    },
  },
});
