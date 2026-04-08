/** Strip C0/C1/DEL/zero-width/line separator chars. */
export function sanitize(text: string): string {
	return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F\u200B-\u200F\u2028\u2029\uFEFF]/g, "");
}

export function modelToStr(model: any): string {
	if (!model) return "";
	return `${model.provider}/${model.id}`;
}

export function findModel(modelStr: string, ctx: any): any | null {
	const idx = modelStr.indexOf("/");
	if (idx === -1) return null;
	return ctx.modelRegistry.find(modelStr.slice(0, idx), modelStr.slice(idx + 1));
}

interface LastAssistant { text: string; stopReason: string | undefined }

export function getLastAssistant(ctx: any): LastAssistant {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message.role === "assistant") {
			return { text: extractText(e.message.content), stopReason: e.message.stopReason };
		}
	}
	return { text: "", stopReason: undefined };
}

export function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}
