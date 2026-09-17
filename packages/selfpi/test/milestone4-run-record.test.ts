import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunRecordStore, decidePromotionRecommendation } from "../src/index.ts";

describe("milestone 4 run persistence", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("persists policy, review, and decision transitions with secrets redacted", async () => {
		const rootDirectory = await mkdtemp(join(tmpdir(), "selfpi-milestone4-record-"));
		temporaryDirectories.push(rootDirectory);
		const store = createRunRecordStore({
			rootDirectory,
			now: () => new Date("2026-09-17T20:00:00.000Z"),
		});
		await store.create({ runId: "run-001", experimentId: "path-recovery-v0" });
		await store.transition("run-001", "evidence_ready");
		await store.recordCandidateProposal("run-001", {
			ok: true,
			proposal: {
				version: 1,
				hypothesis: "Use search guidance with sk-supersecret123",
				targetFailureSignature: "held-in-01:read-call",
				affectedEditableSurface: ["packages/selfpi-recovery-policy/src/index.ts"],
				unifiedDiff: "diff",
				expectedBehavioralMechanism: "Guide search.",
				predictedBenefit: "Recover tasks.",
				regressionRisks: ["Distraction."],
				changedPaths: ["packages/selfpi-recovery-policy/src/index.ts"],
			},
			provenance: {
				provider: "faux",
				model: "fixed-model",
				modelConfiguration: {},
				activeHarnessCommit: "active",
				prompt: "propose",
				evidenceBundleDigest: "sha256:evidence",
				worktreeBase: "baseline",
				unifiedDiff: "diff",
			},
		});
		await store.recordCandidatePolicy("run-001", {
			eligible: true,
			size: "expected",
			changedLines: 2,
			violations: [],
		});
		await store.recordCandidateReview("run-001", {
			proceed: true,
			candidate: {
				version: 1,
				hypothesis: "Use search guidance.",
				targetFailureSignature: "held-in-01:read-call",
				affectedEditableSurface: ["packages/selfpi-recovery-policy/src/index.ts"],
				unifiedDiff: "diff",
				expectedBehavioralMechanism: "Guide search.",
				predictedBenefit: "Recover tasks.",
				regressionRisks: ["Distraction."],
				changedPaths: ["packages/selfpi-recovery-policy/src/index.ts"],
			},
			review: {
				version: 1,
				reviewerProvider: "faux-reviewer",
				reviewerModel: "review-model",
				promptVersion: "review-v1",
				prompt: "Bearer very-secret-token",
				decision: "approve_for_evaluation",
				hypothesisAlignment: "aligned",
				risks: [],
				violations: [],
			},
		});
		await store.transition("run-001", "smoke_passed");
		await store.transition("run-001", "evaluation_complete");
		await store.recordDecision(
			"run-001",
			decidePromotionRecommendation({
				gates: {
					policyPassed: true,
					reviewPassed: true,
					buildPassed: true,
					targetedTestsPassed: true,
					smokePassed: true,
					integrityViolation: false,
				},
				policy: {
					minimumHeldInCompletionGain: 2,
					maximumHeldOutCompletionLoss: 0,
					requireRecoveryRateImprovement: true,
				},
				outcomes: {
					baselineRepetitions: 3,
					candidateRepetitions: 3,
					baselineHeldInCompletions: 3,
					candidateHeldInCompletions: 5,
					baselineHeldOutCompletions: 10,
					candidateHeldOutCompletions: 10,
					baselineRecoveryRate: 0.25,
					candidateRecoveryRate: 0.5,
				},
				efficiency: { baselineTokens: 100, candidateTokens: 120, baselineCostUsd: 0.1, candidateCostUsd: 0.12 },
			}),
		);

		const run = await store.open("run-001");
		const directory = join(rootDirectory, "runs/run-001");
		const persisted = await Promise.all(
			["candidate-proposal.json", "policy-result.json", "review.json", "decision.json"].map((name) =>
				readFile(join(directory, name), "utf8"),
			),
		);
		expect(run.manifest.state).toBe("promotion_recommended");
		expect(run.events.map((event) => event.state)).toEqual([
			"created",
			"evidence_ready",
			"proposal_generated",
			"policy_passed",
			"review_passed",
			"smoke_passed",
			"evaluation_complete",
			"promotion_recommended",
		]);
		expect(persisted.join("\n")).not.toContain("sk-supersecret123");
		expect(persisted.join("\n")).not.toContain("very-secret-token");
		expect(persisted.join("\n")).toContain("[REDACTED]");
	});
});
