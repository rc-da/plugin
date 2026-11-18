import { defineConfig } from "vitest/config";

// `npm run test:bundle`: smoke-tests the built main.js (or $BUNDLE). Separate from
// `npm test` because it needs a build first; CI runs it right after `npm run build`.
export default defineConfig({
  test: { include: ["tests/bundle.smoke.ts"], environment: "node", globals: false },
});
