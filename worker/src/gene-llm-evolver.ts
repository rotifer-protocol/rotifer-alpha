/**
 * LLM-driven Gene variant config generation — Phase 3.5 Step 1.
 *
 * After a Code Epoch eliminates the weakest variant, this module calls
 * Cloudflare Workers AI to generate a challenger config for the winning Gene.
 * The LLM receives trade performance data and returns a JSON config that
 * drives the "llm-config" strategy variant's behavior.
 *
 * Supported genes: polymarket-scanner, polymarket-monitor.
 * Unsupported genes fall back to the respawn path in code-evolver.ts.
 *
 * Per ADR-274 / Phase 3.5: this is Alpha-internal evolution, not protocol F(g).
 */

type AiBinding = NonNullable<import("./types").Env["AI"]>;

export interface LLMVariantStats {
  tradesEvaluated: number;
  winRate: number;   // 0-1
  avgPnl: number;    // USD per trade
  alphaScore: number;
}

// ─── Scanner ────────────────────────────────────────────

function buildScannerPrompt(stats: LLMVariantStats): string {
  return [
    `Gene: polymarket-scanner`,
    `Purpose: Detect trading signals in Polymarket prediction markets via edge/confidence analysis.`,
    ``,
    `Epoch performance of current winner:`,
    `  trades: ${stats.tradesEvaluated}, win rate: ${(stats.winRate * 100).toFixed(1)}%, avg PnL: $${stats.avgPnl.toFixed(0)}, Alpha score: ${stats.alphaScore.toFixed(1)}`,
    ``,
    `Design a challenger with a DIFFERENT scanning hypothesis.`,
    `Available config overrides:`,
    `  "minVolumeMultiplier" [0.5-3.0] — scale volume filter (higher = fewer, more-liquid markets)`,
    `  "edgeBoost" [0.0-4.0]          — subtract from signal edge (higher = only trade larger edges)`,
    `  "confidenceFloor" [0.15-0.50]  — min signal confidence (higher = more selective)`,
    `  "excludeTypes" [array]         — types to skip, choose from: ["SPREAD","MISPRICING","MOMENTUM"]`,
    `  "hypothesis" [string]          — one sentence explaining the approach`,
    ``,
    `Respond with ONLY valid JSON, no prose. Example:`,
    `{"minVolumeMultiplier":1.8,"edgeBoost":1.5,"confidenceFloor":0.38,"excludeTypes":["SPREAD"],"hypothesis":"Prioritize high-confidence mispricing in liquid markets, avoid spread trades"}`,
  ].join("\n");
}

function parseScannerConfig(raw: string): Record<string, unknown> {
  const data = JSON.parse(raw);
  const cfg: Record<string, unknown> = {};
  if (typeof data.minVolumeMultiplier === "number")
    cfg.minVolumeMultiplier = Math.max(0.5, Math.min(3.0, data.minVolumeMultiplier));
  if (typeof data.edgeBoost === "number")
    cfg.edgeBoost = Math.max(0, Math.min(4.0, data.edgeBoost));
  if (typeof data.confidenceFloor === "number")
    cfg.confidenceFloor = Math.max(0.15, Math.min(0.5, data.confidenceFloor));
  if (Array.isArray(data.excludeTypes))
    cfg.excludeTypes = data.excludeTypes.filter((t: unknown) => typeof t === "string");
  if (typeof data.hypothesis === "string")
    cfg.hypothesis = data.hypothesis.slice(0, 200);
  return cfg;
}

// ─── Monitor ────────────────────────────────────────────

function buildMonitorPrompt(stats: LLMVariantStats): string {
  return [
    `Gene: polymarket-monitor`,
    `Purpose: Manage open prediction-market positions — stop-loss, take-profit, trailing stop.`,
    ``,
    `Epoch performance of current winner:`,
    `  trades: ${stats.tradesEvaluated}, win rate: ${(stats.winRate * 100).toFixed(1)}%, avg PnL: $${stats.avgPnl.toFixed(0)}, Alpha score: ${stats.alphaScore.toFixed(1)}`,
    ``,
    `Design a challenger with a DIFFERENT position-management hypothesis.`,
    `Available config overrides:`,
    `  "adaptiveMode" [true/false]       — widen stop-loss for positions younger than youngPositionDays`,
    `  "youngPositionDays" [1-7]         — days before stop-loss fully applies to new positions`,
    `  "trailingTightenFactor" [0.2-0.9] — how aggressively trailing stop tightens as position gains (lower = tighter)`,
    `  "hypothesis" [string]             — one sentence explaining the approach`,
    ``,
    `Respond with ONLY valid JSON, no prose. Example:`,
    `{"adaptiveMode":true,"youngPositionDays":5,"trailingTightenFactor":0.35,"hypothesis":"More patience for new positions, aggressive locking in profits"}`,
  ].join("\n");
}

