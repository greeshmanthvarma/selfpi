import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	loadSupervisedRuntime,
	type ProposerTaskView,
	type ProtectedTaskRegistry,
	type SupervisedRuntime,
} from "../config/load-supervised-runtime.ts";
import {
	type CandidateCheckResult,
	completeImprovementEvaluation,
	type ImprovementEvaluationResult,
} from "../controller/run-improvement-cycle.ts";
import type { SealedEvidenceBundleArtifact } from "../evidence/build-sealed-evidence-bundle.ts";
import { type Experiment, loadExperiment } from "../experiments/load-experiment.ts";
import type { ModelGateway, ModelGatewaySession } from "../gateway/model-gateway.ts";
import {
	type CandidateImageBuilder,
	type CandidateSourceAdapter,
	materializeCandidateVersion,
} from "../promotion/materialize-candidate-version.ts";
import type { PromotionReferenceAdapter } from "../promotion/promote-run.ts";
import type { ProposalGitAdapter, ProposerProcessAdapter } from "../proposal/generate-candidate-proposal.ts";
import { type CandidateProposal, validateCandidateProposal } from "../proposal/validate-candidate-proposal.ts";
import { createRunRecordStore, type RunRecord } from "../records/run-record.ts";
import type { CandidateReviewerAdapter } from "../review/candidate-review.ts";
import { runSupervisedProposalAndReview } from "./run-supervised-proposal-and-review.ts";

export interface SupervisedImprovementAdapters {
	readonly gateway: ModelGateway;
	readonly proposalGit: ProposalGitAdapter;
	readonly createProposer: (session: ModelGatewaySession) => ProposerProcessAdapter | Promise<ProposerProcessAdapter>;
	readonly checks: { run(candidate: CandidateProposal): Promise<CandidateCheckResult> };
	readonly createReviewer: (
		session: ModelGatewaySession,
	) => CandidateReviewerAdapter | Promise<CandidateReviewerAdapter>;
	readonly buildEvidence: (input: {
		readonly experiment: Experiment;
		readonly runtime: SupervisedRuntime;
		readonly proposerView: { readonly tasks: readonly ProposerTaskView[] };
	}) => Promise<SealedEvidenceBundleArtifact>;
	readonly smoke: {
		run(candidate: CandidateProposal): Promise<{ readonly buildPassed: boolean; readonly smokePassed: boolean }>;
	};
	readonly evaluator: {
		run(input: {
			readonly candidate: CandidateProposal;
			readonly experiment: Experiment;
			readonly runtime: SupervisedRuntime;
			readonly taskRegistry: ProtectedTaskRegistry;
		}): Promise<ImprovementEvaluationResult>;
	};
	readonly candidateSource: CandidateSourceAdapter;
	readonly candidateImage: CandidateImageBuilder;
}

export interface RunSupervisedImprovementInput {
	readonly rootDirectory: string;
	readonly repositoryDirectory: string;
	readonly experimentId: string;
	readonly runId: string;
	readonly now: () => Date;
	readonly referenceAdapter: PromotionReferenceAdapter;
}

