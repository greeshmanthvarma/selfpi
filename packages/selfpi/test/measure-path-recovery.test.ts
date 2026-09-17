import { describe, expect, it } from "vitest";
import { measurePathRecovery, type PathPerturbationRecord } from "../src/index.ts";

describe("path recovery measurement", () => {
	it("requires verified task completion even after a later matching read succeeds", () => {
		const perturbation: PathPerturbationRecord = {
			version: 1,
			fired: true,
			toolCallSequence: 2,
			toolCallId: "injected-read",
			path: "src/config.ts",
			error: "configured path failure",
			subsequentMatchingReadSuccesses: 1,
			repeatedIdenticalFailures: 2,
		};

		const incomplete = measurePathRecovery(perturbation, {
			taskId: "path-recovery-01",
			verifiedCompletion: false,
			reason: "artifact_missing",
		});
		const completed = measurePathRecovery(perturbation, {
			taskId: "path-recovery-01",
			verifiedCompletion: true,
			reason: "verified",
		});

		expect(incomplete).toEqual({
			version: 1,
			taskId: "path-recovery-01",
			perturbationFired: true,
			verifiedCompletion: false,
			recovered: false,
			subsequentMatchingReadSuccesses: 1,
			repeatedIdenticalFailures: 2,
		});
		expect(completed).toEqual({
			version: 1,
			taskId: "path-recovery-01",
			perturbationFired: true,
			verifiedCompletion: true,
			recovered: true,
			subsequentMatchingReadSuccesses: 1,
			repeatedIdenticalFailures: 2,
		});
	});
});
