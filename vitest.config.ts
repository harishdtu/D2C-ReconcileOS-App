import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(process.cwd(), "src"),
      "server-only": resolve(process.cwd(), "tests/server-only.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 45_000,
    hookTimeout: 45_000,
  },
});
