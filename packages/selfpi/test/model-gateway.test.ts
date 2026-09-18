import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { startModelGateway } from "../src/gateway/model-gateway.ts";

const executeFile = promisify(execFile);

describe("model gateway", () => {
	it("brokers scoped, budgeted model sessions without exposing provider credentials", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "selfpi-gateway-"));
		const auditPath = path.join(directory, "gateway-audit.jsonl");
		const clientPath = path.join(directory, "client.mjs");
		let now = new Date("2026-09-17T20:00:00.000Z");
		const upstreamCalls: Array<{ credential: string; model: string }> = [];
		const gateway = await startModelGateway({
			host: "127.0.0.1",
			now: () => now,
			auditPath,
			providerCredentials: { anthropic: "provider-secret-value" },
			upstream: {
				async complete(input) {
					upstreamCalls.push({ credential: input.providerCredential, model: input.model });
					return {
						body: {
							id: "completion-1",
							object: "chat.completion",
							choices: [{ index: 0, message: { role: "assistant", content: "gateway response" } }],
							usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
						},
						usage: { inputTokens: 2, outputTokens: 3 },
					};
				},
			},
		});

		try {
			const proposer = await gateway.issueSession({
				runId: "run-1",
				role: "proposer",
				provider: "anthropic",
				model: "claude-proposer",
				tokenBudget: 10,
				expiresAt: new Date("2026-09-17T20:05:00.000Z"),
			});
			await writeFile(
				clientPath,
				[
					'const response = await fetch(process.env.SELFPI_GATEWAY_ENDPOINT + "/chat/completions", {',
					'  method: "POST",',
					'  headers: { authorization: "Bearer " + process.env.SELFPI_GATEWAY_TOKEN, "content-type": "application/json" },',
					'  body: JSON.stringify({ model: "claude-proposer", max_tokens: 5, messages: [{ role: "user", content: "hello" }] }),',
					"});",
					"console.log(JSON.stringify({",
					"  providerCredential: process.env.PROVIDER_API_KEY ?? null,",
					"  status: response.status,",
					"  body: await response.json(),",
					"}));",
				].join("\n"),
				"utf8",
			);

			const child = await executeFile(process.execPath, [clientPath], {
				env: {
					PATH: process.env.PATH,
					SELFPI_GATEWAY_ENDPOINT: proposer.endpoint,
					SELFPI_GATEWAY_TOKEN: proposer.credential,
				},
			});
			expect(JSON.parse(child.stdout)).toEqual({
				providerCredential: null,
				status: 200,
				body: {
					id: "completion-1",
					object: "chat.completion",
					choices: [{ index: 0, message: { role: "assistant", content: "gateway response" } }],
					usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
				},
			});
			expect(upstreamCalls).toEqual([{ credential: "provider-secret-value", model: "claude-proposer" }]);

			const wrongRoleEndpoint = proposer.endpoint.replace("/roles/proposer/", "/roles/reviewer/");
			const wrongRoleResponse = await fetch(`${wrongRoleEndpoint}/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${proposer.credential}`, "content-type": "application/json" },
				body: JSON.stringify({ model: "claude-proposer", max_tokens: 1, messages: [] }),
			});
			expect(wrongRoleResponse.status).toBe(403);

			const overBudget = await gateway.issueSession({
				runId: "run-1",
				role: "evaluation",
				provider: "anthropic",
				model: "claude-evaluation",
				tokenBudget: 1,
				expiresAt: new Date("2026-09-17T20:05:00.000Z"),
			});
			const overBudgetResponse = await fetch(`${overBudget.endpoint}/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${overBudget.credential}`, "content-type": "application/json" },
				body: JSON.stringify({ model: "claude-evaluation", max_tokens: 2, messages: [] }),
			});
			expect(overBudgetResponse.status).toBe(429);

			const expired = await gateway.issueSession({
				runId: "run-1",
				role: "reviewer",
				provider: "anthropic",
				model: "claude-reviewer",
				tokenBudget: 10,
				expiresAt: new Date("2026-09-17T20:01:00.000Z"),
			});
			now = new Date("2026-09-17T20:02:00.000Z");
			const expiredResponse = await fetch(`${expired.endpoint}/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${expired.credential}`, "content-type": "application/json" },
				body: JSON.stringify({ model: "claude-reviewer", max_tokens: 1, messages: [] }),
			});
			expect(expiredResponse.status).toBe(401);

			await gateway.revokeSession(proposer.id);
			const reusedResponse = await fetch(`${proposer.endpoint}/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${proposer.credential}`, "content-type": "application/json" },
				body: JSON.stringify({ model: "claude-proposer", max_tokens: 1, messages: [] }),
			});
			expect(reusedResponse.status).toBe(401);

			const auditSource = await readFile(auditPath, "utf8");
			const auditEvents = auditSource
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(auditEvents.map((event) => [event.type, event.reason])).toEqual([
				["session_issued", undefined],
				["request_authorized", undefined],
				["request_rejected", "wrong_role"],
				["session_issued", undefined],
				["request_rejected", "token_budget_exceeded"],
				["session_issued", undefined],
				["request_rejected", "expired"],
				["session_revoked", undefined],
				["request_rejected", "revoked"],
			]);
			expect(auditSource).not.toContain("provider-secret-value");
			expect(auditSource).not.toContain(proposer.credential);
			expect(auditSource).not.toContain("hello");
		} finally {
			await gateway.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
