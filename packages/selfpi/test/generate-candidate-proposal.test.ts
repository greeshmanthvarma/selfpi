import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	createGitProposalWorktreeAdapter,
	createRunRecordStore,
	generateCandidateProposal,
	type ProposerProcessAdapter,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);

describe("candidate proposal generation", () => {
	it("collects only editable changes from a disposable worktree at the pinned baseline", async () => {
		const root = await mkdtemp(join(tmpdir(), "selfpi-proposal-"));
		const repositoryDirectory = join(root, "repository");
		const worktreeRoot = join(root, "worktrees");
		const editablePath = "packages/selfpi-recovery-policy/src/index.ts";
		const protectedPath = "packages/selfpi/src/index.ts";
		await mkdir(join(repositoryDirectory, "packages/selfpi-recovery-policy/src"), { recursive: true });
		await mkdir(join(repositoryDirectory, "packages/selfpi/src"), { recursive: true });
		await writeFile(join(repositoryDirectory, editablePath), "return undefined;\n", "utf8");
		await writeFile(join(repositoryDirectory, protectedPath), "export const protectedValue = true;\n", "utf8");
		await execFileAsync("git", ["init"], { cwd: repositoryDirectory });
		await execFileAsync("git", ["add", editablePath, protectedPath], { cwd: repositoryDirectory });
		await execFileAsync(
			"git",
			["-c", "user.name=SelfPi Test", "-c", "user.email=selfpi@example.invalid", "commit", "-m", "baseline"],
			{ cwd: repositoryDirectory },
		);
		const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryDirectory });
		const baselineCommit = stdout.trim();
		let proposerInput: Parameters<ProposerProcessAdapter["run"]>[0] | undefined;
		let protectedWriteError: string | undefined;
		const proposer: ProposerProcessAdapter = {
			async run(input) {
				proposerInput = input;
				await writeFile(join(input.worktreeDirectory, editablePath), "return guidance;\n", "utf8");
				await writeFile(
					join(input.worktreeDirectory, "packages/selfpi-recovery-policy/src/new.ts"),
					"export {};\n",
				);
				try {
					await writeFile(
						join(input.worktreeDirectory, protectedPath),
						"export const protectedValue = false;\n",
						"utf8",
					);
				} catch (error) {
					if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
						protectedWriteError = error.code;
					}
				}
				await execFileAsync("git", ["add", "--intent-to-add", "--", "packages/selfpi-recovery-policy"], {
					cwd: input.worktreeDirectory,
				});
				const proposalDiff = await execFileAsync(
					"git",
					["diff", "--binary", "--", "packages/selfpi-recovery-policy"],
					{ cwd: input.worktreeDirectory },
				);
				return {
					version: 1,
					hypothesis: "Search guidance after a missing path improves recovery.",
					targetFailureSignature: "held-in-01:read-call",
					affectedEditableSurface: [editablePath, "packages/selfpi-recovery-policy/src/new.ts"],
					unifiedDiff: proposalDiff.stdout,
					expectedBehavioralMechanism: "The model receives a search strategy.",
					predictedBenefit: "More tasks recover from stale paths.",
					regressionRisks: ["Extra guidance may distract the model."],
				};
			},
		};

		const result = await generateCandidateProposal(
			{
				baselineCommit,
				activeHarnessCommit: baselineCommit,
				editableSurface: ["packages/selfpi-recovery-policy/src/**"],
				prompt: "Propose one bounded path-recovery improvement.",
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
				evidenceBundleDigest: "sha256:evidence",
				model: { provider: "faux", id: "fixed-model", configuration: { thinking: "low" } },
			},
			{
				git: createGitProposalWorktreeAdapter({ repositoryDirectory, worktreeRoot }),
				proposer,
			},
		);

		expect(result).toMatchObject({
			ok: true,
			proposal: { changedPaths: [editablePath, "packages/selfpi-recovery-policy/src/new.ts"] },
			provenance: {
				provider: "faux",
				model: "fixed-model",
				worktreeBase: baselineCommit,
				evidenceBundleDigest: "sha256:evidence",
			},
		});
		if (!result.ok) throw new Error("Expected a valid generated proposal.");
		const recordRoot = join(root, "records");
		const store = createRunRecordStore({
			rootDirectory: recordRoot,
			now: () => new Date("2026-09-17T12:00:00.000Z"),
		});
		await store.create({ runId: "run-001", experimentId: "path-recovery-v0" });
		await store.transition("run-001", "evidence_ready");
		await store.recordCandidateProposal("run-001", result);
		expect(result.proposal.unifiedDiff).toContain(`b/${editablePath}`);
		expect(result.proposal.unifiedDiff).toContain("packages/selfpi-recovery-policy/src/new.ts");
		expect(result.proposal.unifiedDiff).not.toContain(protectedPath);
		expect(protectedWriteError).toBe("EACCES");
		expect(proposerInput?.model.configuration).toEqual({ thinking: "low" });
		expect(await readFile(join(repositoryDirectory, editablePath), "utf8")).toBe("return undefined;\n");
		expect(await readFile(join(repositoryDirectory, protectedPath), "utf8")).toBe(
			"export const protectedValue = true;\n",
		);
		expect(JSON.parse(await readFile(join(recordRoot, "runs/run-001/candidate-proposal.json"), "utf8"))).toEqual(
			result.proposal,
		);
		expect(JSON.parse(await readFile(join(recordRoot, "runs/run-001/proposal-provenance.json"), "utf8"))).toEqual(
			result.provenance,
		);
		const reopened = await store.open("run-001");
		expect(reopened.manifest.state).toBe("proposal_generated");
		expect(reopened.events.at(-1)).toMatchObject({
			type: "state_transitioned",
			from: "evidence_ready",
			state: "proposal_generated",
		});
	});
});
