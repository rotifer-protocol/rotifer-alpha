import { useState } from "react";
import {
  Shield, AlertTriangle, Activity, Lock, LockOpen, ChevronDown, ChevronUp,
  CheckCircle, XCircle, ChevronRight, BarChart2,
} from "lucide-react";
import { useFetch } from "../hooks/useApi";
import { useI18n } from "../i18n/context";
import type { TranslationKey } from "../i18n/translations";
import { FUND_COLORS, fundDisplayName } from "../lib/fundMeta";
import { InfoPopover } from "./InfoPopover";

// ─── Types ──────────────────────────────────────────────

interface PipelineError {
  id: string;
  occurred_at: string;
  stage: string;
  message: string;
  details: string | null;
}

interface DiagnosticsData {
  errors: PipelineError[];
  killSwitch: boolean;
  executionMode: string;
  skipByFund: Record<string, Record<string, number>>;
}

interface HeartbeatData {
  heartbeat: {
    lastScanAt: string;
    totalFetched: number;
    signalsFound: number;
    tradesOpened: number;
    settlementsProcessed: number;
    riskStops: number;
  } | null;
}

// ─── Lookup tables ───────────────────────────────────────

const SKIP_LABEL_KEYS: Record<string, TranslationKey> = {
  TYPE_NOT_ALLOWED:   "skipTypeNotAllowed",
  DUPLICATE_MARKET:   "skipDuplicateMarket",
  MAX_POSITIONS:      "skipMaxPositions",
  MAX_EVENT_EXPOSURE: "skipMaxEventExposure",
  OTM_CAP:            "skipOtmCap",
  LOW_PRICE_REJECT:   "skipLowPriceReject",
  PRICE_BOUNDARY:     "skipPriceBoundary",
  VOLUME_TOO_LOW:     "skipVolumeTooLow",
  LIQUIDITY_TOO_LOW:  "skipLiquidityTooLow",
  EDGE_TOO_LOW:       "skipEdgeTooLow",
  CONFIDENCE_TOO_LOW: "skipConfidenceTooLow",
  COMPOSITE_TOO_LOW:  "skipCompositeTooLow",
  FUND_FROZEN:        "skipFundFrozen",
  INSUFFICIENT_CASH:  "skipInsufficientCash",
};

const SKIP_TIP_KEYS: Record<string, TranslationKey> = {
  TYPE_NOT_ALLOWED:   "tipSkipTypeNotAllowed",
  DUPLICATE_MARKET:   "tipSkipDuplicateMarket",
  MAX_POSITIONS:      "tipSkipMaxPositions",
  MAX_EVENT_EXPOSURE: "tipSkipMaxEventExposure",
  OTM_CAP:            "tipSkipOtmCap",
  LOW_PRICE_REJECT:   "tipSkipLowPriceReject",
  PRICE_BOUNDARY:     "tipSkipPriceBoundary",
  VOLUME_TOO_LOW:     "tipSkipVolumeTooLow",
  LIQUIDITY_TOO_LOW:  "tipSkipLiquidityTooLow",
  EDGE_TOO_LOW:       "tipSkipEdgeTooLow",
  CONFIDENCE_TOO_LOW: "tipSkipConfidenceTooLow",
  COMPOSITE_TOO_LOW:  "tipSkipCompositeTooLow",
  FUND_FROZEN:        "tipSkipFundFrozen",
  INSUFFICIENT_CASH:  "tipSkipInsufficientCash",
};

const SKIP_COLORS: Record<string, string> = {
  TYPE_NOT_ALLOWED:   "bg-zinc-800 text-zinc-400",
  DUPLICATE_MARKET:   "bg-blue-900/40 text-blue-400",
  MAX_POSITIONS:      "bg-blue-900/40 text-blue-400",
  MAX_EVENT_EXPOSURE: "bg-purple-900/40 text-purple-400",
  OTM_CAP:            "bg-purple-900/40 text-purple-400",
  LOW_PRICE_REJECT:   "bg-rose-900/40 text-rose-400",
  PRICE_BOUNDARY:     "bg-rose-900/40 text-rose-400",
  VOLUME_TOO_LOW:     "bg-amber-900/40 text-amber-400",
  LIQUIDITY_TOO_LOW:  "bg-amber-900/40 text-amber-400",
  EDGE_TOO_LOW:       "bg-yellow-900/40 text-yellow-400",
  CONFIDENCE_TOO_LOW: "bg-yellow-900/40 text-yellow-400",
  COMPOSITE_TOO_LOW:  "bg-yellow-900/40 text-yellow-400",
  FUND_FROZEN:        "bg-red-900/40 text-red-400",
  INSUFFICIENT_CASH:  "bg-orange-900/40 text-orange-400",
};

