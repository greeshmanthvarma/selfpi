import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runSelfPiCli } from "../src/cli/run-selfpi-cli.ts";

const executeFile = promisify(execFile);

describe("selfpi improve", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("runs one causally evaluated deterministic cycle and persists every gate", async () => {
		const repositoryDirectory = fileURLToPath(new URL("../../..", import.meta.url));
		const selfPiDirectory = path.join(repositoryDirectory, ".selfpi");
		await mkdir(selfPiDirectory, { recursive: true });
		const rootDirectory = await mkdtemp(path.join(selfPiDirectory, "cli-test-"));
		temporaryDirectories.push(rootDirectory);
		await mkdir(path.join(rootDirectory, "experiments"), { recursive: true });
		await mkdir(path.join(rootDirectory, "promotion"), { recursive: true });
		const { stdout } = await executeFile("git", ["rev-parse", "HEAD"], { cwd: repositoryDirectory });
		const activeCommit = stdout.trim();
		await Promise.all([
			writeFile(
				path.join(rootDirectory, "experiments/path-recovery-v0.json"),
				`${JSON.stringify({
					version: 1,
					id: "path-recovery-v0",
					heldIn: ["path-recovery-held-in-01"],
					heldOut: ["path-recovery-held-out-01"],
					budget: { wallClockMs: 60_000, toolCalls: 20, turns: 10, tokens: 50_000, costUsd: 2 },
					editableSurface: ["packages/selfpi-recovery-policy/src/**"],
					protectedSurface: ["packages/selfpi/**", ".selfpi/**"],
					promotionPolicy: {
						minimumHeldInCompletionGain: 2,
						maximumHeldOutCompletionLoss: 0,
						requireRecoveryRateImprovement: true,
					},
				})}\n`,
				"utf8",
			),
			writeFile(
				path.join(rootDirectory, "runtime.json"),
				`${JSON.stringify({
					version: 1,
					mode: "deterministic_v0",
					proposer: {
						provider: "faux",
						model: "selfpi-proposer-v1",
						thinking: "off",
					},
					reviewer: {
						provider: "faux",
						model: "selfpi-reviewer-v1",
					},
					evaluation: {
						repetitions: 3,
					},
				})}\n`,
				"utf8",
			),
			writeFile(
				path.join(rootDirectory, "promotion/active.json"),
				`${JSON.stringify({
					version: 1,
					reference: "refs/selfpi/active",
					current: { sourceCommit: activeCommit, imageDigest: `sha256:${"c".repeat(64)}` },
				})}\n`,
				"utf8",
			),
		]);
		let terminal = "";

		const exitCode = await runSelfPiCli(["improve", "path-recovery-v0"], {
			rootDirectory,
			repositoryDirectory,
			write: (text) => {
				terminal += text;
			},
			now: () => new Date("2026-09-17T22:00:00.000Z"),
			createRunId: () => "run-deterministic-001",
			referenceAdapter: {
				read: async () => activeCommit,
				advance: async () => {
					throw new Error("Improve must not advance the active reference.");
				},
			},
		});

		const runDirectory = path.join(rootDirectory, "runs/run-deterministic-001");
		const diagnostic = await Promise.all(
			(await readdir(runDirectory)).map(async (name) => [
				name,
				await readFile(path.join(runDirectory, name), "utf8"),
			]),
		);
		expect(exitCode).toBe(0);
		expect(terminal, JSON.stringify(diagnostic)).toContain("Run run-deterministic-001: promotion_recommended");
		expect(terminal).toContain("deterministic engineering evidence");
		const names = [
			"manifest.json",
			"evidence-bundle.json",
			"candidate-proposal.json",
			"policy-result.json",
			"review.json",
			"smoke-result.json",
			"baseline-results.json",
			"candidate-results.json",
			"evaluation-attempts.json",
			"decision.json",
		];
		const records = await Promise.all(names.map((name) => readFile(path.join(runDirectory, name), "utf8")));
		expect(JSON.parse(records[0] ?? "{}")).toMatchObject({
			runId: "run-deterministic-001",
			state: "promotion_recommended",
			evidenceClass: "deterministic_engineering",
		});
		expect(JSON.parse(records.at(-1) ?? "{}")).toMatchObject({
			decision: "promotion_recommended",
			metrics: { heldInCompletionGain: 3, heldOutCompletionLoss: 0 },
		});
		expect(JSON.parse(records.at(-2) ?? "{}").attempts).toHaveLength(6);
		expect(
			await runSelfPiCli(["promote", "run-deterministic-001"], {
				rootDirectory,
				write: (text) => {
					terminal += text;
				},
				referenceAdapter: {
					read: async () => activeCommit,
					advance: async () => {
						throw new Error("Deterministic evidence must not advance the active reference.");
					},
				},
			}),
		).toBe(1);
		expect(terminal).toContain("deterministic engineering evidence and cannot be promoted");
	});
});
