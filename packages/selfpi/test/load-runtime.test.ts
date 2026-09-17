import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDeterministicRuntime } from "../src/config/load-runtime.ts";

describe("deterministic runtime configuration", () => {
	it("loads reproducible faux settings and rejects real providers", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "selfpi-runtime-"));
		const runtimePath = path.join(directory, "runtime.json");
		const runtime = {
			version: 1,
			mode: "deterministic_v0",
			proposer: { provider: "faux", model: "proposer", thinking: "off" },
			reviewer: { provider: "faux", model: "reviewer" },
			evaluation: {
				repetitions: 3,
			},
		};
		try {
			await writeFile(runtimePath, `${JSON.stringify(runtime)}\n`, "utf8");
			expect(await loadDeterministicRuntime(runtimePath)).toMatchObject({
				ok: true,
				runtime: { mode: "deterministic_v0", proposer: { provider: "faux" } },
			});

			await writeFile(
				runtimePath,
				`${JSON.stringify({ ...runtime, proposer: { ...runtime.proposer, provider: "anthropic" } })}\n`,
				"utf8",
			);
			expect(await loadDeterministicRuntime(runtimePath)).toEqual({
				ok: false,
				message: "Runtime configuration is invalid.",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
