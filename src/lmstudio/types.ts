// Narrow validators for /v1/models and /v1/chat/completions chunks.
// We never widen `unknown` to `any` — every shape we touch has a
// hand-rolled type guard. Servers in this space (LM Studio, Ollama,
// vLLM) all add their own non-OpenAI fields (`state`, `max_context_length`,
// `digest`, etc.); we tolerate them by only checking the fields we use.
import { isObject } from '../util/guards';

export interface ModelEntry {
	id: string;
}

export interface ModelsResponse {
	data: ModelEntry[];
}

export interface ChatStreamDelta {
	choices?: Array<{
		delta?: { content?: string };
	}>;
}

function isString(x: unknown): x is string {
	return typeof x === 'string';
}

export function isModelEntry(x: unknown): x is ModelEntry {
	return isObject(x) && isString(x.id);
}

export function isModelsResponse(x: unknown): x is ModelsResponse {
	if (!isObject(x)) return false;
	const data = x.data;
	if (!Array.isArray(data)) return false;
	for (const item of data) {
		if (!isModelEntry(item)) return false;
	}
	return true;
}

export function extractStreamDelta(x: unknown): string | null {
	if (!isObject(x)) return null;
	const choices: unknown = x.choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const first: unknown = choices[0];
	if (!isObject(first)) return null;
	const delta: unknown = first.delta;
	if (!isObject(delta)) return null;
	const content: unknown = delta.content;
	if (!isString(content)) return null;
	return content;
}
