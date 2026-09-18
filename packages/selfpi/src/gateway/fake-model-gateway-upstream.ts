import type { ModelGatewayUpstream, ModelGatewayUpstreamResult } from "./model-gateway.ts";

export function createFakeModelGatewayUpstream(): ModelGatewayUpstream {
	return {
		async complete(): Promise<ModelGatewayUpstreamResult> {
			return {
				body: {
					id: "fake-completion",
					object: "chat.completion",
					choices: [{ index: 0, message: { role: "assistant", content: "fake upstream unused" } }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				},
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		},
	};
}
