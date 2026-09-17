import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("SelfPi promotion image workflow", () => {
	it("manually publishes and records an immutable image with source lineage labels", async () => {
		const workflowPath = fileURLToPath(
			new URL("../../../.github/workflows/publish-selfpi-image.yml", import.meta.url),
		);
		const dockerfilePath = fileURLToPath(new URL("../Dockerfile", import.meta.url));
		const [workflow, dockerfile] = await Promise.all([
			readFile(workflowPath, "utf8"),
			readFile(dockerfilePath, "utf8"),
		]);

		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).toContain("environment: selfpi-promotion");
		expect(workflow).toContain("packages: write");
		expect(workflow).toContain("ref: $" + "{{ inputs.source_commit }}");
		expect(workflow).toContain("org.opencontainers.image.revision=$" + "{{ inputs.source_commit }}");
		expect(workflow).toContain("works.selfpi.predecessor=$" + "{{ inputs.predecessor_commit }}");
		expect(workflow).toContain("IMAGE_DIGEST: $" + "{{ steps.build.outputs.digest }}");
		expect(workflow).toContain('"imageDigest": "$' + '{IMAGE_DIGEST}"');
		expect(workflow).toContain("actions/upload-artifact@");
		expect(workflow).not.toContain(":latest");
		expect(workflow).not.toMatch(/selfpi\s+improve/);
		expect(dockerfile).toContain('ENTRYPOINT ["node", "packages/coding-agent/dist/bundle/cli.js"]');
	});
});
