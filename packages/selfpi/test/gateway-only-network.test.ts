import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayOnlyNetwork } from "../src/gateway/create-gateway-only-network.ts";
import { startSupervisedModelGateway } from "../src/gateway/start-supervised-model-gateway.ts";

describe("gateway-only network", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("creates an internal Docker network with a dual-homed host-controlled gateway proxy", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-gateway-network-"));
		temporaryDirectories.push(rootDirectory);
		const capturePath = path.join(rootDirectory, "docker-commands.jsonl");
		await writeFile(capturePath, "", "utf8");
		const dockerCalls: string[][] = [];
		const network = await createGatewayOnlyNetwork({
			runId: "run-network-001",
			hostGatewayPort: 18_765,
			docker: {
				async run(args) {
					dockerCalls.push([...args]);
					await writeFile(capturePath, `${JSON.stringify(args)}\n`, { flag: "a" });
					if (args[0] === "network" && args[1] === "create") {
						return { stdout: "network-id\n", stderr: "", exitCode: 0 };
					}
					if (args[0] === "network" && args[1] === "connect") {
						return { stdout: "", stderr: "", exitCode: 0 };
					}
					if (args[0] === "run") {
						return { stdout: "proxy-container-id\n", stderr: "", exitCode: 0 };
					}
					if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) {
						return { stdout: "", stderr: "", exitCode: 0 };
					}
					throw new Error(`Unexpected docker args: ${args.join(" ")}`);
				},
			},
		});

		expect(network.name).toBe("selfpi-gw-run-network-001");
		expect(network.gatewayAlias).toBe("selfpi-gateway");
		expect(network.gatewayPort).toBe(8080);
		expect(network.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(dockerCalls[0]).toEqual([
			"network",
			"create",
			"--internal",
			"--label",
			"works.selfpi.role=gateway-only",
			"--label",
			"works.selfpi.run-id=run-network-001",
			"selfpi-gw-run-network-001",
		]);
		expect(dockerCalls[1]).toEqual([
			"network",
			"create",
			"--label",
			"works.selfpi.role=gateway-proxy-egress",
			"--label",
			"works.selfpi.run-id=run-network-001",
			"selfpi-gw-egress-run-network-001",
		]);
		expect(dockerCalls[2]).toEqual([
			"run",
			"--detach",
			"--rm",
			"--name",
			"selfpi-gw-proxy-run-network-001",
			"--network",
			"selfpi-gw-run-network-001",
			"--network-alias",
			"selfpi-gateway",
			"--add-host",
			"host.docker.internal:host-gateway",
			"--label",
			"works.selfpi.role=gateway-proxy",
			"alpine/socat:1.8.0.0",
			"TCP4-LISTEN:8080,fork,reuseaddr",
			"TCP4:host.docker.internal:18765",
		]);
		expect(dockerCalls[3]).toEqual([
			"network",
			"connect",
			"selfpi-gw-egress-run-network-001",
			"selfpi-gw-proxy-run-network-001",
		]);
		expect(dockerCalls[2]?.join(" ")).not.toContain("--network host");

		await network.close();
		expect(dockerCalls.at(-3)).toEqual(["rm", "-f", "selfpi-gw-proxy-run-network-001"]);
		expect(dockerCalls.at(-2)).toEqual(["network", "rm", "selfpi-gw-egress-run-network-001"]);
		expect(dockerCalls.at(-1)).toEqual(["network", "rm", "selfpi-gw-run-network-001"]);
		expect(await readFile(capturePath, "utf8")).toContain("selfpi-gw-run-network-001");
	});

	it("issues host sessions for local harnesses and container-rewritten sessions for evaluation", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-supervised-gateway-"));
		temporaryDirectories.push(rootDirectory);
		const dockerCalls: string[][] = [];
		const supervised = await startSupervisedModelGateway({
			runId: "run-gateway-001",
			now: () => new Date("2026-09-17T23:30:00.000Z"),
			auditPath: path.join(rootDirectory, "gateway-audit.jsonl"),
			providerCredentials: { "fake-provider": "provider-secret" },
			upstream: {
				async complete() {
					return {
						body: {
							id: "completion-1",
							object: "chat.completion",
							choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
							usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
						},
						usage: { inputTokens: 1, outputTokens: 1 },
					};
				},
			},
			docker: {
				async run(args) {
					dockerCalls.push([...args]);
					return { stdout: "ok\n", stderr: "", exitCode: 0 };
				},
			},
		});
		try {
			const hostSession = await supervised.gateway.issueSession({
				runId: "run-gateway-001",
				role: "proposer",
				provider: "fake-provider",
				model: "proposer-model",
				tokenBudget: 100,
				expiresAt: new Date("2026-09-17T23:40:00.000Z"),
			});
			expect(hostSession.endpoint).toMatch(
				/^http:\/\/127\.0\.0\.1:\d+\/runs\/run-gateway-001\/roles\/proposer\/v1$/,
			);
			const containerSession = supervised.forContainer(hostSession);
			expect(containerSession.endpoint).toBe("http://selfpi-gateway:8080/runs/run-gateway-001/roles/proposer/v1");
			expect(containerSession.credential).toBe(hostSession.credential);
			expect(supervised.network.name).toBe("selfpi-gw-run-gateway-001");
			expect(dockerCalls.some((args) => args.includes("--internal"))).toBe(true);
			expect(dockerCalls.some((args) => args.includes("host.docker.internal:host-gateway"))).toBe(true);
			expect(dockerCalls.some((args) => args[0] === "network" && args[1] === "connect")).toBe(true);
		} finally {
			await supervised.close();
		}
	});
});
