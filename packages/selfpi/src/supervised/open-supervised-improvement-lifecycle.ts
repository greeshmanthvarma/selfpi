import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
	loadSupervisedRuntime,
	type ProtectedTaskRegistry,
	type SupervisedRuntime,
} from "../config/load-supervised-runtime.ts";
import type { ImprovementEvaluationResult } from "../controller/run-improvement-cycle.ts";
import { withCandidateWorktree } from "../deterministic/candidate-worktree.ts";
import { createDockerHarnessRunner } from "../evaluation/docker-harness-runner.ts";
import { createExecDockerProcessAdapter } from "../evaluation/exec-docker-process-adapter.ts";
import { loadProtectedEvaluationTask } from "../evaluation/load-protected-evaluation-task.ts";
import { buildSealedEvidenceBundle } from "../evidence/build-sealed-evidence-bundle.ts";
import { type Experiment, loadExperiment } from "../experiments/load-experiment.ts";
import type { DockerProcessAdapter } from "../gateway/create-gateway-only-network.ts";
import type { ModelGateway, ModelGatewaySession, ModelGatewayUpstream } from "../gateway/model-gateway.ts";
import { costUsdForUsage, type ModelTokenPricing } from "../gateway/model-usage-cost.ts";
import { type SupervisedModelGateway, startSupervisedModelGateway } from "../gateway/start-supervised-model-gateway.ts";
import {
	createDockerCandidateImageBuilder,
	createGitCandidateSourceAdapter,
} from "../promotion/materialize-candidate-version.ts";
import { createGitProposalWorktreeAdapter } from "../proposal/generate-candidate-proposal.ts";
import type { CandidateProposal } from "../proposal/validate-candidate-proposal.ts";
import {
	createPinnedImagePiProposerAdapter,
	createPinnedImagePiReviewerAdapter,
} from "./pinned-image-pi-process-adapters.ts";
import { runSupervisedEvaluation } from "./run-supervised-evaluation.ts";
import type { SupervisedImprovementAdapters } from "./run-supervised-improvement.ts";

const executeFile = promisify(execFile);
const candidatePath = "packages/selfpi-recovery-policy/src/index.ts";
const policyTestPath = "packages/selfpi-recovery-policy/test/path-recovery-policy.test.ts";

export interface SupervisedImprovementSeams {
	readonly dockerCommand: string;
	readonly dockerBaseArgs?: readonly string[];
	readonly providerCredentials: Readonly<Record<string, string>>;
	readonly upstream: ModelGatewayUpstream;
	readonly pricing: Readonly<Record<string, ModelTokenPricing>>;
	readonly hostEnvironment?: Readonly<Record<string, string>>;
	readonly evaluationResources?: { readonly cpuLimit: number; readonly memoryMb: number };
	readonly activeImageRepository?: string;
	readonly evaluationImageRepository?: string;
}

export interface OpenSupervisedImprovementLifecycleInput {
	readonly rootDirectory: string;
	readonly repositoryDirectory: string;
	readonly runId: string;
	readonly now: () => Date;
	readonly seams: SupervisedImprovementSeams;
}

export interface SupervisedImprovementLifecycle {
	readonly adapters: SupervisedImprovementAdapters;
	close(): Promise<void>;
}

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function imageReference(repository: string, imageDigest: string): string {
	return `${repository}@${imageDigest}`;
}

function pricingFor(
	pricing: Readonly<Record<string, ModelTokenPricing>>,
	provider: string,
	model: string,
): ModelTokenPricing {
	const exact = pricing[`${provider}/${model}`] ?? pricing[provider] ?? pricing["*"];
	if (exact === undefined) throw new Error(`Model pricing is missing for ${provider}/${model}.`);
	return exact;
}

async function commandPassed(
	command: string,
	args: readonly string[],
	cwd: string,
	timeoutMs: number,
): Promise<boolean> {
	try {
		await executeFile(command, [...args], { cwd, timeout: timeoutMs, killSignal: "SIGKILL" });
		return true;
	} catch {
		return false;
	}
}

