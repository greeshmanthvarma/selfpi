import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
	readonly configuration: Readonly<Record<string, unknown>>;
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
	createWorktree(baselineCommit: string): Promise<ProposalWorktree>;
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createGitProposalWorktreeAdapter(options: {
	readonly repositoryDirectory: string;
	readonly worktreeRoot: string;
}): ProposalGitAdapter {
	return {
		async createWorktree(baselineCommit) {
			await mkdir(options.worktreeRoot, { recursive: true });
			const directory = join(options.worktreeRoot, randomUUID());
			await execFileAsync("git", ["worktree", "add", "--detach", directory, baselineCommit], {
				cwd: options.repositoryDirectory,
			});
			return Object.freeze({ directory });
		},
		async collectDiff(worktree, editableSurface) {
			const pathspecs = editableSurface.map((path) => (path.endsWith("/**") ? path.slice(0, -3) : path));
			const { stdout } = await execFileAsync("git", ["diff", "--binary", "--", ...pathspecs], {
				cwd: worktree.directory,
			});
			return stdout;
		},
		async removeWorktree(worktree) {
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
	const worktree = await adapters.git.createWorktree(input.baselineCommit);
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
	const validation = validateCandidateProposal(
		isRecord(proposerOutput) ? { ...proposerOutput, unifiedDiff } : proposerOutput,
	);
	return validation.ok
		? Object.freeze({ ok: true, proposal: validation.proposal, provenance })
		: Object.freeze({ ok: false, errors: validation.errors, provenance });
}
