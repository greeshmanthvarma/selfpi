import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ProtectedTaskRegistry, RegisteredTask, SupervisedRuntime } from "../config/load-supervised-runtime.ts";
import type { ImprovementEvaluationAttempt, ImprovementEvaluationResult } from "../controller/run-improvement-cycle.ts";
import type { EvaluationFingerprintInputs } from "../evaluation/baseline-cache.ts";
import { compareHarnessAttempts, type EvaluatedHarnessAttempt } from "../evaluation/compare-harness-attempts.ts";
import type { DockerHarnessRunner } from "../evaluation/docker-harness-runner.ts";
import { measurePathRecovery } from "../evaluation/measure-path-recovery.ts";
import type { PathPerturbationRecord } from "../evaluation/path-perturbation-extension.ts";
import { materializeProtectedTaskFixture } from "../evaluation/protected-task-fixture-store.ts";
import type { HarnessAttemptResult } from "../evaluation/run-harness-attempt.ts";
import type { EvaluationTask } from "../evaluation/verify-task.ts";
import type { Experiment } from "../experiments/load-experiment.ts";
import type { ModelGateway } from "../gateway/model-gateway.ts";

interface EvaluationHarness {
	readonly sourceDirectory: string;
	readonly command: string;
	readonly args: readonly string[];
}

export interface SupervisedEvaluationInput {
	readonly rootDirectory: string;
	readonly runId: string;
	readonly experiment: Experiment;
	readonly runtime: SupervisedRuntime;
	readonly taskRegistry: ProtectedTaskRegistry;
	readonly evaluationTasks: Readonly<Record<string, { readonly digest: string; readonly task: EvaluationTask }>>;
	readonly fingerprintInputs: EvaluationFingerprintInputs;
	readonly containerImage: string;
	readonly baselineHarness: EvaluationHarness;
	readonly candidateHarness: EvaluationHarness;
	readonly gatewayNetwork: { readonly name: string; readonly digest: string };
	readonly resources: { readonly cpuLimit: number; readonly memoryMb: number };
	readonly sessionExpiresAt: Date;
}

