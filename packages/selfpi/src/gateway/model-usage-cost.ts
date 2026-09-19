export interface ModelTokenPricing {
	readonly inputUsdPerMillionTokens: number;
	readonly outputUsdPerMillionTokens: number;
}

export function costUsdForUsage(
	usage: { readonly inputTokens: number; readonly outputTokens: number },
	pricing: ModelTokenPricing,
): number {
	if (
		!Number.isFinite(usage.inputTokens) ||
		usage.inputTokens < 0 ||
		!Number.isFinite(usage.outputTokens) ||
		usage.outputTokens < 0 ||
		!Number.isFinite(pricing.inputUsdPerMillionTokens) ||
		pricing.inputUsdPerMillionTokens < 0 ||
		!Number.isFinite(pricing.outputUsdPerMillionTokens) ||
		pricing.outputUsdPerMillionTokens < 0
	) {
		throw new Error("Model usage pricing inputs are invalid.");
	}
	return (
		(usage.inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
		(usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens
	);
}
