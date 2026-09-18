import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runSelfPiCli } from "../src/cli/run-selfpi-cli.ts";
import { createFakeModelGatewayUpstream } from "../src/gateway/fake-model-gateway-upstream.ts";

const executeFile = promisify(execFile);
const activeImageDigest = `sha256:${"a".repeat(64)}`;
const containerDigest = `sha256:${"c".repeat(64)}`;
const answer = "Configuration file: src/settings.ts\n";

async function createMockRepository(rootDirectory: string, name: string): Promise<{ path: string; commit: string }> {
	const repositoryDirectory = path.join(rootDirectory, name);
	await mkdir(path.join(repositoryDirectory, "src"), { recursive: true });
	await writeFile(path.join(repositoryDirectory, "src/settings.ts"), `export const fixture = "${name}";\n`, "utf8");
	await executeFile("git", ["init", "--quiet"], { cwd: repositoryDirectory });
	await executeFile("git", ["add", "src/settings.ts"], { cwd: repositoryDirectory });
	await executeFile(
		"git",
		[
			"-c",
			"user.name=SelfPi Fixture",
			"-c",
			"user.email=selfpi-fixture@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"fixture",
		],
		{ cwd: repositoryDirectory },
	);
	const commit = (await executeFile("git", ["rev-parse", "HEAD"], { cwd: repositoryDirectory })).stdout.trim();
	return { path: repositoryDirectory, commit };
}

async function writeVerifier(rootDirectory: string, id: string, taskId: string): Promise<string> {
	const source = `${JSON.stringify({
		version: 1,
		id: taskId,
		verifier: { type: "exact_file", path: "answer.txt", expectedContent: answer },
	})}\n`;
	const digest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
	await mkdir(path.join(rootDirectory, "protected-verifiers"), { recursive: true });
	await writeFile(path.join(rootDirectory, "protected-verifiers", `${id}.json`), source, "utf8");
	return digest;
}

