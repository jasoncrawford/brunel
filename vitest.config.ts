import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    exclude: ["node_modules", "frontend/**", ".worktrees/**", ".claude/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
    },
  },
});
