export function redactSecrets(text: string): string {
	return text
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
		.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
		.replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]");
}

export function redactSensitiveValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return Object.freeze(value.map(redactSensitiveValue));
	if (typeof value !== "object" || value === null) return value;
	return Object.freeze(
		Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSensitiveValue(entry)])),
	);
}
