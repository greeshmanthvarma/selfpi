export { runSelfPiCli, type SelfPiCliOptions } from "./cli/run-selfpi-cli.ts";
export {
	type DeterministicRuntime,
	loadDeterministicRuntime,
	type RuntimeLoadResult,
} from "./config/load-runtime.ts";
export {
	type LoadSupervisedRuntimeInput,
	loadSupervisedRuntime,
	type ProposerTaskView,
	type ProtectedTaskRegistry,
	type RegisteredTask,
	type SupervisedRuntime,
	type SupervisedRuntimeLoadResult,
} from "./config/load-supervised-runtime.ts";
export {
	type CandidateCheckResult,
	type ImprovementCycleAdapters,
	type ImprovementCycleInput,
	type ImprovementEvaluationAttempt,
	type ImprovementEvaluationResult,
	runImprovementCycle,
} from "./controller/run-improvement-cycle.ts";
export {
	type DeterministicImprovementInput,
	runDeterministicImprovement,
} from "./deterministic/run-deterministic-improvement.ts";
export {
	type BaselineCache,
	type BaselineCacheOptions,
	type BaselineCacheResult,
	type BaselineEvidence,
	createBaselineCache,
	createEvaluationFingerprint,
	type EvaluationFingerprintInputs,
} from "./evaluation/baseline-cache.ts";
export {
	compareHarnessAttempts,
	type EvaluatedHarnessAttempt,
	type HarnessAttemptComparison,
	type HarnessAttemptComparisonInput,
} from "./evaluation/compare-harness-attempts.ts";
export {
	createDockerHarnessRunner,
	type DockerHarnessAttemptInput,
	type DockerHarnessRunner,
	type DockerHarnessRunnerOptions,
} from "./evaluation/docker-harness-runner.ts";
export { createExecDockerProcessAdapter } from "./evaluation/exec-docker-process-adapter.ts";
export { loadProtectedEvaluationTask } from "./evaluation/load-protected-evaluation-task.ts";
export {
	measurePathRecovery,
	type PathRecoveryMeasurement,
} from "./evaluation/measure-path-recovery.ts";
export {
	createPathPerturbationExtension,
	type PathPerturbationExtension,
	type PathPerturbationRecord,
	type PathPerturbationSchedule,
} from "./evaluation/path-perturbation-extension.ts";
export {
	installPathRecoveryCorpus,
	loadPathRecoveryCorpus,
	type PathRecoveryCorpus,
	pathRecoveryCorpusRoot,
} from "./evaluation/path-recovery-corpus.ts";
export {
	type MaterializedTaskFixture,
	type MaterializeProtectedTaskFixtureInput,
	materializeProtectedTaskFixture,
} from "./evaluation/protected-task-fixture-store.ts";
export {
	type HarnessAttemptInput,
	type HarnessAttemptResult,
	type HarnessTermination,
	type HarnessUsage,
	type NormalizedTranscriptEntry,
	runHarnessAttempt,
} from "./evaluation/run-harness-attempt.ts";
export {
	installToolCodeCorpus,
	loadToolCodeCorpus,
	type ToolCodeCorpus,
	type ToolCodeNaturalFailure,
	type ToolCodeToolName,
	toolCodeCorpusRoot,
} from "./evaluation/tool-code-corpus.ts";
export {
	type EvaluationTask,
	type ExactFileVerifier,
	type VerificationResult,
	verifyEvaluationTask,
} from "./evaluation/verify-task.ts";
export {
	buildPathRecoveryHeldInEvidence,
	type PathRecoveryHeldInEvidence,
} from "./evidence/build-path-recovery-held-in-evidence.ts";
export {
	buildSealedEvidenceBundle,
	type EvidenceBundleSource,
	type ProposalChangeBudget,
	type ProposalSchemaSummary,
	type RedactedRepresentativeTrace,
	type SealedEvidenceBundle,
	type SealedEvidenceBundleArtifact,
} from "./evidence/build-sealed-evidence-bundle.ts";
export {
	buildToolCodeHeldInEvidence,
	type ToolCodeHeldInEvidence,
} from "./evidence/build-tool-code-held-in-evidence.ts";
export {
	extractPathRecoveryFailureSignatures,
	type PathRecoveryFailureSignature,
	type SubsequentToolCall,
} from "./evidence/extract-path-recovery-failures.ts";
export {
	type ExtractToolFailureOptions,
	extractToolFailureSignatures,
	type ToolFailureSignature,
} from "./evidence/extract-tool-failures.ts";
export {
	loadRejectedHypothesesFromRuns,
	type RejectedHypothesis,
} from "./evidence/load-rejected-hypotheses-from-runs.ts";
export {
	type Experiment,
	type ExperimentBudget,
	type ExperimentLoadResult,
	type ExperimentValidationError,
	loadExperiment,
	type PromotionPolicy,
} from "./experiments/load-experiment.ts";
export { registerSelfPiSlashCommand } from "./extensions/selfpi-slash-command.ts";
export {
	type CreateGatewayOnlyNetworkOptions,
	createGatewayOnlyNetwork,
	type DockerProcessAdapter,
	GATEWAY_ONLY_NETWORK_DIGEST,
	type GatewayOnlyNetwork,
} from "./gateway/create-gateway-only-network.ts";
export { createFakeModelGatewayUpstream } from "./gateway/fake-model-gateway-upstream.ts";
export { createHttpModelGatewayUpstream } from "./gateway/http-model-gateway-upstream.ts";
export {
	type ModelGateway,
	type ModelGatewayRole,
	type ModelGatewaySession,
	type ModelGatewaySessionInput,
	type ModelGatewayUpstream,
	type ModelGatewayUpstreamInput,
	type ModelGatewayUpstreamResult,
	type StartModelGatewayOptions,
	startModelGateway,
} from "./gateway/model-gateway.ts";
export { costUsdForUsage, type ModelTokenPricing } from "./gateway/model-usage-cost.ts";
export {
	type StartSupervisedModelGatewayOptions,
	type SupervisedModelGateway,
	startSupervisedModelGateway,
} from "./gateway/start-supervised-model-gateway.ts";
export {
	createToolCodePackV1Experiment,
	type EditablePackSurfaces,
	findEditableProtectedOverlaps,
	TOOL_CODE_PACK_V1_EDITABLE_SURFACE,
	TOOL_CODE_PACK_V1_HELD_IN,
	TOOL_CODE_PACK_V1_HELD_OUT,
	TOOL_CODE_PACK_V1_ID,
	TOOL_CODE_PACK_V1_PROTECTED_SURFACE,
	toolCodePackV1Surfaces,
} from "./packs/tool-code-pack-v1.ts";
export {
	type CandidatePolicyInput,
	type CandidatePolicyResult,
	type CandidatePolicyViolation,
	evaluateCandidatePolicy,
} from "./policy/candidate-policy.ts";
export {
	createPathRecoveryExtension,
	type PathRecoveryPolicy,
} from "./policy/path-recovery-extension.ts";
export {
	decidePromotionRecommendation,
	type PromotionReason,
	type PromotionRecommendation,
	type PromotionRecommendationInput,
} from "./promotion/decide-promotion-recommendation.ts";
export {
	type CandidateImageBuilder,
	type CandidateSourceAdapter,
	type CandidateVersionRecord,
	createDockerCandidateImageBuilder,
	createGitCandidateSourceAdapter,
	type MaterializeCandidateVersionResult,
	type MaterializedCandidateSource,
	materializeCandidateVersion,
} from "./promotion/materialize-candidate-version.ts";
export {
	createGitPromotionReferenceAdapter,
	type PromoteRunInput,
	type PromoteRunResult,
	type PromotionReferenceAdapter,
	promoteRun,
	type RollbackVersionInput,
	type RollbackVersionResult,
	rollbackVersion,
} from "./promotion/promote-run.ts";
export {
	type CandidateProposalProvenance,
	createGitProposalWorktreeAdapter,
	type GenerateCandidateProposalInput,
	type GeneratedCandidateProposalResult,
	generateCandidateProposal,
	type ProposalGitAdapter,
	type ProposalModel,
	type ProposalWorktree,
	type ProposerProcessAdapter,
} from "./proposal/generate-candidate-proposal.ts";
export { createPiProposerProcessAdapter } from "./proposal/pi-proposer-process.ts";
export {
	type CandidateProposal,
	type CandidateProposalValidationResult,
	validateCandidateProposal,
} from "./proposal/validate-candidate-proposal.ts";
export {
	createRunRecordStore,
	type RunEvent,
	type RunManifest,
	type RunRecord,
	type RunRecordStore,
	type RunRecordStoreOptions,
	type RunState,
	type SmokeGateResult,
} from "./records/run-record.ts";
export {
	type CandidateReviewerAdapter,
	type CandidateReviewGateResult,
	type CandidateReviewInput,
	type CandidateReviewRecord,
	type CandidateReviewViolation,
	reviewCandidate,
} from "./review/candidate-review.ts";
export { createPiReviewerProcessAdapter } from "./review/pi-reviewer-process.ts";
export {
	createGatewayPiProposerAdapter,
	createGatewayPiReviewerAdapter,
} from "./supervised/gateway-pi-process-adapters.ts";
export {
	loadSupervisedSeamsFromEnvironment,
	type OpenSupervisedImprovementLifecycleInput,
	openSupervisedImprovementLifecycle,
	type SupervisedImprovementLifecycle,
	type SupervisedImprovementSeams,
} from "./supervised/open-supervised-improvement-lifecycle.ts";
export {
	createPinnedImagePiProposerAdapter,
	createPinnedImagePiReviewerAdapter,
} from "./supervised/pinned-image-pi-process-adapters.ts";
export {
	runSupervisedEvaluation,
	type SupervisedEvaluationAdapters,
	type SupervisedEvaluationInput,
} from "./supervised/run-supervised-evaluation.ts";
export {
	type RunSupervisedImprovementInput,
	runSupervisedImprovement,
	type SupervisedImprovementAdapters,
} from "./supervised/run-supervised-improvement.ts";
export {
	runSupervisedProposalAndReview,
	type SupervisedProposalAndReviewAdapters,
	type SupervisedProposalAndReviewInput,
} from "./supervised/run-supervised-proposal-and-review.ts";
