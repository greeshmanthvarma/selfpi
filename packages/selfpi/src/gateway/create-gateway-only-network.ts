import { createHash } from "node:crypto";

export interface DockerProcessAdapter {
	run(args: readonly string[]): Promise<{
		readonly stdout: string;
		readonly stderr: string;
		readonly exitCode: number;
	}>;
}

export interface GatewayOnlyNetwork {
	readonly name: string;
	readonly digest: string;
	readonly gatewayAlias: string;
	readonly gatewayPort: number;
	close(): Promise<void>;
}

export interface CreateGatewayOnlyNetworkOptions {
	readonly runId: string;
	readonly hostGatewayPort: number;
	readonly docker: DockerProcessAdapter;
	readonly proxyImage?: string;
}

export const GATEWAY_ONLY_NETWORK_DIGEST = Object.freeze(
	`sha256:${createHash("sha256").update("selfpi-gateway-only-network-v2-dual-homed-proxy").digest("hex")}`,
);

const DEFAULT_PROXY_IMAGE = "alpine/socat:1.8.0.0";
const GATEWAY_ALIAS = "selfpi-gateway";
const GATEWAY_PORT = 8080;

function assertSafeRunId(runId: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(runId)) {
		throw new Error("Gateway network run ID is invalid.");
	}
}

function assertSafePort(port: number): void {
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new Error("Host gateway port is invalid.");
	}
}

async function runDocker(docker: DockerProcessAdapter, args: readonly string[]): Promise<void> {
	const result = await docker.run(args);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || `Docker command failed: ${args.join(" ")}`);
	}
}

export async function createGatewayOnlyNetwork(options: CreateGatewayOnlyNetworkOptions): Promise<GatewayOnlyNetwork> {
	assertSafeRunId(options.runId);
	assertSafePort(options.hostGatewayPort);
	const name = `selfpi-gw-${options.runId}`;
	const egressName = `selfpi-gw-egress-${options.runId}`;
	const proxyName = `selfpi-gw-proxy-${options.runId}`;
	const proxyImage = options.proxyImage ?? DEFAULT_PROXY_IMAGE;
	let proxyStarted = false;
	let internalCreated = false;
	let egressCreated = false;
	try {
		await runDocker(options.docker, [
			"network",
			"create",
			"--internal",
			"--label",
			"works.selfpi.role=gateway-only",
			"--label",
			`works.selfpi.run-id=${options.runId}`,
			name,
		]);
		internalCreated = true;
		await runDocker(options.docker, [
			"network",
			"create",
			"--label",
			"works.selfpi.role=gateway-proxy-egress",
			"--label",
			`works.selfpi.run-id=${options.runId}`,
			egressName,
		]);
		egressCreated = true;
		await runDocker(options.docker, [
			"run",
			"--detach",
			"--rm",
			"--name",
			proxyName,
			"--network",
			name,
			"--network-alias",
			GATEWAY_ALIAS,
			"--add-host",
			"host.docker.internal:host-gateway",
			"--label",
			"works.selfpi.role=gateway-proxy",
			proxyImage,
			`TCP4-LISTEN:${String(GATEWAY_PORT)},fork,reuseaddr`,
			`TCP4:host.docker.internal:${String(options.hostGatewayPort)}`,
		]);
		proxyStarted = true;
		await runDocker(options.docker, ["network", "connect", egressName, proxyName]);
	} catch (error) {
		if (proxyStarted) {
			await runDocker(options.docker, ["rm", "-f", proxyName]).catch(() => undefined);
		}
		if (egressCreated) {
			await runDocker(options.docker, ["network", "rm", egressName]).catch(() => undefined);
		}
		if (internalCreated) {
			await runDocker(options.docker, ["network", "rm", name]).catch(() => undefined);
		}
		throw error;
	}

	return Object.freeze({
		name,
		digest: GATEWAY_ONLY_NETWORK_DIGEST,
		gatewayAlias: GATEWAY_ALIAS,
		gatewayPort: GATEWAY_PORT,
		async close() {
			await runDocker(options.docker, ["rm", "-f", proxyName]).catch(() => undefined);
			await runDocker(options.docker, ["network", "rm", egressName]).catch(() => undefined);
			await runDocker(options.docker, ["network", "rm", name]);
		},
	});
}
