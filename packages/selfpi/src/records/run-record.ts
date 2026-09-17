import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEvaluationFingerprint } from "../evaluation/baseline-cache.ts";
import type { HarnessAttemptComparison } from "../evaluation/compare-harness-attempts.ts";
import type { SealedEvidenceBundleArtifact } from "../evidence/build-sealed-evidence-bundle.ts";
import type { CandidatePolicyResult } from "../policy/candidate-policy.ts";
import type { PromotionRecommendation } from "../promotion/decide-promotion-recommendation.ts";
import type { GeneratedCandidateProposalResult } from "../proposal/generate-candidate-proposal.ts";
import type { CandidateReviewGateResult } from "../review/candidate-review.ts";
import { redactSensitiveValue } from "../security/redact.ts";

export type RunState =
	| "created"
	| "evidence_ready"
	| "proposal_generated"
	| "policy_passed"
	| "review_passed"
	| "smoke_passed"
	| "evaluation_complete"
	| "promotion_recommended"
	| "promoted"
	| "rolled_back"
	| "rejected"
	| "invalid";

export interface RunManifest {
	readonly version: 1;
	readonly runId: string;
	readonly experimentId: string;
	readonly state: RunState;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly evidenceBundleDigest?: string;
	readonly evidenceClass?: "deterministic_engineering";
}

export type RunEvent =
	| {
			readonly version: 1;
			readonly sequence: 1;
			readonly at: string;
			readonly type: "run_created";
			readonly state: "created";
	  }
	| {
			readonly version: 1;
			readonly sequence: number;
			readonly at: string;
			readonly type: "state_transitioned";
			readonly from: RunState;
			readonly state: RunState;
	  };

export interface RunRecord {
	readonly manifest: RunManifest;
	readonly events: readonly RunEvent[];
}

export interface RunRecordStore {
	create(input: {
		readonly runId: string;
		readonly experimentId: string;
		readonly evidenceClass?: "deterministic_engineering";
	}): Promise<RunRecord>;
	recordEvaluation(runId: string, comparison: HarnessAttemptComparison, attempts?: readonly unknown[]): Promise<void>;
	recordEvidenceBundle(runId: string, artifact: SealedEvidenceBundleArtifact): Promise<RunRecord>;
	recordCandidateProposal(runId: string, result: GeneratedCandidateProposalResult): Promise<void>;
	recordCandidatePolicy(runId: string, result: CandidatePolicyResult): Promise<void>;
	recordCandidateReview(runId: string, result: CandidateReviewGateResult): Promise<void>;
	recordSmokeResult(runId: string, result: SmokeGateResult): Promise<void>;
	recordDecision(runId: string, recommendation: PromotionRecommendation): Promise<void>;
	transition(runId: string, state: RunState): Promise<RunRecord>;
	open(runId: string): Promise<RunRecord>;
}

export interface SmokeGateResult {
	readonly buildPassed: boolean;
	readonly targetedTestsPassed: boolean;
	readonly smokePassed: boolean;
}

export interface RunRecordStoreOptions {
	readonly rootDirectory: string;
	readonly now: () => Date;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunState(value: unknown): value is RunState {
	return (
		value === "created" ||
		value === "evidence_ready" ||
		value === "proposal_generated" ||
		value === "policy_passed" ||
		value === "review_passed" ||
		value === "smoke_passed" ||
		value === "evaluation_complete" ||
		value === "promotion_recommended" ||
		value === "promoted" ||
		value === "rolled_back" ||
		value === "rejected" ||
		value === "invalid"
	);
}

function parseManifest(value: unknown): RunManifest {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.runId !== "string" ||
		typeof value.experimentId !== "string" ||
		!isRunState(value.state) ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string" ||
		(value.evidenceClass !== undefined && value.evidenceClass !== "deterministic_engineering")
	) {
		throw new Error("Run manifest is invalid.");
	}
	return Object.freeze({
		version: 1,
		runId: value.runId,
		experimentId: value.experimentId,
		state: value.state,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...(typeof value.evidenceBundleDigest === "string" ? { evidenceBundleDigest: value.evidenceBundleDigest } : {}),
		...(value.evidenceClass === "deterministic_engineering" ? { evidenceClass: value.evidenceClass } : {}),
	});
}

