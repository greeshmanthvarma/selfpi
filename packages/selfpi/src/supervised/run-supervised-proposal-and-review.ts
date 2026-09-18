import type { SupervisedRuntime } from "../config/load-supervised-runtime.ts";
import type { CandidateCheckResult } from "../controller/run-improvement-cycle.ts";
import type { SealedEvidenceBundleArtifact } from "../evidence/build-sealed-evidence-bundle.ts";
import type { Experiment } from "../experiments/load-experiment.ts";
import type { ModelGateway, ModelGatewaySession } from "../gateway/model-gateway.ts";
import { evaluateCandidatePolicy } from "../policy/candidate-policy.ts";
import {
	generateCandidateProposal,
	type ProposalGitAdapter,
	type ProposerProcessAdapter,
} from "../proposal/generate-candidate-proposal.ts";
import type { CandidateProposal } from "../proposal/validate-candidate-proposal.ts";
import { createRunRecordStore, type RunRecord } from "../records/run-record.ts";
import { type CandidateReviewerAdapter, reviewCandidate } from "../review/candidate-review.ts";

export interface SupervisedProposalAndReviewInput {
	readonly rootDirectory: string;
	readonly runId: string;
	readonly now: () => Date;
	readonly experiment: Experiment;
	readonly runtime: SupervisedRuntime;
	readonly evidence: SealedEvidenceBundleArtifact;
	readonly proposalPrompt: string;
	readonly review: {
		readonly relevantSource: string;
		readonly repositoryInstructions: string;
		readonly promptVersion: string;
		readonly prompt: string;
	};
	readonly humanApproval: boolean;
	readonly sessionExpiresAt: Date;
}

export interface SupervisedProposalAndReviewAdapters {
	readonly gateway: ModelGateway;
	readonly git: ProposalGitAdapter;
	readonly createProposer: (session: ModelGatewaySession) => ProposerProcessAdapter | Promise<ProposerProcessAdapter>;
	readonly checks: { run(candidate: CandidateProposal): Promise<CandidateCheckResult> };
	readonly createReviewer: (
		session: ModelGatewaySession,
	) => CandidateReviewerAdapter | Promise<CandidateReviewerAdapter>;
}

function containsHeldOutIdentifier(value: unknown, heldOutTaskIds: readonly string[]): boolean {
	const source = JSON.stringify(value);
	return heldOutTaskIds.some((taskId) => source.includes(taskId));
}

export async function runSupervisedProposalAndReview(
	input: SupervisedProposalAndReviewInput,
	adapters: SupervisedProposalAndReviewAdapters,
): Promise<RunRecord> {
	if (
		containsHeldOutIdentifier(
			{ evidence: input.evidence.bundle, proposalPrompt: input.proposalPrompt },
			input.experiment.heldOut,
		)
	) {
		throw new Error("Supervised proposal inputs contain a held-out task identifier.");
	}

	const store = createRunRecordStore({ rootDirectory: input.rootDirectory, now: input.now });
	await store.create({ runId: input.runId, experimentId: input.experiment.id, evidenceClass: "supervised_real" });
	await store.recordEvidenceBundle(input.runId, input.evidence);
	await store.transition(input.runId, "evidence_ready");

	let proposerSession: ModelGatewaySession | undefined;
	let reviewerSession: ModelGatewaySession | undefined;
	try {
		proposerSession = await adapters.gateway.issueSession({
			runId: input.runId,
			role: "proposer",
			provider: input.runtime.proposer.provider,
			model: input.runtime.proposer.model,
			tokenBudget: input.experiment.budget.tokens,
			expiresAt: input.sessionExpiresAt,
		});
		const generated = await generateCandidateProposal(
			{
				baselineCommit: input.runtime.activeVersion.sourceCommit,
				activeHarnessCommit: input.runtime.activeVersion.sourceCommit,
				activeHarnessImageDigest: input.runtime.activeVersion.imageDigest,
				editableSurface: input.experiment.editableSurface,
				prompt: input.proposalPrompt,
				evidenceBundle: input.evidence.bundle,
				evidenceBundleDigest: input.evidence.digest,
				model: {
					provider: input.runtime.proposer.provider,
					id: input.runtime.proposer.model,
					configuration: { thinking: input.runtime.proposer.thinking },
				},
				gateway: {
					identity: input.runtime.gateway.identity,
					sessionId: proposerSession.id,
				},
			},
			{ git: adapters.git, proposer: await adapters.createProposer(proposerSession) },
		);
		await store.recordCandidateProposal(input.runId, generated);
		if (!generated.ok) return store.open(input.runId);

		const checks = await adapters.checks.run(generated.proposal);
		const policyResult = evaluateCandidatePolicy({
			proposal: generated.proposal,
			editableSurface: input.experiment.editableSurface,
			protectedSurface: input.experiment.protectedSurface,
			checks: {
				appliesCleanly: checks.appliesCleanly,
				formatting: checks.formatting,
				typeChecking: checks.typeChecking,
				targetedTests: checks.targetedTestsPassed,
			},
			changeBudget: input.evidence.bundle.changeBudget,
			humanApproval: input.humanApproval,
		});
		await store.recordCandidatePolicy(input.runId, policyResult);
		if (!policyResult.eligible) return store.open(input.runId);

		if (
			containsHeldOutIdentifier(
				{
					candidate: generated.proposal,
					relevantSource: input.review.relevantSource,
					repositoryInstructions: input.review.repositoryInstructions,
					prompt: input.review.prompt,
				},
				input.experiment.heldOut,
			)
		) {
			await store.transition(input.runId, "invalid");
			return store.open(input.runId);
		}
		reviewerSession = await adapters.gateway.issueSession({
			runId: input.runId,
			role: "reviewer",
			provider: input.runtime.reviewer.provider,
			model: input.runtime.reviewer.model,
			tokenBudget: input.experiment.budget.tokens,
			expiresAt: input.sessionExpiresAt,
		});
		const reviewResult = await reviewCandidate(
			{
				candidate: generated.proposal,
				policyResult,
				editableSurface: input.experiment.editableSurface,
				relevantSource: input.review.relevantSource,
				repositoryInstructions: input.review.repositoryInstructions,
				reviewer: {
					provider: input.runtime.reviewer.provider,
					model: input.runtime.reviewer.model,
					promptVersion: input.review.promptVersion,
					prompt: input.review.prompt,
					modelConfiguration: {},
					gateway: {
						identity: input.runtime.gateway.identity,
						sessionId: reviewerSession.id,
					},
				},
			},
			await adapters.createReviewer(reviewerSession),
		);
		await store.recordCandidateReview(input.runId, reviewResult);
		return store.open(input.runId);
	} finally {
		if (reviewerSession !== undefined) await adapters.gateway.revokeSession(reviewerSession.id);
		if (proposerSession !== undefined) await adapters.gateway.revokeSession(proposerSession.id);
	}
}
