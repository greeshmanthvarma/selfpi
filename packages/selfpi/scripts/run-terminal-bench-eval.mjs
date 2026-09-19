#!/usr/bin/env node
/**
 * Plan Terminal-Bench tasks for SelfPi evaluation.
 * SelfPi is the harness; TB supplies tasks + tests/test.sh grading.
 * Harbor is optional for downloading tasks / external calibration only.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getExternalBenchmark } from "../src/benchmarks/external-benchmarks.ts";
import {
	buildTerminalBenchSelfPiEvalPlan,
	renderTerminalBenchSelfPiEvalPlan,
	toSelfPiEvaluationTask,
} from "../src/benchmarks/terminal-bench-task-adapter.ts";

path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function usage() {
	return [
		"Usage:",
		"  node packages/selfpi/scripts/run-terminal-bench-eval.mjs plan",
		"",
		"Prints the SelfPi-harness Terminal-Bench smoke plan (held-in/out + shell_reward verifier).",
		"Does not invoke Harbor as an eval harness — SelfPi A/B remains the improve-loop evaluator.",
	].join("\n");
}

async function main() {
	const command = process.argv[2] ?? "plan";
	if (command !== "plan") {
		throw new Error(usage());
	}
	const bench = getExternalBenchmark("terminal-bench");
	if (bench === undefined) {
		throw new Error("terminal-bench registry entry missing.");
	}
	const plan = buildTerminalBenchSelfPiEvalPlan();
	process.stdout.write(renderTerminalBenchSelfPiEvalPlan(plan));
	process.stdout.write("\nSelfPi evaluation tasks (shell_reward):\n");
	for (const task of plan.tasks) {
		const evaluationTask = toSelfPiEvaluationTask(task);
		process.stdout.write(
			`- ${evaluationTask.id}: ${evaluationTask.verifier.type} ${evaluationTask.verifier.testScript} -> ${evaluationTask.verifier.rewardDirectory}/${evaluationTask.verifier.rewardFileName ?? "reward.txt"}\n`,
		);
	}
}

await main();
