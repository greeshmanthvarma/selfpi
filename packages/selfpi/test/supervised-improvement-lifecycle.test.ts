import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSupervisedImprovementLifecycle } from "../src/supervised/open-supervised-improvement-lifecycle.ts";

describe("supervised improvement lifecycle", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("starts a host gateway and gateway-only Docker network before composing adapters", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-lifecycle-"));
		temporaryDirectories.push(rootDirectory);
		const fakeDocker = path.join(rootDirectory, "fake-docker.mjs");
		await writeFile(
			fakeDocker,
			[
				"const args = process.argv.slice(2);",
				"if (args[0] === 'network' && args[1] === 'create') process.exit(0);",
				"if (args[0] === 'run') { process.stdout.write('proxy\\n'); process.exit(0); }",
				"if (args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm')) process.exit(0);",
				"console.error(args.join(' '));",
				"process.exit(1);",
				"",
			].join("\n"),
			"utf8",
		);
		const lifecycle = await openSupervisedImprovementLifecycle({
			rootDirectory,
			repositoryDirectory: rootDirectory,
			runId: "run-lifecycle-001",
			now: () => new Date("2026-09-18T02:00:00.000Z"),
			seams: {
				dockerCommand: process.execPath,
				dockerBaseArgs: [fakeDocker],
				providerCredentials: { "fake-provider": "provider-secret" },
				upstream: {
					async complete() {
						return {
							body: {
								choices: [{ message: { role: "assistant", content: "ok" } }],
								usage: { prompt_tokens: 1, completion_tokens: 1 },
							},
							usage: { inputTokens: 1, outputTokens: 1 },
						};
					},
				},
				pricing: {
					"*": { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
				},
			},
		});

		expect(lifecycle.adapters.gateway.baseEndpoint.startsWith("http://127.0.0.1:")).toBe(true);
		await lifecycle.close();
	});
});
