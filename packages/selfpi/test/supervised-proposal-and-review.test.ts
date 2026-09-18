import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SupervisedRuntime } from "../src/config/load-supervised-runtime.ts";
import type { Experiment } from "../src/experiments/load-experiment.ts";
import type { ModelGateway, ModelGatewayRole } from "../src/gateway/model-gateway.ts";
import { createGatewayPiReviewerAdapter } from "../src/supervised/gateway-pi-process-adapters.ts";
import { runSupervisedProposalAndReview } from "../src/supervised/run-supervised-proposal-and-review.ts";

const sourceCommit = "a".repeat(40);
const sourceImageDigest = `sha256:${"b".repeat(64)}`;
const candidateDiff = [
	"diff --git a/packages/selfpi-recovery-policy/src/index.ts b/packages/selfpi-recovery-policy/src/index.ts",
	"--- a/packages/selfpi-recovery-policy/src/index.ts",
	"+++ b/packages/selfpi-recovery-policy/src/index.ts",
	"@@ -1 +1 @@",
	"-return undefined;",
	"+return guidance;",
	"",
].join("\n");

const experiment: Experiment = {
	version: 1,
	id: "path-recovery-v0",
	heldIn: ["held-in-1"],
	heldOut: ["sealed-held-out-id"],
	budget: { wallClockMs: 60_000, toolCalls: 20, turns: 10, tokens: 50_000, costUsd: 2 },
	editableSurface: ["packages/selfpi-recovery-policy/src/**"],
	protectedSurface: ["packages/selfpi/**", ".selfpi/**"],
	promotionPolicy: {
		minimumHeldInCompletionGain: 2,
		maximumHeldOutCompletionLoss: 0,
		requireRecoveryRateImprovement: true,
	},
};

const runtime: SupervisedRuntime = {
	version: 1,
	mode: "supervised_v0",
	activeVersion: { sourceCommit, imageDigest: sourceImageDigest },
	proposer: { provider: "anthropic", model: "proposer-model", thinking: "low" },
	reviewer: { provider: "openai", model: "reviewer-model" },
	gateway: { identity: "gateway-v1", endpoint: "http://gateway.invalid/v1" },
	container: { imageDigest: `sha256:${"c".repeat(64)}` },
	evaluation: { repetitions: 3 },
	taskRegistry: { id: "registry-v1", digest: `sha256:${"d".repeat(64)}` },
};