export async function runSupervisedImprovement(
	input: RunSupervisedImprovementInput,
	adapters: SupervisedImprovementAdapters,
): Promise<RunRecord> {
	const experimentResult = await loadExperiment(
		path.join(input.rootDirectory, "experiments", `${input.experimentId}.json`),
	);
	if (!experimentResult.ok)
		throw new Error(experimentResult.errors[0]?.message ?? "Experiment configuration is invalid.");
	if (experimentResult.experiment.id !== input.experimentId) {
		throw new Error(`Experiment file does not declare ${input.experimentId}.`);
	}
	const runtimeResult = await loadSupervisedRuntime({
		runtimePath: path.join(input.rootDirectory, "runtime.json"),
		activeVersionPath: path.join(input.rootDirectory, "promotion", "active.json"),
		taskRegistryPath: path.join(input.rootDirectory, "task-registry.json"),
		experiment: experimentResult.experiment,
	});
	if (!runtimeResult.ok) throw new Error(runtimeResult.message);
	const activeValue: unknown = JSON.parse(
		await readFile(path.join(input.rootDirectory, "promotion", "active.json"), "utf8"),
	);
	if (
		typeof activeValue !== "object" ||
		activeValue === null ||
		Array.isArray(activeValue) ||
		!("reference" in activeValue) ||
		typeof activeValue.reference !== "string" ||
		(await input.referenceAdapter.read(activeValue.reference)) !== runtimeResult.runtime.activeVersion.sourceCommit
	) {
		throw new Error("Configured active reference does not match the active harness record.");
	}
	const evidence = await adapters.buildEvidence({
		experiment: experimentResult.experiment,
		runtime: runtimeResult.runtime,
		proposerView: runtimeResult.proposerView,
	});
	const repositoryInstructions = await readFile(path.join(input.repositoryDirectory, "AGENTS.md"), "utf8").catch(
		() => "No repository instructions were found.",
	);
	const relevantSource = evidence.bundle.editableSource
		.map(({ path: sourcePath, content }) => `${sourcePath}\n${content}`)
		.join("\n\n");
	let run = await runSupervisedProposalAndReview(
		{
			rootDirectory: input.rootDirectory,
			runId: input.runId,
			now: input.now,
			experiment: experimentResult.experiment,
			runtime: runtimeResult.runtime,
			evidence,
			proposalPrompt: "Propose one bounded path-recovery change from the sealed held-in evidence.",
			review: {
				relevantSource,
				repositoryInstructions,
				promptVersion: "supervised-review-v1",
				prompt: "Review the bounded candidate for safety and hypothesis alignment.",
			},
			humanApproval: false,
			sessionExpiresAt: new Date(input.now().getTime() + experimentResult.experiment.budget.wallClockMs),
		},
		{
			gateway: adapters.gateway,
			git: adapters.proposalGit,
			createProposer: adapters.createProposer,
			checks: adapters.checks,
			createReviewer: adapters.createReviewer,
		},
	);
	if (run.manifest.state !== "review_passed") return run;

	const candidateValue: unknown = JSON.parse(
		await readFile(path.join(input.rootDirectory, "runs", input.runId, "candidate-proposal.json"), "utf8"),
	);
	const candidateResult = validateCandidateProposal(candidateValue);
	if (!candidateResult.ok) throw new Error("Recorded supervised candidate is invalid.");
	const smoke = await adapters.smoke.run(candidateResult.proposal);
	const store = createRunRecordStore({ rootDirectory: input.rootDirectory, now: input.now });
	await store.recordSmokeResult(input.runId, {
		buildPassed: smoke.buildPassed,
		targetedTestsPassed: true,
		smokePassed: smoke.smokePassed,
	});
	if (!smoke.buildPassed || !smoke.smokePassed) return store.open(input.runId);

	const evaluation = await adapters.evaluator.run({
		candidate: candidateResult.proposal,
		experiment: experimentResult.experiment,
		runtime: runtimeResult.runtime,
		taskRegistry: runtimeResult.taskRegistry,
	});
	const expectedAttemptKeys = new Set(
		[...experimentResult.experiment.heldIn, ...experimentResult.experiment.heldOut].flatMap((taskId) =>
			Array.from(
				{ length: runtimeResult.runtime.evaluation.repetitions },
				(_, repetition) => `${taskId}:${String(repetition)}`,
			),
		),
	);
	const actualAttemptKeys = new Set(
		evaluation.attempts?.map((attempt) => `${attempt.taskId}:${String(attempt.repetition)}`) ?? [],
	);
	if (
		evaluation.attempts === undefined ||
		evaluation.attempts.length !== expectedAttemptKeys.size ||
		actualAttemptKeys.size !== expectedAttemptKeys.size ||
		[...actualAttemptKeys].some((key) => !expectedAttemptKeys.has(key))
	) {
		await store.transition(input.runId, "invalid");
		return store.open(input.runId);
	}
	run = await completeImprovementEvaluation({
		rootDirectory: input.rootDirectory,
		runId: input.runId,
		now: input.now,
		experiment: experimentResult.experiment,
		smoke,
		targetedTestsPassed: true,
		evaluation,
	});
	if (run.manifest.state !== "promotion_recommended") return run;
	await materializeCandidateVersion(
		{ rootDirectory: input.rootDirectory, runId: input.runId, now: input.now },
		{ source: adapters.candidateSource, image: adapters.candidateImage },
	);
	return store.open(input.runId);
}
