import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("SelfPi pull-request CI", () => {
	it("repeats protected checks without running an improvement cycle", async () => {
		const workflowPath = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));
		const workflow = await readFile(workflowPath, "utf8");

		expect(workflow).toContain("pull_request:");
		expect(workflow).toContain("run: npm run check");
		expect(workflow).toContain("name: SelfPi targeted tests");
		expect(workflow).toContain("test/improvement-cycle.test.ts");
		expect(workflow).toContain("name: SelfPi candidate-policy validation");
		expect(workflow).toContain("test/candidate-policy.test.ts");
		expect(workflow).toContain("name: SelfPi artifact-redaction checks");
		expect(workflow).toContain("test/sealed-evidence-bundle.test.ts");
		expect(workflow).toContain("test/inspect-run.test.ts");
		expect(workflow).not.toMatch(/selfpi\s+improve/);
	});
});