const STAGE_COLORS: Record<string, string> = {
  scanner:          "text-blue-400",
  trader:           "text-yellow-400",
  monitor:          "text-purple-400",
  settler:          "text-green-400",
  risk:             "text-red-400",
  "micro-evolver":  "text-pink-400",
  genome:           "text-[var(--r-accent)]",
};

const STAGE_NAME_KEYS: Record<string, TranslationKey> = {
  scanner:          "stageScannerName",
  trader:           "stageTraderName",
  monitor:          "stageMonitorName",
  settler:          "stageSettlerName",
  risk:             "stageRiskName",
  "micro-evolver":  "stageMicroEvolverName",
  genome:           "stageGenomeName",
};

const EXEC_MODE_LABELS: Record<string, TranslationKey> = {
  paper:  "executionModePaper",
  shadow: "executionModeShadow",
  live:   "executionModeLive",
};

// ─── Utilities ───────────────────────────────────────────

function relativeTime(iso: string, agoLabel: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return `<1 min ${agoLabel}`;
  if (mins < 60) return `${mins} min ${agoLabel}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ${agoLabel}`;
  return `${Math.floor(hrs / 24)} d ${agoLabel}`;
}

// ─── Confirm Modal (P0-②) ────────────────────────────────

interface ConfirmModalProps {
  title: string;
  desc: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmModal({ title, desc, confirmLabel, cancelLabel, danger, onConfirm, onCancel }: ConfirmModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        className="glass-card max-w-sm w-full p-5 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-semibold text-sm">{title}</h3>
        <p className="text-xs text-[var(--r-text-muted)]">{desc}</p>
        <div className="flex gap-2 pt-1">
          <button
            onClick={onConfirm}
            className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors ${
              danger
                ? "bg-red-500 hover:bg-red-400 text-white"
                : "bg-[var(--r-accent)] hover:opacity-90 text-black"
            }`}
          >
            {confirmLabel}
          </button>
          <button
            onClick={onCancel}
            className="flex-1 py-2 text-xs rounded-lg bg-[var(--r-surface)] border border-[var(--r-border)] text-[var(--r-text-muted)] hover:text-[var(--r-text)] transition-colors"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Health Banner (P0-①) ────────────────────────────────

function HealthBanner({
  killSwitch, errorCount, executionMode, lastScanAt,
}: {
  killSwitch: boolean;
  errorCount: number;
  executionMode: string;
  lastScanAt?: string;
}) {
  const { t } = useI18n();

  const status = killSwitch ? "halted" : errorCount > 0 ? "degraded" : "ok";
  const cfg = {
    ok:       { bg: "bg-[var(--r-accent)]/10 border-[var(--r-accent)]/25", dot: "bg-[var(--r-accent)]", label: t("diagHealthOk"),      pulse: false },
    degraded: { bg: "bg-amber-900/20 border-amber-500/30",                  dot: "bg-amber-400",         label: t("diagHealthDegraded"), pulse: true },
    halted:   { bg: "bg-red-900/20 border-red-500/30",                      dot: "bg-red-500",           label: t("diagHealthHalted"),   pulse: true },
  }[status];

  const modeKey = EXEC_MODE_LABELS[executionMode] as TranslationKey | undefined;
  const modeLabel = modeKey ? t(modeKey) : executionMode;

  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 rounded-xl border ${cfg.bg}`}>
      {/* Status dot + label */}
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.dot} ${cfg.pulse ? "animate-pulse" : ""}`} />
        <span className="text-sm font-semibold">{cfg.label}</span>
        {status === "halted" && (
          <span className="text-xs text-red-400">{t("diagHealthHaltedDesc")}</span>
        )}
        {status === "degraded" && errorCount > 0 && (
          <span className="text-xs text-amber-400">{errorCount} {t("diagHealthErrors")}</span>
        )}
      </div>
      {/* Divider */}
      <span className="hidden sm:inline text-[var(--r-border)]">|</span>
      {/* Mode */}
      <span className="text-xs text-[var(--r-text-muted)]">
        {t("diagHealthModeLabel")}: <span className="text-[var(--r-text)] font-medium">{modeLabel}</span>
      </span>
      {/* Last scan */}
      {lastScanAt && (
        <>
          <span className="hidden sm:inline text-[var(--r-border)]">|</span>
          <span className="text-xs text-[var(--r-text-muted)]">
            {t("heartbeatLastScan")}: {relativeTime(lastScanAt, t("diagErrorAgo"))}
          </span>
        </>
      )}
    </div>
  );
}

// ─── Pipeline KPI Strip (P2-①) ───────────────────────────

function PipelineKpiStrip({ hb }: { hb: HeartbeatData["heartbeat"] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);

  if (!hb) return null;

  const kpis = [
    { label: t("diagMarketsFetched"), value: hb.totalFetched },
    { label: t("diagSignalsFound"),   value: hb.signalsFound },
    { label: t("diagTradesOpenedDiag"), value: hb.tradesOpened },
    { label: t("diagSettled"),        value: hb.settlementsProcessed },
    { label: t("diagRiskStopsDiag"),  value: hb.riskStops, warn: hb.riskStops > 0 },
  ];

  return (
    <div className="glass-card">
      <button
        type="button"
        className="w-full flex items-center justify-between px-5 py-3"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-[var(--r-accent)]" />
          <span className="text-sm font-semibold">{t("diagPipelineActivity")}</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-[var(--r-text-muted)]" /> : <ChevronDown className="w-4 h-4 text-[var(--r-text-muted)]" />}
      </button>
      {open && (
        <div className="px-5 pb-4 grid grid-cols-2 sm:grid-cols-5 gap-3">
          {kpis.map(k => (
            <div key={k.label} className="flex flex-col gap-0.5">
              <span className="text-[10px] text-[var(--r-text-faint)]">{k.label}</span>
              <span className={`font-mono text-xl font-bold tabular-nums ${k.warn ? "text-amber-400" : "text-[var(--r-text)]"}`}>
                {k.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Skip Badge with tooltip (P1-②) ─────────────────────

function SkipBadge({ code, count, t }: { code: string; count: number; t: (k: TranslationKey) => string }) {
  const cls   = SKIP_COLORS[code] ?? "bg-zinc-800 text-zinc-400";
  const label = SKIP_LABEL_KEYS[code] ? t(SKIP_LABEL_KEYS[code]) : code;
  const tip   = SKIP_TIP_KEYS[code]   ? t(SKIP_TIP_KEYS[code])   : undefined;

  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded ${cls}`}>
      {label}
      <span className="opacity-70">×{count}</span>
      {tip && <InfoPopover text={tip} />}
    </span>
  );
}

