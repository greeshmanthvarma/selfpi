export function usesOpenAIResponsesApi(modelId: string): boolean {
	return (
		modelId.startsWith("gpt-5.5") ||
		modelId.startsWith("gpt-5.6") ||
		modelId.startsWith("gpt-6") ||
		modelId.includes("gpt-5.6-") ||
		modelId.includes("gpt-5.5-")
	);
}

export function gatewayModelProviderConfig(input: {
	readonly provider: string;
	readonly model: string;
	readonly endpoint: string;
	readonly maxTokens?: number;
}): Readonly<Record<string, unknown>> {
	const maxTokens = input.maxTokens ?? 16_384;
	const responses = usesOpenAIResponsesApi(input.model);
	return Object.freeze({
		providers: {
			[input.provider]: {
				baseUrl: input.endpoint,
				api: responses ? "openai-responses" : "openai-completions",
				apiKey: "$SELFPI_GATEWAY_TOKEN",
				models: [
					responses
						? {
								id: input.model,
								name: input.model,
								reasoning: true,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 272_000,
								maxTokens,
								thinkingLevelMap: {
									off: "none",
									low: "low",
									medium: "medium",
									high: "high",
									xhigh: "xhigh",
									max: "max",
								},
								compat: {
									supportsStore: false,
									supportsDeveloperRole: false,
								},
							}
						: {
								id: input.model,
								name: input.model,
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128_000,
								maxTokens,
								compat: {
									maxTokensField: "max_tokens",
									supportsStore: false,
									supportsDeveloperRole: false,
								},
							},
				],
			},
		},
	});
}
