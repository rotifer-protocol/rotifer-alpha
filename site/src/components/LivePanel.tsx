/**
 * LivePanel — Phase 2 Live Trading Dashboard
 * ALPHA-001 Phase 2 · P2.7
 *
 * Shows:
 *   - Phase 2 readiness checklist (P2.4–P2.7 status)
 *   - Execution mode + Kill Switch state
 *   - Deposit wallet registration status
 *   - Per-fund Circuit Breaker state
 *   - Live orders summary (populated in Phase 2)
 */

import { useFetch } from "../hooks/useApi";
import { fundDisplayName } from "../lib/fundMeta";
import { useI18n } from "../i18n/context";
import {
  Shield, ShieldOff, Wallet, Activity, CheckCircle2, Circle,
  AlertTriangle, XCircle, Zap, TrendingUp, TrendingDown, Minus,
  DollarSign, ChevronDown, ChevronUp,
} from "lucide-react";
import { useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CbFundState {
  fundId: string;
  epochLossPct: number;
  thresholdPct: number;
  tripped: boolean;
  trippedAt: string | null;
}

interface ReadinessItem {
  done: boolean;
  label: string;
}

interface LiveStatusResponse {
  executionMode: string;
  killSwitch: boolean;
  depositWallet: {
    address: string | null;
    registeredAt: string | null;
    fundCount: number;
  };
  circuitBreaker: {
    thresholdPct: number;
    trippedCount: number;
    allClear: boolean;
    funds: CbFundState[];
  };
  liveOrders: {
    pending: number;
    open: number;
    filled: number;
    partial: number;
    cancelled: number;
    expired: number;
    rejected: number;
  };
  phase2Readiness: {
    p24: ReadinessItem;
    p25: ReadinessItem;
    p26: ReadinessItem;
    p27: ReadinessItem;
    allReady: boolean;
  };
}

// ─── Helper components ────────────────────────────────────────────────────────

function StatusBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
        active
          ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
          : "bg-[var(--r-border)] text-[var(--r-muted)] border border-[var(--r-border)]"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${active ? "bg-emerald-400" : "bg-[var(--r-muted)]"}`} />
      {label}
    </span>
  );
}

function ReadinessRow({ id, item }: { id: string; item: ReadinessItem }) {
  return (
    <div className="flex items-center gap-3 py-2">
      {item.done
        ? <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
        : <Circle size={16} className="text-[var(--r-muted)] shrink-0" />
      }
      <span className={`text-sm ${item.done ? "text-[var(--r-fg)]" : "text-[var(--r-muted)]"}`}>
        <span className="font-mono text-xs text-[var(--r-muted)] mr-1.5">{id}</span>
        {item.label}
      </span>
    </div>
  );
}

// ─── Circuit Breaker mini heatmap ─────────────────────────────────────────────

function CbFundRow({ state }: { state: CbFundState }) {
  const { t } = useI18n();
  const pct = Math.min(state.epochLossPct, state.thresholdPct);
  const fillWidth = state.thresholdPct > 0 ? (pct / state.thresholdPct) * 100 : 0;
  const isWarning = fillWidth >= 70 && !state.tripped;

  return (
    <div className="flex items-center gap-3 py-1.5">
      {/* Fund name */}
      <span className="w-36 shrink-0 text-xs text-[var(--r-muted)] truncate">
        {fundDisplayName(state.fundId, t)}
      </span>

      {/* Progress bar */}
      <div className="flex-1 h-1.5 bg-[var(--r-border)] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            state.tripped
              ? "bg-red-500"
              : isWarning
              ? "bg-amber-400"
              : "bg-emerald-500"
          }`}
          style={{ width: `${Math.max(2, fillWidth)}%` }}
        />
      </div>

      {/* Loss % */}
      <span className={`w-14 text-right text-xs tabular-nums shrink-0 ${
        state.tripped ? "text-red-400 font-semibold"
        : isWarning ? "text-amber-400"
        : "text-[var(--r-muted)]"
      }`}>
        {state.epochLossPct.toFixed(1)}%
      </span>

      {/* Status icon */}
      {state.tripped
        ? <AlertTriangle size={12} className="text-red-400 shrink-0" />
        : <span className="w-3 shrink-0" />
      }
    </div>
  );
}

