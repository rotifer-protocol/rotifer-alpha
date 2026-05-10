import { useState } from "react";
import { Shield, AlertTriangle, Activity, Lock, ChevronDown, ChevronUp } from "lucide-react";
import { useFetch } from "../hooks/useApi";
import { useI18n } from "../i18n/context";
import { FUND_COLORS, fundDisplayName } from "../lib/fundMeta";

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

// ─── Skip reason styling ─────────────────────────────────

const SKIP_COLORS: Record<string, string> = {
  TYPE_NOT_ALLOWED:    "bg-zinc-800 text-zinc-400",
  DUPLICATE_MARKET:    "bg-blue-900/40 text-blue-400",
  MAX_POSITIONS:       "bg-blue-900/40 text-blue-400",
  MAX_EVENT_EXPOSURE:  "bg-purple-900/40 text-purple-400",
  OTM_CAP:             "bg-purple-900/40 text-purple-400",
  LOW_PRICE_REJECT:    "bg-rose-900/40 text-rose-400",
  PRICE_BOUNDARY:      "bg-rose-900/40 text-rose-400",
  VOLUME_TOO_LOW:      "bg-amber-900/40 text-amber-400",
  LIQUIDITY_TOO_LOW:   "bg-amber-900/40 text-amber-400",
  EDGE_TOO_LOW:        "bg-yellow-900/40 text-yellow-400",
  CONFIDENCE_TOO_LOW:  "bg-yellow-900/40 text-yellow-400",
  COMPOSITE_TOO_LOW:   "bg-yellow-900/40 text-yellow-400",
  FUND_FROZEN:         "bg-red-900/40 text-red-400",
};

const SKIP_LABELS: Record<string, string> = {
  TYPE_NOT_ALLOWED:    "Type",
  DUPLICATE_MARKET:    "Duplicate",
  MAX_POSITIONS:       "MaxPos",
  MAX_EVENT_EXPOSURE:  "MaxEvent",
  OTM_CAP:             "OTM Cap",
  LOW_PRICE_REJECT:    "Low-Price Reject",
  PRICE_BOUNDARY:      "Price Boundary",
  VOLUME_TOO_LOW:      "Volume",
  LIQUIDITY_TOO_LOW:   "Liquidity",
  EDGE_TOO_LOW:        "Edge",
  CONFIDENCE_TOO_LOW:  "Confidence",
  COMPOSITE_TOO_LOW:   "Composite",
  FUND_FROZEN:         "Frozen",
};

