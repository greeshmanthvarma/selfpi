import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CandidateImageBuilder,
	type CandidateSourceAdapter,
	createGitCandidateSourceAdapter,
	materializeCandidateVersion,
} from "../src/promotion/materialize-candidate-version.ts";

const executeFile = promisify(execFile);

const predecessorCommit = "a".repeat(40);
const sourceCommit = "b".repeat(40);
const predecessorImageDigest = `sha256:${"c".repeat(64)}`;
const imageDigest = `sha256:${"d".repeat(64)}`;
const unifiedDiff = [
	"diff --git a/packages/selfpi-recovery-policy/src/index.ts b/packages/selfpi-recovery-policy/src/index.ts",
	"--- a/packages/selfpi-recovery-policy/src/index.ts",
	"+++ b/packages/selfpi-recovery-policy/src/index.ts",
	"@@ -1 +1 @@",
	"-old",
	"+new",
	"",
].join("\n");

describe("candidate version materialization", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("materializes only a fully eligible candidate as an immutable source and image version", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-candidate-version-"));
		temporaryDirectories.push(rootDirectory);
		await writeRun(rootDirectory, "run-eligible", "promotion_recommended");
		await writeRun(rootDirectory, "run-rejected", "rejected");
		const sourceCalls: unknown[] = [];
		const releaseCalls: unknown[] = [];
		const buildCalls: unknown[] = [];
		const source: CandidateSourceAdapter = {
			async materialize(input) {
				sourceCalls.push(input);
				return Object.freeze({
					directory: path.join(rootDirectory, "candidate-worktree"),
					sourceCommit,
					candidateReference: input.candidateReference,
				});
			},
			async release(input) {
				releaseCalls.push(input);
			},
		};
		const image: CandidateImageBuilder = {
			async build(input) {
				buildCalls.push(input);
				return Object.freeze({ imageDigest, labels: input.labels });
			},
		};

		const result = await materializeCandidateVersion(
			{
				rootDirectory,
				runId: "run-eligible",
				now: () => new Date("2026-09-17T22:00:00.000Z"),
			},
			{ source, image },
		);

		expect(result).toEqual({
			materialized: true,
			version: {
				version: 1,
				runId: "run-eligible",
				sourceCommit,
				predecessorCommit,
				imageDigest,
				candidateReference: "refs/selfpi/candidates/run-eligible",
				createdAt: "2026-09-17T22:00:00.000Z",
				labels: {
					"org.opencontainers.image.revision": sourceCommit,
					"works.selfpi.predecessor": predecessorCommit,
					"works.selfpi.run": "run-eligible",
				},
			},
		});
		expect(sourceCalls).toEqual([
			{
				predecessorCommit,
				unifiedDiff,
				candidateReference: "refs/selfpi/candidates/run-eligible",
				commitMessage: "feat: materialize SelfPi candidate run-eligible",
				committedAt: "2026-09-17T22:00:00.000Z",
			},
		]);
		expect(buildCalls).toEqual([
			{
				contextDirectory: path.join(rootDirectory, "candidate-worktree"),
				sourceCommit,
				predecessorCommit,
				labels: {
					"org.opencontainers.image.revision": sourceCommit,
					"works.selfpi.predecessor": predecessorCommit,
					"works.selfpi.run": "run-eligible",
				},
			},
		]);
		expect(releaseCalls).toEqual([
			{
				candidate: {
					directory: path.join(rootDirectory, "candidate-worktree"),
					sourceCommit,
					candidateReference: "refs/selfpi/candidates/run-eligible",
				},
				retainReference: true,
			},
		]);
		expect(
			JSON.parse(await readFile(path.join(rootDirectory, "runs/run-eligible/candidate-version.json"), "utf8")),
		).toEqual((result as Extract<typeof result, { readonly materialized: true }>).version);

		expect(
			await materializeCandidateVersion(
				{
					rootDirectory,
					runId: "run-rejected",
					now: () => new Date("2026-09-17T22:00:00.000Z"),
				},
				{ source, image },
			),
		).toEqual({ materialized: false, reason: "not_recommended" });
		await expect(access(path.join(rootDirectory, "runs/run-rejected/candidate-version.json"))).rejects.toThrow();
		expect(sourceCalls).toHaveLength(1);
		expect(buildCalls).toHaveLength(1);
	});

	it("creates the candidate commit on its run-specific reference without advancing the active reference", async () => {
		const repositoryDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-candidate-source-"));
		temporaryDirectories.push(repositoryDirectory);
		await executeFile("git", ["init"], { cwd: repositoryDirectory });
		await writeFile(path.join(repositoryDirectory, "policy.txt"), "old\n", "utf8");
		await executeFile("git", ["add", "policy.txt"], { cwd: repositoryDirectory });
		await executeFile(
			"git",
			["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "baseline"],
			{ cwd: repositoryDirectory },
		);
		const predecessor = (await executeFile("git", ["rev-parse", "HEAD"], { cwd: repositoryDirectory })).stdout.trim();
		await executeFile("git", ["update-ref", "refs/selfpi/active", predecessor], { cwd: repositoryDirectory });
		const adapter = createGitCandidateSourceAdapter({
			repositoryDirectory,
			worktreeRoot: path.join(repositoryDirectory, ".selfpi-worktrees"),
		});

		const candidate = await adapter.materialize({
			predecessorCommit: predecessor,
			unifiedDiff: [
				"diff --git a/policy.txt b/policy.txt",
				"--- a/policy.txt",
				"+++ b/policy.txt",
				"@@ -1 +1 @@",
				"-old",
				"+new",
				"",
			].join("\n"),
			candidateReference: "refs/selfpi/candidates/run-source",
			commitMessage: "feat: materialize SelfPi candidate run-source",
			committedAt: "2026-09-17T22:00:00.000Z",
		});

		expect((await executeFile("git", ["rev-parse", "HEAD"], { cwd: candidate.directory })).stdout).toBe(
			`${candidate.sourceCommit}\n`,
		);
		expect(
			(await executeFile("git", ["rev-parse", "refs/selfpi/candidates/run-source"], { cwd: repositoryDirectory }))
				.stdout,
		).toBe(`${candidate.sourceCommit}\n`);
		expect(
			(await executeFile("git", ["rev-parse", `${candidate.sourceCommit}^`], { cwd: repositoryDirectory })).stdout,
		).toBe(`${predecessor}\n`);
		expect(
			(await executeFile("git", ["show", `${candidate.sourceCommit}:policy.txt`], { cwd: repositoryDirectory }))
				.stdout,
		).toBe("new\n");
		expect((await executeFile("git", ["rev-parse", "refs/selfpi/active"], { cwd: repositoryDirectory })).stdout).toBe(
			`${predecessor}\n`,
		);

		await adapter.release({ candidate, retainReference: true });
		expect(
			(await executeFile("git", ["rev-parse", "refs/selfpi/candidates/run-source"], { cwd: repositoryDirectory }))
				.stdout,
		).toBe(`${candidate.sourceCommit}\n`);
	});
});

