import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createToolCodePackV1Experiment,
	findEditableProtectedOverlaps,
	loadExperiment,
	toolCodePackV1Surfaces,
} from "../src/index.ts";

describe("tool-code pack v1", () => {
	it("keeps editable and protected surfaces disjoint", () => {
		expect(findEditableProtectedOverlaps(toolCodePackV1Surfaces())).toEqual([]);
	});

	it("builds a loadable experiment with recovery-rate promotion disabled", () => {
		const experiment = createToolCodePackV1Experiment();
		expect(experiment.id).toBe("tool-code-v0");
		expect(experiment.heldIn).toHaveLength(4);
		expect(experiment.heldOut).toHaveLength(4);
		expect(experiment.editableSurface).toEqual(["packages/coding-agent/src/core/tools/**"]);
		expect(experiment.promotionPolicy.requireRecoveryRateImprovement).toBe(false);
		expect(experiment.promotionPolicy.minimumHeldInCompletionGain).toBe(1);
	});

	it("loads the example experiment file", async () => {
		const examplePath = path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"../examples/supervised-v0/tool-code-v0.json",
		);
		const loaded = await loadExperiment(examplePath);
		expect(loaded).toMatchObject({
			ok: true,
			experiment: {
				id: "tool-code-v0",
				promotionPolicy: { requireRecoveryRateImprovement: false },
			},
		});
	});
});
