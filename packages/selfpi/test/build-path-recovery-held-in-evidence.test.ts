import { describe, expect, it } from "vitest";
import { buildPathRecoveryHeldInEvidence } from "../src/index.ts";

describe("buildPathRecoveryHeldInEvidence", () => {
	it("teaches the policy input shape and recovery score without prescribing a patch", () => {
		const evidence = buildPathRecoveryHeldInEvidence([
			{
				id: "path-recovery-held-in-01",
				set: "held_in",
				repository: { url: "https://example.invalid/held-in.git", commit: "a".repeat(40) },
				input: "Find the configuration module.",
				verifier: { id: "verifier-1", digest: `sha256:${"b".repeat(64)}` },
				perturbation: {
					version: 1,
					path: "src/config.ts",
					error: "ENOENT: no such file or directory, open 'src/config.ts'",
				},
			},
			{
				id: "path-recovery-held-in-02",
				set: "held_in",
				repository: { url: "https://example.invalid/held-in-2.git", commit: "c".repeat(40) },
				input: "Locate nested settings.",
				verifier: { id: "verifier-2", digest: `sha256:${"d".repeat(64)}` },
				perturbation: {
					version: 1,
					path: "apps/api/src/config/app.ts",
					error: "ENOENT: no such file or directory, open 'apps/api/src/config/app.ts'",
				},
			},
		]);

		expect(evidence.heldInFailures).toHaveLength(2);
		expect(evidence.heldInFailures[0]).toMatchObject({
			taskId: "path-recovery-held-in-01",
			toolName: "read",
			arguments: { path: "src/config.ts" },
			subsequentToolCalls: [],
			verifiedCompletion: false,
		});
		const serialized = JSON.stringify(evidence);
		expect(serialized).toContain("Observed PathRecoveryInput");
		expect(serialized).toContain("isError");
		expect(serialized).toContain("content is always a non-empty text-part array");
		expect(serialized).toContain("verified completion");
		expect(serialized).not.toContain("Inspect repository files before choosing a corrected path");
		expect(serialized).not.toContain("applyPathRecoveryPolicy so that");
		expect(evidence.redactedRepresentativeTraces[0]?.entries.map((entry) => entry.role)).toEqual([
			"task",
			"tool",
			"policy_hook",
			"outcome",
			"gap",
		]);
	});
});