function parseEvent(value: unknown): RunEvent {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.sequence !== "number" ||
		typeof value.at !== "string" ||
		!isRunState(value.state)
	) {
		throw new Error("Run event is invalid.");
	}
	if (value.type === "run_created" && value.sequence === 1 && value.state === "created") {
		return Object.freeze({ version: 1, sequence: 1, at: value.at, type: "run_created", state: "created" });
	}
	if (value.type === "state_transitioned" && isRunState(value.from)) {
		return Object.freeze({
			version: 1,
			sequence: value.sequence,
			at: value.at,
			type: "state_transitioned",
			from: value.from,
			state: value.state,
		});
	}
	throw new Error("Run event is invalid.");
}

export function createRunRecordStore(options: RunRecordStoreOptions): RunRecordStore {
	const runDirectory = (runId: string) => path.join(options.rootDirectory, "runs", runId);

	const writeJson = async (targetPath: string, value: unknown): Promise<void> => {
		const temporaryPath = `${targetPath}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(redactSensitiveValue(value), null, 2)}\n`, "utf8");
		await rename(temporaryPath, targetPath);
	};

	const writeManifest = async (directory: string, manifest: RunManifest): Promise<void> => {
		await writeJson(path.join(directory, "manifest.json"), manifest);
	};

	const open = async (runId: string): Promise<RunRecord> => {
		const directory = runDirectory(runId);
		const [manifestSource, eventsSource] = await Promise.all([
			readFile(path.join(directory, "manifest.json"), "utf8"),
			readFile(path.join(directory, "events.jsonl"), "utf8"),
		]);
		const manifestValue: unknown = JSON.parse(manifestSource);
		const events = eventsSource
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => {
				const value: unknown = JSON.parse(line);
				return parseEvent(value);
			});
		return Object.freeze({ manifest: parseManifest(manifestValue), events: Object.freeze(events) });
	};
	const transition = async (runId: string, state: RunState): Promise<RunRecord> => {
		const current = await open(runId);
		const allowed: Readonly<Record<RunState, readonly RunState[]>> = {
			created: ["evidence_ready"],
			evidence_ready: ["proposal_generated", "invalid"],
			proposal_generated: ["policy_passed", "invalid"],
			policy_passed: ["review_passed", "rejected", "invalid"],
			review_passed: ["smoke_passed", "rejected", "invalid"],
			smoke_passed: ["evaluation_complete", "rejected", "invalid"],
			evaluation_complete: ["promotion_recommended", "rejected", "invalid"],
			promotion_recommended: ["promoted"],
			promoted: ["rolled_back"],
			rolled_back: [],
			rejected: [],
			invalid: [],
		};
		const valid = allowed[current.manifest.state].includes(state);
		if (!valid) {
			throw new Error(`Invalid run transition: ${current.manifest.state} -> ${state}.`);
		}
		const at = options.now().toISOString();
		const event: RunEvent = Object.freeze({
			version: 1,
			sequence: current.events.length + 1,
			at,
			type: "state_transitioned",
			from: current.manifest.state,
			state,
		});
		const manifest: RunManifest = Object.freeze({ ...current.manifest, state, updatedAt: at });
		const directory = runDirectory(runId);
		await appendFile(path.join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
		await writeManifest(directory, manifest);
		return Object.freeze({ manifest, events: Object.freeze([...current.events, event]) });
	};

	return {
		async create(input) {
			const directory = runDirectory(input.runId);
			await mkdir(path.dirname(directory), { recursive: true });
			await mkdir(directory);
			const at = options.now().toISOString();
			const manifest: RunManifest = Object.freeze({
				version: 1,
				runId: input.runId,
				experimentId: input.experimentId,
				state: "created",
				createdAt: at,
				updatedAt: at,
				...(input.evidenceClass === undefined ? {} : { evidenceClass: input.evidenceClass }),
			});
			const event: RunEvent = Object.freeze({
				version: 1,
				sequence: 1,
				at,
				type: "run_created",
				state: "created",
			});
			await writeManifest(directory, manifest);
			await writeFile(path.join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
			return Object.freeze({ manifest, events: Object.freeze([event]) });
		},

		async recordEvaluation(runId, comparison, attempts) {
			const current = await open(runId);
			if (current.manifest.state !== "created" && current.manifest.state !== "smoke_passed") {
				throw new Error(`Cannot record evaluation evidence for a run in state ${current.manifest.state}.`);
			}
			const baselineFingerprint = createEvaluationFingerprint(comparison.baseline.fingerprintInputs);
			const candidateFingerprint = createEvaluationFingerprint(comparison.candidate.fingerprintInputs);
			if (baselineFingerprint !== candidateFingerprint) {
				throw new Error("Cannot record evaluation evidence with different fingerprints.");
			}
			const directory = runDirectory(runId);
			if (current.manifest.state === "smoke_passed") {
				const provenanceValue: unknown = JSON.parse(
					await readFile(path.join(directory, "proposal-provenance.json"), "utf8"),
				);
				const provenance = isRecord(provenanceValue) ? provenanceValue : undefined;
				const harness = comparison.baseline.fingerprintInputs.harness;
				if (
					provenance === undefined ||
					typeof provenance.activeHarnessCommit !== "string" ||
					typeof provenance.worktreeBase !== "string" ||
					provenance.activeHarnessCommit !== provenance.worktreeBase ||
					provenance.worktreeBase !== harness.baselineCommit ||
					harness.baselineCommit !== harness.candidateParentCommit
				) {
					await writeJson(path.join(directory, "integrity-result.json"), {
						version: 1,
						valid: false,
						violation: "evaluation_provenance_mismatch",
					});
					await transition(runId, "invalid");
					throw new Error("Evaluation provenance does not match the proposal base.");
				}
				await writeJson(path.join(directory, "integrity-result.json"), { version: 1, valid: true });
			}
			const writes = [
				writeJson(path.join(directory, "baseline-results.json"), comparison.baseline),
				writeJson(path.join(directory, "candidate-results.json"), comparison.candidate),
				writeJson(path.join(directory, "comparison.json"), {
					version: 1,
					fingerprint: baselineFingerprint,
					baselineCompletions: comparison.baselineCompletions,
					candidateCompletions: comparison.candidateCompletions,
					completionGain: comparison.completionGain,
				}),
			];
			if (attempts !== undefined) {
				writes.push(
					writeJson(path.join(directory, "evaluation-attempts.json"), {
						version: 1,
						attempts,
					}),
				);
			}
			await Promise.all(writes);
			if (current.manifest.state === "smoke_passed") {
				await transition(runId, "evaluation_complete");
			}
		},

		async recordEvidenceBundle(runId, artifact) {
			const current = await open(runId);
			const directory = runDirectory(runId);
			await writeJson(path.join(directory, "evidence-bundle.json"), artifact.bundle);
			const manifest: RunManifest = Object.freeze({
				...current.manifest,
				evidenceBundleDigest: artifact.digest,
				updatedAt: options.now().toISOString(),
			});
			await writeManifest(directory, manifest);
			return Object.freeze({ manifest, events: current.events });
		},

		async recordCandidateProposal(runId, result) {
			const current = await open(runId);
			if (current.manifest.state !== "evidence_ready") {
				throw new Error(`Cannot record a proposal for a run in state ${current.manifest.state}.`);
			}
			const directory = runDirectory(runId);
			await Promise.all([
				writeJson(
					path.join(directory, "candidate-proposal.json"),
					result.ok ? result.proposal : { version: 1, errors: result.errors },
				),
				writeJson(path.join(directory, "proposal-provenance.json"), result.provenance),
			]);
			await transition(runId, result.ok ? "proposal_generated" : "invalid");
		},

		async recordCandidatePolicy(runId, result) {
			const current = await open(runId);
			if (current.manifest.state !== "proposal_generated") {
				throw new Error(`Cannot record candidate policy for a run in state ${current.manifest.state}.`);
			}
			await writeJson(path.join(runDirectory(runId), "policy-result.json"), result);
			await transition(runId, result.eligible ? "policy_passed" : "invalid");
		},

		async recordCandidateReview(runId, result) {
			const current = await open(runId);
			if (current.manifest.state !== "policy_passed") {
				throw new Error(`Cannot record candidate review for a run in state ${current.manifest.state}.`);
			}
			await writeJson(
				path.join(runDirectory(runId), "review.json"),
				"review" in result ? result.review : { version: 1, error: result.error },
			);
			await transition(runId, "error" in result ? "invalid" : result.proceed ? "review_passed" : "rejected");
		},

		async recordSmokeResult(runId, result) {
			const current = await open(runId);
			if (current.manifest.state !== "review_passed") {
				throw new Error(`Cannot record smoke results for a run in state ${current.manifest.state}.`);
			}
			await writeJson(path.join(runDirectory(runId), "smoke-result.json"), { version: 1, ...result });
			await transition(
				runId,
				result.buildPassed && result.targetedTestsPassed && result.smokePassed ? "smoke_passed" : "rejected",
			);
		},

		async recordDecision(runId, recommendation) {
			const current = await open(runId);
			if (current.manifest.state !== "evaluation_complete") {
				throw new Error(`Cannot record a decision for a run in state ${current.manifest.state}.`);
			}
			await writeJson(path.join(runDirectory(runId), "decision.json"), recommendation);
			await transition(runId, recommendation.decision);
		},

		transition,

		open,
	};
}
