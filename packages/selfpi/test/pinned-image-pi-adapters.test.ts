import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPinnedImagePiProposerAdapter } from "../src/supervised/pinned-image-pi-process-adapters.ts";

describe("pinned image pi adapters", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("runs the digest-pinned active image on the gateway-only network", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-pinned-image-"));
		temporaryDirectories.push(rootDirectory);
		const capturePath = path.join(rootDirectory, "docker-args.json");
		const fakeDocker = fileURLToPath(new URL("./fixtures/harness/fake-pinned-docker.mjs", import.meta.url));
		const imageDigest = `sha256:${"a".repeat(64)}`;
		const proposer = await createPinnedImagePiProposerAdapter({
			runtime: {
				version: 1,
				mode: "supervised_v0",
				activeVersion: { sourceCommit: "a".repeat(40), imageDigest },
				proposer: { provider: "fake-provider", model: "proposer-model", thinking: "low" },
				reviewer: { provider: "fake-provider", model: "reviewer-model" },
				gateway: { identity: "gateway-v1", endpoint: "http://gateway.internal/v1" },
				container: { imageDigest },
				evaluation: { repetitions: 1 },
				taskRegistry: { id: "registry", digest: imageDigest },
			},
			session: {
				id: "session-1",
				endpoint: "http://selfpi-gateway:8080/runs/run-1/roles/proposer/v1",
				credential: "short-lived",
			},
			image: `selfpi-active@${imageDigest}`,
			networkName: "selfpi-gw-run-1",
			dockerCommand: process.execPath,
			dockerBaseArgs: [fakeDocker, capturePath],
			agentDirectory: path.join(rootDirectory, "agent"),
			environment: { PATH: process.env.PATH ?? "" },
		});

		const output = await proposer.run({
			worktreeDirectory: rootDirectory,
			prompt: "propose",
			evidenceBundle: {
				version: 1,
				heldInFailures: [],
				redactedRepresentativeTraces: [],
				heldInVerifierOutcomes: [],
				preservedSuccesses: [],
				editableSource: [],
				rejectedHypotheses: [],
				proposalSchema: { version: 1, requiredFields: [] },
				editableSurface: ["packages/selfpi-recovery-policy/src/**"],
				changeBudget: {
					expectedMaximumChangedLines: 100,
					justificationRequiredAbove: 100,
					humanApprovalAbove: 250,
				},
			},
			editableSurface: ["packages/selfpi-recovery-policy/src/**"],
			model: { provider: "fake-provider", id: "proposer-model", configuration: { thinking: "low" } },
		});

		expect(output).toEqual({ hypothesis: "pinned-image-proposal" });
		const dockerArgs = JSON.parse(await readFile(capturePath, "utf8")) as string[];
		expect(dockerArgs).toContain("--network");
		expect(dockerArgs).toContain("selfpi-gw-run-1");
		expect(dockerArgs).toContain(`selfpi-active@${imageDigest}`);
		expect(dockerArgs.join(" ")).not.toContain("--network host");
		expect(dockerArgs.join(" ")).not.toContain("short-lived");
	});
});