async function loadConfiguredExperiment(rootDirectory: string): Promise<Experiment> {
	const names = await readdir(path.join(rootDirectory, "experiments"));
	const first = names.find((name) => name.endsWith(".json"));
	if (first === undefined) throw new Error("Supervised experiment configuration is missing.");
	const loaded = await loadExperiment(path.join(rootDirectory, "experiments", first));
	if (!loaded.ok) throw new Error(loaded.errors[0]?.message ?? "Experiment configuration is invalid.");
	return loaded.experiment;
}

async function loadRuntime(
	rootDirectory: string,
	experiment: Experiment,
): Promise<{ readonly runtime: SupervisedRuntime; readonly taskRegistry: ProtectedTaskRegistry }> {
	const runtimeResult = await loadSupervisedRuntime({
		runtimePath: path.join(rootDirectory, "runtime.json"),
		activeVersionPath: path.join(rootDirectory, "promotion", "active.json"),
		taskRegistryPath: path.join(rootDirectory, "task-registry.json"),
		experiment,
	});
	if (!runtimeResult.ok) throw new Error(runtimeResult.message);
	return Object.freeze({ runtime: runtimeResult.runtime, taskRegistry: runtimeResult.taskRegistry });
}

async function materializeHarnessSource(input: {
	readonly repositoryDirectory: string;
	readonly commit: string;
	readonly targetDirectory: string;
}): Promise<void> {
	await rm(input.targetDirectory, { recursive: true, force: true });
	await mkdir(input.targetDirectory, { recursive: true });
	const archive = await executeFile("git", ["archive", "--format=tar", input.commit], {
		cwd: input.repositoryDirectory,
		encoding: "buffer",
		maxBuffer: 64 * 1024 * 1024,
	});
	await new Promise<void>((resolve, reject) => {
		const child = execFile("tar", ["-xf", "-", "-C", input.targetDirectory], (error) => {
			if (error) reject(error);
			else resolve();
		});
		child.stdin?.end(archive.stdout);
	});
}

function evaluationGateway(supervised: SupervisedModelGateway): ModelGateway {
	return Object.freeze({
		baseEndpoint: supervised.gateway.baseEndpoint,
		issueSession: async (sessionInput: Parameters<ModelGateway["issueSession"]>[0]) =>
			supervised.forContainer(await supervised.gateway.issueSession(sessionInput)),
		revokeSession: (sessionId: string) => supervised.gateway.revokeSession(sessionId),
		close: () => supervised.gateway.close(),
	});
}

