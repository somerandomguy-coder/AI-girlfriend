import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";
import { APP_ROOT } from "./paths.js";
import { winHelper } from "./winhelper.js";

export interface GpuInfo {
	name: string;
	vramTotalGB: number;
	vramUsedGB: number;
	utilPct: number;
}

export function gpus(): GpuInfo[] {
	try {
		const out = execFileSync("nvidia-smi", ["--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 8000,
		});
		return out
			.trim()
			.split("\n")
			.map((l) => {
				const [name, total, used, util] = l.split(",").map((s) => s.trim());
				return { name, vramTotalGB: +(+total / 1024).toFixed(1), vramUsedGB: +(+used / 1024).toFixed(1), utilPct: +util };
			});
	} catch {
		return [];
	}
}

export async function systemInfo(ollamaBaseUrl: string): Promise<Record<string, unknown>> {
	const extra = await winHelper.send("sysinfo", 20_000).catch(() => ({}));
	let loadedModels: unknown = [];
	try {
		const r = await fetch(`${ollamaBaseUrl}/api/ps`);
		loadedModels = ((await r.json()) as { models: Array<{ name: string; size_vram: number }> }).models.map(
			(m) => `${m.name} (${(m.size_vram / 1e9).toFixed(1)} GB VRAM)`,
		);
	} catch {
		loadedModels = "ollama not reachable";
	}
	return {
		cpu: cpus()[0]?.model,
		cores: cpus().length,
		ramTotalGB: +(totalmem() / 1e9).toFixed(1),
		ramFreeGB: +(freemem() / 1e9).toFixed(1),
		gpus: gpus(),
		ollamaLoaded: loadedModels,
		...extra,
	};
}

// ---- Cookbook: "what model fits this PC?" (heuristic adapted from odysseus services/hwfit) ----

const BYTES_PER_PARAM: Record<string, number> = { Q8_0: 1.05, Q6_K: 0.8, Q5_K_M: 0.68, Q4_K_M: 0.58, Q3_K_M: 0.48 };

interface CatalogModel {
	tag: string;
	paramsB: number;
	activeB: number;
	uses: string[];
	langs: string;
	notes: string;
}

export interface FitResult {
	tag: string;
	quant: string;
	needGB: number;
	fit: "perfect" | "good" | "tight" | "no";
	estTokPerSec: number;
	uses: string[];
	langs: string;
	notes: string;
}

export function recommendModels(opts: { vramGB?: number; gpuName?: string; reserveGB?: number; contextTokens?: number; use?: string }): {
	vramGB: number;
	budgetGB: number;
	results: FitResult[];
} {
	const catalog = JSON.parse(readFileSync(join(APP_ROOT, "catalog", "models.json"), "utf8")) as {
		models: CatalogModel[];
		gpuBandwidthGBs: Record<string, number>;
	};
	const g = gpus()[0];
	const vramGB = opts.vramGB ?? g?.vramTotalGB ?? 0;
	const gpuName = opts.gpuName ?? g?.name ?? "";
	// Leave room for TTS/ASR, the desktop, and the browser.
	const reserve = opts.reserveGB ?? 3;
	const budget = Math.max(0, vramGB - reserve);
	const ctx = opts.contextTokens ?? 16384;
	const bwKey = Object.keys(catalog.gpuBandwidthGBs)
		.sort((a, b) => b.length - a.length)
		.find((k) => gpuName.toUpperCase().includes(k.toUpperCase()));
	const bandwidth = bwKey ? catalog.gpuBandwidthGBs[bwKey] : 400;

	const results: FitResult[] = [];
	for (const m of catalog.models) {
		if (opts.use && !m.uses.includes(opts.use)) continue;
		let best: FitResult | undefined;
		for (const quant of Object.keys(BYTES_PER_PARAM)) {
			const weights = m.paramsB * BYTES_PER_PARAM[quant];
			const kv = 8e-6 * m.activeB * ctx;
			const need = weights + kv + 0.5;
			if (need > budget) continue;
			const ratio = budget / need;
			const activeGB = m.activeB * BYTES_PER_PARAM[quant];
			best = {
				tag: m.tag,
				quant,
				needGB: +need.toFixed(1),
				fit: ratio >= 1.5 ? "perfect" : ratio >= 1.2 ? "good" : "tight",
				estTokPerSec: Math.round((bandwidth / activeGB) * 0.55 * (m.activeB < m.paramsB ? 0.8 : 1)),
				uses: m.uses,
				langs: m.langs,
				notes: m.notes,
			};
			break; // highest quality quant that fits
		}
		results.push(
			best ?? {
				tag: m.tag,
				quant: "-",
				needGB: +(m.paramsB * BYTES_PER_PARAM.Q4_K_M + 0.5).toFixed(1),
				fit: "no",
				estTokPerSec: 0,
				uses: m.uses,
				langs: m.langs,
				notes: m.notes,
			},
		);
	}
	const rank = { perfect: 0, good: 1, tight: 2, no: 3 };
	results.sort((a, b) => rank[a.fit] - rank[b.fit] || b.needGB - a.needGB);
	return { vramGB, budgetGB: +budget.toFixed(1), results };
}
