import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSelfPiCli } from "../src/index.ts";

describe("selfpi inspect", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("reports a complete persisted run and writes the same redacted report", async () => {
		const rootDirectory = await mkdtemp(join(tmpdir(), "selfpi-inspect-"));
		temporaryDirectories.push(rootDirectory);
		const runDirectory = join(rootDirectory, "runs/run-001");
		await mkdir(runDirectory, { recursive: true });
		const records: Readonly<Record<string, unknown>> = {
			"manifest.json": {
				version: 1,
				runId: "run-001",
				experimentId: "path-recovery-v0",
				state: "promotion_recommended",
			},
			"candidate-proposal.json": {
				version: 1,
				hypothesis: "Use search guidance with secret sk-supersecret123",
				affectedEditableSurface: ["packages/selfpi-recovery-policy/src/index.ts"],
			},
			"review.json": {
				version: 1,
				decision: "approve_for_evaluation",
				risks: ["Guidance may distract the model."],
				violations: [],
			},
			"baseline-results.json": {
				fingerprintInputs: { harnessCommit: "baseline" },
				result: { usage: { totalTokens: 100 }, verifier: { verifiedCompletion: false } },
			},
			"candidate-results.json": {
				fingerprintInputs: { harnessCommit: "candidate" },
				result: { usage: { totalTokens: 120 }, verifier: { verifiedCompletion: true } },
			},
			"decision.json": {
				version: 1,
				decision: "promotion_recommended",
				metrics: {
					outcomes: {
						baselineHeldInCompletions: 3,
						candidateHeldInCompletions: 5,
						baselineRecoveryRate: 0.25,
						candidateRecoveryRate: 0.5,
					},
					efficiency: {
						baselineTokens: 100,
						candidateTokens: 120,
						baselineCostUsd: 0.1,
						candidateCostUsd: 0.12,
					},
				},
			},
		};
		await Promise.all(
			Object.entries(records).map(([name, value]) =>
				writeFile(join(runDirectory, name), `${JSON.stringify(value)}\n`, "utf8"),
			),
		);
		let terminal = "";

		const exitCode = await runSelfPiCli(["inspect", "run-001"], {
			rootDirectory,
			write: (text) => {
				terminal += text;
			},
		});
		const report = await readFile(join(runDirectory, "report.md"), "utf8");

		expect(exitCode).toBe(0);
		expect(terminal).toContain("State: promotion_recommended");
		expect(terminal).toContain("Changed surface: packages/selfpi-recovery-policy/src/index.ts");
		expect(terminal).toContain("Review: approve_for_evaluation");
		expect(terminal).toContain("Baseline: 3 completions, 100 tokens, $0.10");
		expect(terminal).toContain("Candidate: 5 completions, 120 tokens, $0.12");
		expect(terminal).toContain("Decision: promotion_recommended");
		expect(terminal).toContain("[REDACTED]");
		expect(report).toContain("# SelfPi run run-001");
		expect(report).toContain("promotion_recommended");
		expect(report).toContain("[REDACTED]");
		expect(`${terminal}${report}`).not.toContain("sk-supersecret123");
	});
});