describe("supervised proposal and review", () => {
	it("uses distinct gateway roles and records a pinned active-harness proposal and independent review", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-supervised-proposal-"));
		const issuedRoles: ModelGatewayRole[] = [];
		const revokedSessions: string[] = [];
		const prompts: string[] = [];
		const reviewerPromptPath = path.join(rootDirectory, "reviewer-prompt.txt");
		const reviewerProcessPath = path.join(rootDirectory, "reviewer.mjs");
		await writeFile(
			reviewerProcessPath,
			[
				'import { writeFile } from "node:fs/promises";',
				"await writeFile(process.env.REVIEWER_PROMPT_PATH, process.argv.at(-1), 'utf8');",
				"const review = { decision: 'approve_for_evaluation', hypothesisAlignment: 'aligned', risks: [], violations: [] };",
				"console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(review) }] } }));",
			].join("\n"),
			"utf8",
		);
		const gateway: ModelGateway = {
			async issueSession(input) {
				issuedRoles.push(input.role);
				return {
					id: `${input.role}-session`,
					endpoint: `http://gateway.invalid/runs/${input.runId}/roles/${input.role}/v1`,
					credential: `${input.role}-credential`,
				};
			},
			async revokeSession(sessionId) {
				revokedSessions.push(sessionId);
			},
			async close() {},
		};

		try {
			const run = await runSupervisedProposalAndReview(
				{
					rootDirectory,
					runId: "run-27",
					now: () => new Date("2026-09-17T20:00:00.000Z"),
					experiment,
					runtime,
					evidence: {
						digest: "sha256:held-in-evidence",
						bundle: {
							version: 1,
							heldInFailures: [],
							redactedRepresentativeTraces: [],
							heldInVerifierOutcomes: [],
							preservedSuccesses: [],
							editableSource: [],
							rejectedHypotheses: [],
							proposalSchema: { version: 1, requiredFields: [] },
							editableSurface: experiment.editableSurface,
							changeBudget: {
								expectedMaximumChangedLines: 100,
								justificationRequiredAbove: 100,
								humanApprovalAbove: 250,
							},
						},
					},
					proposalPrompt: "Use held-in-1 evidence. Never access held-out evaluation.",
					review: {
						relevantSource: "return undefined;",
						repositoryInstructions: "Only review the candidate.",
						promptVersion: "candidate-review-v1",
						prompt: "Review this bounded candidate.",
					},
					humanApproval: false,
					sessionExpiresAt: new Date("2026-09-17T20:05:00.000Z"),
				},
				{
					gateway,
					git: {
						async createWorktree(commit) {
							expect(commit).toBe(sourceCommit);
							return { directory: "/pinned-active-harness-worktree" };
						},
						async collectDiff() {
							return candidateDiff;
						},
						async removeWorktree() {},
					},
					createProposer(session) {
						expect(session.credential).toBe("proposer-credential");
						return {
							async run(input) {
								prompts.push(`${input.prompt}\n${JSON.stringify(input.evidenceBundle)}`);
								return {
									version: 1,
									hypothesis: "Recovery guidance improves completion.",
									targetFailureSignature: "held-in-1:read",
									affectedEditableSurface: ["packages/selfpi-recovery-policy/src/index.ts"],
									unifiedDiff: candidateDiff,
									expectedBehavioralMechanism: "The model receives path-search guidance.",
									predictedBenefit: "More held-in tasks recover.",
									regressionRisks: ["Guidance may distract the model."],
								};
							},
						};
					},
					checks: {
						async run() {
							return {
								appliesCleanly: true,
								formatting: true,
								typeChecking: true,
								targetedTestsPassed: true,
							};
						},
					},
					async createReviewer(session) {
						expect(session.credential).toBe("reviewer-credential");
						return createGatewayPiReviewerAdapter({
							runtime,
							session,
							activeHarnessDirectory: rootDirectory,
							process: {
								activeHarnessCommand: process.execPath,
								baseArgs: [reviewerProcessPath],
								agentDirectory: path.join(rootDirectory, "reviewer-agent"),
								environment: { REVIEWER_PROMPT_PATH: reviewerPromptPath },
							},
						});
					},
				},
			);

			expect(run.manifest.state).toBe("review_passed");
			expect(issuedRoles).toEqual(["proposer", "reviewer"]);
			expect(revokedSessions).toEqual(["reviewer-session", "proposer-session"]);
			expect(prompts.join("\n")).not.toContain("sealed-held-out-id");
			expect(await readFile(reviewerPromptPath, "utf8")).not.toContain("sealed-held-out-id");
			const reviewerModels = await readFile(path.join(rootDirectory, "reviewer-agent/models.json"), "utf8");
			expect(reviewerModels).toContain("reviewer-model");
			expect(reviewerModels).toContain("$SELFPI_GATEWAY_TOKEN");
			expect(reviewerModels).not.toContain("reviewer-credential");
			expect(await readFile(path.join(rootDirectory, "runs/run-27/proposal-provenance.json"), "utf8")).toContain(
				'"gatewaySessionId": "proposer-session"',
			);
			expect(JSON.parse(await readFile(path.join(rootDirectory, "runs/run-27/review.json"), "utf8"))).toMatchObject({
				reviewerProvider: "openai",
				reviewerModel: "reviewer-model",
				gatewayIdentity: "gateway-v1",
				gatewaySessionId: "reviewer-session",
			});
		} finally {
			await rm(rootDirectory, { recursive: true, force: true });
		}
	});
});
