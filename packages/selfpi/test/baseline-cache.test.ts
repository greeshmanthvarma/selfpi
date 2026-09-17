import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBaselineCache } from "../src/index.ts";

describe("baseline cache", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("reuses only evidence with an identical evaluation fingerprint", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-baseline-cache-"));
		temporaryDirectories.push(rootDirectory);
		const cache = createBaselineCache({ rootDirectory });
		const inputs = {
			version: 1 as const,
			harness: { commit: "baseline-commit" },
			model: { provider: "fake", id: "deterministic-v1", parameters: { temperature: 0, seed: 7 } },
			task: { setVersion: "path-recovery-v0", repositoryCommit: "fixture-commit" },
			evaluator: { version: "evaluator-v1" },
			container: { imageDigest: "sha256:container-a" },
			budget: { timeoutMs: 5_000, toolCalls: 20, turns: 10, tokens: 50_000, costUsd: 2 },
			repetitions: 1,
		};
		let evidenceCreations = 0;
		const createEvidence = async () => {
			evidenceCreations += 1;
			return { version: 1 as const, baselineId: `baseline-${evidenceCreations}`, verifiedCompletions: 0 };
		};

		const first = await cache.getOrCreate(inputs, createEvidence);
		const reused = await createBaselineCache({ rootDirectory }).getOrCreate(
			{
				...inputs,
				model: { ...inputs.model, parameters: { seed: 7, temperature: 0 } },
			},
			createEvidence,
		);
		const changedInputs = [
			{ ...inputs, harness: { commit: "different-commit" } },
			{ ...inputs, model: { ...inputs.model, id: "different-model" } },
			{ ...inputs, task: { ...inputs.task, setVersion: "different-task-set" } },
			{ ...inputs, evaluator: { version: "different-evaluator" } },
			{ ...inputs, container: { imageDigest: "sha256:container-b" } },
			{ ...inputs, budget: { ...inputs.budget, turns: 11 } },
			{ ...inputs, repetitions: 3 },
		];
		const invalidated = [];
		for (const changed of changedInputs) {
			invalidated.push(await cache.getOrCreate(changed, createEvidence));
		}

		expect({
			firstSource: first.source,
			reusedSource: reused.source,
			reusedEvidence: reused.evidence,
			invalidatedSources: invalidated.map((entry) => entry.source),
			uniqueFingerprints: new Set([first.fingerprint, ...invalidated.map((entry) => entry.fingerprint)]).size,
			evidenceCreations,
		}).toEqual({
			firstSource: "created",
			reusedSource: "cache",
			reusedEvidence: { version: 1, baselineId: "baseline-1", verifiedCompletions: 0 },
			invalidatedSources: ["created", "created", "created", "created", "created", "created", "created"],
			uniqueFingerprints: 8,
			evidenceCreations: 8,
		});
	});
});
