import { createEvaluationFingerprint } from "../evaluation/baseline-cache.ts";
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
	readonly evidenceClass?: "deterministic_engineering" | "supervised_real";
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
	readonly attempts?: readonly ImprovementEvaluationAttempt[];
	/** When set (e.g. TB smoke eval), attempt keys validate against this plan instead of experiment heldIn/heldOut. */
	readonly attemptTaskPlan?: {
		readonly heldIn: readonly string[];
		readonly heldOut: readonly string[];
	};
}

export interface ImprovementEvaluationAttempt {
	readonly taskId: string;
	readonly set: "held_in" | "held_out";
	readonly repetition: number;
	readonly baseline: HarnessAttemptComparison["baseline"];
	readonly candidate: HarnessAttemptComparison["candidate"];
	readonly baselineRecovered: boolean;
	readonly candidateRecovered: boolean;
	readonly baselineCostUsd: number;
	readonly candidateCostUsd: number;
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

export interface CompleteImprovementEvaluationInput {
	readonly rootDirectory: string;
	readonly runId: string;
	readonly now: () => Date;
	readonly experiment: Experiment;
	readonly smoke: { readonly buildPassed: boolean; readonly smokePassed: boolean };
	readonly targetedTestsPassed: boolean;
	readonly evaluation: ImprovementEvaluationResult;
}

function summarizeAttempts(attempts: readonly ImprovementEvaluationAttempt[]): {
	readonly outcomes: PromotionRecommendationInput["outcomes"];
	readonly efficiency: PromotionRecommendationInput["efficiency"];
} {
	const heldIn = attempts.filter((attempt) => attempt.set === "held_in");
	const heldOut = attempts.filter((attempt) => attempt.set === "held_out");
	const repetitionCount = new Set(attempts.map((attempt) => attempt.repetition)).size;
	const completions = (values: readonly ImprovementEvaluationAttempt[], side: "baseline" | "candidate") =>
		values.filter((attempt) => attempt[side].result.verifier.verifiedCompletion).length;
	const recovered = (side: "baseline" | "candidate") =>
		heldIn.filter((attempt) => (side === "baseline" ? attempt.baselineRecovered : attempt.candidateRecovered)).length;
	return Object.freeze({
		outcomes: Object.freeze({
			baselineRepetitions: repetitionCount,
			candidateRepetitions: repetitionCount,
			baselineHeldInCompletions: completions(heldIn, "baseline"),
			candidateHeldInCompletions: completions(heldIn, "candidate"),
			baselineHeldOutCompletions: completions(heldOut, "baseline"),
			candidateHeldOutCompletions: completions(heldOut, "candidate"),
			baselineRecoveryRate: heldIn.length === 0 ? 0 : recovered("baseline") / heldIn.length,
			candidateRecoveryRate: heldIn.length === 0 ? 0 : recovered("candidate") / heldIn.length,
		}),
		efficiency: Object.freeze({
			baselineTokens: attempts.reduce((total, attempt) => total + attempt.baseline.result.usage.totalTokens, 0),
			candidateTokens: attempts.reduce((total, attempt) => total + attempt.candidate.result.usage.totalTokens, 0),
			baselineCostUsd: attempts.reduce((total, attempt) => total + attempt.baselineCostUsd, 0),
			candidateCostUsd: attempts.reduce((total, attempt) => total + attempt.candidateCostUsd, 0),
		}),
	});
}

function attemptsMatchComparison(
	attempts: readonly ImprovementEvaluationAttempt[],
	comparison: HarnessAttemptComparison,
): boolean {
	const expected = createEvaluationFingerprint(comparison.baseline.fingerprintInputs);
	return (
		attempts.length > 0 &&
		attempts.every(
			(attempt) =>
				Number.isInteger(attempt.repetition) &&
				attempt.repetition >= 0 &&
				attempt.taskId === attempt.baseline.result.verifier.taskId &&
				attempt.taskId === attempt.candidate.result.verifier.taskId &&
				createEvaluationFingerprint(attempt.baseline.fingerprintInputs) === expected &&
				createEvaluationFingerprint(attempt.candidate.fingerprintInputs) === expected,
		)
	);
}

export async function completeImprovementEvaluation(input: CompleteImprovementEvaluationInput): Promise<RunRecord> {
	const store = createRunRecordStore({ rootDirectory: input.rootDirectory, now: input.now });
	const attemptsValid =
		input.evaluation.attempts === undefined ||
		attemptsMatchComparison(input.evaluation.attempts, input.evaluation.comparison);
	try {
		await store.recordEvaluation(
			input.runId,
			input.evaluation.comparison,
			attemptsValid ? input.evaluation.attempts : undefined,
		);
	} catch (error) {
		const run = await store.open(input.runId);
		if (run.manifest.state === "invalid") return run;
		throw error;
	}
	const aggregate =
		input.evaluation.attempts === undefined || !attemptsValid
			? { outcomes: input.evaluation.outcomes, efficiency: input.evaluation.efficiency }
			: summarizeAttempts(input.evaluation.attempts);
	const recommendation = decidePromotionRecommendation({
		gates: {
			policyPassed: true,
			reviewPassed: true,
			buildPassed: input.smoke.buildPassed,
			targetedTestsPassed: input.targetedTestsPassed,
			smokePassed: input.smoke.smokePassed,
			integrityViolation: input.evaluation.integrityViolation || !attemptsValid,
		},
		policy: input.experiment.promotionPolicy,
		outcomes: aggregate.outcomes,
		efficiency: aggregate.efficiency,
	});
	await store.recordDecision(input.runId, recommendation);
	return store.open(input.runId);
}

export async function runImprovementCycle(
	input: ImprovementCycleInput,
	adapters: ImprovementCycleAdapters,
): Promise<RunRecord> {
	const store = createRunRecordStore({ rootDirectory: input.rootDirectory, now: input.now });
	await store.create({
		runId: input.runId,
		experimentId: input.experiment.id,
		...(input.evidenceClass === undefined ? {} : { evidenceClass: input.evidenceClass }),
	});
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

	return completeImprovementEvaluation({
		rootDirectory: input.rootDirectory,
		runId: input.runId,
		now: input.now,
		experiment: input.experiment,
		smoke,
		targetedTestsPassed: checks.targetedTestsPassed,
		evaluation: await adapters.evaluator.run(generated.proposal),
	});
}
