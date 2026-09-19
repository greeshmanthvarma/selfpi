import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DeterministicRuntime } from "../config/load-runtime.ts";
import {
	type ImprovementEvaluationAttempt,
	type ImprovementEvaluationResult,
	runImprovementCycle,
} from "../controller/run-improvement-cycle.ts";
import { compareHarnessAttempts, type EvaluatedHarnessAttempt } from "../evaluation/compare-harness-attempts.ts";
import { measurePathRecovery } from "../evaluation/measure-path-recovery.ts";
import { runHarnessAttempt } from "../evaluation/run-harness-attempt.ts";
import type { EvaluationTask } from "../evaluation/verify-task.ts";
import { buildSealedEvidenceBundle } from "../evidence/build-sealed-evidence-bundle.ts";
import type { Experiment } from "../experiments/load-experiment.ts";
import type { PromotionReferenceAdapter } from "../promotion/promote-run.ts";
import { createGitProposalWorktreeAdapter } from "../proposal/generate-candidate-proposal.ts";
import { createPiProposerProcessAdapter } from "../proposal/pi-proposer-process.ts";
import type { CandidateProposal } from "../proposal/validate-candidate-proposal.ts";
import type { CandidateReviewerAdapter } from "../review/candidate-review.ts";
import { withCandidateWorktree } from "./candidate-worktree.ts";

const executeFile = promisify(execFile);
const candidatePath = "packages/selfpi-recovery-policy/src/index.ts";
const policyTestPath = "packages/selfpi-recovery-policy/test/path-recovery-policy.test.ts";
const evaluationHarnessPath = "packages/selfpi/src/deterministic/faux-evaluation-harness.ts";
const proposerPath = "packages/selfpi/src/deterministic/faux-proposer.mjs";
const reviewerPath = "packages/selfpi/src/deterministic/faux-reviewer.mjs";
const evaluatorSourcePaths = [
	"packages/selfpi/src/deterministic/run-deterministic-improvement.ts",
	"packages/selfpi/src/controller/run-improvement-cycle.ts",
	"packages/selfpi/src/evaluation/run-harness-attempt.ts",
	"packages/selfpi/src/evaluation/compare-harness-attempts.ts",
	"packages/selfpi/src/evaluation/measure-path-recovery.ts",
	"packages/selfpi/src/promotion/decide-promotion-recommendation.ts",
] as const;
const verifierPath = "packages/selfpi/src/evaluation/verify-task.ts";

interface ActiveHarness {
	readonly sourceCommit: string;
}

export interface DeterministicImprovementInput {
	readonly rootDirectory: string;
	readonly repositoryDirectory: string;
	readonly runId: string;
	readonly now: () => Date;
	readonly experiment: Experiment;
	readonly runtime: DeterministicRuntime;
	readonly referenceAdapter: PromotionReferenceAdapter;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadActiveHarness(input: DeterministicImprovementInput): Promise<ActiveHarness> {
	const value: unknown = JSON.parse(
		await readFile(path.join(input.rootDirectory, "promotion", "active.json"), "utf8"),
	);
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.reference !== "string" ||
		!isRecord(value.current) ||
		typeof value.current.sourceCommit !== "string" ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.current.sourceCommit)
	) {
		throw new Error("Active harness configuration is invalid.");
	}
	const actualCommit = await input.referenceAdapter.read(value.reference);
	if (actualCommit !== value.current.sourceCommit) {
		throw new Error("Configured active reference does not match the active harness record.");
	}
	return Object.freeze({ sourceCommit: value.current.sourceCommit });
}