export interface SupervisedEvaluationAdapters {
	readonly gateway: ModelGateway;
	readonly runner: DockerHarnessRunner;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertControlledInputs(input: SupervisedEvaluationInput, tasks: readonly RegisteredTask[]): void {
	const expectedTasks = [...input.experiment.heldIn, ...input.experiment.heldOut];
	if (
		input.taskRegistry.id !== input.runtime.taskRegistry.id ||
		input.taskRegistry.digest !== input.runtime.taskRegistry.digest ||
		!sameValues(
			tasks.map((task) => task.id),
			expectedTasks,
		) ||
		input.fingerprintInputs.harness.baselineCommit !== input.runtime.activeVersion.sourceCommit ||
		input.fingerprintInputs.harness.candidateParentCommit !== input.runtime.activeVersion.sourceCommit ||
		input.fingerprintInputs.task.setVersion !== input.taskRegistry.digest ||
		input.fingerprintInputs.repetitions !== input.runtime.evaluation.repetitions ||
		input.fingerprintInputs.container.imageDigest !== input.runtime.container.imageDigest ||
		input.fingerprintInputs.container.networkPolicyDigest !== input.gatewayNetwork.digest ||
		input.fingerprintInputs.container.cpuLimit !== input.resources.cpuLimit ||
		input.fingerprintInputs.container.memoryMb !== input.resources.memoryMb ||
		!input.containerImage.endsWith(`@${input.runtime.container.imageDigest}`)
	) {
		throw new Error("Supervised evaluation controlled inputs do not match.");
	}
	for (const task of tasks) {
		if (input.fingerprintInputs.task.repositoryCommits[task.id] !== task.repository.commit) {
			throw new Error("Supervised evaluation task repository identity does not match.");
		}
		const verifier = input.evaluationTasks[task.verifier.id];
		if (verifier === undefined || verifier.digest !== task.verifier.digest || verifier.task.id !== task.id) {
			throw new Error("Supervised evaluation verifier identity does not match.");
		}
	}
}

function perturbationFor(result: HarnessAttemptResult): PathPerturbationRecord {
	return result.perturbation ?? Object.freeze({ version: 1, fired: false });
}

export async function runSupervisedEvaluation(
	input: SupervisedEvaluationInput,
	adapters: SupervisedEvaluationAdapters,
): Promise<ImprovementEvaluationResult> {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(input.runId)) {
		throw new Error("Supervised evaluation run ID is invalid.");
	}
	const registeredTasks = [...input.taskRegistry.heldIn, ...input.taskRegistry.heldOut];
	const tasksById = new Map(registeredTasks.map((task) => [task.id, task]));
	if (
		tasksById.size !== registeredTasks.length ||
		registeredTasks.length !== input.experiment.heldIn.length + input.experiment.heldOut.length
	) {
		throw new Error("Supervised evaluation task registry does not match the experiment.");
	}
	const tasks = Object.freeze(
		[...input.experiment.heldIn, ...input.experiment.heldOut].map((taskId) => {
			const task = tasksById.get(taskId);
			if (task === undefined) throw new Error("Supervised evaluation task registry does not match the experiment.");
			return task;
		}),
	);
	assertControlledInputs(input, tasks);
	const totalContainerAttempts = tasks.length * input.runtime.evaluation.repetitions * 2;
	if (
		input.experiment.budget.tokens < totalContainerAttempts ||
		input.experiment.budget.wallClockMs < totalContainerAttempts
	) {
		throw new Error("Supervised evaluation budget is too small for the declared attempts.");
	}
	const tokenBudget = Math.floor(input.experiment.budget.tokens / totalContainerAttempts);
	const timeoutMs = Math.floor(input.experiment.budget.wallClockMs / totalContainerAttempts);
	const protectedRoot = path.join(input.rootDirectory, "task-fixtures");
	const workspaceRoot = path.join(input.rootDirectory, "evaluation-workspaces", input.runId);
	const evaluationAttempts: ImprovementEvaluationAttempt[] = [];

	for (const task of tasks) {
		const fixture = await materializeProtectedTaskFixture({
			protectedRoot,
			registryId: input.taskRegistry.id,
			task,
		});
		const evaluationTask = input.evaluationTasks[task.verifier.id]?.task;
		if (evaluationTask === undefined) throw new Error("Supervised evaluation task is missing.");
		for (let repetition = 0; repetition < input.runtime.evaluation.repetitions; repetition += 1) {
			const runVariant = async (
				variant: "baseline" | "candidate",
				harness: EvaluationHarness,
			): Promise<EvaluatedHarnessAttempt> => {
				const workspaceDirectory = path.join(workspaceRoot, task.id, String(repetition), variant);
				await mkdir(path.dirname(workspaceDirectory), { recursive: true });
				await cp(fixture.repositoryDirectory, workspaceDirectory, { recursive: true });
				const session = await adapters.gateway.issueSession({
					runId: input.runId,
					role: "evaluation",
					provider: input.runtime.proposer.provider,
					model: input.runtime.proposer.model,
					tokenBudget,
					expiresAt: input.sessionExpiresAt,
				});
				try {
					const result = await adapters.runner.run({
						image: input.containerImage,
						command: harness.command,
						args: harness.args,
						workspaceDirectory,
						immutableInputs: [{ source: harness.sourceDirectory, target: "/inputs/harness" }],
						task: evaluationTask,
						timeoutMs,
						resources: input.resources,
						networkPolicy: {
							mode: "gateway_only",
							digest: input.gatewayNetwork.digest,
							networkName: input.gatewayNetwork.name,
						},
						gatewaySession: { endpoint: session.endpoint, credential: session.credential },
						environment: {
							SELFPI_VARIANT: variant,
							SELFPI_TASK_ID: task.id,
							SELFPI_TASK_INPUT: task.input,
							SELFPI_REPETITION: String(repetition),
							SELFPI_PROVIDER: input.runtime.proposer.provider,
							SELFPI_MODEL: input.runtime.proposer.model,
							SELFPI_HARNESS_ROOT: "/inputs/harness",
							SELFPI_TOOL_CALL_LIMIT: String(input.experiment.budget.toolCalls),
							SELFPI_TURN_LIMIT: String(input.experiment.budget.turns),
							SELFPI_MODEL_BUDGET: String(tokenBudget),
							...(task.perturbation === undefined
								? {}
								: { SELFPI_PERTURBATION_JSON: JSON.stringify(task.perturbation) }),
						},
					});
					return Object.freeze({ fingerprintInputs: input.fingerprintInputs, result });
				} finally {
					await adapters.gateway.revokeSession(session.id);
					await rm(workspaceDirectory, { recursive: true, force: true });
				}
			};

			const baseline = await runVariant("baseline", input.baselineHarness);
			const candidate = await runVariant("candidate", input.candidateHarness);
			const baselineRecovery = measurePathRecovery(perturbationFor(baseline.result), baseline.result.verifier);
			const candidateRecovery = measurePathRecovery(perturbationFor(candidate.result), candidate.result.verifier);
			evaluationAttempts.push(
				Object.freeze({
					taskId: task.id,
					set: task.set,
					repetition,
					baseline,
					candidate,
					baselineRecovered: baselineRecovery.recovered,
					candidateRecovered: candidateRecovery.recovered,
					baselineCostUsd: 0,
					candidateCostUsd: 0,
				}),
			);
		}
	}