// ─── P&L types ────────────────────────────────────────────────────────────────

interface FundPnLRow {
  fundId: string;
  filledBuys: number;
  filledSells: number;
  deployedUsdc: number;
  receivedUsdc: number;
  totalOrders: number;
  rejectedOrders: number;
}

interface LivePnLResponse {
  generatedAt: string;
  walletAddress: string;
  initialBudgetUsdc: number;
  walletBalanceUsdc: number | null;
  balanceApiStatus: "ok" | "error" | "unavailable";
  totalDeployedUsdc: number;
  totalReceivedUsdc: number;
  netDeployedUsdc: number;
  totalFilledOrders: number;
  totalRejectedOrders: number;
  funds: FundPnLRow[];
}

// ─── P&L Card ─────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function DeltaBadge({ delta }: { delta: number }) {
  if (Math.abs(delta) < 0.005) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-[var(--r-muted)]">
        <Minus size={11} /> $0.00
      </span>
    );
  }
  const positive = delta > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${
      positive ? "text-emerald-400" : "text-red-400"
    }`}>
      {positive ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {positive ? "+" : "−"}${fmt(Math.abs(delta))}
    </span>
  );
}

function PnLCard() {
  const { t } = useI18n();
  const { data, error, loading } = useFetch<LivePnLResponse>("/api/live-pnl");
  const [expanded, setExpanded] = useState(false);

  if (loading) {
    return (
      <div className="glass-card p-5 h-32 animate-pulse bg-[var(--r-border)] rounded-xl opacity-40" />
    );
  }

  if (error || !data) {
    return (
      <section className="glass-card p-5">
        <div className="flex items-center gap-2 mb-2">
          <DollarSign size={15} className="text-[var(--r-accent)]" />
          <h3 className="text-sm font-semibold text-[var(--r-fg)]">Live P&L</h3>
        </div>
        <p className="text-xs text-[var(--r-muted)]">
          {error?.includes("no_wallet_registered")
            ? "钱包未注册（P2.4 尚未完成）"
            : "P&L 数据暂不可用"}
        </p>
      </section>
    );
  }

  const {
    initialBudgetUsdc,
    walletBalanceUsdc,
    balanceApiStatus,
    totalDeployedUsdc,
    netDeployedUsdc,
    totalFilledOrders,
    totalRejectedOrders,
    funds,
  } = data;

  // True P&L = current balance − initial budget (includes resolved market payouts)
  const realizedDelta =
    walletBalanceUsdc !== null ? walletBalanceUsdc - initialBudgetUsdc : null;

  const hasOrders = totalFilledOrders > 0;

  return (
    <section className="glass-card p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <DollarSign size={15} className="text-[var(--r-accent)]" />
          <h3 className="text-sm font-semibold text-[var(--r-fg)]">Live P&L</h3>
        </div>
        {realizedDelta !== null && (
          <DeltaBadge delta={realizedDelta} />
        )}
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        {/* Current balance */}
        <div className="space-y-0.5">
          <p className="text-xs text-[var(--r-muted)]">当前余额</p>
          {walletBalanceUsdc !== null ? (
            <p className="text-base font-semibold tabular-nums text-[var(--r-fg)]">
              ${fmt(walletBalanceUsdc)}
            </p>
          ) : (
            <p className="text-base font-semibold text-[var(--r-muted)]">
              {balanceApiStatus === "unavailable" ? "—" : "获取失败"}
            </p>
          )}
          <p className="text-xs text-[var(--r-muted)]">pUSD</p>
        </div>

        {/* Initial budget */}
        <div className="space-y-0.5">
          <p className="text-xs text-[var(--r-muted)]">初始预算</p>
          <p className="text-base font-semibold tabular-nums text-[var(--r-fg)]">
            ${fmt(initialBudgetUsdc)}
          </p>
          <p className="text-xs text-[var(--r-muted)]">pUSD</p>
        </div>

        {/* Net deployed */}
        <div className="space-y-0.5">
          <p className="text-xs text-[var(--r-muted)]">净投入</p>
          <p className={`text-base font-semibold tabular-nums ${
            netDeployedUsdc > 0 ? "text-amber-400" : "text-[var(--r-fg)]"
          }`}>
            {netDeployedUsdc > 0 ? `−$${fmt(netDeployedUsdc)}` : "$0.00"}
          </p>
          <p className="text-xs text-[var(--r-muted)]">已部署</p>
        </div>
      </div>

      {/* Order stats */}
      <div className="flex items-center gap-4 text-xs text-[var(--r-muted)] pb-3 border-b border-[var(--r-border)]">
        <span>
          <span className="text-emerald-400 font-medium">{totalFilledOrders}</span> 笔成交
        </span>
        {totalRejectedOrders > 0 && (
          <span>
            <span className="text-red-400 font-medium">{totalRejectedOrders}</span> 笔被拒
          </span>
        )}
        <span>合计 {totalDeployedUsdc > 0 ? `$${fmt(totalDeployedUsdc)} 已花` : "无真实下单"}</span>
        {!hasOrders && (
          <span className="text-[var(--r-muted)] italic">Phase 2 启动后自动填充</span>
        )}
      </div>

      {/* Per-fund breakdown (collapsible) */}
      {funds.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-1 text-xs text-[var(--r-muted)] hover:text-[var(--r-fg)] transition-colors"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? "收起" : "展开"} 基金明细
          </button>

          {expanded && (
            <div className="mt-2 space-y-1">
              {funds.map(f => (
                <div key={f.fundId} className="flex items-center gap-2 py-1 text-xs">
                  <span className="w-40 truncate text-[var(--r-muted)]">
                    {fundDisplayName(f.fundId, t)}
                  </span>
                  <span className="flex-1 text-right tabular-nums text-[var(--r-fg)]">
                    {f.deployedUsdc > 0 ? `−$${fmt(f.deployedUsdc)}` : "$0.00"}
                  </span>
                  <span className="w-12 text-right text-[var(--r-muted)]">
                    {f.filledBuys + f.filledSells} 笔
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function LivePanel() {
  const { data, error, loading } = useFetch<LiveStatusResponse>("/api/live-status");

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        {[1, 2, 3].map(i => (
          <div key={i} className="glass-card p-5 h-28 bg-[var(--r-border)] rounded-xl opacity-40" />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="glass-card p-5 text-center text-[var(--r-muted)] text-sm">
        <XCircle size={20} className="mx-auto mb-2 opacity-40" />
        Unable to load live status
      </div>
    );
  }

  const { executionMode, killSwitch, depositWallet, circuitBreaker, liveOrders, phase2Readiness } = data;
  const isLive = executionMode === "live";
  const totalOrders = Object.values(liveOrders).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">

      {/* ── System Status ── */}
      <section className="glass-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Zap size={15} className="text-[var(--r-accent)]" />
          <h3 className="text-sm font-semibold text-[var(--r-fg)]">系统状态</h3>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--r-muted)]">执行模式</span>
            <StatusBadge
              active={isLive}
              label={executionMode.toUpperCase()}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--r-muted)]">Kill Switch</span>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
              killSwitch
                ? "bg-red-500/15 text-red-400 border border-red-500/30"
                : "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
            }`}>
              {killSwitch ? <ShieldOff size={11} /> : <Shield size={11} />}
              {killSwitch ? "已激活" : "未激活"}
            </span>
          </div>
          {!isLive && (
            <p className="w-full text-xs text-[var(--r-muted)] mt-1">
              当前模式为 <span className="font-mono">{executionMode}</span>，Phase 2 全部前置完成后切换为 <span className="font-mono">live</span>。
            </p>
          )}
        </div>
      </section>

      {/* ── Phase 2 Readiness Checklist ── */}
      <section className="glass-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Activity size={15} className="text-[var(--r-accent)]" />
            <h3 className="text-sm font-semibold text-[var(--r-fg)]">Phase 2 前置检查</h3>
          </div>
          <StatusBadge active={phase2Readiness.allReady} label={phase2Readiness.allReady ? "就绪" : "未就绪"} />
        </div>
        <div className="divide-y divide-[var(--r-border)]">
          <ReadinessRow id="P2.4" item={phase2Readiness.p24} />
          <ReadinessRow id="P2.5" item={phase2Readiness.p25} />
          <ReadinessRow id="P2.6" item={phase2Readiness.p26} />
          <ReadinessRow id="P2.7" item={phase2Readiness.p27} />
        </div>
      </section>

      {/* ── Deposit Wallet ── */}
      <section className="glass-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Wallet size={15} className="text-[var(--r-accent)]" />
          <h3 className="text-sm font-semibold text-[var(--r-fg)]">Deposit Wallet</h3>
        </div>
        {depositWallet.address ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
              <span className="font-mono text-xs text-[var(--r-fg)] break-all">
                {depositWallet.address}
              </span>
            </div>
            <p className="text-xs text-[var(--r-muted)]">
              已为 {depositWallet.fundCount} 个基金注册 · {depositWallet.registeredAt?.slice(0, 10)}
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2 text-[var(--r-muted)]">
            <Circle size={14} className="shrink-0 mt-0.5" />
            <div>
              <p className="text-sm">尚未注册</p>
              <p className="text-xs mt-0.5">
                运行 <span className="font-mono">worker/scripts/register-deposit-wallet.sh</span> 完成 P2.4 配置
              </p>
            </div>
          </div>
        )}
      </section>

      {/* ── Circuit Breaker ── */}
      <section className="glass-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Shield size={15} className={circuitBreaker.allClear ? "text-emerald-400" : "text-red-400"} />
            <h3 className="text-sm font-semibold text-[var(--r-fg)]">
              Circuit Breaker
              <span className="ml-2 text-xs font-normal text-[var(--r-muted)]">
                阈值 {circuitBreaker.thresholdPct}% / epoch
              </span>
            </h3>
          </div>
          {circuitBreaker.trippedCount > 0 ? (
            <span className="text-xs text-red-400 font-medium">
              {circuitBreaker.trippedCount} 基金已熔断
            </span>
          ) : (
            <span className="text-xs text-emerald-400">全部正常</span>
          )}
        </div>

        {circuitBreaker.funds.length === 0 ? (
          <p className="text-xs text-[var(--r-muted)]">无数据（Phase 2 启动后自动填充）</p>
        ) : (
          <div className="space-y-0.5">
            {circuitBreaker.funds.map(s => (
              <CbFundRow key={s.fundId} state={s} />
            ))}
          </div>
        )}
      </section>

      {/* ── Live P&L ── */}
      <PnLCard />

      {/* ── Live Orders Summary ── */}
      <section className="glass-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Activity size={15} className="text-[var(--r-accent)]" />
          <h3 className="text-sm font-semibold text-[var(--r-fg)]">
            Live Orders
            <span className="ml-2 text-xs font-normal text-[var(--r-muted)]">
              {totalOrders === 0 ? "Phase 2 启动后填充" : `共 ${totalOrders} 笔`}
            </span>
          </h3>
        </div>

        {totalOrders === 0 ? (
          <p className="text-xs text-[var(--r-muted)]">
            当前执行模式为 <span className="font-mono">{executionMode}</span>，live_orders 为空。
            Phase 2 上线后此处将显示真实订单状态。
          </p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            {(["open", "filled", "partial", "pending", "cancelled", "rejected"] as const).map(key => (
              <div key={key} className="text-center">
                <div className="text-lg font-semibold tabular-nums text-[var(--r-fg)]">
                  {liveOrders[key]}
                </div>
                <div className="text-xs text-[var(--r-muted)] capitalize">{key}</div>
              </div>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}
