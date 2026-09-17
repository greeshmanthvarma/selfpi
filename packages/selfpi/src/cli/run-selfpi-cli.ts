import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

function redactSecrets(text: string): string {
	return text
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
		.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
		.replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]");
}

function renderTerminal(model: InspectionReportModel): string {
	return redactSecrets(
		`${[
			`Run: ${model.runId}`,
			`State: ${model.state}`,
			`Hypothesis: ${model.hypothesis}`,
			`Changed surface: ${model.changedSurface.join(", ")}`,
			`Review: ${model.reviewDecision}`,
			`Review risks: ${model.reviewRisks.join("; ") || "none"}`,
			`Baseline: ${model.baseline.completions} completions, ${model.baseline.tokens} tokens, $${model.baseline.costUsd.toFixed(2)}`,
			`Candidate: ${model.candidate.completions} completions, ${model.candidate.tokens} tokens, $${model.candidate.costUsd.toFixed(2)}`,
			`Recovery rate: ${model.baseline.recoveryRate} -> ${model.candidate.recoveryRate}`,
			`Decision: ${model.decision}`,
		].join("\n")}\n`,
	);
}

function renderMarkdown(model: InspectionReportModel): string {
	return redactSecrets(
		`# SelfPi run ${model.runId}\n\n` +
			`- State: ${model.state}\n` +
			`- Hypothesis: ${model.hypothesis}\n` +
			`- Changed surface: ${model.changedSurface.join(", ")}\n` +
			`- Review: ${model.reviewDecision}\n` +
			`- Review risks: ${model.reviewRisks.join("; ") || "none"}\n` +
			`- Baseline: ${model.baseline.completions} completions, ${model.baseline.tokens} tokens, $${model.baseline.costUsd.toFixed(2)}\n` +
			`- Candidate: ${model.candidate.completions} completions, ${model.candidate.tokens} tokens, $${model.candidate.costUsd.toFixed(2)}\n` +
			`- Recovery rate: ${model.baseline.recoveryRate} -> ${model.candidate.recoveryRate}\n` +
			`- Decision: ${model.decision}\n`,
	);
}

export async function runSelfPiCli(args: readonly string[], options: SelfPiCliOptions): Promise<number> {
	if (args.length !== 2 || args[0] !== "inspect") {
		options.write("Usage: selfpi inspect <run-id>\n");
		return 2;
	}
	const runId = args[1];
	const directory = join(options.rootDirectory, "runs", runId);
	const names = [
		"manifest.json",
		"candidate-proposal.json",
		"review.json",
		"baseline-results.json",
		"candidate-results.json",
		"decision.json",
	] as const;
	const values = await Promise.all(
		names.map(async (name) => {
			const value: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
			return requireRecord(value, name);
		}),
	);
	const [manifest, proposal, review, baseline, candidate, decision] = values;
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
	const model: InspectionReportModel = Object.freeze({
		runId,
		state: manifest.state,
		hypothesis: proposal.hypothesis,
		changedSurface: Object.freeze([...proposal.affectedEditableSurface]),
		reviewDecision: review.decision,
		reviewRisks: Object.freeze([...review.risks]),
		baseline: Object.freeze({
			completions: requireNumber(baseline.completions, "baseline completions"),
			recoveryRate: requireNumber(baseline.recoveryRate, "baseline recovery rate"),
			tokens: requireNumber(baseline.tokens, "baseline tokens"),
			costUsd: requireNumber(baseline.costUsd, "baseline cost"),
		}),
		candidate: Object.freeze({
			completions: requireNumber(candidate.completions, "candidate completions"),
			recoveryRate: requireNumber(candidate.recoveryRate, "candidate recovery rate"),
			tokens: requireNumber(candidate.tokens, "candidate tokens"),
			costUsd: requireNumber(candidate.costUsd, "candidate cost"),
		}),
		decision: decision.decision,
	});
	const terminal = renderTerminal(model);
	const report = renderMarkdown(model);
	await writeFile(join(directory, "report.md"), report, "utf8");
	options.write(terminal);
	return 0;
}
