import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const executeFile = promisify(execFile);

describe("selfpi executable", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("inspects a run stored under the current repository's .selfpi directory", async () => {
		const repositoryDirectory = await mkdtemp(join(tmpdir(), "selfpi-cli-entry-"));
		temporaryDirectories.push(repositoryDirectory);
		const runDirectory = join(repositoryDirectory, ".selfpi/runs/run-001");
		await mkdir(runDirectory, { recursive: true });
		const records: Readonly<Record<string, unknown>> = {
			"manifest.json": { state: "promotion_recommended" },
			"candidate-proposal.json": {
				hypothesis: "Guide recovery after a failed read.",
				affectedEditableSurface: ["packages/selfpi-recovery-policy/src/index.ts"],
			},
			"review.json": { decision: "approve_for_evaluation", risks: [], violations: [] },
			"baseline-results.json": {
				result: { usage: { totalTokens: 100 }, verifier: { verifiedCompletion: false } },
			},
			"candidate-results.json": {
				result: { usage: { totalTokens: 120 }, verifier: { verifiedCompletion: true } },
			},
			"decision.json": {
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
		const entryPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

		const result = await executeFile(process.execPath, [entryPath, "inspect", "run-001"], {
			cwd: repositoryDirectory,
		});

		expect(result.stdout).toContain("Run: run-001");
		expect(result.stdout).toContain("Decision: promotion_recommended");
		expect(await readFile(join(runDirectory, "report.md"), "utf8")).toContain("# SelfPi run run-001");
	});
});
