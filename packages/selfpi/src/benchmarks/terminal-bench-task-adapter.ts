/**
 * Terminal-Bench tasks adapted for SelfPi's evaluation harness.
 *
 * SelfPi remains the A/B runner (coding-agent baseline vs candidate).
 * TB supplies task identity, instruction, and tests/test.sh grading —
 * not Harbor as a second harness.
 */

import type { EvaluationTask, ShellRewardVerifier } from "../evaluation/verify-task.ts";
import { type ExternalBenchmarkSmokePlan, getExternalBenchmark } from "./external-benchmarks.ts";

/** TB verifier contract, remapped into SelfPi workspace paths. */
export const TERMINAL_BENCH_VERIFIER = Object.freeze({
	entrypoint: "tests/test.sh",
	/** Absolute path inside TB containers; SelfPi remaps to workspace. */
	upstreamRewardPath: "/logs/verifier/reward.txt",
	selfPiRewardDirectory: "logs/verifier",
	selfPiRewardFileName: "reward.txt",
} as const);

export type TerminalBenchTaskSet = "smoke" | "custom" | "held_in" | "held_out";

export interface TerminalBenchTaskRef {
	readonly taskId: string;
	readonly datasetPin: string;
	readonly set: TerminalBenchTaskSet;
	readonly verifier: typeof TERMINAL_BENCH_VERIFIER;
}

export type TerminalBenchRewardReason = "reward_pass" | "reward_fail" | "reward_missing" | "reward_invalid";

export interface TerminalBenchTaskOutcome {
	readonly taskId: string;
	readonly verifiedCompletion: boolean;
	readonly reason: TerminalBenchRewardReason;
	readonly rewardRaw: string | null;
}

export interface TerminalBenchSelfPiEvalPlan {
	readonly benchmarkId: "terminal-bench";
	readonly role: "evaluation";
	readonly evalHarness: "selfpi";
	readonly editablePack: "tool-code-v0";
	readonly datasetPin: string;
	readonly tasks: readonly TerminalBenchTaskRef[];
	readonly heldIn: readonly TerminalBenchTaskRef[];
	readonly heldOut: readonly TerminalBenchTaskRef[];
	readonly verifier: typeof TERMINAL_BENCH_VERIFIER;
	readonly principles: {
		readonly doNotRegressToFit: true;
		readonly replacesToolCodeCorpus: false;
		readonly selfPiHarnessOnly: true;
		readonly promoteOnTbCompletionGain: true;
	};
}

export interface TerminalBenchAbTaskPair {
	readonly taskId: string;
	readonly baseline: TerminalBenchTaskOutcome;
	readonly candidate: TerminalBenchTaskOutcome;
}

export interface TerminalBenchAbComparison {
	readonly taskCount: number;
	readonly baselineCompletions: number;
	readonly candidateCompletions: number;
	readonly heldInCompletionGain: number;
	readonly pairs: readonly TerminalBenchAbTaskPair[];
}

function requireTerminalBenchRegistry(): ExternalBenchmarkSmokePlan {
	const bench = getExternalBenchmark("terminal-bench");
	if (bench === undefined) {
		throw new Error("terminal-bench registry entry missing.");
	}
	return bench;
}

function shortTaskName(taskId: string): string {
	return taskId.includes("/") ? taskId.slice(taskId.lastIndexOf("/") + 1) : taskId;
}

export function listTerminalBenchSmokeTaskRefs(): readonly TerminalBenchTaskRef[] {
	const bench = requireTerminalBenchRegistry();
	return Object.freeze(
		bench.smokeTaskIds.map((taskId) =>
			Object.freeze({
				taskId,
				datasetPin: bench.datasetPin,
				set: "smoke" as const,
				verifier: TERMINAL_BENCH_VERIFIER,
			}),
		),
	);
}

export function buildTerminalBenchTaskRefs(input: {
	readonly taskIds: readonly string[];
	readonly datasetPin?: string;
	readonly set?: TerminalBenchTaskSet;
}): readonly TerminalBenchTaskRef[] {
	const bench = requireTerminalBenchRegistry();
	const datasetPin = input.datasetPin ?? bench.datasetPin;
	const set = input.set ?? "custom";
	if (input.taskIds.length === 0) {
		throw new Error("Terminal-Bench eval plan requires at least one task id.");
	}
	return Object.freeze(
		input.taskIds.map((taskId) =>
			Object.freeze({
				taskId,
				datasetPin,
				set,
				verifier: TERMINAL_BENCH_VERIFIER,
			}),
		),
	);
}

/**
 * Split smoke allowlist into held-in / held-out for SelfPi promote metrics.
 * Default: all but the last task are held-in.
 */
export function buildTerminalBenchSelfPiEvalPlan(input?: {
	readonly taskIds?: readonly string[];
	readonly heldInCount?: number;
}): TerminalBenchSelfPiEvalPlan {
	const bench = requireTerminalBenchRegistry();
	const taskIds = input?.taskIds ?? bench.smokeTaskIds;
	const tasks = buildTerminalBenchTaskRefs({ taskIds, set: "custom" });
	const heldInCount = Math.min(Math.max(input?.heldInCount ?? Math.max(1, taskIds.length - 1), 1), taskIds.length);
	const heldIn = Object.freeze(
		tasks.slice(0, heldInCount).map((task) => Object.freeze({ ...task, set: "held_in" as const })),
	);
	const heldOut = Object.freeze(
		tasks.slice(heldInCount).map((task) => Object.freeze({ ...task, set: "held_out" as const })),
	);
	return Object.freeze({
		benchmarkId: "terminal-bench",
		role: "evaluation",
		evalHarness: "selfpi",
		editablePack: "tool-code-v0",
		datasetPin: bench.datasetPin,
		tasks,
		heldIn,
		heldOut,
		verifier: TERMINAL_BENCH_VERIFIER,
		principles: Object.freeze({
			doNotRegressToFit: true,
			replacesToolCodeCorpus: false,
			selfPiHarnessOnly: true,
			promoteOnTbCompletionGain: true,
		}),
	});
}