async function writeRun(
	rootDirectory: string,
	runId: string,
	state: "promotion_recommended" | "rejected",
): Promise<void> {
	const runDirectory = path.join(rootDirectory, "runs", runId);
	await mkdir(runDirectory, { recursive: true });
	await Promise.all([
		writeFile(
			path.join(runDirectory, "manifest.json"),
			`${JSON.stringify({
				version: 1,
				runId,
				experimentId: "path-recovery-v0",
				state,
				createdAt: "2026-09-17T20:00:00.000Z",
				updatedAt: "2026-09-17T21:00:00.000Z",
			})}\n`,
			"utf8",
		),
		writeFile(
			path.join(runDirectory, "events.jsonl"),
			`${JSON.stringify({
				version: 1,
				sequence: 1,
				at: "2026-09-17T20:00:00.000Z",
				type: "run_created",
				state: "created",
			})}\n`,
			"utf8",
		),
		writeFile(
			path.join(runDirectory, "candidate-proposal.json"),
			`${JSON.stringify({
				version: 1,
				hypothesis: "The candidate fixes path recovery.",
				targetFailureSignature: "ENOENT",
				affectedEditableSurface: ["packages/selfpi-recovery-policy/src/index.ts"],
				unifiedDiff,
				expectedBehavioralMechanism: "Suggest an existing sibling path.",
				predictedBenefit: "Completes the failed read.",
				regressionRisks: ["May suggest the wrong sibling."],
				changedPaths: ["packages/selfpi-recovery-policy/src/index.ts"],
			})}\n`,
			"utf8",
		),
		writeFile(
			path.join(runDirectory, "proposal-provenance.json"),
			`${JSON.stringify({ activeHarnessCommit: predecessorCommit, worktreeBase: predecessorCommit })}\n`,
			"utf8",
		),
	]);
	const promotionDirectory = path.join(rootDirectory, "promotion");
	await mkdir(promotionDirectory, { recursive: true });
	await writeFile(
		path.join(promotionDirectory, "active.json"),
		`${JSON.stringify({
			version: 1,
			reference: "refs/selfpi/active",
			current: { sourceCommit: predecessorCommit, imageDigest: predecessorImageDigest },
		})}\n`,
		"utf8",
	);
}