export async function openSupervisedImprovementLifecycle(
	input: OpenSupervisedImprovementLifecycleInput,
): Promise<SupervisedImprovementLifecycle> {
	const docker: DockerProcessAdapter = createExecDockerProcessAdapter({
		executable: input.seams.dockerCommand,
		baseArgs: input.seams.dockerBaseArgs,
		environment: input.seams.hostEnvironment,
	});
	const supervised = await startSupervisedModelGateway({
		runId: input.runId,
		now: input.now,
		auditPath: path.join(input.rootDirectory, "gateway-audits", `${input.runId}.jsonl`),
		providerCredentials: input.seams.providerCredentials,
		upstream: input.seams.upstream,
		docker,
	});
	const worktreeRoot = path.join(input.rootDirectory, "worktrees", input.runId);
	const agentRoot = path.join(input.rootDirectory, "agent-dirs", input.runId);
	const harnessRoot = path.join(input.rootDirectory, "harness-sources", input.runId);
	const hostEnvironment = input.seams.hostEnvironment ?? { PATH: process.env.PATH ?? "" };
	const resources = input.seams.evaluationResources ?? { cpuLimit: 1, memoryMb: 512 };
	const activeImageRepository = input.seams.activeImageRepository ?? "selfpi-active";
	const evaluationImageRepository = input.seams.evaluationImageRepository ?? "selfpi-eval";
	const runner = createDockerHarnessRunner({
		dockerCommand: input.seams.dockerCommand,
		baseArgs: input.seams.dockerBaseArgs,
		hostEnvironment,
		allowedHostRoot: input.rootDirectory,
	});

	const adapters: SupervisedImprovementAdapters = {
		gateway: supervised.gateway,
		proposalGit: createGitProposalWorktreeAdapter({
			repositoryDirectory: input.repositoryDirectory,
			worktreeRoot: path.join(worktreeRoot, "proposal"),
		}),
		async createProposer(session: ModelGatewaySession) {
			const { runtime } = await loadRuntime(
				input.rootDirectory,
				await loadConfiguredExperiment(input.rootDirectory),
			);
			return createPinnedImagePiProposerAdapter({
				runtime,
				session: supervised.forContainer(session),
				image: imageReference(activeImageRepository, runtime.activeVersion.imageDigest),
				networkName: supervised.network.name,
				dockerCommand: input.seams.dockerCommand,
				dockerBaseArgs: input.seams.dockerBaseArgs,
				agentDirectory: path.join(agentRoot, "proposer"),
				environment: hostEnvironment,
			});
		},
		checks: {
			async run(candidate) {
				const { runtime } = await loadRuntime(
					input.rootDirectory,
					await loadConfiguredExperiment(input.rootDirectory),
				);
				try {
					return await withCandidateWorktree({
						repositoryDirectory: input.repositoryDirectory,
						worktreeRoot: path.join(worktreeRoot, "checks"),
						baselineCommit: runtime.activeVersion.sourceCommit,
						unifiedDiff: candidate.unifiedDiff,
						run: async (directory) => {
							await cp(
								path.join(input.repositoryDirectory, policyTestPath),
								path.join(directory, policyTestPath),
								{
									force: true,
								},
							);
							await commandPassed(
								path.join(input.repositoryDirectory, "node_modules/@biomejs/biome/bin/biome"),
								["check", "--write", candidatePath],
								directory,
								60_000,
							);
							const formatting = await commandPassed(
								path.join(input.repositoryDirectory, "node_modules/@biomejs/biome/bin/biome"),
								["check", candidatePath],
								directory,
								60_000,
							);
							const typeChecking = await commandPassed(
								path.join(input.repositoryDirectory, "node_modules/.bin/tsgo"),
								["--noEmit", "-p", "packages/selfpi-recovery-policy/tsconfig.json"],
								directory,
								60_000,
							);
							const targetedTestsPassed = await commandPassed(
								process.execPath,
								[
									path.join(input.repositoryDirectory, "node_modules/vitest/dist/cli.js"),
									"--run",
									policyTestPath,
								],
								directory,
								60_000,
							);
							return { appliesCleanly: true, formatting, typeChecking, targetedTestsPassed };
						},
					});
				} catch {
					return {
						appliesCleanly: false,
						formatting: false,
						typeChecking: false,
						targetedTestsPassed: false,
					};
				}
			},
		},
		async createReviewer(session: ModelGatewaySession) {
			const { runtime } = await loadRuntime(
				input.rootDirectory,
				await loadConfiguredExperiment(input.rootDirectory),
			);
			const reviewDirectory = path.join(worktreeRoot, "reviewer-source");
			await materializeHarnessSource({
				repositoryDirectory: input.repositoryDirectory,
				commit: runtime.activeVersion.sourceCommit,
				targetDirectory: reviewDirectory,
			});
			return createPinnedImagePiReviewerAdapter({
				runtime,
				session: supervised.forContainer(session),
				image: imageReference(activeImageRepository, runtime.activeVersion.imageDigest),
				networkName: supervised.network.name,
				dockerCommand: input.seams.dockerCommand,
				dockerBaseArgs: input.seams.dockerBaseArgs,
				agentDirectory: path.join(agentRoot, "reviewer"),
				activeHarnessDirectory: reviewDirectory,
				environment: hostEnvironment,
			});
		},
		async buildEvidence(evidenceInput) {
			const { stdout: editableSource } = await executeFile(
				"git",
				["show", `${evidenceInput.runtime.activeVersion.sourceCommit}:${candidatePath}`],
				{ cwd: input.repositoryDirectory },
			);
			const { taskRegistry } = await loadRuntime(input.rootDirectory, evidenceInput.experiment);
			const heldInTask = evidenceInput.proposerView.tasks[0];
			const perturbationSchedules = taskRegistry.heldIn
				.filter((task) => task.perturbation !== undefined)
				.map((task) => Object.freeze({ path: task.perturbation?.path ?? "" }))
				.filter((schedule) => schedule.path.length > 0);
			return buildSealedEvidenceBundle({
				heldInFailures:
					heldInTask === undefined
						? []
						: [
								{
									version: 1,
									taskId: heldInTask.id,
									verifiedCompletion: false,
									verification: { verifiedCompletion: false, reason: "artifact_missing" },
									toolCallId: "supervised-read-1",
									toolName: "read",
									arguments: { path: "src/config.ts" },
									errorContent: "src/config.ts does not exist",
									sourceEntryIds: { toolCall: "supervised-call", toolResult: "supervised-result" },
									subsequentToolCalls: [],
								},
							],
				redactedRepresentativeTraces:
					heldInTask === undefined
						? []
						: [
								{
									taskId: heldInTask.id,
									entries: [{ role: "tool", content: "read src/config.ts: file does not exist" }],
								},
							],
				heldInVerifierOutcomes:
					heldInTask === undefined
						? []
						: [{ taskId: heldInTask.id, verifiedCompletion: false, reason: "artifact_missing" }],
				preservedSuccesses: [],
				editableSource: [{ path: candidatePath, content: editableSource }],
				rejectedHypotheses: [],
				proposalSchema: {
					version: 1,
					requiredFields: [
						"hypothesis",
						"targetFailureSignature",
						"affectedEditableSurface",
						"unifiedDiff",
						"expectedBehavioralMechanism",
						"predictedBenefit",
						"regressionRisks",
					],
				},
				editableSurface: evidenceInput.experiment.editableSurface,
				changeBudget: {
					expectedMaximumChangedLines: 100,
					justificationRequiredAbove: 100,
					humanApprovalAbove: 250,
				},
				heldOutTaskIds: evidenceInput.experiment.heldOut,
				perturbationSchedules,
			});
		},
		smoke: {
			async run(candidate) {
				const { runtime } = await loadRuntime(
					input.rootDirectory,
					await loadConfiguredExperiment(input.rootDirectory),
				);
				return withCandidateWorktree({
					repositoryDirectory: input.repositoryDirectory,
					worktreeRoot: path.join(worktreeRoot, "smoke"),
					baselineCommit: runtime.activeVersion.sourceCommit,
					unifiedDiff: candidate.unifiedDiff,
					run: async (directory) => {
						await commandPassed(
							path.join(input.repositoryDirectory, "node_modules/@biomejs/biome/bin/biome"),
							["check", "--write", candidatePath],
							directory,
							60_000,
						);
						const formatting = await commandPassed(
							path.join(input.repositoryDirectory, "node_modules/@biomejs/biome/bin/biome"),
							["check", candidatePath],
							directory,
							60_000,
						);
						return { buildPassed: formatting, smokePassed: formatting };
					},
				});
			},
		},
		evaluator: {
			async run(evaluationInput) {
				return runProductionEvaluation({
					rootDirectory: input.rootDirectory,
					repositoryDirectory: input.repositoryDirectory,
					runId: input.runId,
					now: input.now,
					candidate: evaluationInput.candidate,
					experiment: evaluationInput.experiment,
					runtime: evaluationInput.runtime,
					taskRegistry: evaluationInput.taskRegistry,
					supervised,
					evaluationGateway: evaluationGateway(supervised),
					runner,
					pricing: input.seams.pricing,
					resources,
					evaluationImageRepository,
					harnessRoot,
				});
			},
		},
		candidateSource: createGitCandidateSourceAdapter({
			repositoryDirectory: input.repositoryDirectory,
			worktreeRoot: path.join(worktreeRoot, "candidate"),
		}),
		candidateImage: createDockerCandidateImageBuilder({
			executable: input.seams.dockerCommand,
			baseArgs: input.seams.dockerBaseArgs,
			environment: hostEnvironment,
		}),
	};

	return Object.freeze({
		adapters,
		async close() {
			await supervised.close();
			await rm(worktreeRoot, { recursive: true, force: true }).catch(() => undefined);
			await rm(agentRoot, { recursive: true, force: true }).catch(() => undefined);
			await rm(harnessRoot, { recursive: true, force: true }).catch(() => undefined);
		},
	});
}

