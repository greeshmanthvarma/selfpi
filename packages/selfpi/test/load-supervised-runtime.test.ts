import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSupervisedRuntime } from "../src/config/load-supervised-runtime.ts";
import type { Experiment } from "../src/experiments/load-experiment.ts";

const activeCommit = "a".repeat(40);
const activeImageDigest = `sha256:${"b".repeat(64)}`;
const containerImageDigest = `sha256:${"c".repeat(64)}`;
const repositoryCommit = "d".repeat(40);
const verifierDigest = `sha256:${"e".repeat(64)}`;

const experiment: Experiment = {
	version: 1,
	id: "path-recovery-v0",
	heldIn: ["held-in-1"],
	heldOut: ["held-out-1"],
	budget: {
		wallClockMs: 60_000,
		toolCalls: 20,
		turns: 10,
		tokens: 50_000,
		costUsd: 2,
	},
	editableSurface: ["packages/selfpi-recovery-policy/src/**"],
	protectedSurface: ["packages/selfpi/**", ".selfpi/**"],
	promotionPolicy: {
		minimumHeldInCompletionGain: 2,
		maximumHeldOutCompletionLoss: 0,
		requireRecoveryRateImprovement: true,
	},
};

describe("supervised runtime configuration", () => {
	it("loads pinned identities and exposes only held-in task definitions to the proposer", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "selfpi-supervised-runtime-"));
		const runtimePath = path.join(directory, "runtime.json");
		const activeVersionPath = path.join(directory, "active.json");
		const taskRegistryPath = path.join(directory, "task-registry.json");
		const registry = {
			version: 1,
			id: "path-recovery-registry-v1",
			tasks: [
				{
					id: "held-in-1",
					set: "held_in",
					repository: { url: "https://example.invalid/held-in.git", commit: repositoryCommit },
					input: "Repair the held-in fixture.",
					verifier: { id: "exact-file-v1", digest: verifierDigest },
					perturbation: { version: 1, path: "src/missing.ts", error: "ENOENT held-in secret" },
				},
				{
					id: "held-out-1",
					set: "held_out",
					repository: { url: "https://example.invalid/held-out.git", commit: repositoryCommit },
					input: "Repair the sealed held-out fixture.",
					verifier: { id: "exact-file-v1", digest: verifierDigest },
					perturbation: { version: 1, path: "src/sealed.ts", error: "ENOENT held-out secret" },
				},
			],
		};
		const registrySource = `${JSON.stringify(registry, null, 2)}\n`;
		const registryDigest = `sha256:${createHash("sha256").update(registrySource).digest("hex")}`;
		const runtime = {
			version: 1,
			mode: "supervised_v0",
			proposer: { provider: "anthropic", model: "claude-proposer", thinking: "low" },
			reviewer: { provider: "openai", model: "reviewer-v1" },
			gateway: { identity: "selfpi-gateway-v1", endpoint: "http://model-gateway.internal/v1" },
			container: { imageDigest: containerImageDigest },
			evaluation: { repetitions: 3 },
			taskRegistry: { id: registry.id, digest: registryDigest },
		};

		try {
			await Promise.all([
				writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`, "utf8"),
				writeFile(
					activeVersionPath,
					`${JSON.stringify({
						version: 1,
						reference: "refs/selfpi/active",
						current: { sourceCommit: activeCommit, imageDigest: activeImageDigest },
					})}\n`,
					"utf8",
				),
				writeFile(taskRegistryPath, registrySource, "utf8"),
			]);

			const result = await loadSupervisedRuntime({
				runtimePath,
				activeVersionPath,
				taskRegistryPath,
				experiment,
			});

			expect(result).toMatchObject({
				ok: true,
				runtime: {
					mode: "supervised_v0",
					activeVersion: { sourceCommit: activeCommit, imageDigest: activeImageDigest },
					proposer: { provider: "anthropic", model: "claude-proposer" },
					reviewer: { provider: "openai", model: "reviewer-v1" },
					gateway: { identity: "selfpi-gateway-v1" },
					container: { imageDigest: containerImageDigest },
					evaluation: { repetitions: 3 },
					taskRegistry: { id: registry.id, digest: registryDigest },
				},
				taskRegistry: {
					heldIn: [{ id: "held-in-1" }],
					heldOut: [{ id: "held-out-1" }],
				},
				proposerView: {
					tasks: [
						{
							id: "held-in-1",
							repository: { url: "https://example.invalid/held-in.git", commit: repositoryCommit },
							input: "Repair the held-in fixture.",
						},
					],
				},
			});
			if (!result.ok) return;
			expect(JSON.stringify(result.proposerView)).not.toContain("held-out-1");
			expect(JSON.stringify(result.proposerView)).not.toContain("perturbation");
			expect(JSON.stringify(result.proposerView)).not.toContain("ENOENT");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
