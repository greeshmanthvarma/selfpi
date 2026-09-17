import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "../security/redact.ts";

interface InspectionReportModel {
	readonly runId: string;
	readonly state: string;
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
}

export interface SelfPiCliOptions {
	readonly rootDirectory: string;
	readonly write: (text: string) => void;
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
	return Object.freeze({
		runId,
		state: manifest.state,
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
	});
}

export async function runSelfPiCli(args: readonly string[], options: SelfPiCliOptions): Promise<number> {
	if (args.length !== 2 || args[0] !== "inspect") {
		options.write("Usage: selfpi inspect <run-id>\n");
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
