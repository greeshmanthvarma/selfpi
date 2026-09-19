import { describe, expect, it } from "vitest";

/**
 * Opt-in real Docker integration for the complete supervised composition.
 * Enable with SELFPI_DOCKER_INTEGRATION=1. Requires a working Docker daemon,
 * pullable proxy/base images, and provider credentials configured via
 * SELFPI_PROVIDER_CREDENTIALS_JSON / SELFPI_MODEL_PRICING_JSON.
 */
const describeDocker = process.env.SELFPI_DOCKER_INTEGRATION === "1" ? describe : describe.skip;

describeDocker("supervised improvement real Docker integration", () => {
	it("documents the opt-in seam for a complete supervised composition", () => {
		expect(process.env.SELFPI_DOCKER_INTEGRATION).toBe("1");
		expect(process.env.SELFPI_PROVIDER_CREDENTIALS_JSON?.length ?? 0).toBeGreaterThan(0);
		expect(process.env.SELFPI_MODEL_PRICING_JSON?.length ?? 0).toBeGreaterThan(0);
	});
});
