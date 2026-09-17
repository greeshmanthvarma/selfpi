import type { HarnessAttemptComparison } from "../evaluation/compare-harness-attempts.ts";
import type { SealedEvidenceBundleArtifact } from "../evidence/build-sealed-evidence-bundle.ts";
import type { Experiment } from "../experiments/load-experiment.ts";
import { evaluateCandidatePolicy } from "../policy/candidate-policy.ts";
import {
	decidePromotionRecommendation,
	type PromotionRecommendationInput,
} from "../promotion/decide-promotion-recommendation.ts";
import {
	generateCandidateProposal,
	type ProposalGitAdapter,
	type ProposalModel,
	type ProposerProcessAdapter,
} from "../proposal/generate-candidate-proposal.ts";
import type { CandidateProposal } from "../proposal/validate-candidate-proposal.ts";
import { createRunRecordStore, type RunRecord } from "../records/run-record.ts";
import {
	type CandidateReviewerAdapter,
	type CandidateReviewInput,
	reviewCandidate,
} from "../review/candidate-review.ts";

export interface ImprovementCycleInput {
	readonly rootDirectory: string;
	readonly runId: string;
	readonly now: () => Date;
	readonly experiment: Experiment;
	readonly proposal: {
		readonly baselineCommit: string;
		readonly activeHarnessCommit: string;
		readonly prompt: string;
		readonly model: ProposalModel;
		readonly evidence: SealedEvidenceBundleArtifact;
	};
	readonly review: Pick<CandidateReviewInput, "relevantSource" | "repositoryInstructions" | "reviewer">;
	readonly humanApproval: boolean;
}

export interface CandidateCheckResult {
	readonly appliesCleanly: boolean;
	readonly formatting: boolean;
	readonly typeChecking: boolean;
	readonly targetedTestsPassed: boolean;
}

export interface ImprovementEvaluationResult {
	readonly comparison: HarnessAttemptComparison;
	readonly outcomes: PromotionRecommendationInput["outcomes"];
	readonly efficiency: PromotionRecommendationInput["efficiency"];
	readonly integrityViolation: boolean;
}

export interface ImprovementCycleAdapters {
	readonly git: ProposalGitAdapter;
	readonly proposer: ProposerProcessAdapter;
	readonly checks: { run(candidate: CandidateProposal): Promise<CandidateCheckResult> };
	readonly reviewer: CandidateReviewerAdapter;
	readonly smoke: {
		run(candidate: CandidateProposal): Promise<{ readonly buildPassed: boolean; readonly smokePassed: boolean }>;
	};
	readonly evaluator: { run(candidate: CandidateProposal): Promise<ImprovementEvaluationResult> };
}

export async function runImprovementCycle(
	input: ImprovementCycleInput,
	adapters: ImprovementCycleAdapters,
): Promise<RunRecord> {
	const store = createRunRecordStore({ rootDirectory: input.rootDirectory, now: input.now });
	await store.create({ runId: input.runId, experimentId: input.experiment.id });
	await store.recordEvidenceBundle(input.runId, input.proposal.evidence);
	await store.transition(input.runId, "evidence_ready");
	const generated = await generateCandidateProposal(
		{
			baselineCommit: input.proposal.baselineCommit,
			activeHarnessCommit: input.proposal.activeHarnessCommit,
			editableSurface: input.experiment.editableSurface,
			prompt: input.proposal.prompt,
			evidenceBundle: input.proposal.evidence.bundle,
			evidenceBundleDigest: input.proposal.evidence.digest,
			model: input.proposal.model,
		},
		{ git: adapters.git, proposer: adapters.proposer },
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
		changeBudget: input.proposal.evidence.bundle.changeBudget,
		humanApproval: input.humanApproval,
	});
	await store.recordCandidatePolicy(input.runId, policyResult);
	if (!policyResult.eligible) return store.open(input.runId);

	const reviewResult = await reviewCandidate(
		{
			candidate: generated.proposal,
			policyResult,
			editableSurface: input.experiment.editableSurface,
			relevantSource: input.review.relevantSource,
			repositoryInstructions: input.review.repositoryInstructions,
			reviewer: input.review.reviewer,
		},
		adapters.reviewer,
	);
	await store.recordCandidateReview(input.runId, reviewResult);
	if (!reviewResult.proceed) return store.open(input.runId);

	const smoke = await adapters.smoke.run(generated.proposal);
	await store.recordSmokeResult(input.runId, {
		buildPassed: smoke.buildPassed,
		targetedTestsPassed: checks.targetedTestsPassed,
		smokePassed: smoke.smokePassed,
	});
	if (!smoke.buildPassed || !checks.targetedTestsPassed || !smoke.smokePassed) return store.open(input.runId);

	const evaluation = await adapters.evaluator.run(generated.proposal);
	try {
		await store.recordEvaluation(input.runId, evaluation.comparison);
	} catch (error) {
		const run = await store.open(input.runId);
		if (run.manifest.state === "invalid") return run;
		throw error;
	}
	const recommendation = decidePromotionRecommendation({
		gates: {
			policyPassed: true,
			reviewPassed: true,
			buildPassed: smoke.buildPassed,
			targetedTestsPassed: checks.targetedTestsPassed,
			smokePassed: smoke.smokePassed,
			integrityViolation: evaluation.integrityViolation,
		},
		policy: input.experiment.promotionPolicy,
		outcomes: evaluation.outcomes,
		efficiency: evaluation.efficiency,
	});
	await store.recordDecision(input.runId, recommendation);
	return store.open(input.runId);
}