// ─── Skip by Fund section (P1-② + P2-②) ─────────────────

function SkipByFundSection({ skipByFund }: { skipByFund: Record<string, Record<string, number>> }) {
  const { t } = useI18n();
  const [expanded, setExpanded]   = useState(true);
  const [sortBy, setSortBy]       = useState<"skips" | "fund">("skips");

  const entries = Object.entries(skipByFund).filter(([, reasons]) => Object.keys(reasons).length > 0);
  const sorted  = [...entries].sort(([aId, aR], [bId, bR]) => {
    if (sortBy === "skips") {
      const aTotal = Object.values(aR).reduce((s, n) => s + n, 0);
      const bTotal = Object.values(bR).reduce((s, n) => s + n, 0);
      return bTotal - aTotal;
    }
    return aId.localeCompare(bId);
  });

  return (
    <div className="glass-card p-5">
      {/* Header */}
      <button
        type="button"
        className="w-full flex items-center justify-between mb-1"
        aria-expanded={expanded}
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[var(--r-accent)]" />
          <h3 className="font-semibold text-sm">{t("diagSkipTitle")}</h3>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-[var(--r-text-muted)]" /> : <ChevronDown className="w-4 h-4 text-[var(--r-text-muted)]" />}
      </button>

      {expanded && (
        <>
          {/* Sort toggle + desc (P2-②) */}
          <div className="flex items-center justify-between mb-3 mt-2">
            <p className="text-xs text-[var(--r-text-muted)]">{t("diagSkipDesc")}</p>
            <div className="flex gap-1 shrink-0 ml-3">
              {(["skips", "fund"] as const).map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSortBy(k)}
                  className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors outline-none ${
                    sortBy === k
                      ? "bg-[var(--r-accent)]/15 text-[var(--r-accent)] border-[var(--r-accent)]/30"
                      : "text-[var(--r-text-faint)] border-transparent hover:text-[var(--r-text-muted)]"
                  }`}
                >
                  {k === "skips" ? t("diagSortBySkips") : t("diagSortByFund")}
                </button>
              ))}
            </div>
          </div>

          {sorted.length === 0 ? (
            <p className="text-xs text-[var(--r-text-faint)]">{t("diagSkipEmpty")}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {sorted.map(([fundId, reasons]) => {
                const color = FUND_COLORS[fundId] ?? "text-[var(--r-text-muted)]";
                const total = Object.values(reasons).reduce((s, n) => s + n, 0);
                return (
                  <div
                    key={fundId}
                    className="flex flex-col gap-1.5 p-3 rounded-lg bg-[var(--r-surface)] border border-[var(--r-border)]"
                  >
                    <div className="flex items-center justify-between">
                      <span className={`text-xs font-medium ${color}`}>{fundDisplayName(fundId, t)}</span>
                      <span className="text-[10px] text-[var(--r-text-faint)] font-mono">{total} {t("diagSkipCount")}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(reasons)
                        .sort(([, a], [, b]) => b - a)
                        .map(([code, count]) => (
                          <SkipBadge key={code} code={code} count={count} t={t} />
                        ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Pipeline errors section (P1-① ③) ────────────────────

function ErrorLogSection({ errors }: { errors: PipelineError[] }) {
  const { t } = useI18n();
  const [expanded,      setExpanded]      = useState(true);
  const [stageFilter,   setStageFilter]   = useState<string>("all");
  const [expandedErr,   setExpandedErr]   = useState<Set<string>>(new Set());

  const stages       = ["all", ...Array.from(new Set(errors.map(e => e.stage))).sort()];
  const filtered     = stageFilter === "all" ? errors : errors.filter(e => e.stage === stageFilter);
  const stageCounts  = Object.fromEntries(stages.map(s => [s, s === "all" ? errors.length : errors.filter(e => e.stage === s).length]));

  function toggleDetails(id: string) {
    setExpandedErr(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="glass-card p-5">
      {/* Header + stage filters */}
      <div className="mb-3">
        <button
          type="button"
          className="w-full flex items-center justify-between mb-2"
          aria-expanded={expanded}
          onClick={() => setExpanded(e => !e)}
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className={`w-4 h-4 ${errors.length > 0 ? "text-amber-400" : "text-[var(--r-text-muted)]"}`} />
            <h3 className="font-semibold text-sm">{t("diagErrorTitle")}</h3>
            {errors.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-900/40 text-amber-400 font-mono">
                {errors.length} {t("diagErrorCount")}
              </span>
            )}
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-[var(--r-text-muted)]" /> : <ChevronDown className="w-4 h-4 text-[var(--r-text-muted)]" />}
        </button>

        {/* Stage filter chips (P1-③) */}
        {expanded && errors.length > 0 && stages.length > 2 && (
          <div className="flex gap-1 flex-wrap mt-1">
            {stages.map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setStageFilter(s)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors outline-none ${
                  stageFilter === s
                    ? "bg-[var(--r-accent)]/15 text-[var(--r-accent)] border-[var(--r-accent)]/30"
                    : "text-[var(--r-text-faint)] border-transparent hover:text-[var(--r-text-muted)]"
                }`}
              >
                {s === "all" ? t("diagErrorAllStages") : (STAGE_NAME_KEYS[s] ? t(STAGE_NAME_KEYS[s]) : s)}
                {stageCounts[s] > 0 && (
                  <span className="ml-1 opacity-60">{stageCounts[s]}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {!expanded ? null : errors.length === 0 ? (
        <p className="text-xs text-[var(--r-accent)] flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--r-accent)]" />
          {t("diagErrorEmpty")}
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-[var(--r-text-faint)]">{t("diagSkipEmpty")}</p>
      ) : (
        <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
          {filtered.map(err => {
            const isExpanded = expandedErr.has(err.id);
            return (
              <div key={err.id} className="text-xs p-2.5 rounded-lg bg-[var(--r-surface)] border border-[var(--r-border)]">
                <div className="flex gap-3 items-start">
                  {/* Stage pill */}
                  <span className={`shrink-0 font-mono font-medium text-[10px] mt-0.5 ${STAGE_COLORS[err.stage] ?? "text-[var(--r-text-muted)]"}`}>
                    {STAGE_NAME_KEYS[err.stage] ? t(STAGE_NAME_KEYS[err.stage]) : err.stage}
                  </span>
                  {/* Message + time */}
                  <div className="flex-1 min-w-0">
                    <p className="text-[var(--r-text)] leading-snug">{err.message}</p>
                    <p className="text-[var(--r-text-faint)] text-[10px] mt-0.5">
                      {relativeTime(err.occurred_at, t("diagErrorAgo"))}
                    </p>
                  </div>
                  {/* Expand details toggle (P1-①) */}
                  {err.details && (
                    <button
                      type="button"
                      onClick={() => toggleDetails(err.id)}
                      className="shrink-0 text-[var(--r-text-faint)] hover:text-[var(--r-text-muted)] transition-colors mt-0.5 outline-none"
                      title={t("diagErrorDetails")}
                    >
                      <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                    </button>
                  )}
                </div>
                {/* Details panel (P1-①) */}
                {isExpanded && err.details && (
                  <pre className="mt-2 text-[10px] text-[var(--r-text-faint)] font-mono bg-black/20 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                    {(() => { try { return JSON.stringify(JSON.parse(err.details), null, 2); } catch { return err.details; } })()}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Admin section (P0-② + P1-④) ────────────────────────

function AdminSection({ initial }: { initial: { killSwitch: boolean; executionMode: string } }) {
  const { t } = useI18n();
  const [token,       setToken]       = useState("");
  const [unlocked,    setUnlocked]    = useState(false);
  const [ks,          setKs]          = useState(initial.killSwitch);
  const [mode,        setMode]        = useState(initial.executionMode);
  const [saving,      setSaving]      = useState(false);
  const [saveResult,  setSaveResult]  = useState<"ok" | "err" | null>(null);
  const [confirmKs,   setConfirmKs]   = useState<boolean | null>(null); // pending KS change

  async function save() {
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch("/api/admin/system-config", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": token },
        body: JSON.stringify({ killSwitch: ks, executionMode: mode }),
      });
      setSaveResult(res.ok ? "ok" : "err");
      if (!res.ok) setUnlocked(false);
    } catch {
      setSaveResult("err");
    } finally {
      setSaving(false);
    }
  }

  // Apply confirmed KS change
  function applyKsChange(newVal: boolean) {
    setKs(newVal);
    setConfirmKs(null);
  }

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Lock className={`w-4 h-4 ${unlocked ? "text-[var(--r-accent)]" : "text-[var(--r-text-muted)]"}`} />
          <h3 className="font-semibold text-sm">{t("diagAdminTitle")}</h3>
        </div>
        {/* Re-lock button (P1-④) */}
        {unlocked && (
          <button
            type="button"
            onClick={() => { setUnlocked(false); setToken(""); setSaveResult(null); }}
            className="flex items-center gap-1 text-[10px] text-[var(--r-text-faint)] hover:text-[var(--r-text-muted)] transition-colors outline-none"
          >
            <LockOpen className="w-3 h-3" />
            {t("diagAdminRelock")}
          </button>
        )}
      </div>

      {/* Kill Switch confirmation modal (P0-②) */}
      {confirmKs !== null && (
        <ConfirmModal
          title={confirmKs ? t("diagKillEnableTitle") : t("diagKillDisableTitle")}
          desc={confirmKs ? t("diagKillEnableDesc") : t("diagKillDisableDesc")}
          confirmLabel={t("diagKillConfirmBtn")}
          cancelLabel={t("diagKillCancelBtn")}
          danger={confirmKs}
          onConfirm={() => applyKsChange(confirmKs)}
          onCancel={() => setConfirmKs(null)}
        />
      )}

      {!unlocked ? (
        <div className="flex gap-2">
          <input
            type="password"
            className="flex-1 px-3 py-2 text-xs rounded-lg bg-[var(--r-surface)] border border-[var(--r-border)] text-[var(--r-text)] placeholder:text-[var(--r-text-faint)] focus:outline-none focus:border-[var(--r-accent)]"
            placeholder={t("diagAdminTokenPlaceholder")}
            value={token}
            onChange={e => setToken(e.target.value)}
            onKeyDown={e => e.key === "Enter" && token && setUnlocked(true)}
          />
          <button
            type="button"
            className="px-3 py-2 text-xs rounded-lg bg-[var(--r-accent-dim)] text-[var(--r-accent)] border border-[var(--r-accent)]/30 hover:bg-[var(--r-accent)]/20 transition-colors"
            onClick={() => token && setUnlocked(true)}
          >
            <Lock className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Kill Switch */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{t("diagAdminKillSwitch")}</p>
              <p className={`text-xs mt-0.5 ${ks ? "text-red-400" : "text-[var(--r-accent)]"}`}>
                {ks ? t("diagAdminKillActive") : t("diagAdminKillInactive")}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={ks}
              onClick={() => setConfirmKs(!ks)}
              className={`relative w-11 h-6 rounded-full transition-colors outline-none ${ks ? "bg-red-500" : "bg-[var(--r-accent)]"}`}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${ks ? "translate-x-5" : "translate-x-0.5"}`}
              />
            </button>
          </div>

          {/* Execution Mode */}
          <div>
            <p className="text-sm font-medium mb-2">{t("diagAdminExecMode")}</p>
            <div className="flex gap-2">
              {(["paper", "shadow", "live"] as const).map(m => (
                <button
                  type="button"
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 py-1.5 text-xs rounded-lg border transition-colors outline-none ${
                    mode === m
                      ? "bg-[var(--r-accent-dim)] text-[var(--r-accent)] border-[var(--r-accent)]/40"
                      : "bg-[var(--r-surface)] text-[var(--r-text-muted)] border-[var(--r-border)] hover:border-[var(--r-accent)]/30"
                  }`}
                >
                  {EXEC_MODE_LABELS[m] ? t(EXEC_MODE_LABELS[m] as TranslationKey) : m}
                </button>
              ))}
            </div>
          </div>

          {/* Save */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="px-4 py-2 text-xs rounded-lg bg-[var(--r-accent)] text-black font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {saving ? "…" : t("diagAdminSave")}
            </button>
            {saveResult === "ok" && (
              <span className="text-xs text-[var(--r-accent)] flex items-center gap-1">
                <CheckCircle className="w-3 h-3" />
                {t("diagAdminSaved")}
              </span>
            )}
            {saveResult === "err" && (
              <span className="text-xs text-red-400 flex items-center gap-1">
                <XCircle className="w-3 h-3" />
                {t("diagAdminError")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────

export function DiagnosticsPage() {
  const { t } = useI18n();
  const { data, loading, error }   = useFetch<DiagnosticsData>("/api/diagnostics", 30_000);
  const { data: hbData }           = useFetch<HeartbeatData>("/api/heartbeat", 60_000);

  const heartbeat = hbData?.heartbeat ?? null;

  return (
    <div className="space-y-4 animate-in">
      {/* Page title */}
      <div className="flex items-center gap-3">
        <Shield className="w-5 h-5 text-[var(--r-accent)]" />
        <div>
          <h2 className="text-xl font-bold">{t("diagTitle")}</h2>
          <p className="text-xs text-[var(--r-text-muted)] mt-0.5">{t("diagDesc")}</p>
        </div>
      </div>

      {loading && <div className="glass-card p-6 h-16 animate-pulse rounded-xl" />}

      {!loading && error && !data && (
        <div className="glass-card p-6 text-center text-sm text-[var(--r-red)]">{error}</div>
      )}

      {!loading && !error && data && (
        <div className="space-y-4">
          {/* P0-①: Health banner */}
          <HealthBanner
            killSwitch={data.killSwitch}
            errorCount={data.errors.length}
            executionMode={data.executionMode}
            lastScanAt={heartbeat?.lastScanAt}
          />

          {/* P2-①: Pipeline KPI strip */}
          <PipelineKpiStrip hb={heartbeat} />

          {/* P1-①③: Error log (reordered above skip, higher priority) */}
          <ErrorLogSection errors={data.errors ?? []} />

          {/* P1-②, P2-②: Skip analysis */}
          <SkipByFundSection skipByFund={data.skipByFund ?? {}} />

          {/* P0-②, P1-④: Admin */}
          <AdminSection initial={{ killSwitch: data.killSwitch, executionMode: data.executionMode }} />
        </div>
      )}
    </div>
  );
}
