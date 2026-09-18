import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export type ModelGatewayRole = "proposer" | "reviewer" | "evaluation";

export interface ModelGatewayUpstreamInput {
	readonly provider: string;
	readonly model: string;
	readonly providerCredential: string;
	readonly request: Readonly<Record<string, unknown>>;
}

export interface ModelGatewayUpstreamResult {
	readonly body: unknown;
	readonly contentType?: "application/json" | "text/event-stream";
	readonly usage: {
		readonly inputTokens: number;
		readonly outputTokens: number;
	};
}

export interface ModelGatewayUpstream {
	complete(input: ModelGatewayUpstreamInput): Promise<ModelGatewayUpstreamResult>;
}

export interface ModelGatewaySessionInput {
	readonly runId: string;
	readonly role: ModelGatewayRole;
	readonly provider: string;
	readonly model: string;
	readonly tokenBudget: number;
	readonly expiresAt: Date;
}

export interface ModelGatewaySession {
	readonly id: string;
	readonly endpoint: string;
	readonly credential: string;
}

export interface ModelGateway {
	issueSession(input: ModelGatewaySessionInput): Promise<ModelGatewaySession>;
	revokeSession(sessionId: string): Promise<void>;
	close(): Promise<void>;
}

export interface StartModelGatewayOptions {
	readonly host: string;
	readonly now: () => Date;
	readonly auditPath: string;
	readonly providerCredentials: Readonly<Record<string, string>>;
	readonly upstream: ModelGatewayUpstream;
}

interface SessionState {
	readonly id: string;
	readonly credential: string;
	readonly runId: string;
	readonly role: ModelGatewayRole;
	readonly provider: string;
	readonly model: string;
	readonly tokenBudget: number;
	readonly expiresAt: Date;
	usedTokens: number;
	reservedTokens: number;
	revoked: boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function writeResponse(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(`${JSON.stringify(body)}\n`);
}

function readRequest(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let length = 0;
		request.on("data", (chunk: Buffer) => {
			length += chunk.length;
			if (length > 1_048_576) {
				request.destroy(new Error("Model gateway request is too large."));
				return;
			}
			chunks.push(chunk);
		});
		request.once("error", reject);
		request.once("end", () => {
			try {
				const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (!isRecord(value)) {
					reject(new Error("Model gateway request body is invalid."));
					return;
				}
				resolve(value);
			} catch (error) {
				reject(error);
			}
		});
	});
}

function credentialFingerprint(credential: string): string {
	return createHash("sha256").update(credential).digest("hex").slice(0, 16);
}

async function stopServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

