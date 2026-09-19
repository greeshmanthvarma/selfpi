import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProtectedEvaluationTask } from "../src/evaluation/load-protected-evaluation-task.ts";
import {
	installTerminalBenchSmokeVerifiers,
	loadTerminalBenchSmokeCorpus,
} from "../src/evaluation/terminal-bench-smoke-corpus.ts";

describe("terminal-bench smoke corpus", () => {
	it("loads shell_reward tasks with SelfPi-safe ids", async () => {
		const corpus = await loadTerminalBenchSmokeCorpus();
		expect(corpus.registryId).toBe("terminal-bench-smoke-registry-v1");
		expect(corpus.heldIn.map((task) => task.id)).toEqual(["sqlite-db-truncate", "db-wal-recovery"]);
		expect(corpus.heldOut.map((task) => task.id)).toEqual(["large-scale-text-editing"]);
		expect(corpus.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		for (const task of [...corpus.heldIn, ...corpus.heldOut]) {
			expect(task.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
			expect(task.repository.url).toContain("selfpi-corpus:terminal-bench-smoke-v1/");
			expect(task.repository.commit).toMatch(/^[0-9a-f]{40}$/);
		}
	});

	it("installs verifiers without replacing the tool-code task registry", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-tb-smoke-"));
		const priorRegistry = `${JSON.stringify({ version: 1, id: "tool-code-registry-v1", tasks: [] }, null, "\t")}\n`;
		await mkdir(path.join(rootDirectory, "protected-verifiers"), { recursive: true });
		await writeFile(path.join(rootDirectory, "task-registry.json"), priorRegistry, "utf8");
		const corpus = await installTerminalBenchSmokeVerifiers(rootDirectory);
		expect(await readFile(path.join(rootDirectory, "task-registry.json"), "utf8")).toBe(priorRegistry);
		const loaded = await loadProtectedEvaluationTask({
			rootDirectory,
			verifierId: corpus.heldIn[0]!.verifier.id,
			expectedDigest: corpus.heldIn[0]!.verifier.digest,
			taskId: corpus.heldIn[0]!.id,
		});
		expect(loaded.task.verifier.type).toBe("shell_reward");
	});
});
