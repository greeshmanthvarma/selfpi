import type { ModelGatewayUpstream, ModelGatewayUpstreamInput, ModelGatewayUpstreamResult } from "./model-gateway.ts";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createHttpModelGatewayUpstream(options?: { readonly fetchImpl?: typeof fetch }): ModelGatewayUpstream {
	const fetchImpl = options?.fetchImpl ?? fetch;
	return {
		async complete(input: ModelGatewayUpstreamInput): Promise<ModelGatewayUpstreamResult> {
			const baseUrl =
				process.env[`SELFPI_PROVIDER_${input.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE_URL`];
			if (baseUrl === undefined || baseUrl.length === 0) {
				throw new Error(`Provider base URL is not configured for ${input.provider}.`);
			}
			const response = await fetchImpl(
				new URL(input.path ?? "chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`),
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${input.providerCredential}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(input.request),
				},
			);
			const contentType = response.headers.get("content-type") ?? "application/json";
			if (contentType.includes("text/event-stream")) {
				const body = await response.text();
				return {
					body,
					contentType: "text/event-stream",
					usage: { inputTokens: 0, outputTokens: 0 },
				};
			}
			const body: unknown = await response.json();
			if (!response.ok) {
				const detail =
					isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
						? body.error.message
						: isRecord(body) && typeof body.error === "string"
							? body.error
							: JSON.stringify(body).slice(0, 500);
				throw new Error(
					`Provider ${input.provider} request failed with status ${String(response.status)}: ${detail}`,
				);
			}
			const usage =
				isRecord(body) && isRecord(body.usage)
					? {
							inputTokens:
								typeof body.usage.prompt_tokens === "number"
									? body.usage.prompt_tokens
									: typeof body.usage.input_tokens === "number"
										? body.usage.input_tokens
										: 0,
							outputTokens:
								typeof body.usage.completion_tokens === "number"
									? body.usage.completion_tokens
									: typeof body.usage.output_tokens === "number"
										? body.usage.output_tokens
										: 0,
						}
					: { inputTokens: 0, outputTokens: 0 };
			return { body, usage };
		},
	};
}
