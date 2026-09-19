import { describe, expect, it } from "vitest";
import {
	buildHarborTerminalBenchArgs,
	buildRecoveryBenchArgs,
	getExternalBenchmark,
	listExternalBenchmarks,
	renderExternalBenchmarkPlan,
} from "../src/benchmarks/external-benchmarks.ts";
import {
	buildTerminalBenchSelfPiEvalPlan,
	compareTerminalBenchAbOutcomes,
	listTerminalBenchSmokeTaskRefs,
	parseTerminalBenchRewardText,
	renderTerminalBenchSelfPiEvalPlan,
	TERMINAL_BENCH_VERIFIER,
	toSelfPiEvaluationTask,
} from "../src/benchmarks/terminal-bench-task-adapter.ts";

describe("external benchmarks registry", () => {
	it("lists Terminal-Bench and Recovery-Bench with SelfPi as eval harness", () => {
		const benches = listExternalBenchmarks();
		expect(benches.map((bench) => bench.id)).toEqual(["terminal-bench", "recovery-bench"]);
		const terminal = getExternalBenchmark("terminal-bench");
		expect(terminal?.role).toBe("evaluation");
		expect(terminal?.notes.toLowerCase()).toContain("selfpi");
		expect(terminal?.coexistence.toLowerCase()).toContain("selfpi remains the eval harness");
		expect(terminal?.smokeTaskIds).toEqual(["sqlite-db-truncate", "db-wal-recovery", "large-scale-text-editing"]);
		for (const bench of benches) {
			expect(bench.license).toBe("Apache-2.0");
			expect(renderExternalBenchmarkPlan(bench)).toContain("replacesToolCodeCorpus: false");
		}
	});

	it("builds harbor and recovery-bench smoke arg lists for optional calibration only", () => {
		const terminal = getExternalBenchmark("terminal-bench");
		expect(terminal).toBeDefined();
		if (terminal === undefined) return;
		expect(buildHarborTerminalBenchArgs(terminal)).toEqual([
			"run",
			"--dataset",
			"terminal-bench/terminal-bench-2-1",
			"--agent",
			"terminus-2",
			"--n-concurrent",
			"1",
			"--env",
			"docker",
			"--yes",
			"--include-task-name",
			"terminal-bench/sqlite-db-truncate",
			"--include-task-name",
			"terminal-bench/db-wal-recovery",
			"--include-task-name",
			"terminal-bench/large-scale-text-editing",
		]);

		const recovery = getExternalBenchmark("recovery-bench");
		expect(recovery).toBeDefined();
		if (recovery === undefined) return;
		expect(
			buildRecoveryBenchArgs({
				smokeTaskIds: recovery.smokeTaskIds,
				resumeInitial: "runs/initial-example",
				recoveryModel: "openai/gpt-5.6-luna",
			}),
		).toEqual([
			"-m",
			"recovery_bench.generate_traces",
			"--n-concurrent",
			"1",
			"--resume-initial",
			"runs/initial-example",
			"--recovery-model",
			"openai/gpt-5.6-luna",
			"--task-id",
			"terminal-bench/sqlite-db-truncate",
		]);
	});
});

describe("terminal-bench SelfPi task adapter", () => {
	it("maps smoke tasks to SelfPi shell_reward evaluation tasks", () => {
		const refs = listTerminalBenchSmokeTaskRefs();
		expect(refs.map((task) => task.taskId)).toEqual([
			"sqlite-db-truncate",
			"db-wal-recovery",
			"large-scale-text-editing",
		]);
		expect(refs.every((task) => task.verifier === TERMINAL_BENCH_VERIFIER)).toBe(true);

		const plan = buildTerminalBenchSelfPiEvalPlan();
		expect(plan.evalHarness).toBe("selfpi");
		expect(plan.editablePack).toBe("tool-code-v0");
		expect(plan.principles.selfPiHarnessOnly).toBe(true);
		expect(plan.principles.doNotRegressToFit).toBe(true);
		expect(plan.heldIn.map((task) => task.taskId)).toEqual(["sqlite-db-truncate", "db-wal-recovery"]);
		expect(plan.heldOut.map((task) => task.taskId)).toEqual(["large-scale-text-editing"]);
		expect(renderTerminalBenchSelfPiEvalPlan(plan)).toContain("evalHarness: selfpi");

		const evaluationTask = toSelfPiEvaluationTask(plan.heldIn[0]!);
		expect(evaluationTask).toEqual({
			id: "sqlite-db-truncate",
			verifier: {
				type: "shell_reward",
				testScript: "tests/test.sh",
				rewardDirectory: "logs/verifier",
				rewardFileName: "reward.txt",
			},
		});
	});

	it("parses reward.txt and compares baseline vs candidate gain", () => {
		expect(parseTerminalBenchRewardText("t1", "1\n")).toMatchObject({
			verifiedCompletion: true,
			reason: "reward_pass",
		});
		expect(parseTerminalBenchRewardText("t1", "0")).toMatchObject({
			verifiedCompletion: false,
			reason: "reward_fail",
		});
		expect(parseTerminalBenchRewardText("t1", null)).toMatchObject({
			verifiedCompletion: false,
			reason: "reward_missing",
		});

		const comparison = compareTerminalBenchAbOutcomes({
			baseline: [
				parseTerminalBenchRewardText("sqlite-db-truncate", "0"),
				parseTerminalBenchRewardText("db-wal-recovery", "0"),
			],
			candidate: [
				parseTerminalBenchRewardText("sqlite-db-truncate", "1"),
				parseTerminalBenchRewardText("db-wal-recovery", "0"),
			],
		});
		expect(comparison.baselineCompletions).toBe(0);
		expect(comparison.candidateCompletions).toBe(1);
		expect(comparison.heldInCompletionGain).toBe(1);
	});
});
