import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSealedEvidenceBundle, createRunRecordStore } from "../src/index.ts";

describe("sealed evidence bundle", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("persists only allowlisted proposal evidence and records its digest", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-evidence-bundle-"));
		temporaryDirectories.push(rootDirectory);
		const artifact = buildSealedEvidenceBundle({
			heldInFailures: [
				{
					version: 1,
					taskId: "held-in-01",
					verifiedCompletion: false,
					verification: { verifiedCompletion: false, reason: "artifact_missing" },
					toolCallId: "read-1",
					toolName: "read",
					arguments: { path: "missing.ts" },
					errorContent: "missing path",
					sourceEntryIds: { toolCall: "entry-1", toolResult: "entry-2" },
					subsequentToolCalls: [],
				},
			],
			redactedRepresentativeTraces: [{ taskId: "held-in-01", entries: [{ role: "tool", content: "missing path" }] }],
			heldInVerifierOutcomes: [{ taskId: "held-in-01", verifiedCompletion: false, reason: "artifact_missing" }],
			preservedSuccesses: [{ taskId: "held-in-02", verifiedCompletion: true }],
			editableSource: [{ path: "packages/selfpi-recovery-policy/src/index.ts", content: "return undefined;" }],
			rejectedHypotheses: [{ hypothesis: "retry blindly", reason: "causes loops" }],
			proposalSchema: {
				version: 1,
				requiredFields: ["hypothesis", "targetFailureSignature", "unifiedDiff", "regressionRisks"],
			},
			editableSurface: ["packages/selfpi-recovery-policy/src/**"],
			changeBudget: { expectedMaximumChangedLines: 100, justificationRequiredAbove: 100, humanApprovalAbove: 250 },
			heldOutTaskIds: ["SECRET-HELD-OUT-01"],
			perturbationSchedules: [{ path: "SECRET-SCHEDULE-PATH" }],
		});
		const store = createRunRecordStore({ rootDirectory, now: () => new Date("2026-09-17T01:00:00.000Z") });
		await store.create({ runId: "run-001", experimentId: "path-recovery-v0" });
		await store.recordEvidenceBundle("run-001", artifact);

		const reopened = await store.open("run-001");
		const persisted = await readFile(path.join(rootDirectory, "runs/run-001/evidence-bundle.json"), "utf8");

		expect(artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(reopened.manifest.evidenceBundleDigest).toBe(artifact.digest);
		expect(JSON.parse(persisted)).toEqual(artifact.bundle);
		expect(artifact.bundle.heldInFailures[0]?.toolCallId).toBe("read-1");
		expect(artifact.bundle.redactedRepresentativeTraces[0]?.entries).toEqual([
			{ role: "tool", content: "missing path" },
		]);
		expect(artifact.bundle.proposalSchema.requiredFields).toContain("unifiedDiff");
		expect(artifact.bundle.editableSurface).toEqual(["packages/selfpi-recovery-policy/src/**"]);
		expect(artifact.bundle.changeBudget.humanApprovalAbove).toBe(250);
		expect(persisted).not.toContain("SECRET-HELD-OUT-01");
		expect(persisted).not.toContain("SECRET-SCHEDULE-PATH");
	});
});