function SkipBadge({ code, count }: { code: string; count: number }) {
  const cls = SKIP_COLORS[code] ?? "bg-zinc-800 text-zinc-400";
  const label = SKIP_LABELS[code] ?? code;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded ${cls}`}>
      {label}
      <span className="opacity-70">×{count}</span>
    </span>
  );
}

// ─── Skip by Fund section ────────────────────────────────

function SkipByFundSection({ skipByFund }: { skipByFund: Record<string, Record<string, number>> }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const entries = Object.entries(skipByFund).filter(([, reasons]) => Object.keys(reasons).length > 0);

  return (
    <div className="glass-card p-5">
      <button
        className="w-full flex items-center justify-between mb-3"
        aria-expanded={expanded}
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[var(--r-accent)]" />
          <h3 className="font-semibold text-sm">{t("diagSkipTitle")}</h3>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-[var(--r-text-muted)]" /> : <ChevronDown className="w-4 h-4 text-[var(--r-text-muted)]" />}
      </button>
      <p className="text-xs text-[var(--r-text-muted)] mb-3">{t("diagSkipDesc")}</p>

      {!expanded ? null : entries.length === 0 ? (
        <p className="text-xs text-[var(--r-text-faint)]">{t("diagSkipEmpty")}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {entries.sort(([a], [b]) => a.localeCompare(b)).map(([fundId, reasons]) => {
            const color = FUND_COLORS[fundId] ?? "text-[var(--r-text-muted)]";
            const total = Object.values(reasons).reduce((s, n) => s + n, 0);
            return (
              <div
                key={fundId}
                className="flex flex-col gap-1.5 p-3 rounded-lg bg-[var(--r-surface)] border border-[var(--r-border)]"
              >
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-medium ${color}`}>{fundDisplayName(fundId, t)}</span>
                  <span className="text-[10px] text-[var(--r-text-faint)]">{total} skip{total !== 1 ? "s" : ""}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(reasons).map(([code, count]) => (
                    <SkipBadge key={code} code={code} count={count} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Pipeline errors section ─────────────────────────────

const STAGE_COLORS: Record<string, string> = {
  scanner:      "text-blue-400",
  trader:       "text-yellow-400",
  monitor:      "text-purple-400",
  settler:      "text-green-400",
  risk:         "text-red-400",
  "micro-evolver": "text-pink-400",
  genome:       "text-[var(--r-accent)]",
};

function ErrorLogSection({ errors }: { errors: PipelineError[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="glass-card p-5">
      <button
        className="w-full flex items-center justify-between mb-3"
        aria-expanded={expanded}
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className={`w-4 h-4 ${errors.length > 0 ? "text-amber-400" : "text-[var(--r-text-muted)]"}`} />
          <h3 className="font-semibold text-sm">{t("diagErrorTitle")}</h3>
          {errors.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-900/40 text-amber-400 font-mono">
              {errors.length}
            </span>
          )}
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-[var(--r-text-muted)]" /> : <ChevronDown className="w-4 h-4 text-[var(--r-text-muted)]" />}
      </button>

      {!expanded ? null : errors.length === 0 ? (
        <p className="text-xs text-[var(--r-accent)] flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--r-accent)]" />
          {t("diagErrorEmpty")}
        </p>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {errors.map(err => (
            <div key={err.id} className="flex gap-3 text-xs p-2 rounded-lg bg-[var(--r-surface)] border border-[var(--r-border)]">
              <div className="shrink-0 w-16">
                <span className={`font-mono font-medium ${STAGE_COLORS[err.stage] ?? "text-[var(--r-text-muted)]"}`}>
                  {err.stage}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[var(--r-text)] truncate">{err.message}</p>
                <p className="text-[var(--r-text-faint)] mt-0.5">
                  {new Date(err.occurred_at).toLocaleString()}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Admin section (token-gated) ─────────────────────────

function AdminSection({ initial }: { initial: { killSwitch: boolean; executionMode: string } }) {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [ks, setKs] = useState(initial.killSwitch);
  const [mode, setMode] = useState(initial.executionMode);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<"ok" | "err" | null>(null);

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

  return (
    <div className="glass-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Lock className={`w-4 h-4 ${unlocked ? "text-[var(--r-accent)]" : "text-[var(--r-text-muted)]"}`} />
        <h3 className="font-semibold text-sm">{t("diagAdminTitle")}</h3>
      </div>

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
              role="switch"
              aria-checked={ks}
              onClick={() => setKs(k => !k)}
              className={`relative w-11 h-6 rounded-full transition-colors ${ks ? "bg-red-500" : "bg-[var(--r-accent)]"}`}
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
              {["paper", "shadow", "live"].map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 py-1.5 text-xs rounded-lg border transition-colors ${
                    mode === m
                      ? "bg-[var(--r-accent-dim)] text-[var(--r-accent)] border-[var(--r-accent)]/40"
                      : "bg-[var(--r-surface)] text-[var(--r-text-muted)] border-[var(--r-border)] hover:border-[var(--r-accent)]/30"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Save */}
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-2 text-xs rounded-lg bg-[var(--r-accent)] text-black font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {saving ? "…" : t("diagAdminSave")}
            </button>
            {saveResult === "ok" && (
              <span className="text-xs text-[var(--r-accent)]">{t("diagAdminSaved")} ✓</span>
            )}
            {saveResult === "err" && (
              <span className="text-xs text-red-400">{t("diagAdminError")}</span>
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
  const { data, loading, error } = useFetch<DiagnosticsData>("/api/diagnostics", 30_000);

  return (
    <div className="space-y-6 animate-in">
      <div className="flex items-center gap-3">
        <Shield className="w-5 h-5 text-[var(--r-accent)]" />
        <div>
          <h2 className="text-xl font-bold">{t("diagTitle")}</h2>
          <p className="text-xs text-[var(--r-text-muted)] mt-0.5">{t("diagDesc")}</p>
        </div>
      </div>

      {loading && <div className="glass-card p-6 h-24 animate-pulse" />}

      {!loading && error && !data && (
        <div className="glass-card p-6 text-center text-sm text-[var(--r-red)]">
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <div className="space-y-4">
          <SkipByFundSection skipByFund={data.skipByFund ?? {}} />
          <ErrorLogSection errors={data.errors ?? []} />
          <AdminSection initial={{ killSwitch: data.killSwitch, executionMode: data.executionMode }} />
        </div>
      )}
    </div>
  );
}
