import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	createGitProposalWorktreeAdapter,
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
		const proposer: ProposerProcessAdapter = {
			async run(input) {
				proposerInput = input;
				await writeFile(join(input.worktreeDirectory, editablePath), "return guidance;\n", "utf8");
				await writeFile(
					join(input.worktreeDirectory, protectedPath),
					"export const protectedValue = false;\n",
					"utf8",
				);
				return {
					version: 1,
					hypothesis: "Search guidance after a missing path improves recovery.",
					targetFailureSignature: "held-in-01:read-call",
					affectedEditableSurface: [editablePath],
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
					preservedSuccesses: [],
					editableSource: [],
					rejectedHypotheses: [],
				},
				evidenceBundleDigest: "sha256:evidence",
				model: { provider: "faux", id: "fixed-model", configuration: { temperature: 0 } },
			},
			{
				git: createGitProposalWorktreeAdapter({ repositoryDirectory, worktreeRoot }),
				proposer,
			},
		);

		expect(result).toMatchObject({
			ok: true,
			proposal: { changedPaths: [editablePath] },
			provenance: {
				provider: "faux",
				model: "fixed-model",
				worktreeBase: baselineCommit,
				evidenceBundleDigest: "sha256:evidence",
			},
		});
		if (!result.ok) throw new Error("Expected a valid generated proposal.");
		expect(result.proposal.unifiedDiff).toContain(`b/${editablePath}`);
		expect(result.proposal.unifiedDiff).not.toContain(protectedPath);
		expect(proposerInput?.model.configuration).toEqual({ temperature: 0 });
		expect(await readFile(join(repositoryDirectory, editablePath), "utf8")).toBe("return undefined;\n");
		expect(await readFile(join(repositoryDirectory, protectedPath), "utf8")).toBe(
			"export const protectedValue = true;\n",
		);
	});
});