async function runProcessJson(
	command: string,
	args: readonly string[],
	cwd: string,
	standardInput: unknown,
	timeoutMs: number,
): Promise<unknown> {
	const child = spawn(command, [...args, JSON.stringify(standardInput)], {
		cwd,
		env: { PATH: process.env.PATH ?? "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	}).finally(() => clearTimeout(timeout));
	if (timedOut) throw new Error("Deterministic process timed out.");
	if (exitCode !== 0) {
		throw new Error(
			Buffer.concat(stderrChunks).toString("utf8").trim() ||
				`Deterministic process failed with exit code ${String(exitCode)}.`,
		);
	}
	return JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as unknown;
}

async function commandPassed(
	command: string,
	args: readonly string[],
	cwd: string,
	timeoutMs: number,
): Promise<boolean> {
	try {
		await executeFile(command, [...args], { cwd, timeout: timeoutMs, killSignal: "SIGKILL" });
		return true;
	} catch {
		return false;
	}
}

async function installProtectedEvaluationFiles(repositoryDirectory: string, worktreeDirectory: string): Promise<void> {
	await mkdir(path.join(worktreeDirectory, path.dirname(evaluationHarnessPath)), { recursive: true });
	await Promise.all([
		cp(path.join(repositoryDirectory, policyTestPath), path.join(worktreeDirectory, policyTestPath), {
			force: true,
		}),
		cp(path.join(repositoryDirectory, evaluationHarnessPath), path.join(worktreeDirectory, evaluationHarnessPath), {
			force: true,
		}),
	]);
}

function remainingTime(deadline: number): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error("Deterministic improvement cycle timed out.");
	return remaining;
}

function createReviewer(input: DeterministicImprovementInput, deadline: number): CandidateReviewerAdapter {
	return {
		review(reviewInput) {
			return runProcessJson(
				process.execPath,
				[path.join(input.repositoryDirectory, reviewerPath)],
				input.repositoryDirectory,
				reviewInput,
				remainingTime(deadline),
			);
		},
	};
}

function task(taskId: string): EvaluationTask {
	return Object.freeze({
		id: taskId,
		verifier: Object.freeze({
			type: "exact_file",
			path: "answer.txt",
			expectedContent: "Configuration file: src/settings.ts\n",
		}),
	});
}

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function runAttempt(input: {
	readonly worktreeDirectory: string;
	readonly workspaceDirectory: string;
	readonly taskId: string;
	readonly fingerprintInputs: EvaluatedHarnessAttempt["fingerprintInputs"];
	readonly timeoutMs: number;
}): Promise<EvaluatedHarnessAttempt> {
	const result = await runHarnessAttempt({
		command: process.execPath,
		args: [path.join(input.worktreeDirectory, evaluationHarnessPath), input.taskId, input.workspaceDirectory],
		workspaceDirectory: input.workspaceDirectory,
		task: task(input.taskId),
		timeoutMs: input.timeoutMs,
		environment: { PATH: process.env.PATH ?? "" },
	});
	return Object.freeze({ fingerprintInputs: input.fingerprintInputs, result });
}

async function createEvaluator(
	input: DeterministicImprovementInput,
	activeCommit: string,
	candidate: CandidateProposal,
	deadline: number,
): Promise<ImprovementEvaluationResult> {
	const worktreeRoot = path.join(input.rootDirectory, "worktrees", "evaluation");
	return withCandidateWorktree({
		repositoryDirectory: input.repositoryDirectory,
		worktreeRoot,
		baselineCommit: activeCommit,
		run: async (baselineDirectory) => {
			await installProtectedEvaluationFiles(input.repositoryDirectory, baselineDirectory);
			return withCandidateWorktree({
				repositoryDirectory: input.repositoryDirectory,
				worktreeRoot,
				baselineCommit: activeCommit,
				unifiedDiff: candidate.unifiedDiff,
				run: async (candidateDirectory) => {
					await installProtectedEvaluationFiles(input.repositoryDirectory, candidateDirectory);
					const [lockfile, evaluationHarness, policyTest, verifier, ...evaluatorSources] = await Promise.all([
						readFile(path.join(input.repositoryDirectory, "package-lock.json"), "utf8"),
						readFile(path.join(input.repositoryDirectory, evaluationHarnessPath), "utf8"),
						readFile(path.join(input.repositoryDirectory, policyTestPath), "utf8"),
						readFile(path.join(input.repositoryDirectory, verifierPath), "utf8"),
						...evaluatorSourcePaths.map((sourcePath) =>
							readFile(path.join(input.repositoryDirectory, sourcePath), "utf8"),
						),
					]);
					const lockfileDigest = digest(lockfile);
					const evaluatorDigest = digest(evaluatorSources.join("\n"));
					const verifierDigest = digest(verifier);
					const executorDigest = digest(
						`${process.version}\n${evaluationHarness}\n${policyTest}\n${evaluatorDigest}\n${verifierDigest}`,
					);
					const taskIds = [...input.experiment.heldIn, ...input.experiment.heldOut];
					const fingerprintInputs = Object.freeze({
						version: 1 as const,
						harness: Object.freeze({
							baselineCommit: activeCommit,
							candidateParentCommit: activeCommit,
						}),
						model: Object.freeze({
							provider: "faux",
							id: "deterministic-v0",
							parameters: Object.freeze({ temperature: 0 }),
						}),
						systemInputsDigest: digest(`${evaluationHarness}\n${policyTest}`),
						task: Object.freeze({
							setVersion: input.experiment.id,
							repositoryCommits: Object.freeze(
								Object.fromEntries(taskIds.map((taskId) => [taskId, "deterministic-fixture-v1"])),
							),
						}),
						dependencies: Object.freeze({ lockfileDigest }),
						evaluator: Object.freeze({ version: evaluatorDigest }),
						verifier: Object.freeze({ version: verifierDigest }),
						container: Object.freeze({
							imageDigest: executorDigest,
							networkPolicyDigest: digest("host-process"),
							cpuLimit: 0,
							memoryMb: 0,
						}),
						budget: Object.freeze({
							timeoutMs: input.experiment.budget.wallClockMs,
							toolCalls: input.experiment.budget.toolCalls,
							turns: input.experiment.budget.turns,
							tokens: input.experiment.budget.tokens,
							costUsd: input.experiment.budget.costUsd,
						}),
						repetitions: input.runtime.evaluation.repetitions,
					});
					const attempts: ImprovementEvaluationAttempt[] = [];
					for (const [heldOut, ids] of [
						[false, input.experiment.heldIn],
						[true, input.experiment.heldOut],
					] as const) {
						for (const taskId of ids) {
							for (let repetition = 0; repetition < input.runtime.evaluation.repetitions; repetition++) {
								const timeoutMs = remainingTime(deadline);
								const [baselineWorkspace, candidateWorkspace] = await Promise.all([
									mkdtemp(path.join(os.tmpdir(), "selfpi-baseline-")),
									mkdtemp(path.join(os.tmpdir(), "selfpi-candidate-")),
								]);
								try {
									const [baseline, evaluatedCandidate] = await Promise.all([
										runAttempt({
											worktreeDirectory: baselineDirectory,
											workspaceDirectory: baselineWorkspace,
											taskId,
											fingerprintInputs,
											timeoutMs,
										}),
										runAttempt({
											worktreeDirectory: candidateDirectory,
											workspaceDirectory: candidateWorkspace,
											taskId,
											fingerprintInputs,
											timeoutMs,
										}),
									]);
									const perturbation = {
										version: 1 as const,
										fired: true as const,
										toolCallSequence: 1,
										toolCallId: "deterministic-read-1",
										path: "src/config.ts",
										error: "src/config.ts does not exist",
										subsequentMatchingReadSuccesses: 0,
										repeatedIdenticalFailures: 0,
									};
									attempts.push({
										taskId,
										set: heldOut ? "held_out" : "held_in",
										repetition,
										baseline,
										candidate: evaluatedCandidate,
										baselineRecovered:
											!heldOut && measurePathRecovery(perturbation, baseline.result.verifier).recovered,
										candidateRecovered:
											!heldOut &&
											measurePathRecovery(perturbation, evaluatedCandidate.result.verifier).recovered,
										baselineCostUsd: 0,
										candidateCostUsd: 0,
									});
								} finally {
									await Promise.all([
										rm(baselineWorkspace, { recursive: true, force: true }),
										rm(candidateWorkspace, { recursive: true, force: true }),
									]);
								}
							}
						}
					}
					const heldIn = attempts.filter((attempt) => attempt.set === "held_in");
					const heldOut = attempts.filter((attempt) => attempt.set === "held_out");
					const completions = (values: readonly (typeof attempts)[number][], side: "baseline" | "candidate") =>
						values.filter((attempt) => attempt[side].result.verifier.verifiedCompletion).length;
					const baselineTokens = attempts.reduce(
						(total, attempt) => total + attempt.baseline.result.usage.totalTokens,
						0,
					);
					const candidateTokens = attempts.reduce(
						(total, attempt) => total + attempt.candidate.result.usage.totalTokens,
						0,
					);
					const recoveries = (side: "baseline" | "candidate") =>
						heldIn.filter((attempt) =>
							side === "baseline" ? attempt.baselineRecovered : attempt.candidateRecovered,
						).length;
					const first = heldIn[0];
					if (first === undefined) throw new Error("Deterministic evaluation requires a held-in task.");
					return Object.freeze({
						comparison: compareHarnessAttempts({
							baseline: first.baseline,
							candidate: first.candidate,
						}),
						outcomes: Object.freeze({
							baselineRepetitions: input.runtime.evaluation.repetitions,
							candidateRepetitions: input.runtime.evaluation.repetitions,
							baselineHeldInCompletions: completions(heldIn, "baseline"),
							candidateHeldInCompletions: completions(heldIn, "candidate"),
							baselineHeldOutCompletions: completions(heldOut, "baseline"),
							candidateHeldOutCompletions: completions(heldOut, "candidate"),
							baselineRecoveryRate: recoveries("baseline") / heldIn.length,
							candidateRecoveryRate: recoveries("candidate") / heldIn.length,
						}),
						efficiency: Object.freeze({
							baselineTokens,
							candidateTokens,
							baselineCostUsd: 0,
							candidateCostUsd: 0,
						}),
						integrityViolation: false,
						attempts: Object.freeze(attempts),
					});
				},
			});
		},
	});
}

export async function runDeterministicImprovement(input: DeterministicImprovementInput) {
	if (
		input.experiment.heldIn.length !== 1 ||
		input.experiment.heldIn[0] !== "path-recovery-held-in-01" ||
		input.experiment.heldOut.length !== 1 ||
		input.experiment.heldOut[0] !== "path-recovery-held-out-01"
	) {
		throw new Error("Deterministic v0 task mapping is invalid.");
	}
	const deadline = Date.now() + input.experiment.budget.wallClockMs;
	const active = await loadActiveHarness(input);
	const { stdout: editableSource } = await executeFile("git", ["show", `${active.sourceCommit}:${candidatePath}`], {
		cwd: input.repositoryDirectory,
	});
	const evidence = buildSealedEvidenceBundle({
		heldInFailures: [
			{
				version: 1,
				taskId: input.experiment.heldIn[0] ?? "missing-held-in-task",
				verifiedCompletion: false,
				verification: { verifiedCompletion: false, reason: "artifact_missing" },
				toolCallId: "deterministic-read-1",
				toolName: "read",
				arguments: { path: "src/config.ts" },
				errorContent: "src/config.ts does not exist",
				sourceEntryIds: { toolCall: "deterministic-call", toolResult: "deterministic-result" },
				subsequentToolCalls: [],
			},
		],
		redactedRepresentativeTraces: [
			{
				taskId: input.experiment.heldIn[0] ?? "missing-held-in-task",
				entries: [{ role: "tool", content: "read src/config.ts: file does not exist" }],
			},
		],
		heldInVerifierOutcomes: [
			{
				taskId: input.experiment.heldIn[0] ?? "missing-held-in-task",
				verifiedCompletion: false,
				reason: "artifact_missing",
			},
		],
		preservedSuccesses: [],
		editableSource: [{ path: candidatePath, content: editableSource }],
		rejectedHypotheses: [],
		proposalSchema: {
			version: 1,
			requiredFields: [
				"hypothesis",
				"targetFailureSignature",
				"affectedEditableSurface",
				"unifiedDiff",
				"expectedBehavioralMechanism",
				"predictedBenefit",
				"regressionRisks",
			],
		},
		editableSurface: input.experiment.editableSurface,
		changeBudget: {
			expectedMaximumChangedLines: 100,
			justificationRequiredAbove: 100,
			humanApprovalAbove: 250,
		},
		heldOutTaskIds: input.experiment.heldOut,
		perturbationSchedules: [{ path: "src/config.ts" }],
	});
	const worktreeRoot = path.join(input.rootDirectory, "worktrees");
	const run = await runImprovementCycle(
		{
			rootDirectory: input.rootDirectory,
			runId: input.runId,
			now: input.now,
			experiment: input.experiment,
			evidenceClass: "deterministic_engineering",
			proposal: {
				baselineCommit: active.sourceCommit,
				activeHarnessCommit: active.sourceCommit,
				prompt: "Propose one bounded deterministic path-recovery change.",
				model: {
					provider: input.runtime.proposer.provider,
					id: input.runtime.proposer.model,
					configuration: { thinking: input.runtime.proposer.thinking },
				},
				evidence,
			},
			review: {
				relevantSource: editableSource,
				repositoryInstructions: await readFile(path.join(input.repositoryDirectory, "AGENTS.md"), "utf8"),
				reviewer: {
					provider: input.runtime.reviewer.provider,
					model: input.runtime.reviewer.model,
					promptVersion: "deterministic-review-v1",
					prompt: "Review the candidate without rewriting it.",
				},
			},
			humanApproval: false,
		},
		{
			git: createGitProposalWorktreeAdapter({
				repositoryDirectory: input.repositoryDirectory,
				worktreeRoot: path.join(worktreeRoot, "proposal"),
			}),
			proposer: createPiProposerProcessAdapter({
				activeHarnessCommand: process.execPath,
				baseArgs: [path.join(input.repositoryDirectory, proposerPath)],
				environment: { PATH: process.env.PATH ?? "" },
				timeoutMs: remainingTime(deadline),
			}),
			checks: {
				async run(candidate) {
					try {
						return await withCandidateWorktree({
							repositoryDirectory: input.repositoryDirectory,
							worktreeRoot: path.join(worktreeRoot, "checks"),
							baselineCommit: active.sourceCommit,
							unifiedDiff: candidate.unifiedDiff,
							run: async (directory) => {
								await cp(
									path.join(input.repositoryDirectory, policyTestPath),
									path.join(directory, policyTestPath),
									{ force: true },
								);
								const formatting = await commandPassed(
									path.join(input.repositoryDirectory, "node_modules/@biomejs/biome/bin/biome"),
									["check", candidatePath],
									directory,
									remainingTime(deadline),
								);
								const typeChecking = await commandPassed(
									path.join(input.repositoryDirectory, "node_modules/.bin/tsgo"),
									["--noEmit", "-p", "packages/selfpi-recovery-policy/tsconfig.json"],
									directory,
									remainingTime(deadline),
								);
								const targetedTestsPassed = await commandPassed(
									process.execPath,
									[
										path.join(input.repositoryDirectory, "node_modules/vitest/dist/cli.js"),
										"--run",
										policyTestPath,
									],
									directory,
									remainingTime(deadline),
								);
								return { appliesCleanly: true, formatting, typeChecking, targetedTestsPassed };
							},
						});
					} catch {
						return {
							appliesCleanly: false,
							formatting: false,
							typeChecking: false,
							targetedTestsPassed: false,
						};
					}
				},
			},
			reviewer: createReviewer(input, deadline),
			smoke: {
				async run(candidate) {
					return withCandidateWorktree({
						repositoryDirectory: input.repositoryDirectory,
						worktreeRoot: path.join(worktreeRoot, "smoke"),
						baselineCommit: active.sourceCommit,
						unifiedDiff: candidate.unifiedDiff,
						run: async (directory) => {
							await installProtectedEvaluationFiles(input.repositoryDirectory, directory);
							const workspace = await mkdtemp(path.join(os.tmpdir(), "selfpi-smoke-"));
							try {
								const fingerprint = {
									version: 1 as const,
									harness: { baselineCommit: active.sourceCommit, candidateParentCommit: active.sourceCommit },
									model: { provider: "faux", id: "deterministic-v0", parameters: { temperature: 0 } },
									systemInputsDigest: digest("smoke"),
									task: {
										setVersion: "deterministic-smoke-v1",
										repositoryCommits: { smoke: "deterministic-fixture-v1" },
									},
									dependencies: { lockfileDigest: digest("smoke-lock") },
									evaluator: { version: "deterministic-evaluator-v1" },
									verifier: { version: "exact-file-v1" },
									container: {
										imageDigest: digest("deterministic-smoke-host-process"),
										networkPolicyDigest: digest("host-process"),
										cpuLimit: 0,
										memoryMb: 0,
									},
									budget: {
										timeoutMs: input.experiment.budget.wallClockMs,
										toolCalls: input.experiment.budget.toolCalls,
										turns: input.experiment.budget.turns,
										tokens: input.experiment.budget.tokens,
										costUsd: input.experiment.budget.costUsd,
									},
									repetitions: 1,
								};
								const attempt = await runAttempt({
									worktreeDirectory: directory,
									workspaceDirectory: workspace,
									taskId: "deterministic-smoke",
									fingerprintInputs: fingerprint,
									timeoutMs: remainingTime(deadline),
								});
								return {
									buildPassed: attempt.result.termination.reason === "completed",
									smokePassed: attempt.result.verifier.verifiedCompletion,
								};
							} finally {
								await rm(workspace, { recursive: true, force: true });
							}
						},
					});
				},
			},
			evaluator: {
				run(candidate) {
					return createEvaluator(input, active.sourceCommit, candidate, deadline);
				},
			},
		},
	);
	return run;
}
