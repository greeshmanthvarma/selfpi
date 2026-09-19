import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDeterministicRuntime } from "../config/load-runtime.ts";
import { runDeterministicImprovement } from "../deterministic/run-deterministic-improvement.ts";
import { loadExperiment } from "../experiments/load-experiment.ts";
import { type PromotionReferenceAdapter, promoteRun, rollbackVersion } from "../promotion/promote-run.ts";
import { redactSecrets } from "../security/redact.ts";
import {
	openSupervisedImprovementLifecycle,
	type SupervisedImprovementSeams,
} from "../supervised/open-supervised-improvement-lifecycle.ts";
import {
	runSupervisedImprovement,
	type SupervisedImprovementAdapters,
} from "../supervised/run-supervised-improvement.ts";

interface InspectionReportModel {
	readonly runId: string;
	readonly state: string;
	readonly evidenceClass?: string;
	readonly hypothesis: string;
	readonly changedSurface: readonly string[];
	readonly reviewDecision: string;
	readonly reviewRisks: readonly string[];
	readonly baseline: {
		readonly completions: number;
		readonly recoveryRate: number;
		readonly tokens: number;
		readonly costUsd: number;
	};
	readonly candidate: {
		readonly completions: number;
		readonly recoveryRate: number;
		readonly tokens: number;
		readonly costUsd: number;
	};
	readonly decision: string;
	readonly gatewayIdentity?: string;
	readonly proposerModel?: string;
	readonly reviewerModel?: string;
	readonly taskRegistryDigest?: string;
	readonly candidateVersion?: { readonly sourceCommit: string; readonly imageDigest: string };
}

export interface SelfPiCliOptions {
	readonly rootDirectory: string;
	readonly repositoryDirectory?: string;
	readonly write: (text: string) => void;
	readonly now?: () => Date;
	readonly createRunId?: () => string;
	readonly referenceAdapter?: PromotionReferenceAdapter;
	readonly supervisedAdapters?: SupervisedImprovementAdapters;
	readonly supervisedSeams?: SupervisedImprovementSeams;
}

function requireRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${name} is invalid.`);
	}
	return value as Readonly<Record<string, unknown>>;
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is invalid.`);
	return value;
}

function requireEvaluationRecord(value: Readonly<Record<string, unknown>>, name: string): void {
	const result = requireRecord(value.result, `${name} result`);
	const usage = requireRecord(result.usage, `${name} usage`);
	const verifier = requireRecord(result.verifier, `${name} verifier`);
	requireNumber(usage.totalTokens, `${name} total tokens`);
	if (typeof verifier.verifiedCompletion !== "boolean") {
		throw new Error(`${name} verified completion is invalid.`);
	}
}

function reportRows(model: InspectionReportModel): readonly (readonly [string, string])[] {
	return [
		["State", model.state],
		...(model.evidenceClass === undefined ? [] : ([["Evidence class", model.evidenceClass]] as const)),
		["Hypothesis", model.hypothesis],
		["Changed surface", model.changedSurface.join(", ")],
		["Review", model.reviewDecision],
		["Review risks", model.reviewRisks.join("; ") || "none"],
		[
			"Baseline",
			`${model.baseline.completions} completions, ${model.baseline.tokens} tokens, $${model.baseline.costUsd.toFixed(2)}`,
		],
		[
			"Candidate",
			`${model.candidate.completions} completions, ${model.candidate.tokens} tokens, $${model.candidate.costUsd.toFixed(2)}`,
		],
		["Recovery rate", `${model.baseline.recoveryRate} -> ${model.candidate.recoveryRate}`],
		["Decision", model.decision],
		...(model.gatewayIdentity === undefined ? [] : ([["Gateway", model.gatewayIdentity]] as const)),
		...(model.proposerModel === undefined ? [] : ([["Proposer model", model.proposerModel]] as const)),
		...(model.reviewerModel === undefined ? [] : ([["Reviewer model", model.reviewerModel]] as const)),
		...(model.taskRegistryDigest === undefined ? [] : ([["Task registry", model.taskRegistryDigest]] as const)),
		...(model.candidateVersion === undefined
			? []
			: ([
					["Candidate version", `${model.candidateVersion.sourceCommit} (${model.candidateVersion.imageDigest})`],
				] as const)),
	];
}

function renderTerminal(model: InspectionReportModel): string {
	return redactSecrets(
		`${[`Run: ${model.runId}`, ...reportRows(model).map(([label, value]) => `${label}: ${value}`)].join("\n")}\n`,
	);
}

function renderMarkdown(model: InspectionReportModel): string {
	return redactSecrets(
		`# SelfPi run ${model.runId}\n\n` +
			reportRows(model)
				.map(([label, value]) => `- ${label}: ${value}\n`)
				.join(""),
	);
}