function parseMonitorConfig(raw: string): Record<string, unknown> {
  const data = JSON.parse(raw);
  const cfg: Record<string, unknown> = {};
  if (typeof data.adaptiveMode === "boolean")
    cfg.adaptiveMode = data.adaptiveMode;
  if (typeof data.youngPositionDays === "number")
    cfg.youngPositionDays = Math.round(Math.max(1, Math.min(7, data.youngPositionDays)));
  if (typeof data.trailingTightenFactor === "number")
    cfg.trailingTightenFactor = Math.max(0.2, Math.min(0.9, data.trailingTightenFactor));
  if (typeof data.hypothesis === "string")
    cfg.hypothesis = data.hypothesis.slice(0, 200);
  return cfg;
}

// ─── Risk ────────────────────────────────────────────────

function buildRiskPrompt(stats: LLMVariantStats): string {
  return [
    `Gene: polymarket-risk`,
    `Purpose: Enforce stop-loss and max-hold-days rules on open positions.`,
    ``,
    `Epoch performance of current winner:`,
    `  trades: ${stats.tradesEvaluated}, win rate: ${(stats.winRate * 100).toFixed(1)}%, avg PnL: $${stats.avgPnl.toFixed(0)}, Alpha score: ${stats.alphaScore.toFixed(1)}`,
    ``,
    `Design a challenger with a DIFFERENT risk management hypothesis.`,
    `Available config overrides (multipliers applied to each fund's configured thresholds):`,
    `  "stopLossMultiplier" [0.5-1.5]  — scale stop-loss threshold (0.8=tighter, 1.2=looser)`,
    `  "maxHoldMultiplier"  [0.5-2.0]  — scale max hold days (0.7=shorter, 1.5=longer)`,
    `  "hypothesis" [string]           — one sentence explaining the approach`,
    ``,
    `Respond with ONLY valid JSON. Example:`,
    `{"stopLossMultiplier":0.75,"maxHoldMultiplier":0.8,"hypothesis":"Tighter stops and shorter holds to cut losses faster"}`,
  ].join("\n");
}

function parseRiskConfig(raw: string): Record<string, unknown> {
  const data = JSON.parse(raw);
  const cfg: Record<string, unknown> = {};
  if (typeof data.stopLossMultiplier === "number")
    cfg.stopLossMultiplier = Math.max(0.5, Math.min(1.5, data.stopLossMultiplier));
  if (typeof data.maxHoldMultiplier === "number")
    cfg.maxHoldMultiplier = Math.max(0.5, Math.min(2.0, data.maxHoldMultiplier));
  if (typeof data.hypothesis === "string")
    cfg.hypothesis = data.hypothesis.slice(0, 200);
  return cfg;
}

// ─── Trader ──────────────────────────────────────────────

function buildTraderPrompt(stats: LLMVariantStats): string {
  return [
    `Gene: polymarket-trader`,
    `Purpose: Select and size positions from scanner signals for each fund.`,
    ``,
    `Epoch performance of current winner:`,
    `  trades: ${stats.tradesEvaluated}, win rate: ${(stats.winRate * 100).toFixed(1)}%, avg PnL: $${stats.avgPnl.toFixed(0)}, Alpha score: ${stats.alphaScore.toFixed(1)}`,
    ``,
    `Design a challenger with a DIFFERENT signal selection hypothesis.`,
    `Available config overrides:`,
    `  "edgeMultiplier" [0.5-3.0]         — scale the minimum edge bar (higher=more selective)`,
    `  "signalSortMode" [string]           — sort signals by: "edge", "confidence", "combined"`,
    `  "maxSignalsPerFund" [1-8]           — max signals to attempt per fund per cycle`,
    `  "hypothesis" [string]              — one sentence explaining the approach`,
    ``,
    `Respond with ONLY valid JSON. Example:`,
    `{"edgeMultiplier":1.5,"signalSortMode":"confidence","maxSignalsPerFund":3,"hypothesis":"Prioritize high-confidence signals and be more selective on edge"}`,
  ].join("\n");
}

