import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SealedEvidenceBundle } from "../evidence/build-sealed-evidence-bundle.ts";
import {
	type CandidateProposal,
	type CandidateProposalValidationResult,
	validateCandidateProposal,
} from "./validate-candidate-proposal.ts";

const execFileAsync = promisify(execFile);

export interface ProposalModel {
	readonly provider: string;
	readonly id: string;
	readonly configuration: {
		readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	};
}

export interface GenerateCandidateProposalInput {
	readonly baselineCommit: string;
	readonly activeHarnessCommit: string;
	readonly editableSurface: readonly string[];
	readonly prompt: string;
	readonly evidenceBundle: SealedEvidenceBundle;
	readonly evidenceBundleDigest: string;
	readonly model: ProposalModel;
}

export interface ProposalWorktree {
	readonly directory: string;
}

export interface ProposalGitAdapter {
	createWorktree(baselineCommit: string, editableSurface: readonly string[]): Promise<ProposalWorktree>;
	collectDiff(worktree: ProposalWorktree, editableSurface: readonly string[]): Promise<string>;
	removeWorktree(worktree: ProposalWorktree): Promise<void>;
}

export interface ProposerProcessAdapter {
	run(input: {
		readonly worktreeDirectory: string;
		readonly prompt: string;
		readonly evidenceBundle: SealedEvidenceBundle;
		readonly editableSurface: readonly string[];
		readonly model: ProposalModel;
	}): Promise<unknown>;
}

export interface CandidateProposalProvenance {
	readonly provider: string;
	readonly model: string;
	readonly modelConfiguration: Readonly<Record<string, unknown>>;
	readonly activeHarnessCommit: string;
	readonly prompt: string;
	readonly evidenceBundleDigest: string;
	readonly worktreeBase: string;
	readonly unifiedDiff: string;
}

export type GeneratedCandidateProposalResult =
	| {
			readonly ok: true;
			readonly proposal: CandidateProposal;
			readonly provenance: CandidateProposalProvenance;
	  }
	| {
			readonly ok: false;
			readonly errors: Extract<CandidateProposalValidationResult, { readonly ok: false }>["errors"];
			readonly provenance: CandidateProposalProvenance;
	  };

async function setTreeModes(targetPath: string, writable: boolean): Promise<void> {
	const metadata = await lstat(targetPath);
	if (metadata.isSymbolicLink()) {
		return;
	}
	if (!metadata.isDirectory()) {
		await chmod(targetPath, writable ? 0o644 : 0o444);
		return;
	}
	for (const entry of await readdir(targetPath)) {
		await setTreeModes(join(targetPath, entry), writable);
	}
	await chmod(targetPath, writable ? 0o755 : 0o555);
}

function editableSurfaceRoots(editableSurface: readonly string[]): readonly string[] {
	return editableSurface.map((path) => (path.endsWith("/**") ? path.slice(0, -3) : path));
}

export function createGitProposalWorktreeAdapter(options: {
	readonly repositoryDirectory: string;
	readonly worktreeRoot: string;
}): ProposalGitAdapter {
	return {
		async createWorktree(baselineCommit, editableSurface) {
			await mkdir(options.worktreeRoot, { recursive: true });
			const directory = join(options.worktreeRoot, randomUUID());
			let added = false;
			try {
				await execFileAsync("git", ["worktree", "add", "--detach", directory, baselineCommit], {
					cwd: options.repositoryDirectory,
				});
				added = true;
				await setTreeModes(directory, false);
				for (const root of editableSurfaceRoots(editableSurface)) {
					await setTreeModes(join(directory, root), true);
				}
				return Object.freeze({ directory });
			} catch (error) {
				if (added) {
					await setTreeModes(directory, true).catch(() => undefined);
					await execFileAsync("git", ["worktree", "remove", "--force", directory], {
						cwd: options.repositoryDirectory,
					}).catch(() => undefined);
				}
				throw error;
			}
		},
		async collectDiff(worktree, editableSurface) {
			const pathspecs = editableSurfaceRoots(editableSurface);
			await execFileAsync("git", ["add", "--intent-to-add", "--", ...pathspecs], {
				cwd: worktree.directory,
			});
			const { stdout } = await execFileAsync("git", ["diff", "--binary", "--", ...pathspecs], {
				cwd: worktree.directory,
			});
			return stdout;
		},
		async removeWorktree(worktree) {
			await setTreeModes(worktree.directory, true);
			await execFileAsync("git", ["worktree", "remove", "--force", worktree.directory], {
				cwd: options.repositoryDirectory,
			});
		},
	};
}

export async function generateCandidateProposal(
	input: GenerateCandidateProposalInput,
	adapters: { readonly git: ProposalGitAdapter; readonly proposer: ProposerProcessAdapter },
): Promise<GeneratedCandidateProposalResult> {
	const worktree = await adapters.git.createWorktree(input.baselineCommit, input.editableSurface);
	let proposerOutput: unknown;
	let unifiedDiff = "";
	try {
		proposerOutput = await adapters.proposer.run({
			worktreeDirectory: worktree.directory,
			prompt: input.prompt,
			evidenceBundle: input.evidenceBundle,
			editableSurface: input.editableSurface,
			model: input.model,
		});
		unifiedDiff = await adapters.git.collectDiff(worktree, input.editableSurface);
	} finally {
		await adapters.git.removeWorktree(worktree);
	}

	const provenance = Object.freeze({
		provider: input.model.provider,
		model: input.model.id,
		modelConfiguration: Object.freeze({ ...input.model.configuration }),
		activeHarnessCommit: input.activeHarnessCommit,
		prompt: input.prompt,
		evidenceBundleDigest: input.evidenceBundleDigest,
		worktreeBase: input.baselineCommit,
		unifiedDiff,
	});
	const validation = validateCandidateProposal(proposerOutput);
	if (validation.ok && validation.proposal.unifiedDiff !== unifiedDiff) {
		const mismatch: GeneratedCandidateProposalResult = {
			ok: false,
			errors: [{ code: "invalid_unified_diff" }],
			provenance,
		};
		return Object.freeze(mismatch);
	}
	return validation.ok
		? Object.freeze({ ok: true, proposal: validation.proposal, provenance })
		: Object.freeze({ ok: false, errors: validation.errors, provenance });
}