/** Map a TB task ref into a SelfPi EvaluationTask using shell_reward grading. */
export function toSelfPiEvaluationTask(task: TerminalBenchTaskRef): EvaluationTask {
	const verifier: ShellRewardVerifier = Object.freeze({
		type: "shell_reward",
		testScript: TERMINAL_BENCH_VERIFIER.entrypoint,
		rewardDirectory: TERMINAL_BENCH_VERIFIER.selfPiRewardDirectory,
		rewardFileName: TERMINAL_BENCH_VERIFIER.selfPiRewardFileName,
	});
	return Object.freeze({
		id: task.taskId,
		verifier,
	});
}

export function terminalBenchWorkspaceTaskName(taskId: string): string {
	return shortTaskName(taskId);
}

/**
 * Parse reward.txt contents (`1` / `0`, optionally with trailing whitespace).
 */
export function parseTerminalBenchRewardText(
	taskId: string,
	rewardRaw: string | null | undefined,
): TerminalBenchTaskOutcome {
	if (rewardRaw === null || rewardRaw === undefined) {
		return Object.freeze({
			taskId,
			verifiedCompletion: false,
			reason: "reward_missing",
			rewardRaw: null,
		});
	}
	const trimmed = rewardRaw.trim();
	if (trimmed === "1") {
		return Object.freeze({
			taskId,
			verifiedCompletion: true,
			reason: "reward_pass",
			rewardRaw: trimmed,
		});
	}
	if (trimmed === "0") {
		return Object.freeze({
			taskId,
			verifiedCompletion: false,
			reason: "reward_fail",
			rewardRaw: trimmed,
		});
	}
	return Object.freeze({
		taskId,
		verifiedCompletion: false,
		reason: "reward_invalid",
		rewardRaw: trimmed,
	});
}

export function compareTerminalBenchAbOutcomes(input: {
	readonly baseline: readonly TerminalBenchTaskOutcome[];
	readonly candidate: readonly TerminalBenchTaskOutcome[];
}): TerminalBenchAbComparison {
	const candidateById = new Map(input.candidate.map((outcome) => [outcome.taskId, outcome]));
	const pairs: TerminalBenchAbTaskPair[] = [];
	for (const baseline of input.baseline) {
		const candidate = candidateById.get(baseline.taskId);
		if (candidate === undefined) {
			throw new Error(`Candidate Terminal-Bench outcome missing for task ${baseline.taskId}.`);
		}
		pairs.push(Object.freeze({ taskId: baseline.taskId, baseline, candidate }));
	}
	if (pairs.length !== input.candidate.length) {
		throw new Error("Baseline and candidate Terminal-Bench outcome task sets must match.");
	}
	const baselineCompletions = pairs.filter((pair) => pair.baseline.verifiedCompletion).length;
	const candidateCompletions = pairs.filter((pair) => pair.candidate.verifiedCompletion).length;
	return Object.freeze({
		taskCount: pairs.length,
		baselineCompletions,
		candidateCompletions,
		heldInCompletionGain: candidateCompletions - baselineCompletions,
		pairs: Object.freeze(pairs),
	});
}

export function renderTerminalBenchSelfPiEvalPlan(plan: TerminalBenchSelfPiEvalPlan): string {
	const lines = [
		`benchmarkId: ${plan.benchmarkId}`,
		`role: ${plan.role}`,
		`evalHarness: ${plan.evalHarness}`,
		`editablePack: ${plan.editablePack}`,
		`datasetPin: ${plan.datasetPin}`,
		`heldIn: ${plan.heldIn.map((task) => task.taskId).join(", ")}`,
		`heldOut: ${plan.heldOut.map((task) => task.taskId).join(", ") || "(none)"}`,
		`verifier: ${plan.verifier.entrypoint} -> workspace/${plan.verifier.selfPiRewardDirectory}/${plan.verifier.selfPiRewardFileName}`,
		`doNotRegressToFit: ${String(plan.principles.doNotRegressToFit)}`,
		`selfPiHarnessOnly: ${String(plan.principles.selfPiHarnessOnly)}`,
		`replacesToolCodeCorpus: ${String(plan.principles.replacesToolCodeCorpus)}`,
		`promoteOnTbCompletionGain: ${String(plan.principles.promoteOnTbCompletionGain)}`,
	];
	return `${lines.join("\n")}\n`;
}

/** @deprecated Use buildTerminalBenchSelfPiEvalPlan — Harbor is not the eval harness. */
export function buildTerminalBenchEvalPlan(input?: {
	readonly taskIds?: readonly string[];
	readonly model?: string;
	readonly agent?: string;
	readonly concurrent?: number;
}): TerminalBenchSelfPiEvalPlan {
	void input?.model;
	void input?.agent;
	void input?.concurrent;
	return buildTerminalBenchSelfPiEvalPlan({ taskIds: input?.taskIds });
}

/** @deprecated Use renderTerminalBenchSelfPiEvalPlan. */
export function renderTerminalBenchEvalPlan(plan: TerminalBenchSelfPiEvalPlan): string {
	return renderTerminalBenchSelfPiEvalPlan(plan);
}
