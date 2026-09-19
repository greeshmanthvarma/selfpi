import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadExperiment } from "../src/index.ts";

describe("loadExperiment boundaries", () => {
	it("rejects an editable path that overlaps a declared protected path", async () => {
		const fixturePath = path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"fixtures/path-recovery-overlap.json",
		);

		const result = await loadExperiment(fixturePath);

		expect(result).toEqual({
			ok: false,
			errors: [
				{
					code: "editable_surface_overlaps_protected_surface",
					path: "editableSurface[0]",
					message: "Editable path packages/selfpi/src/** overlaps protected path packages/selfpi/**.",
				},
			],
		});
	});
});
