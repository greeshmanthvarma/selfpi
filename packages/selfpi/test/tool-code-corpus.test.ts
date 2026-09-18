import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSupervisedRuntime } from "../src/config/load-supervised-runtime.ts";
import { loadProtectedEvaluationTask } from "../src/evaluation/load-protected-evaluation-task.ts";
import { materializeProtectedTaskFixture } from "../src/evaluation/protected-task-fixture-store.ts";
import { installToolCodeCorpus, loadToolCodeCorpus, toolCodeCorpusRoot } from "../src/evaluation/tool-code-corpus.ts";
import { verifyEvaluationTask } from "../src/evaluation/verify-task.ts";
import { createToolCodePackV1Experiment } from "../src/packs/tool-code-pack-v1.ts";

const activeCommit = "a".repeat(40);
const activeImageDigest = `sha256:${"b".repeat(64)}`;
const containerImageDigest = `sha256:${"c".repeat(64)}`;

describe("protected tool-code task corpus", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("registers four held-in and four held-out tasks without path bait", async () => {
		const corpus = await loadToolCodeCorpus();
		expect(corpus.registryId).toBe("tool-code-registry-v1");
		expect(corpus.heldIn.map((task) => task.id)).toEqual([
			"tool-code-held-in-01",
			"tool-code-held-in-02",
			"tool-code-held-in-03",
			"tool-code-held-in-04",
		]);
		expect(corpus.heldOut.map((task) => task.id)).toEqual([
			"tool-code-held-out-01",
			"tool-code-held-out-02",
			"tool-code-held-out-03",
			"tool-code-held-out-04",
		]);
		expect([...corpus.heldIn, ...corpus.heldOut].every((task) => task.perturbation === undefined)).toBe(true);
		expect(Object.keys(corpus.failureCatalog).sort()).toEqual(corpus.heldIn.map((task) => task.id));
		expect(corpus.failureCatalog["tool-code-held-in-02"]?.toolName).toBe("bash");
		expect(corpus.failureCatalog["tool-code-held-in-04"]?.toolName).toBe("edit");

		for (const task of [...corpus.heldIn, ...corpus.heldOut]) {
			const loaded = await loadProtectedEvaluationTask({
				rootDirectory: toolCodeCorpusRoot(),
				verifierId: task.verifier.id,
				expectedDigest: task.verifier.digest,
				taskId: task.id,
			});
			expect(loaded.digest).toBe(task.verifier.digest);
		}
	});

	it("materializes commits and keeps held-out inputs out of the proposer view", async () => {
		const corpus = await loadToolCodeCorpus();
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-tool-code-corpus-"));
		temporaryDirectories.push(rootDirectory);
		const protectedRoot = path.join(rootDirectory, "task-fixtures");
		const installed = await installToolCodeCorpus(rootDirectory);
		expect(installed.digest).toBe(corpus.digest);

		for (const task of [...corpus.heldIn, ...corpus.heldOut]) {
			const fixture = await materializeProtectedTaskFixture({
				protectedRoot,
				registryId: corpus.registryId,
				task,
			});
			expect(fixture.commit).toBe(task.repository.commit);
		}

		const experiment = createToolCodePackV1Experiment();
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
						evaluation: { repetitions: 1 },
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
		expect(result.proposerView.tasks.map((task) => task.id)).toEqual(corpus.heldIn.map((task) => task.id));
		const proposerJson = JSON.stringify(result.proposerView);
		expect(proposerJson).not.toContain("perturbation");
		for (const task of corpus.heldOut) {
			expect(proposerJson).not.toContain(task.id);
			expect(proposerJson).not.toContain(task.input);
		}
	});

	it("accepts a passing workspace and rejects a failing workspace for every verifier", async () => {
		const corpus = await loadToolCodeCorpus();
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-tool-code-verify-"));
		temporaryDirectories.push(rootDirectory);

		for (const task of [...corpus.heldIn, ...corpus.heldOut]) {
			const loaded = await loadProtectedEvaluationTask({
				rootDirectory: toolCodeCorpusRoot(),
				verifierId: task.verifier.id,
				expectedDigest: task.verifier.digest,
				taskId: task.id,
			});
			const passDirectory = path.join(rootDirectory, task.id, "pass");
			const failDirectory = path.join(rootDirectory, task.id, "fail");
			await mkdir(path.dirname(path.join(passDirectory, loaded.task.verifier.path)), { recursive: true });
			await mkdir(path.dirname(path.join(failDirectory, loaded.task.verifier.path)), { recursive: true });
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

	it("keeps held-out task inputs out of registry metadata", async () => {
		const corpus = await loadToolCodeCorpus();
		const metadata = await readFile(path.join(toolCodeCorpusRoot(), "task-registry.metadata.json"), "utf8");
		expect(metadata).toContain('"heldInTaskCount": 4');
		expect(metadata).toContain('"heldOutTaskCount": 4');
		expect(metadata).toContain(corpus.digest);
		for (const task of corpus.heldOut) {
			expect(metadata).not.toContain(task.input);
			expect(metadata).not.toContain(task.id);
		}
	});
});
