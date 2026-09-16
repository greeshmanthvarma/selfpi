import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadExperiment } from "../src/index.ts";

describe("loadExperiment", () => {
	it("loads a normalized immutable path-recovery experiment", async () => {
		const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/path-recovery-v0.json");

		const result = await loadExperiment(fixturePath);

		expect(result).toEqual({
			ok: true,
			experiment: {
				version: 1,
				id: "path-recovery-v0",
				heldIn: ["path-recovery-held-in-01"],
				heldOut: ["path-recovery-held-out-01"],
				budget: {
					wallClockMs: 60_000,
					toolCalls: 20,
					turns: 10,
					tokens: 50_000,
					costUsd: 2,
				},
				editableSurface: ["packages/selfpi-recovery-policy/src/**"],
				protectedSurface: ["packages/selfpi/**", ".selfpi/held-out/**", ".selfpi/promotion/**"],
				promotionPolicy: {
					minimumHeldInCompletionGain: 2,
					maximumHeldOutCompletionLoss: 0,
					requireRecoveryRateImprovement: true,
				},
			},
		});
		if (result.ok) {
			expect(Object.isFrozen(result.experiment)).toBe(true);
			expect(Object.isFrozen(result.experiment.budget)).toBe(true);
			expect(Object.isFrozen(result.experiment.editableSurface)).toBe(true);
			expect(Object.isFrozen(result.experiment.protectedSurface)).toBe(true);
		}
	});
});