async function loadInspectionReport(rootDirectory: string, runId: string): Promise<InspectionReportModel> {
	const directory = join(rootDirectory, "runs", runId);
	const names = [
		"manifest.json",
		"candidate-proposal.json",
		"review.json",
		"baseline-results.json",
		"candidate-results.json",
		"decision.json",
	] as const;
	const [manifest, proposal, review, baseline, candidate, decision] = await Promise.all(
		names.map(async (name) => {
			const value: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
			return requireRecord(value, name);
		}),
	);
	const [proposalProvenance, candidateVersion] = await Promise.all([
		readOptionalRecord(join(directory, "proposal-provenance.json")),
		readOptionalRecord(join(directory, "candidate-version.json")),
	]);
	if (
		typeof manifest.state !== "string" ||
		typeof proposal.hypothesis !== "string" ||
		!Array.isArray(proposal.affectedEditableSurface) ||
		!proposal.affectedEditableSurface.every((path) => typeof path === "string") ||
		typeof review.decision !== "string" ||
		!Array.isArray(review.risks) ||
		!review.risks.every((risk) => typeof risk === "string") ||
		typeof decision.decision !== "string"
	) {
		throw new Error("Run inspection records are invalid.");
	}
	requireEvaluationRecord(baseline, "baseline");
	requireEvaluationRecord(candidate, "candidate");
	const metrics = requireRecord(decision.metrics, "decision metrics");
	const outcomes = requireRecord(metrics.outcomes, "decision outcomes");
	const efficiency = requireRecord(metrics.efficiency, "decision efficiency");
	const fingerprintInputs = requireRecord(baseline.fingerprintInputs, "baseline fingerprint inputs");
	const taskIdentity =
		typeof fingerprintInputs.task === "object" &&
		fingerprintInputs.task !== null &&
		!Array.isArray(fingerprintInputs.task)
			? (fingerprintInputs.task as Readonly<Record<string, unknown>>)
			: undefined;
	return Object.freeze({
		runId,
		state: manifest.state,
		...(typeof manifest.evidenceClass === "string" ? { evidenceClass: manifest.evidenceClass } : {}),
		hypothesis: proposal.hypothesis,
		changedSurface: Object.freeze([...proposal.affectedEditableSurface]),
		reviewDecision: review.decision,
		reviewRisks: Object.freeze([...review.risks]),
		baseline: Object.freeze({
			completions: requireNumber(outcomes.baselineHeldInCompletions, "baseline completions"),
			recoveryRate: requireNumber(outcomes.baselineRecoveryRate, "baseline recovery rate"),
			tokens: requireNumber(efficiency.baselineTokens, "baseline tokens"),
			costUsd: requireNumber(efficiency.baselineCostUsd, "baseline cost"),
		}),
		candidate: Object.freeze({
			completions: requireNumber(outcomes.candidateHeldInCompletions, "candidate completions"),
			recoveryRate: requireNumber(outcomes.candidateRecoveryRate, "candidate recovery rate"),
			tokens: requireNumber(efficiency.candidateTokens, "candidate tokens"),
			costUsd: requireNumber(efficiency.candidateCostUsd, "candidate cost"),
		}),
		decision: decision.decision,
		...(typeof proposalProvenance?.gatewayIdentity === "string"
			? { gatewayIdentity: proposalProvenance.gatewayIdentity }
			: {}),
		...(typeof proposalProvenance?.model === "string" ? { proposerModel: proposalProvenance.model } : {}),
		...(typeof review.reviewerModel === "string" ? { reviewerModel: review.reviewerModel } : {}),
		...(typeof taskIdentity?.setVersion === "string" ? { taskRegistryDigest: taskIdentity.setVersion } : {}),
		...(typeof candidateVersion?.sourceCommit === "string" && typeof candidateVersion.imageDigest === "string"
			? {
					candidateVersion: Object.freeze({
						sourceCommit: candidateVersion.sourceCommit,
						imageDigest: candidateVersion.imageDigest,
					}),
				}
			: {}),
	});
}

async function readOptionalRecord(targetPath: string): Promise<Readonly<Record<string, unknown>> | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(targetPath, "utf8"));
		return requireRecord(value, targetPath);
	} catch {
		return undefined;
	}
}

