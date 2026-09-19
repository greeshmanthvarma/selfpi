import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSupervisedRuntime } from "../src/config/load-supervised-runtime.ts";
import { loadProtectedEvaluationTask } from "../src/evaluation/load-protected-evaluation-task.ts";
import {
	installPathRecoveryCorpus,
	loadPathRecoveryCorpus,
	pathRecoveryCorpusRoot,
} from "../src/evaluation/path-recovery-corpus.ts";
import { materializeProtectedTaskFixture } from "../src/evaluation/protected-task-fixture-store.ts";
import { verifyEvaluationTask } from "../src/evaluation/verify-task.ts";
import type { Experiment } from "../src/experiments/load-experiment.ts";

const activeCommit = "a".repeat(40);
const activeImageDigest = `sha256:${"b".repeat(64)}`;
const containerImageDigest = `sha256:${"c".repeat(64)}`;

describe("protected path-recovery task corpus", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("registers eight held-in and twelve held-out immutable mock-repository tasks", async () => {
		const corpus = await loadPathRecoveryCorpus();
		expect(corpus.registryId).toBe("path-recovery-registry-v1");
		expect(corpus.heldIn.map((task) => task.id)).toEqual([
			"path-recovery-held-in-01",
			"path-recovery-held-in-02",
			"path-recovery-held-in-03",
			"path-recovery-held-in-04",
			"path-recovery-held-in-05",
			"path-recovery-held-in-06",
			"path-recovery-held-in-07",
			"path-recovery-held-in-08",
		]);
		expect(corpus.heldOut.map((task) => task.id)).toEqual([
			"path-recovery-held-out-01",
			"path-recovery-held-out-02",
			"path-recovery-held-out-03",
			"path-recovery-held-out-04",
			"path-recovery-held-out-05",
			"path-recovery-held-out-06",
			"path-recovery-held-out-07",
			"path-recovery-held-out-08",
			"path-recovery-held-out-09",
			"path-recovery-held-out-10",
			"path-recovery-held-out-11",
			"path-recovery-held-out-12",
		]);
		expect(corpus.heldIn.every((task) => task.perturbation !== undefined)).toBe(true);
		expect(corpus.heldOut.filter((task) => task.perturbation !== undefined).length).toBeGreaterThanOrEqual(4);
		expect(corpus.heldOut.filter((task) => task.perturbation === undefined).length).toBeGreaterThanOrEqual(4);

		const repositoryLayouts = new Set(
			[...corpus.heldIn, ...corpus.heldOut].map((task) => task.repository.url.replace(/.*\//, "")),
		);
		expect(repositoryLayouts.size).toBe(20);

		const artifactPaths = new Set<string>();
		const expectedContents = new Set<string>();
		for (const task of [...corpus.heldIn, ...corpus.heldOut]) {
			const loaded = await loadProtectedEvaluationTask({
				rootDirectory: pathRecoveryCorpusRoot(),
				verifierId: task.verifier.id,
				expectedDigest: task.verifier.digest,
				taskId: task.id,
			});
			expect(loaded.digest).toBe(task.verifier.digest);
			expect(loaded.task.verifier.type).toBe("exact_file");
			if (loaded.task.verifier.type !== "exact_file") throw new Error("expected exact_file verifier");
			artifactPaths.add(loaded.task.verifier.path);
			expectedContents.add(loaded.task.verifier.expectedContent);
		}
		expect(artifactPaths.size).toBeGreaterThan(1);
		expect(expectedContents.size).toBe(20);
	});

	it("materializes every registered commit and keeps held-out definitions out of the proposer view", async () => {
		const corpus = await loadPathRecoveryCorpus();
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-corpus-runtime-"));
		temporaryDirectories.push(rootDirectory);
		const protectedRoot = path.join(rootDirectory, "task-fixtures");
		const installed = await installPathRecoveryCorpus(rootDirectory);
		expect(installed.digest).toBe(corpus.digest);

		for (const task of [...corpus.heldIn, ...corpus.heldOut]) {
			const fixture = await materializeProtectedTaskFixture({
				protectedRoot,
				registryId: corpus.registryId,
				task,
			});
			expect(fixture.commit).toBe(task.repository.commit);
			expect(fixture.taskId).toBe(task.id);
		}

		const experiment: Experiment = {
			version: 1,
			id: "path-recovery-v0",
			heldIn: corpus.heldIn.map((task) => task.id),
			heldOut: corpus.heldOut.map((task) => task.id),
			budget: {
				wallClockMs: 600_000,
				toolCalls: 40,
				turns: 20,
				tokens: 200_000,
				costUsd: 10,
			},
			editableSurface: ["packages/selfpi-recovery-policy/src/**"],
			protectedSurface: ["packages/selfpi/**", ".selfpi/**"],
			promotionPolicy: {
				minimumHeldInCompletionGain: 2,
				maximumHeldOutCompletionLoss: 0,
				requireRecoveryRateImprovement: true,
			},
		};
		await mkdir(path.join(rootDirectory, "promotion"), { recursive: true });
		await Promise.all([
			writeFile(
				path.join(rootDirectory, "runtime.json"),
				`${JSON.stringify(
					{
						version: 1,
						mode: "supervised_v0",
						proposer: { provider: "anthropic", model: "claude-proposer", thinking: "low" },
						reviewer: { provider: "openai", model: "reviewer-v1" },
						gateway: { identity: "selfpi-gateway-v1", endpoint: "http://model-gateway.internal/v1" },
						container: { imageDigest: containerImageDigest },
						evaluation: { repetitions: 3 },
						taskRegistry: { id: corpus.registryId, digest: corpus.digest },
					},
					null,
					2,
				)}\n`,
				"utf8",
			),
			writeFile(
				path.join(rootDirectory, "promotion/active.json"),
				`${JSON.stringify({
					version: 1,
					reference: "refs/selfpi/active",
					current: { sourceCommit: activeCommit, imageDigest: activeImageDigest },
				})}\n`,
				"utf8",
			),
		]);

		const result = await loadSupervisedRuntime({
			runtimePath: path.join(rootDirectory, "runtime.json"),
			activeVersionPath: path.join(rootDirectory, "promotion/active.json"),
			taskRegistryPath: path.join(rootDirectory, "task-registry.json"),
			experiment,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.runtime.taskRegistry.digest).toBe(corpus.digest);
		expect(result.proposerView.tasks.map((task) => task.id)).toEqual(corpus.heldIn.map((task) => task.id));
		const proposerJson = JSON.stringify(result.proposerView);
		expect(proposerJson).not.toContain("held-out");
		expect(proposerJson).not.toContain("perturbation");
		expect(proposerJson).not.toContain("ENOENT");
		for (const task of corpus.heldOut) {
			expect(proposerJson).not.toContain(task.id);
			expect(proposerJson).not.toContain(task.input);
		}
	});

	it("accepts a passing workspace and rejects a failing workspace for every task verifier", async () => {
		const corpus = await loadPathRecoveryCorpus();
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-corpus-verify-"));
		temporaryDirectories.push(rootDirectory);

		for (const task of [...corpus.heldIn, ...corpus.heldOut]) {
			const loaded = await loadProtectedEvaluationTask({
				rootDirectory: pathRecoveryCorpusRoot(),
				verifierId: task.verifier.id,
				expectedDigest: task.verifier.digest,
				taskId: task.id,
			});
			const passDirectory = path.join(rootDirectory, task.id, "pass");
			const failDirectory = path.join(rootDirectory, task.id, "fail");
			expect(loaded.task.verifier.type).toBe("exact_file");
			if (loaded.task.verifier.type !== "exact_file") throw new Error("expected exact_file verifier");
			await mkdir(path.dirname(path.join(passDirectory, loaded.task.verifier.path)), { recursive: true });
			await mkdir(failDirectory, { recursive: true });
			await writeFile(
				path.join(passDirectory, loaded.task.verifier.path),
				loaded.task.verifier.expectedContent,
				"utf8",
			);
			await writeFile(
				path.join(failDirectory, loaded.task.verifier.path),
				`wrong-${createHash("sha256").update(task.id).digest("hex").slice(0, 8)}\n`,
				"utf8",
			);

			await expect(verifyEvaluationTask(loaded.task, passDirectory)).resolves.toEqual({
				taskId: task.id,
				verifiedCompletion: true,
				reason: "verified",
			});
			await expect(verifyEvaluationTask(loaded.task, failDirectory)).resolves.toEqual({
				taskId: task.id,
				verifiedCompletion: false,
				reason: "artifact_mismatch",
			});
		}
	});

	it("does not dump held-out task inputs into the installed registry metadata digest helper", async () => {
		const corpus = await loadPathRecoveryCorpus();
		const metadata = await readFile(path.join(pathRecoveryCorpusRoot(), "task-registry.metadata.json"), "utf8");
		expect(metadata).toContain('"heldInTaskCount": 8');
		expect(metadata).toContain('"heldOutTaskCount": 12');
		expect(metadata).toContain(corpus.digest);
		for (const task of corpus.heldOut) {
			expect(metadata).not.toContain(task.input);
			expect(metadata).not.toContain(task.id);
		}
	});
});