	const first = evaluationAttempts[0];
	if (first === undefined) throw new Error("Supervised evaluation requires at least one attempt.");
	const heldIn = evaluationAttempts.filter((attempt) => attempt.set === "held_in");
	const heldOut = evaluationAttempts.filter((attempt) => attempt.set === "held_out");
	const completions = (attempts: readonly ImprovementEvaluationAttempt[], variant: "baseline" | "candidate") =>
		attempts.filter((attempt) => attempt[variant].result.verifier.verifiedCompletion).length;
	const recoveries = (variant: "baseline" | "candidate") =>
		heldIn.filter((attempt) => (variant === "baseline" ? attempt.baselineRecovered : attempt.candidateRecovered))
			.length;
	const outcomes = Object.freeze({
		baselineRepetitions: input.runtime.evaluation.repetitions,
		candidateRepetitions: input.runtime.evaluation.repetitions,
		baselineHeldInCompletions: completions(heldIn, "baseline"),
		candidateHeldInCompletions: completions(heldIn, "candidate"),
		baselineHeldOutCompletions: completions(heldOut, "baseline"),
		candidateHeldOutCompletions: completions(heldOut, "candidate"),
		baselineRecoveryRate: heldIn.length === 0 ? 0 : recoveries("baseline") / heldIn.length,
		candidateRecoveryRate: heldIn.length === 0 ? 0 : recoveries("candidate") / heldIn.length,
	});
	const efficiency = Object.freeze({
		baselineTokens: evaluationAttempts.reduce(
			(total, attempt) => total + attempt.baseline.result.usage.totalTokens,
			0,
		),
		candidateTokens: evaluationAttempts.reduce(
			(total, attempt) => total + attempt.candidate.result.usage.totalTokens,
			0,
		),
		baselineCostUsd: evaluationAttempts.reduce((total, attempt) => total + attempt.baselineCostUsd, 0),
		candidateCostUsd: evaluationAttempts.reduce((total, attempt) => total + attempt.candidateCostUsd, 0),
	});
	return Object.freeze({
		comparison: compareHarnessAttempts({ baseline: first.baseline, candidate: first.candidate }),
		outcomes,
		efficiency,
		integrityViolation: false,
		attempts: Object.freeze(evaluationAttempts),
	});
}