export async function runSelfPiCli(args: readonly string[], options: SelfPiCliOptions): Promise<number> {
	if (args.length === 2 && args[0] === "improve") {
		if (options.repositoryDirectory === undefined || options.referenceAdapter === undefined) {
			options.write("SelfPi improve requires a configured repository and active reference.\n");
			return 1;
		}
		const experimentResult = await loadExperiment(join(options.rootDirectory, "experiments", `${args[1]}.json`));
		if (!experimentResult.ok) {
			options.write(`${experimentResult.errors[0]?.message ?? "Experiment configuration is invalid."}\n`);
			return 1;
		}
		if (experimentResult.experiment.id !== args[1]) {
			options.write(`Experiment file does not declare ${args[1]}.\n`);
			return 1;
		}
		const runtimePath = join(options.rootDirectory, "runtime.json");
		let runtimeMode: unknown;
		try {
			runtimeMode = requireRecord(JSON.parse(await readFile(runtimePath, "utf8")), "Runtime configuration").mode;
		} catch {
			options.write(`Runtime configuration could not be read: ${runtimePath}.\n`);
			return 1;
		}
		const runId = options.createRunId?.() ?? `run-${randomUUID()}`;
		if (runtimeMode === "supervised_v0") {
			const now = options.now ?? (() => new Date());
			if (options.supervisedAdapters !== undefined) {
				const run = await runSupervisedImprovement(
					{
						rootDirectory: options.rootDirectory,
						repositoryDirectory: options.repositoryDirectory,
						experimentId: args[1],
						runId,
						now,
						referenceAdapter: options.referenceAdapter,
					},
					options.supervisedAdapters,
				);
				options.write(`Run ${runId}: ${run.manifest.state} (supervised real evidence).\n`);
				return 0;
			}
			if (options.supervisedSeams === undefined) {
				options.write("SelfPi supervised improve requires configured supervisor adapters.\n");
				return 1;
			}
			const lifecycle = await openSupervisedImprovementLifecycle({
				rootDirectory: options.rootDirectory,
				repositoryDirectory: options.repositoryDirectory,
				runId,
				now,
				seams: options.supervisedSeams,
				experimentId: args[1],
			});
			try {
				const run = await runSupervisedImprovement(
					{
						rootDirectory: options.rootDirectory,
						repositoryDirectory: options.repositoryDirectory,
						experimentId: args[1],
						runId,
						now,
						referenceAdapter: options.referenceAdapter,
					},
					lifecycle.adapters,
				);
				options.write(`Run ${runId}: ${run.manifest.state} (supervised real evidence).\n`);
				return 0;
			} finally {
				await lifecycle.close();
			}
		}
		const runtimeResult = await loadDeterministicRuntime(runtimePath);
		if (!runtimeResult.ok) {
			options.write(`${runtimeResult.message}\n`);
			return 1;
		}
		const run = await runDeterministicImprovement({
			rootDirectory: options.rootDirectory,
			repositoryDirectory: options.repositoryDirectory,
			runId,
			now: options.now ?? (() => new Date()),
			experiment: experimentResult.experiment,
			runtime: runtimeResult.runtime,
			referenceAdapter: options.referenceAdapter,
		});
		options.write(`Run ${runId}: ${run.manifest.state} (deterministic engineering evidence).\n`);
		return 0;
	}
	if (args.length === 2 && args[0] === "promote") {
		if (options.referenceAdapter === undefined) {
			options.write("SelfPi promote requires a configured active reference.\n");
			return 1;
		}
		const result = await promoteRun({
			rootDirectory: options.rootDirectory,
			runId: args[1],
			now: options.now ?? (() => new Date()),
			referenceAdapter: options.referenceAdapter,
		});
		if (!result.promoted) {
			options.write(
				result.reason === "engineering_evidence_only"
					? `Run ${args[1]} contains deterministic engineering evidence and cannot be promoted.\n`
					: `Run ${args[1]} is not eligible for promotion.\n`,
			);
			return 1;
		}
		options.write(`Promoted ${result.sourceCommit} (${result.imageDigest}).\n`);
		return 0;
	}
	if (args.length === 2 && args[0] === "rollback") {
		if (options.referenceAdapter === undefined) {
			options.write("SelfPi rollback requires a configured active reference.\n");
			return 1;
		}
		const result = await rollbackVersion({
			rootDirectory: options.rootDirectory,
			version: args[1],
			now: options.now ?? (() => new Date()),
			referenceAdapter: options.referenceAdapter,
		});
		if (!result.rolledBack) {
			options.write(
				result.reason === "unrecorded"
					? `Version ${args[1]} is not a recorded harness version.\n`
					: `Version ${args[1]} is an ambiguous harness version.\n`,
			);
			return 1;
		}
		options.write(`Rolled back to ${result.sourceCommit} (${result.imageDigest}).\n`);
		return 0;
	}
	if (args.length !== 2 || args[0] !== "inspect") {
		options.write("Usage: selfpi <improve|inspect|promote|rollback> <experiment-run-or-version>\n");
		return 2;
	}
	const runId = args[1];
	const directory = join(options.rootDirectory, "runs", runId);
	const model = await loadInspectionReport(options.rootDirectory, runId);
	const terminal = renderTerminal(model);
	const report = renderMarkdown(model);
	await writeFile(join(directory, "report.md"), report, "utf8");
	options.write(terminal);
	return 0;
}
