import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { step, runScenario, coverage } from "./property-harness";

// §11 property test: two devices, random edits (text + binary, overlapping and not),
// random syncs with injected network faults, "app killed here" points and races with
// the other device. After the storm, sync until quiet and check (see property-harness.ts):
//   1. both devices and the remote hold identical content;
//   2. no edit is lost: every token a user typed and never removed is somewhere in the vault;
//   3. every binary file is byte-identical to a version a user wrote;
//   4. nothing is gone that a user did not delete or rename away.

describe("property: two devices, random edits, faults and kills", () => {
  it("converges without losing data", async () => {
    await fc.assert(
      // size: "max" → uniform lengths; the default biases toward tiny sequences with ~2 syncs.
      fc.asyncProperty(fc.array(step, { minLength: 20, maxLength: 80, size: "max" }), async steps => {
        await runScenario(steps);
      }),
      // Fixed seed by default so the coverage floors below are deterministic in CI;
      // set PROP_SEED / PROP_RUNS to explore further.
      { numRuns: Number(process.env.PROP_RUNS ?? 300), seed: Number(process.env.PROP_SEED ?? 20261114), verbose: true },
    );
    // The storm must have exercised the interesting paths, or the property proves little.
    console.info(`property coverage: ${JSON.stringify(coverage)}`);
    expect(coverage.merged, "3-way merges happened").toBeGreaterThanOrEqual(20);
    expect(coverage.conflicts, "conflict copies happened").toBeGreaterThan(0);
    expect(coverage.failedSyncs, "syncs failed mid-way").toBeGreaterThan(0);
    expect(coverage.kills, "app kills happened").toBeGreaterThan(0);
    expect(coverage.renames, "renames happened").toBeGreaterThan(0);
    expect(coverage.retriedPushes, "422 push retries happened").toBeGreaterThan(0);
    expect(coverage.guardStops, "guards stopped a sync and the user confirmed").toBeGreaterThan(0);
  }, 180_000);

  it("converges without losing data through the real GitHub adapter (HTTP wire format, typed errors, retry)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 20, maxLength: 80, size: "max" }), async steps => {
        await runScenario(steps, { viaAdapter: true });
      }),
      { numRuns: Number(process.env.PROP_RUNS_ADAPTER ?? 100), seed: Number(process.env.PROP_SEED ?? 20261118), verbose: true },
    );
  }, 180_000);
});
