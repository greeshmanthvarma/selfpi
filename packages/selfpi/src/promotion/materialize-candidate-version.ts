import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateCandidateProposal } from "../proposal/validate-candidate-proposal.ts";
import { createRunRecordStore } from "../records/run-record.ts";

const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface MaterializedCandidateSource {
	readonly directory: string;
	readonly sourceCommit: string;
	readonly candidateReference: string;
}

export interface CandidateSourceAdapter {
	materialize(input: {
		readonly predecessorCommit: string;
		readonly unifiedDiff: string;
		readonly candidateReference: string;
		readonly commitMessage: string;
		readonly committedAt: string;
	}): Promise<MaterializedCandidateSource>;
	release(input: {
		readonly candidate: MaterializedCandidateSource;
		readonly retainReference: boolean;
	}): Promise<void>;
}

export interface CandidateImageBuilder {
	build(input: {
		readonly contextDirectory: string;
		readonly sourceCommit: string;
		readonly predecessorCommit: string;
		readonly labels: Readonly<Record<string, string>>;
	}): Promise<{
		readonly imageDigest: string;
		readonly labels: Readonly<Record<string, string>>;
	}>;
}

export interface CandidateVersionRecord {
	readonly version: 1;
	readonly runId: string;
	readonly sourceCommit: string;
	readonly predecessorCommit: string;
	readonly imageDigest: string;
	readonly candidateReference: string;
	readonly createdAt: string;
	readonly labels: Readonly<Record<string, string>>;
}

export type MaterializeCandidateVersionResult =
	| { readonly materialized: false; readonly reason: "not_recommended" }
	| { readonly materialized: true; readonly version: CandidateVersionRecord };

