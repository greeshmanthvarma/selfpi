process.stdout.write(
	`${JSON.stringify({
		decision: "approve_for_evaluation",
		hypothesisAlignment: "aligned",
		risks: ["Deterministic evidence does not establish real-model improvement."],
		violations: [],
	})}\n`,
);