function parseTraderConfig(raw: string): Record<string, unknown> {
  const data = JSON.parse(raw);
  const cfg: Record<string, unknown> = {};
  if (typeof data.edgeMultiplier === "number")
    cfg.edgeMultiplier = Math.max(0.5, Math.min(3.0, data.edgeMultiplier));
  if (typeof data.signalSortMode === "string" && ["edge", "confidence", "combined"].includes(data.signalSortMode))
    cfg.signalSortMode = data.signalSortMode;
  if (typeof data.maxSignalsPerFund === "number")
    cfg.maxSignalsPerFund = Math.round(Math.max(1, Math.min(8, data.maxSignalsPerFund)));
  if (typeof data.hypothesis === "string")
    cfg.hypothesis = data.hypothesis.slice(0, 200);
  return cfg;
}

// ─── Micro-Evolver ───────────────────────────────────────

function buildMicroEvolverPrompt(stats: LLMVariantStats): string {
  return [
    `Gene: polymarket-micro-evolver`,
    `Purpose: Periodically nudge fund parameters (stop-loss, sizing, etc.) based on recent trade outcomes.`,
    ``,
    `Epoch performance of current winner:`,
    `  trades: ${stats.tradesEvaluated}, win rate: ${(stats.winRate * 100).toFixed(1)}%, avg PnL: $${stats.avgPnl.toFixed(0)}, Alpha score: ${stats.alphaScore.toFixed(1)}`,
    ``,
    `Design a challenger with a DIFFERENT parameter-adjustment strategy.`,
    `Available config overrides:`,
    `  "adjustRatio" [0.01-0.08]    — nudge size as fraction of param range (0.02=conservative, 0.05=aggressive)`,
    `  "tradeThreshold" [5-30]      — closed trades needed before nudging triggers`,
    `  "hypothesis" [string]        — one sentence explaining the approach`,
    ``,
    `Respond with ONLY valid JSON. Example:`,
    `{"adjustRatio":0.04,"tradeThreshold":12,"hypothesis":"More frequent, slightly larger nudges for faster adaptation"}`,
  ].join("\n");
}

function parseMicroEvolverConfig(raw: string): Record<string, unknown> {
  const data = JSON.parse(raw);
  const cfg: Record<string, unknown> = {};
  if (typeof data.adjustRatio === "number")
    cfg.adjustRatio = Math.max(0.01, Math.min(0.08, data.adjustRatio));
  if (typeof data.tradeThreshold === "number")
    cfg.tradeThreshold = Math.round(Math.max(5, Math.min(30, data.tradeThreshold)));
  if (typeof data.hypothesis === "string")
    cfg.hypothesis = data.hypothesis.slice(0, 200);
  return cfg;
}

// ─── Public API ─────────────────────────────────────────

const SUPPORTED_GENES: Record<string, {
  buildPrompt: (stats: LLMVariantStats) => string;
  parseConfig: (raw: string) => Record<string, unknown>;
}> = {
  "polymarket-scanner":       { buildPrompt: buildScannerPrompt,      parseConfig: parseScannerConfig },
  "polymarket-monitor":       { buildPrompt: buildMonitorPrompt,      parseConfig: parseMonitorConfig },
  "polymarket-risk":          { buildPrompt: buildRiskPrompt,         parseConfig: parseRiskConfig },
  "polymarket-trader":        { buildPrompt: buildTraderPrompt,       parseConfig: parseTraderConfig },
  "polymarket-micro-evolver": { buildPrompt: buildMicroEvolverPrompt, parseConfig: parseMicroEvolverConfig },
};

export function isLLMSupportedGene(geneId: string): boolean {
  return geneId in SUPPORTED_GENES;
}

/**
 * Call Cloudflare Workers AI to generate a challenger variant config.
 * Returns null on any failure — callers should fall back to respawn.
 */
export async function generateLLMVariantConfig(
  ai: AiBinding,
  geneId: string,
  stats: LLMVariantStats,
): Promise<Record<string, unknown> | null> {
  const handler = SUPPORTED_GENES[geneId];
  if (!handler) return null;

  try {
    const result = await ai.run("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", {
      messages: [
        {
          role: "system",
          content: "You are a quantitative trading strategy optimizer. Respond with ONLY valid JSON. Do not include any reasoning, explanation, or text outside the JSON object.",
        },
        { role: "user", content: handler.buildPrompt(stats) },
      ],
      max_tokens: 300,
    });

    const text = result.response?.trim() ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[LLM-Evolver] No JSON found in AI response for ${geneId}:`, text.slice(0, 100));
      return null;
    }

    const config = handler.parseConfig(jsonMatch[0]);
    console.log(`[LLM-Evolver] Generated config for ${geneId}:`, JSON.stringify(config));
    return config;
  } catch (e) {
    console.warn(`[LLM-Evolver] AI call failed for ${geneId}:`, e);
    return null;
  }
}
