import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
  resolve: {
    alias: {
      obsidian: new URL("./tests/fakes/obsidian-stub.ts", import.meta.url).pathname,
    },
  },
});
