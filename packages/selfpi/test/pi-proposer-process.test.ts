import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPiProposerProcessAdapter } from "../src/index.ts";

describe("Pi proposer process", () => {
	it("runs the configured harness process with the fixed proposal inputs", async () => {
		const worktreeDirectory = await mkdtemp(join(tmpdir(), "selfpi-proposer-process-"));
		const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-pi-proposer.mjs");
		const proposer = createPiProposerProcessAdapter({
			activeHarnessCommand: process.execPath,
			baseArgs: [fixture],
			environment: {},
		});

		const output = await proposer.run({
			worktreeDirectory,
			prompt: "propose one change",
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
			model: { provider: "faux", id: "fixed-model", configuration: { thinking: "low" } },
		});

		expect(output).toEqual({
			hypothesis: "faux/fixed-model:low",
			promptIncludesEvidence: true,
		});
	});
});