interface CommandResult {
	readonly stdout: string;
	readonly stderr: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runCommand(input: {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly standardInput?: string;
	readonly environment?: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
	const child = spawn(input.executable, [...input.args], {
		cwd: input.cwd,
		env: input.environment,
		stdio: [input.standardInput === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
	if (input.standardInput !== undefined) child.stdin?.end(input.standardInput);
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	const result = Object.freeze({
		stdout: Buffer.concat(stdoutChunks).toString("utf8"),
		stderr: Buffer.concat(stderrChunks).toString("utf8"),
	});
	if (exitCode !== 0) {
		throw new Error(result.stderr.trim() || `${input.executable} exited with ${String(exitCode)}.`);
	}
	return result;
}

export function createGitCandidateSourceAdapter(options: {
	readonly repositoryDirectory: string;
	readonly worktreeRoot: string;
}): CandidateSourceAdapter {
	return {
		async materialize(input) {
			await mkdir(options.worktreeRoot, { recursive: true });
			const directory = path.join(options.worktreeRoot, randomUUID());
			let worktreeCreated = false;
			let candidateReferenceCreated = false;
			let sourceCommit = "";
			try {
				await runCommand({
					executable: "git",
					args: ["worktree", "add", "--detach", directory, input.predecessorCommit],
					cwd: options.repositoryDirectory,
				});
				worktreeCreated = true;
				await runCommand({
					executable: "git",
					args: ["apply", "--whitespace=nowarn", "-"],
					cwd: directory,
					standardInput: input.unifiedDiff,
				});
				await runCommand({ executable: "git", args: ["add", "--all"], cwd: directory });
				const tree = (await runCommand({ executable: "git", args: ["write-tree"], cwd: directory })).stdout.trim();
				const commit = await runCommand({
					executable: "git",
					args: ["commit-tree", tree, "-p", input.predecessorCommit],
					cwd: directory,
					standardInput: `${input.commitMessage}\n`,
					environment: {
						...process.env,
						GIT_AUTHOR_NAME: "SelfPi Supervisor",
						GIT_AUTHOR_EMAIL: "selfpi@localhost",
						GIT_AUTHOR_DATE: input.committedAt,
						GIT_COMMITTER_NAME: "SelfPi Supervisor",
						GIT_COMMITTER_EMAIL: "selfpi@localhost",
						GIT_COMMITTER_DATE: input.committedAt,
					},
				});
				sourceCommit = commit.stdout.trim();
				if (!commitPattern.test(sourceCommit) || sourceCommit === input.predecessorCommit) {
					throw new Error("Candidate source commit is invalid.");
				}
				await runCommand({
					executable: "git",
					args: ["update-ref", input.candidateReference, sourceCommit, "0".repeat(sourceCommit.length)],
					cwd: options.repositoryDirectory,
				});
				candidateReferenceCreated = true;
				await runCommand({ executable: "git", args: ["reset", "--hard", sourceCommit], cwd: directory });
				return Object.freeze({ directory, sourceCommit, candidateReference: input.candidateReference });
			} catch (error) {
				if (candidateReferenceCreated) {
					await runCommand({
						executable: "git",
						args: ["update-ref", "-d", input.candidateReference, sourceCommit],
						cwd: options.repositoryDirectory,
					}).catch(() => undefined);
				}
				if (worktreeCreated) {
					await runCommand({
						executable: "git",
						args: ["worktree", "remove", "--force", directory],
						cwd: options.repositoryDirectory,
					}).catch(() => undefined);
				} else {
					await rm(directory, { recursive: true, force: true });
				}
				throw error;
			}
		},
		async release(input) {
			await runCommand({
				executable: "git",
				args: ["worktree", "remove", "--force", input.candidate.directory],
				cwd: options.repositoryDirectory,
			});
			if (!input.retainReference) {
				await runCommand({
					executable: "git",
					args: ["update-ref", "-d", input.candidate.candidateReference, input.candidate.sourceCommit],
					cwd: options.repositoryDirectory,
				});
			}
		},
	};
}

export function createDockerCandidateImageBuilder(options?: {
	readonly executable?: string;
	readonly baseArgs?: readonly string[];
	readonly dockerfilePath?: string;
	readonly environment?: Readonly<Record<string, string>>;
}): CandidateImageBuilder {
	return {
		async build(input) {
			const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-image-build-"));
			const imageIdPath = path.join(temporaryDirectory, "image-id");
			const executable = options?.executable ?? "docker";
			const environment =
				options?.environment === undefined
					? undefined
					: {
							PATH: process.env.PATH ?? "",
							...options.environment,
						};
			try {
				const args = [
					...(options?.baseArgs ?? []),
					"build",
					"--iidfile",
					imageIdPath,
					"--build-arg",
					`SOURCE_COMMIT=${input.sourceCommit}`,
					"--build-arg",
					`PREDECESSOR_COMMIT=${input.predecessorCommit}`,
				];
				for (const [name, value] of Object.entries(input.labels).sort(([left], [right]) =>
					left.localeCompare(right),
				)) {
					args.push("--label", `${name}=${value}`);
				}
				args.push("--file", options?.dockerfilePath ?? "packages/selfpi/Dockerfile", input.contextDirectory);
				await runCommand({ executable, args, cwd: input.contextDirectory, environment });
				const imageDigest = (await readFile(imageIdPath, "utf8")).trim();
				if (!digestPattern.test(imageDigest)) throw new Error("Candidate image digest is invalid.");
				const inspection = await runCommand({
					executable,
					args: [
						...(options?.baseArgs ?? []),
						"image",
						"inspect",
						"--format",
						"{{json .Config.Labels}}",
						imageDigest,
					],
					cwd: input.contextDirectory,
					environment,
				});
				const inspectedValue: unknown = JSON.parse(inspection.stdout);
				if (!isRecord(inspectedValue)) throw new Error("Candidate image labels are invalid.");
				const labels = Object.freeze(
					Object.fromEntries(
						Object.entries(inspectedValue).filter(
							(entry): entry is [string, string] => typeof entry[1] === "string",
						),
					),
				);
				for (const [name, value] of Object.entries(input.labels)) {
					if (labels[name] !== value) throw new Error(`Candidate image label ${name} does not match.`);
				}
				return Object.freeze({ imageDigest, labels: input.labels });
			} finally {
				await rm(temporaryDirectory, { recursive: true, force: true });
			}
		},
	};
}

export async function materializeCandidateVersion(
	input: { readonly rootDirectory: string; readonly runId: string; readonly now: () => Date },
	adapters: { readonly source: CandidateSourceAdapter; readonly image: CandidateImageBuilder },
): Promise<MaterializeCandidateVersionResult> {
	if (!runIdPattern.test(input.runId)) throw new Error("Run ID is invalid.");
	const store = createRunRecordStore({ rootDirectory: input.rootDirectory, now: input.now });
	const run = await store.open(input.runId);
	if (run.manifest.state !== "promotion_recommended") {
		return Object.freeze({ materialized: false, reason: "not_recommended" });
	}

	const runDirectory = path.join(input.rootDirectory, "runs", input.runId);
	const [activeValue, proposalValue, provenanceValue] = await Promise.all([
		readJson(path.join(input.rootDirectory, "promotion", "active.json")),
		readJson(path.join(runDirectory, "candidate-proposal.json")),
		readJson(path.join(runDirectory, "proposal-provenance.json")),
	]);
	if (!isRecord(activeValue) || !isRecord(activeValue.current)) throw new Error("Active harness record is invalid.");
	const predecessorCommit = activeValue.current.sourceCommit;
	if (typeof predecessorCommit !== "string" || !commitPattern.test(predecessorCommit)) {
		throw new Error("Active harness record is invalid.");
	}
	const proposal = validateCandidateProposal(proposalValue);
	if (!proposal.ok) throw new Error("Candidate proposal is invalid.");
	if (
		!isRecord(provenanceValue) ||
		provenanceValue.activeHarnessCommit !== predecessorCommit ||
		provenanceValue.worktreeBase !== predecessorCommit
	) {
		throw new Error("Candidate proposal provenance does not match the active predecessor.");
	}

	const createdAt = input.now().toISOString();
	const candidateReference = `refs/selfpi/candidates/${input.runId}`;
	const candidate = await adapters.source.materialize({
		predecessorCommit,
		unifiedDiff: proposal.proposal.unifiedDiff,
		candidateReference,
		commitMessage: `feat: materialize SelfPi candidate ${input.runId}`,
		committedAt: createdAt,
	});
	let retainReference = false;
	try {
		if (
			!commitPattern.test(candidate.sourceCommit) ||
			candidate.sourceCommit === predecessorCommit ||
			candidate.candidateReference !== candidateReference
		) {
			throw new Error("Materialized candidate source does not match its requested identity.");
		}
		const labels = Object.freeze({
			"org.opencontainers.image.revision": candidate.sourceCommit,
			"works.selfpi.predecessor": predecessorCommit,
			"works.selfpi.run": input.runId,
		});
		const image = await adapters.image.build({
			contextDirectory: candidate.directory,
			sourceCommit: candidate.sourceCommit,
			predecessorCommit,
			labels,
		});
		if (!digestPattern.test(image.imageDigest) || !sameLabels(image.labels, labels)) {
			throw new Error("Candidate image identity does not match its source provenance.");
		}
		const version: CandidateVersionRecord = Object.freeze({
			version: 1,
			runId: input.runId,
			sourceCommit: candidate.sourceCommit,
			predecessorCommit,
			imageDigest: image.imageDigest,
			candidateReference,
			createdAt,
			labels,
		});
		await writeJson(path.join(runDirectory, "candidate-version.json"), version);
		retainReference = true;
		return Object.freeze({ materialized: true, version });
	} finally {
		await adapters.source.release({ candidate, retainReference });
	}
}

function sameLabels(actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): boolean {
	const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
	const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
	return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

async function readJson(targetPath: string): Promise<unknown> {
	return JSON.parse(await readFile(targetPath, "utf8"));
}

async function writeJson(targetPath: string, value: unknown): Promise<void> {
	const temporaryPath = `${targetPath}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temporaryPath, targetPath);
}
