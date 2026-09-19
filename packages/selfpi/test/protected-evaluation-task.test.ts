import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProtectedEvaluationTask } from "../src/evaluation/load-protected-evaluation-task.ts";
import { costUsdForUsage } from "../src/gateway/model-usage-cost.ts";

describe("protected evaluation task loader", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("loads a digest-pinned verifier outside candidate authority", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-verifier-"));
		temporaryDirectories.push(rootDirectory);
		const source = `${JSON.stringify({
			version: 1,
			id: "held-in-1",
			verifier: { type: "exact_file", path: "answer.txt", expectedContent: "ok\n" },
		})}\n`;
		const digest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
		await mkdir(path.join(rootDirectory, "protected-verifiers"), { recursive: true });
		await writeFile(path.join(rootDirectory, "protected-verifiers/held-in-verifier.json"), source, "utf8");

		await expect(
			loadProtectedEvaluationTask({
				rootDirectory,
				verifierId: "held-in-verifier",
				expectedDigest: digest,
				taskId: "held-in-1",
			}),
		).resolves.toEqual({
			digest,
			task: {
				id: "held-in-1",
				verifier: { type: "exact_file", path: "answer.txt", expectedContent: "ok\n" },
			},
		});
		await expect(
			loadProtectedEvaluationTask({
				rootDirectory,
				verifierId: "held-in-verifier",
				expectedDigest: `sha256:${"0".repeat(64)}`,
				taskId: "held-in-1",
			}),
		).rejects.toThrow("digest does not match");
	});
});

describe("model usage cost", () => {
	it("derives USD cost from token usage and configured pricing", () => {
		expect(
			costUsdForUsage(
				{ inputTokens: 1_000_000, outputTokens: 500_000 },
				{ inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 4 },
			),
		).toBe(4);
	});
});