async function runProductionEvaluation(input: {
	readonly rootDirectory: string;
	readonly repositoryDirectory: string;
	readonly runId: string;
	readonly now: () => Date;
	readonly candidate: CandidateProposal;
	readonly experiment: Experiment;
	readonly runtime: SupervisedRuntime;
	readonly taskRegistry: ProtectedTaskRegistry;
	readonly supervised: SupervisedModelGateway;
	readonly evaluationGateway: ModelGateway;
	readonly runner: ReturnType<typeof createDockerHarnessRunner>;
	readonly pricing: Readonly<Record<string, ModelTokenPricing>>;
	readonly resources: { readonly cpuLimit: number; readonly memoryMb: number };
	readonly evaluationImageRepository: string;
	readonly harnessRoot: string;
}): Promise<ImprovementEvaluationResult> {
	const evaluationTasks: Record<
		string,
		{ readonly digest: string; readonly task: Awaited<ReturnType<typeof loadProtectedEvaluationTask>>["task"] }
	> = {};
	for (const task of [...input.taskRegistry.heldIn, ...input.taskRegistry.heldOut]) {
		evaluationTasks[task.verifier.id] = await loadProtectedEvaluationTask({
			rootDirectory: input.rootDirectory,
			verifierId: task.verifier.id,
			expectedDigest: task.verifier.digest,
			taskId: task.id,
		});
	}
	const baselineDirectory = path.join(input.harnessRoot, "baseline");
	const candidateDirectory = path.join(input.harnessRoot, "candidate");
	await materializeHarnessSource({
		repositoryDirectory: input.repositoryDirectory,
		commit: input.runtime.activeVersion.sourceCommit,
		targetDirectory: baselineDirectory,
	});
	await withCandidateWorktree({
		repositoryDirectory: input.repositoryDirectory,
		worktreeRoot: path.join(input.harnessRoot, "candidate-worktrees"),
		baselineCommit: input.runtime.activeVersion.sourceCommit,
		unifiedDiff: input.candidate.unifiedDiff,
		run: async (directory) => {
			await rm(candidateDirectory, { recursive: true, force: true });
			await cp(directory, candidateDirectory, { recursive: true });
		},
	});
	const packageLock = await readFile(path.join(input.repositoryDirectory, "package-lock.json"), "utf8").catch(
		() => "",
	);
	const modelPricing = pricingFor(input.pricing, input.runtime.proposer.provider, input.runtime.proposer.model);
	const fingerprintInputs = {
		version: 1 as const,
		harness: {
			baselineCommit: input.runtime.activeVersion.sourceCommit,
			candidateParentCommit: input.runtime.activeVersion.sourceCommit,
		},
		model: {
			provider: input.runtime.proposer.provider,
			id: input.runtime.proposer.model,
			parameters: { temperature: 0 },
		},
		systemInputsDigest: digest("supervised-system-v1"),
		task: {
			setVersion: input.taskRegistry.digest,
			repositoryCommits: Object.freeze(
				Object.fromEntries(
					[...input.taskRegistry.heldIn, ...input.taskRegistry.heldOut].map((task) => [
						task.id,
						task.repository.commit,
					]),
				),
			),
		},
		dependencies: { lockfileDigest: digest(packageLock) },
		evaluator: { version: "supervised-evaluator-v1" },
		verifier: { version: "protected-verifier-v1" },
		container: {
			imageDigest: input.runtime.container.imageDigest,
			networkPolicyDigest: input.supervised.network.digest,
			cpuLimit: input.resources.cpuLimit,
			memoryMb: input.resources.memoryMb,
		},
		budget: {
			timeoutMs: input.experiment.budget.wallClockMs,
			toolCalls: input.experiment.budget.toolCalls,
			turns: input.experiment.budget.turns,
			tokens: input.experiment.budget.tokens,
			costUsd: input.experiment.budget.costUsd,
		},
		repetitions: input.runtime.evaluation.repetitions,
	};
	const evaluation = await runSupervisedEvaluation(
		{
			rootDirectory: input.rootDirectory,
			runId: input.runId,
			experiment: input.experiment,
			runtime: input.runtime,
			taskRegistry: input.taskRegistry,
			evaluationTasks,
			fingerprintInputs,
			containerImage: imageReference(input.evaluationImageRepository, input.runtime.container.imageDigest),
			baselineHarness: {
				sourceDirectory: baselineDirectory,
				command: "node",
				args: [
					"--experimental-strip-types",
					"/opt/selfpi/packages/selfpi/src/evaluation/supervised-pi-evaluation-harness.ts",
				],
			},
			candidateHarness: {
				sourceDirectory: candidateDirectory,
				command: "node",
				args: [
					"--experimental-strip-types",
					"/opt/selfpi/packages/selfpi/src/evaluation/supervised-pi-evaluation-harness.ts",
				],
			},
			gatewayNetwork: {
				name: input.supervised.network.name,
				digest: input.supervised.network.digest,
			},
			resources: input.resources,
			sessionExpiresAt: new Date(input.now().getTime() + input.experiment.budget.wallClockMs),
		},
		{ gateway: input.evaluationGateway, runner: input.runner },
	);
	const pricedAttempts = evaluation.attempts?.map((attempt) =>
		Object.freeze({
			...attempt,
			baselineCostUsd: costUsdForUsage(attempt.baseline.result.usage, modelPricing),
			candidateCostUsd: costUsdForUsage(attempt.candidate.result.usage, modelPricing),
		}),
	);
	return Object.freeze({
		...evaluation,
		efficiency: Object.freeze({
			baselineTokens: evaluation.efficiency.baselineTokens,
			candidateTokens: evaluation.efficiency.candidateTokens,
			baselineCostUsd: pricedAttempts?.reduce((total, attempt) => total + attempt.baselineCostUsd, 0) ?? 0,
			candidateCostUsd: pricedAttempts?.reduce((total, attempt) => total + attempt.candidateCostUsd, 0) ?? 0,
		}),
		attempts: pricedAttempts === undefined ? undefined : Object.freeze(pricedAttempts),
	});
}

export function loadSupervisedSeamsFromEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
	options: {
		readonly upstream: ModelGatewayUpstream;
	},
): SupervisedImprovementSeams {
	const credentialsJson = environment.SELFPI_PROVIDER_CREDENTIALS_JSON;
	const pricingJson = environment.SELFPI_MODEL_PRICING_JSON;
	if (credentialsJson === undefined || credentialsJson.length === 0) {
		throw new Error("SELFPI_PROVIDER_CREDENTIALS_JSON is required for supervised improve.");
	}
	if (pricingJson === undefined || pricingJson.length === 0) {
		throw new Error("SELFPI_MODEL_PRICING_JSON is required for supervised improve.");
	}
	const providerCredentialsValue: unknown = JSON.parse(credentialsJson);
	const pricingValue: unknown = JSON.parse(pricingJson);
	if (
		typeof providerCredentialsValue !== "object" ||
		providerCredentialsValue === null ||
		Array.isArray(providerCredentialsValue) ||
		typeof pricingValue !== "object" ||
		pricingValue === null ||
		Array.isArray(pricingValue)
	) {
		throw new Error("Supervised credential or pricing configuration is invalid.");
	}
	return Object.freeze({
		dockerCommand: environment.SELFPI_DOCKER_COMMAND ?? "docker",
		...(environment.SELFPI_DOCKER_BASE_ARGS_JSON === undefined
			? {}
			: { dockerBaseArgs: JSON.parse(environment.SELFPI_DOCKER_BASE_ARGS_JSON) as readonly string[] }),
		providerCredentials: providerCredentialsValue as Readonly<Record<string, string>>,
		upstream: options.upstream,
		pricing: pricingValue as Readonly<Record<string, ModelTokenPricing>>,
		hostEnvironment: Object.freeze({
			PATH: environment.PATH ?? "",
		}),
	});
}
