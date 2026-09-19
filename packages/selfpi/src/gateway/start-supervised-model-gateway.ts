import {
	createGatewayOnlyNetwork,
	type DockerProcessAdapter,
	type GatewayOnlyNetwork,
} from "./create-gateway-only-network.ts";
import {
	type ModelGateway,
	type ModelGatewaySession,
	type ModelGatewayUpstream,
	startModelGateway,
} from "./model-gateway.ts";

export interface SupervisedModelGateway {
	readonly gateway: ModelGateway;
	readonly network: Pick<GatewayOnlyNetwork, "name" | "digest" | "gatewayAlias" | "gatewayPort">;
	forContainer(session: ModelGatewaySession): ModelGatewaySession;
	close(): Promise<void>;
}

export interface StartSupervisedModelGatewayOptions {
	readonly runId: string;
	readonly now: () => Date;
	readonly auditPath: string;
	readonly providerCredentials: Readonly<Record<string, string>>;
	readonly upstream: ModelGatewayUpstream;
	readonly docker: DockerProcessAdapter;
	readonly proxyImage?: string;
}

function hostPort(baseEndpoint: string): number {
	const url = new URL(baseEndpoint);
	if (url.port.length > 0) return Number(url.port);
	return url.protocol === "https:" ? 443 : 80;
}

function rewriteEndpoint(endpoint: string, alias: string, port: number): string {
	const url = new URL(endpoint);
	return `http://${alias}:${String(port)}${url.pathname}`;
}

export async function startSupervisedModelGateway(
	options: StartSupervisedModelGatewayOptions,
): Promise<SupervisedModelGateway> {
	const gateway = await startModelGateway({
		host: "127.0.0.1",
		now: options.now,
		auditPath: options.auditPath,
		providerCredentials: options.providerCredentials,
		upstream: options.upstream,
	});
	let network: GatewayOnlyNetwork | undefined;
	try {
		network = await createGatewayOnlyNetwork({
			runId: options.runId,
			hostGatewayPort: hostPort(gateway.baseEndpoint),
			docker: options.docker,
			proxyImage: options.proxyImage,
		});
	} catch (error) {
		await gateway.close();
		throw error;
	}

	const activeNetwork = network;
	return Object.freeze({
		gateway,
		network: Object.freeze({
			name: activeNetwork.name,
			digest: activeNetwork.digest,
			gatewayAlias: activeNetwork.gatewayAlias,
			gatewayPort: activeNetwork.gatewayPort,
		}),
		forContainer(session: ModelGatewaySession) {
			return Object.freeze({
				id: session.id,
				endpoint: rewriteEndpoint(session.endpoint, activeNetwork.gatewayAlias, activeNetwork.gatewayPort),
				credential: session.credential,
			});
		},
		async close() {
			await activeNetwork.close();
			await gateway.close();
		},
	});
}