export async function startModelGateway(options: StartModelGatewayOptions): Promise<ModelGateway> {
	const sessionsByCredential = new Map<string, SessionState>();
	const sessionsById = new Map<string, SessionState>();
	await mkdir(path.dirname(options.auditPath), { recursive: true });

	async function audit(event: Readonly<Record<string, unknown>>): Promise<void> {
		await appendFile(
			options.auditPath,
			`${JSON.stringify({ version: 1, at: options.now().toISOString(), ...event })}\n`,
			"utf8",
		);
	}

	async function reject(
		response: ServerResponse,
		status: number,
		reason: string,
		session?: SessionState,
	): Promise<void> {
		await audit({
			type: "request_rejected",
			reason,
			...(session === undefined
				? {}
				: {
						sessionId: session.id,
						runId: session.runId,
						role: session.role,
						provider: session.provider,
						model: session.model,
					}),
		});
		writeResponse(response, status, { error: { type: "gateway_rejection", reason } });
	}

	const server = createServer((request, response) => {
		void (async () => {
			if (request.method !== "POST" || request.url === undefined) {
				writeResponse(response, 404, { error: { type: "not_found" } });
				return;
			}
			const route = /^\/runs\/([^/]+)\/roles\/(proposer|reviewer|evaluation)\/v1\/chat\/completions$/.exec(
				request.url,
			);
			if (route === null) {
				writeResponse(response, 404, { error: { type: "not_found" } });
				return;
			}
			const authorization = request.headers.authorization;
			const credential =
				typeof authorization === "string" && authorization.startsWith("Bearer ")
					? authorization.slice("Bearer ".length)
					: undefined;
			if (credential === undefined) {
				await reject(response, 401, "missing_credential");
				return;
			}
			const session = sessionsByCredential.get(credential);
			if (session === undefined) {
				await reject(response, 401, "unknown_credential");
				return;
			}
			if (session.revoked) {
				await reject(response, 401, "revoked", session);
				return;
			}
			if (options.now().getTime() >= session.expiresAt.getTime()) {
				await reject(response, 401, "expired", session);
				return;
			}
			const routeRunId = decodeURIComponent(route[1] ?? "");
			const routeRole = route[2];
			if (routeRunId !== session.runId) {
				await reject(response, 403, "wrong_run", session);
				return;
			}
			if (routeRole !== session.role) {
				await reject(response, 403, "wrong_role", session);
				return;
			}

			let body: Readonly<Record<string, unknown>>;
			try {
				body = await readRequest(request);
			} catch {
				await reject(response, 400, "invalid_request", session);
				return;
			}
			if (body.model !== session.model) {
				await reject(response, 403, "wrong_model", session);
				return;
			}
			if (
				!isPositiveInteger(body.max_tokens) ||
				session.usedTokens + session.reservedTokens + body.max_tokens > session.tokenBudget
			) {
				await reject(response, 429, "token_budget_exceeded", session);
				return;
			}
			const providerCredential = options.providerCredentials[session.provider];
			if (providerCredential === undefined || providerCredential.length === 0) {
				await reject(response, 503, "provider_unavailable", session);
				return;
			}

			session.reservedTokens += body.max_tokens;
			let upstreamResult: ModelGatewayUpstreamResult;
			try {
				upstreamResult = await options.upstream.complete({
					provider: session.provider,
					model: session.model,
					providerCredential,
					request: body,
				});
			} finally {
				session.reservedTokens -= body.max_tokens;
			}
			const requestTokens = upstreamResult.usage.inputTokens + upstreamResult.usage.outputTokens;
			if (
				!Number.isInteger(upstreamResult.usage.inputTokens) ||
				upstreamResult.usage.inputTokens < 0 ||
				!Number.isInteger(upstreamResult.usage.outputTokens) ||
				upstreamResult.usage.outputTokens < 0 ||
				session.usedTokens + requestTokens > session.tokenBudget
			) {
				session.revoked = true;
				await reject(response, 429, "response_budget_exceeded", session);
				return;
			}
			session.usedTokens += requestTokens;
			await audit({
				type: "request_authorized",
				sessionId: session.id,
				runId: session.runId,
				role: session.role,
				provider: session.provider,
				model: session.model,
				inputTokens: upstreamResult.usage.inputTokens,
				outputTokens: upstreamResult.usage.outputTokens,
				totalTokens: requestTokens,
				remainingTokens: session.tokenBudget - session.usedTokens,
			});
			if (upstreamResult.contentType === "text/event-stream") {
				if (typeof upstreamResult.body !== "string") {
					await reject(response, 502, "invalid_upstream_response", session);
					return;
				}
				response.writeHead(200, {
					"cache-control": "no-cache",
					connection: "keep-alive",
					"content-type": "text/event-stream",
				});
				response.end(upstreamResult.body);
			} else {
				writeResponse(response, 200, upstreamResult.body);
			}
		})().catch(async () => {
			if (!response.headersSent) {
				await reject(response, 502, "upstream_failure");
			} else {
				response.end();
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, options.host, resolve);
	});
	const address = server.address() as AddressInfo;
	const baseEndpoint = `http://${options.host}:${String(address.port)}`;

	return Object.freeze({
		async issueSession(input: ModelGatewaySessionInput) {
			if (
				input.runId.length === 0 ||
				input.provider.length === 0 ||
				input.model.length === 0 ||
				!isPositiveInteger(input.tokenBudget) ||
				input.expiresAt.getTime() <= options.now().getTime() ||
				options.providerCredentials[input.provider] === undefined
			) {
				throw new Error("Model gateway session request is invalid.");
			}
			const id = randomBytes(16).toString("hex");
			const credential = randomBytes(32).toString("base64url");
			const state: SessionState = {
				id,
				credential,
				runId: input.runId,
				role: input.role,
				provider: input.provider,
				model: input.model,
				tokenBudget: input.tokenBudget,
				expiresAt: new Date(input.expiresAt),
				usedTokens: 0,
				reservedTokens: 0,
				revoked: false,
			};
			sessionsByCredential.set(credential, state);
			sessionsById.set(id, state);
			await audit({
				type: "session_issued",
				sessionId: id,
				credentialFingerprint: credentialFingerprint(credential),
				runId: input.runId,
				role: input.role,
				provider: input.provider,
				model: input.model,
				tokenBudget: input.tokenBudget,
				expiresAt: input.expiresAt.toISOString(),
			});
			return Object.freeze({
				id,
				endpoint: `${baseEndpoint}/runs/${encodeURIComponent(input.runId)}/roles/${input.role}/v1`,
				credential,
			});
		},
		async revokeSession(sessionId: string) {
			const session = sessionsById.get(sessionId);
			if (session === undefined) {
				throw new Error("Model gateway session does not exist.");
			}
			if (session.revoked) return;
			session.revoked = true;
			await audit({
				type: "session_revoked",
				sessionId: session.id,
				runId: session.runId,
				role: session.role,
				provider: session.provider,
				model: session.model,
			});
		},
		async close() {
			await stopServer(server);
		},
	});
}