describe("supervised selfpi improve with production seams", () => {
	const temporaryDirectories: string[] = [];
	const candidateReferences: Array<{ readonly repositoryDirectory: string; readonly reference: string }> = [];
	afterEach(async () => {
		await Promise.all(
			candidateReferences.splice(0).map(async ({ repositoryDirectory, reference }) => {
				await executeFile("git", ["update-ref", "-d", reference], { cwd: repositoryDirectory }).catch(
					() => undefined,
				);
			}),
		);
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("runs one real-adapter supervised cycle through the public CLI with fake upstream and fake Docker", async () => {
		const repositoryDirectory = fileURLToPath(new URL("../../..", import.meta.url));
		const selfPiDirectory = path.join(repositoryDirectory, ".selfpi");
		await mkdir(selfPiDirectory, { recursive: true });
		const rootDirectory = await mkdtemp(path.join(selfPiDirectory, "supervised-cli-"));
		temporaryDirectories.push(rootDirectory);
		const runId = `run-seams-${randomUUID().slice(0, 8)}`;
		candidateReferences.push({
			repositoryDirectory,
			reference: `refs/selfpi/candidates/${runId}`,
		});
		const fixtureRoot = await mkdtemp(path.join(rootDirectory, "fixture-sources-"));
		const heldInRepository = await createMockRepository(fixtureRoot, "held-in-source");
		const heldOutRepository = await createMockRepository(fixtureRoot, "held-out-source");
		const heldInVerifierDigest = await writeVerifier(rootDirectory, "held-in-verifier", "held-in-1");
		const heldOutVerifierDigest = await writeVerifier(rootDirectory, "held-out-verifier", "held-out-1");
		const registry = {
			version: 1,
			id: "registry-v1",
			tasks: [
				{
					id: "held-in-1",
					set: "held_in",
					repository: { url: heldInRepository.path, commit: heldInRepository.commit },
					input: "Recover the missing path.",
					verifier: { id: "held-in-verifier", digest: heldInVerifierDigest },
					perturbation: { version: 1, path: "src/config.ts", error: "ENOENT src/config.ts" },
				},
				{
					id: "held-out-1",
					set: "held_out",
					repository: { url: heldOutRepository.path, commit: heldOutRepository.commit },
					input: "Complete the sealed task.",
					verifier: { id: "held-out-verifier", digest: heldOutVerifierDigest },
				},
			],
		};
		const registrySource = `${JSON.stringify(registry, null, 2)}\n`;
		const registryDigest = `sha256:${createHash("sha256").update(registrySource).digest("hex")}`;
		const { stdout: activeCommit } = await executeFile("git", ["rev-parse", "HEAD"], {
			cwd: repositoryDirectory,
		});
		const trimmedActiveCommit = activeCommit.trim();
		await mkdir(path.join(rootDirectory, "experiments"), { recursive: true });
		await mkdir(path.join(rootDirectory, "promotion"), { recursive: true });
		await Promise.all([
			writeFile(
				path.join(rootDirectory, "experiments/path-recovery-v0.json"),
				`${JSON.stringify({
					version: 1,
					id: "path-recovery-v0",
					heldIn: ["held-in-1"],
					heldOut: ["held-out-1"],
					budget: { wallClockMs: 600_000, toolCalls: 40, turns: 20, tokens: 100_000, costUsd: 5 },
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
					mode: "supervised_v0",
					proposer: { provider: "fake-provider", model: "proposer-model", thinking: "low" },
					reviewer: { provider: "independent-provider", model: "reviewer-model" },
					gateway: { identity: "gateway-v1", endpoint: "http://model-gateway.internal/v1" },
					container: { imageDigest: containerDigest },
					evaluation: { repetitions: 2 },
					taskRegistry: { id: registry.id, digest: registryDigest },
				})}\n`,
				"utf8",
			),
			writeFile(path.join(rootDirectory, "task-registry.json"), registrySource, "utf8"),
			writeFile(
				path.join(rootDirectory, "promotion/active.json"),
				`${JSON.stringify({
					version: 1,
					reference: "refs/selfpi/active",
					current: { sourceCommit: trimmedActiveCommit, imageDigest: activeImageDigest },
				})}\n`,
				"utf8",
			),
		]);

		const fakeDocker = fileURLToPath(new URL("./fixtures/harness/fake-supervised-docker.mjs", import.meta.url));
		const dockerStatePath = path.join(rootDirectory, "fake-docker-state.json");
		await writeFile(dockerStatePath, `${JSON.stringify({ labelsByDigest: {}, calls: [] })}\n`, "utf8");
		let terminal = "";
		const exitCode = await runSelfPiCli(["improve", "path-recovery-v0"], {
			rootDirectory,
			repositoryDirectory,
			write: (text) => {
				terminal += text;
			},
			now: () => new Date("2026-09-18T03:00:00.000Z"),
			createRunId: () => runId,
			referenceAdapter: {
				read: async () => trimmedActiveCommit,
				advance: async () => {
					throw new Error("Improve must not advance the active reference.");
				},
			},
			supervisedSeams: {
				dockerCommand: process.execPath,
				dockerBaseArgs: [fakeDocker],
				providerCredentials: {
					"fake-provider": "provider-secret",
					"independent-provider": "reviewer-secret",
				},
				upstream: createFakeModelGatewayUpstream(),
				pricing: {
					"*": { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
				},
				hostEnvironment: {
					PATH: process.env.PATH ?? "",
					SELFPI_FAKE_DOCKER_STATE: dockerStatePath,
				},
			},
		});

		const runDirectory = path.join(rootDirectory, "runs", runId);
		const diagnostic = await Promise.all(
			(await readdir(runDirectory).catch(() => [])).map(async (name) => [
				name,
				await readFile(path.join(runDirectory, name), "utf8").catch(() => "<missing>"),
			]),
		);
		expect(exitCode, JSON.stringify(diagnostic)).toBe(0);
		expect(terminal, JSON.stringify(diagnostic)).toContain(
			`Run ${runId}: promotion_recommended (supervised real evidence)`,
		);
		expect(JSON.parse(await readFile(path.join(runDirectory, "manifest.json"), "utf8"))).toMatchObject({
			state: "promotion_recommended",
			evidenceClass: "supervised_real",
		});
		expect(JSON.parse(await readFile(path.join(runDirectory, "candidate-version.json"), "utf8"))).toMatchObject({
			runId,
			predecessorCommit: trimmedActiveCommit,
			imageDigest: `sha256:${"b".repeat(64)}`,
		});
		expect(
			JSON.parse(await readFile(path.join(runDirectory, "evaluation-attempts.json"), "utf8")).attempts,
		).toHaveLength(4);
		const dockerState = JSON.parse(await readFile(dockerStatePath, "utf8")) as {
			calls: string[][];
		};
		expect(dockerState.calls.some((call) => call.includes("--internal"))).toBe(true);
		expect(dockerState.calls.some((call) => call.includes(`selfpi-gw-${runId}`))).toBe(true);
		expect(dockerState.calls.every((call) => !call.includes("--network") || !call.includes("host"))).toBe(true);

		terminal = "";
		expect(
			await runSelfPiCli(["inspect", runId], {
				rootDirectory,
				write: (text) => {
					terminal += text;
				},
			}),
		).toBe(0);
		expect(terminal).toContain("Gateway: gateway-v1");
		expect(terminal).toContain("Evidence class: supervised_real");
		expect(terminal).toContain(`Task registry: ${registryDigest}`);
		expect(terminal).toContain("Candidate version:");
	}, 60_000);
});
