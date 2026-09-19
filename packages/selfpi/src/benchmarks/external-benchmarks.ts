/**
 * External open benchmarks adopted alongside SelfPi sealed corpora.
 * Terminal-Bench is the evaluation bar; tool-code-v0 stays the editable pack.
 */

export type ExternalBenchmarkId = "terminal-bench" | "recovery-bench";

export type ExternalBenchmarkRole = "evaluation" | "recovery_calibration";

export interface ExternalBenchmarkSmokePlan {
	readonly id: ExternalBenchmarkId;
	readonly displayName: string;
	readonly role: ExternalBenchmarkRole;
	readonly license: string;
	readonly upstream: string;
	readonly datasetPin: string;
	readonly harness: "harbor" | "recovery_bench";
	/** Cheap allowlist for local smoke; full suites stay upstream. Real TB task ids only. */
	readonly smokeTaskIds: readonly string[];
	readonly notes: string;
	/** How this relates to SelfPi tool-code improve (does not replace the editable pack). */
	readonly coexistence: string;
}

export const EXTERNAL_BENCHMARKS: readonly ExternalBenchmarkSmokePlan[] = Object.freeze([
	Object.freeze({
		id: "terminal-bench" as const,
		displayName: "Terminal-Bench 2.1",
		role: "evaluation" as const,
		license: "Apache-2.0",
		upstream: "https://github.com/harbor-framework/terminal-bench-2-1",
		datasetPin: "terminal-bench/terminal-bench-2-1",
		harness: "harbor" as const,
		smokeTaskIds: Object.freeze([
			"terminal-bench/sqlite-db-truncate",
			"terminal-bench/db-wal-recovery",
			"terminal-bench/large-scale-text-editing",
		] as const),
		notes: "Hard CLI tasks. SelfPi harness runs A/B; TB supplies instruction + tests/test.sh grading. Harbor is optional for task download/calibration only.",
		coexistence:
			"tool-code-v0 stays the editable pack. SelfPi remains the eval harness. Use Terminal-Bench task trees under SelfPi Docker A/B. Do not regress model or soften tasks to fit luna; do not treat tool-code-corpus-v1 as the learning bar.",
	}),
	Object.freeze({
		id: "recovery-bench" as const,
		displayName: "Recovery-Bench",
		role: "recovery_calibration" as const,
		license: "Apache-2.0",
		upstream: "https://github.com/letta-ai/recovery-bench",
		datasetPin: "terminal-bench@2.0 (via Recovery-Bench / Harbor)",
		harness: "recovery_bench" as const,
		smokeTaskIds: Object.freeze(["terminal-bench/sqlite-db-truncate"] as const),
		notes: "Optional recovery-after-failure calibration on TB trajectories. Prefer bundled initial traces (`git lfs pull`).",
		coexistence: "Secondary side channel. Do not replace SelfPi harness A/B or the tools-code editable pack.",
	}),
]);

export function listExternalBenchmarks(): readonly ExternalBenchmarkSmokePlan[] {
	return EXTERNAL_BENCHMARKS;
}

export function getExternalBenchmark(id: string): ExternalBenchmarkSmokePlan | undefined {
	return EXTERNAL_BENCHMARKS.find((bench) => bench.id === id);
}

export function buildHarborTerminalBenchArgs(input: {
	readonly datasetPin: string;
	readonly smokeTaskIds: readonly string[];
	readonly model?: string;
	readonly agent?: string;
	readonly concurrent?: number;
}): readonly string[] {
	const agent = input.agent ?? "terminus-2";
	const concurrent = input.concurrent ?? 1;
	const args = [
		"run",
		"--dataset",
		input.datasetPin,
		"--agent",
		agent,
		"--n-concurrent",
		String(concurrent),
		"--env",
		"docker",
		"--yes",
	];
	if (input.model !== undefined && input.model.length > 0) {
		args.push("--model", input.model);
	}
	for (const taskId of input.smokeTaskIds) {
		// Harbor 0.23+: include by task name (not --task-id).
		args.push("--include-task-name", taskId);
	}
	return Object.freeze(args);
}

export function buildRecoveryBenchArgs(input: {
	readonly smokeTaskIds: readonly string[];
	readonly resumeInitial?: string;
	readonly recoveryModel?: string;
	readonly recoveryAgent?: string;
	readonly messageMode?: "full" | "summary" | "none";
	readonly concurrent?: number;
}): readonly string[] {
	const args = ["-m", "recovery_bench.generate_traces", "--n-concurrent", String(input.concurrent ?? 1)];
	if (input.resumeInitial !== undefined && input.resumeInitial.length > 0) {
		args.push("--resume-initial", input.resumeInitial);
	}
	if (input.recoveryModel !== undefined && input.recoveryModel.length > 0) {
		args.push("--recovery-model", input.recoveryModel);
	}
	if (input.recoveryAgent !== undefined && input.recoveryAgent.length > 0) {
		args.push("--recovery-agent", input.recoveryAgent);
	}
	if (input.messageMode !== undefined) {
		args.push("--message-mode", input.messageMode);
	}
	for (const taskId of input.smokeTaskIds) {
		args.push("--task-id", taskId);
	}
	return Object.freeze(args);
}

export function renderExternalBenchmarkPlan(bench: ExternalBenchmarkSmokePlan): string {
	const lines = [
		`id: ${bench.id}`,
		`name: ${bench.displayName}`,
		`role: ${bench.role}`,
		`license: ${bench.license}`,
		`upstream: ${bench.upstream}`,
		`dataset: ${bench.datasetPin}`,
		`harness: ${bench.harness}`,
		`smokeTaskIds: ${bench.smokeTaskIds.join(", ")}`,
		`notes: ${bench.notes}`,
		`coexistence: ${bench.coexistence}`,
		"replacesToolCodeCorpus: false",
	];
	return `${lines.join("\n")}\n`;
}
