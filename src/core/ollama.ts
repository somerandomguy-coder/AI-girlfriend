/** Direct Ollama calls for side jobs (goal checks, vision) that shouldn't enter the chat transcript. */
export async function ollamaChat(
	baseUrl: string,
	model: string,
	messages: Array<{ role: "system" | "user" | "assistant"; content: string; images?: string[] }>,
	opts: { format?: "json" | object; timeoutMs?: number; numCtx?: number; numPredict?: number } = {},
): Promise<string> {
	const res = await fetch(`${baseUrl}/api/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model,
			messages,
			stream: false,
			think: false,
			format: opts.format,
			// No num_ctx unless asked: a context size different from the one the model is loaded with makes
			// Ollama reload the whole model, so side calls use the Modelfile's value like the chat does.
			options: { temperature: 0.2, num_ctx: opts.numCtx, num_predict: opts.numPredict },
			keep_alive: "30m",
		}),
		signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
	});
	if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const out = (await res.json()) as { message?: { content?: string } };
	return out.message?.content?.trim() ?? "";
}

export async function ollamaUp(baseUrl: string): Promise<boolean> {
	try {
		const r = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(3000) });
		return r.ok;
	} catch {
		return false;
	}
}
