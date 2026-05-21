/**
 * ShareModal — Hero-layout redesign (2026-05-13)
 *
 * Layout: poster (centered hero) → TopN toggle → share destination grid
 *         → X share steps (animated) → text accordion
 * Mobile: bottom-sheet slide-up; desktop: centered modal
 */
import { useRef, useState, useCallback, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { X, Download, Check, Share2, ClipboardCopy, ChevronDown, Copy } from "lucide-react";
import { toPng, toBlob } from "html-to-image";
import type { FundData } from "../App";
import { useI18n } from "../i18n/context";
import { fundDisplayName, fundPersonality } from "../lib/fundMeta";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SnapshotRow {
  fund_id: string;
  date: string;
  total_value: number;
}

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  funds: FundData[];
  snapshots: SnapshotRow[];
  startDate?: string | null;
  totalPool: number;
  initialCapital: number;
  totalPnl: number;
  totalReturnPct: number;
  todayChangePct: number | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MEDALS = ["🥇", "🥈", "🥉"];
const POSTER_W = 340;
const BRAND_NAME = "ROTIFER ALPHA";
const BRAND_URL = "https://rotifer.xyz/";

const PERSONALITY_HEX: Record<string, string> = {
  cheetah: "#eab308",
  octopus: "#60a5fa",
  turtle:  "#22c55e",
  shark:   "#ef4444",
  honeyBadger: "#f472b6",
};

// ─── Sub-component: poster card (captured by html-to-image) ──────────────────

interface PosterProps {
  funds: FundData[];
  totalReturnPct: number;
  totalPnl: number;
  todayChangeAbs: number | null;
  daysRunning: number | null;
  topN: 3 | 5;
  isZh: boolean;
  dateStr: string;
  t: (k: any) => string;
}

function PosterCard({
  funds, totalReturnPct, totalPnl, todayChangeAbs, daysRunning,
  topN, isZh, dateStr, t,
}: PosterProps) {
  const topFunds = [...funds].sort((a, b) => b.returnPct - a.returnPct).slice(0, topN);

  const fmtAmt = (v: number) => {
    const abs = Math.abs(v);
    const sign = v >= 0 ? "+" : "-";
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 10_000)    return `${sign}$${Math.round(abs / 1_000)}K`;
    if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  };

  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

  const getFundColor = (id: string) =>
    PERSONALITY_HEX[fundPersonality(id)] ?? "#9ca3af";

  const todayStat = todayChangeAbs !== null
    ? { label: isZh ? "今日收益" : "Today", value: fmtAmt(todayChangeAbs), color: todayChangeAbs >= 0 ? "#4ade80" : "#f87171" }
    : { label: isZh ? "总盈亏" : "Total PnL", value: fmtAmt(totalPnl), color: totalPnl >= 0 ? "#4ade80" : "#f87171" };

  return (
    <div
      style={{
        width: POSTER_W,
        background: "linear-gradient(160deg, #0e1018 0%, #090b10 100%)",
        borderRadius: 14,
        overflow: "hidden",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif",
        color: "#e8eaed",
        border: "1px solid rgba(255,255,255,0.09)",
      }}
    >
      {/* ── Header ── */}
      <div style={{ padding: "18px 20px 14px", background: "rgba(0,212,170,0.07)", borderBottom: "1px solid rgba(0,212,170,0.12)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 26, height: 26, borderRadius: "50%", border: "1.5px solid #00d4aa", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: "#00d4aa", lineHeight: 1 }}>⊙</span>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "#00d4aa" }}>{BRAND_NAME}</div>
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.38)", marginTop: 1 }}>AI 基金进化实验室</div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.42)" }}>{dateStr}</div>
            {daysRunning !== null && (
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.24)", marginTop: 2 }}>
                {isZh ? `运行第 ${daysRunning} 天` : `Day ${daysRunning}`}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        {[
          { label: isZh ? "总收益率" : "Total Return", value: fmtPct(totalReturnPct), color: totalReturnPct >= 0 ? "#4ade80" : "#f87171" },
          { label: isZh ? "总盈亏" : "Total PnL",     value: fmtAmt(totalPnl),        color: totalPnl >= 0 ? "#4ade80" : "#f87171" },
          todayStat,
        ].map((s, i) => (
          <div key={i} style={{ textAlign: "center", padding: "0 4px" }}>
            <div style={{ fontSize: 8, color: "rgba(255,255,255,0.32)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.07em" }}>{s.label}</div>
            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: s.color, letterSpacing: "-0.4px" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* ── Leaderboard ── */}
      <div style={{ padding: "13px 20px 15px" }}>
        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.28)", textTransform: "uppercase", letterSpacing: "0.10em", marginBottom: 10 }}>
          {isZh ? `排行榜 TOP ${topN}` : `LEADERBOARD TOP ${topN}`}
        </div>
        {topFunds.map((fund, i) => {
          const pnl = fund.totalValue - fund.initialBalance;
          const medal = MEDALS[i] ?? `${i + 1}.`;
          const name = fundDisplayName(fund.id, t);
          const color = getFundColor(fund.id);
          return (
            <div
              key={fund.id}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "5px 0",
                borderBottom: i < topFunds.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
              }}
            >
              <span style={{ fontSize: 14, width: 22, flexShrink: 0 }}>{medal}</span>
              <span style={{ fontSize: 16, width: 22, flexShrink: 0 }}>{fund.emoji}</span>
              <span style={{ fontSize: 11, fontWeight: 600, flex: 1, marginLeft: 4, color }}>{name}</span>
              <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "monospace", color: fund.returnPct >= 0 ? "#4ade80" : "#f87171", marginRight: 8, letterSpacing: "-0.3px" }}>
                {fund.returnPct >= 0 ? "+" : ""}{fund.returnPct.toFixed(1)}%
              </span>
              <span style={{ fontSize: 10, fontFamily: "monospace", color: "rgba(255,255,255,0.38)", minWidth: 48, textAlign: "right" }}>
                {fmtAmt(pnl)}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── Footer ── */}
      <div style={{ padding: "10px 20px 15px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.22)" }}>
          ⚡ {isZh ? "Rotifer Protocol AI Gene 驱动" : "Powered by Rotifer Protocol AI Gene"}
        </span>
        <span style={{ fontSize: 9.5, color: "#00d4aa", opacity: 0.65, fontWeight: 500 }}>rotifer.xyz</span>
      </div>
    </div>
  );
}

// ─── Helper: X share step badge ──────────────────────────────────────────────

function StepBadge({ done, active, label }: { done?: boolean; active?: boolean; label: string }) {
  return (
    <span className={`flex items-center gap-1 text-[11px] font-medium ${
      done ? "text-[var(--r-accent)]" : active ? "text-[var(--r-text)]" : "text-[var(--r-text-faint)]"
    }`}>
      {done && <Check className="w-3 h-3 shrink-0" />}
      <span>{label}</span>
    </span>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

function ShareModalInner({
  onClose, funds, snapshots, startDate,
  totalPnl, totalReturnPct, todayChangePct,
}: Omit<ShareModalProps, "isOpen">) {
  const { t, locale } = useI18n();
  const posterRef        = useRef<HTMLDivElement>(null);
  const posterContainerRef = useRef<HTMLDivElement>(null);

  // ── UI state ──
  const [topN, setTopN] = useState<3 | 5>(() => {
    try {
      const v = localStorage.getItem("share-topN");
      return v === "3" ? 3 : 5; // default 5
    } catch { return 5; }
  });
  const handleSetTopN = useCallback((n: 3 | 5) => {
    setTopN(n);
    try { localStorage.setItem("share-topN", String(n)); } catch { }
  }, []);
  const [copied, setCopied]               = useState(false);
  const [copiedPoster, setCopiedPoster]   = useState(false);
  const [copyingPoster, setCopyingPoster] = useState(false);
  const [downloading, setDownloading]     = useState(false);
  const [posterSuccess, setPosterSuccess] = useState(false);   // overlay on poster
  const [textExpanded, setTextExpanded]   = useState(false);   // accordion
  const [xStep, setXStep]                 = useState<null | "preparing" | "ready">(null);

  // ── Responsive poster scaling ──
  const [posterScale, setPosterScale]   = useState(1);
  const [posterNaturalH, setPosterNaturalH] = useState(0);

  const isZh = locale === "zh";
  const sortedFunds = [...funds].sort((a, b) => b.returnPct - a.returnPct);

  useLayoutEffect(() => {
    if (posterRef.current) setPosterNaturalH(posterRef.current.offsetHeight);
  }, [topN, sortedFunds.length]);

  useEffect(() => {
    const el = posterContainerRef.current;
    if (!el) return;
    const update = () => setPosterScale(Math.min(1, el.offsetWidth / POSTER_W));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Data computations ──
  let todayChangeAbs: number | null = null;
  if (todayChangePct !== null && snapshots.length > 0) {
    const latestByFund = new Map<string, SnapshotRow>();
    for (const s of snapshots) {
      const cur = latestByFund.get(s.fund_id);
      if (!cur || new Date(s.date) > new Date(cur.date)) latestByFund.set(s.fund_id, s);
    }
    let yPool = 0, todayMatched = 0;
    for (const f of funds) {
      const snap = latestByFund.get(f.id);
      if (snap) { yPool += snap.total_value; todayMatched += f.totalValue; }
    }
    if (yPool > 0) todayChangeAbs = todayMatched - yPool;
  }

  // Use API-provided startDate (MIN(date) from DB) to avoid the sliding window bug.
  let daysRunning: number | null = null;
  const anchor = startDate ?? (snapshots.length > 0 ? (() => {
    const ts = snapshots.reduce((m, s) => {
      const t = new Date(s.date).getTime();
      return t < m ? t : m;
    }, Infinity);
    return isFinite(ts) ? new Date(ts).toISOString() : null;
  })() : null);
  if (anchor) daysRunning = Math.round((Date.now() - new Date(anchor).getTime()) / 86_400_000);

  const now = new Date();
  const dateStr = isZh
    ? now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })
    : now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const fmtAmt = (v: number) => {
    const abs = Math.abs(v);
    const sign = v >= 0 ? "+" : "-";
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 10_000)    return `${sign}$${Math.round(abs / 1_000)}K`;
    if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  };

  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

  // ── Text generation ──
  const generateText = useCallback((): string => {
    const lines: string[] = [];
    if (isZh) {
      lines.push(`🏆 Rotifer Alpha | AI 基金排行榜`);
      lines.push(`📅 ${dateStr}${daysRunning ? `  ·  运行第 ${daysRunning} 天` : ""}`);
      lines.push("");
      lines.push("📊 整体表现");
      lines.push(`  总收益率  ${fmtPct(totalReturnPct)}`);
      lines.push(`  总盈亏   ${fmtAmt(totalPnl)}`);
      if (todayChangeAbs !== null) lines.push(`  今日收益  ${fmtAmt(todayChangeAbs)}`);
      lines.push("");
      lines.push(`🏅 排行榜 Top ${topN}`);
      sortedFunds.slice(0, topN).forEach((fund, i) => {
        const pnl = fund.totalValue - fund.initialBalance;
        const medal = MEDALS[i] ?? `#${i + 1}`;
        lines.push(`  ${medal} ${fund.emoji} ${fundDisplayName(fund.id, t)}   ${fmtPct(fund.returnPct)}  (${fmtAmt(pnl)})`);
      });
      lines.push("");
      lines.push("⚡ 由 Rotifer Protocol AI Gene 驱动");
      lines.push(`🌍 ${BRAND_URL}`);
    } else {
      lines.push(`🏆 Rotifer Alpha | AI Fund Leaderboard`);
      lines.push(`📅 ${dateStr}${daysRunning ? `  ·  Day ${daysRunning}` : ""}`);
      lines.push("");
      lines.push("📊 Portfolio Overview");
      lines.push(`  Total Return   ${fmtPct(totalReturnPct)}`);
      lines.push(`  Total PnL      ${fmtAmt(totalPnl)}`);
      if (todayChangeAbs !== null) lines.push(`  Today's Gain   ${fmtAmt(todayChangeAbs)}`);
      lines.push("");
      lines.push(`🏅 Top ${topN} Leaderboard`);
      sortedFunds.slice(0, topN).forEach((fund, i) => {
        const pnl = fund.totalValue - fund.initialBalance;
        const medal = MEDALS[i] ?? `#${i + 1}`;
        lines.push(`  ${medal} ${fund.emoji} ${fundDisplayName(fund.id, t)}   ${fmtPct(fund.returnPct)}  (${fmtAmt(pnl)})`);
      });
      lines.push("");
      lines.push("⚡ Powered by Rotifer Protocol AI Gene");
      lines.push(`🌍 ${BRAND_URL}`);
    }
    return lines.join("\n");
  }, [isZh, dateStr, daysRunning, totalReturnPct, totalPnl, todayChangeAbs, topN, sortedFunds, t]);

  // ── Utility: trigger poster success overlay ──
  const flashPosterSuccess = useCallback(() => {
    setPosterSuccess(true);
    setTimeout(() => setPosterSuccess(false), 1600);
  }, []);

  // ── Copy text ──
  const handleCopyText = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(generateText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* silently fail */ }
  }, [generateText]);

  // ── Download poster ──
  const handleDownload = useCallback(async () => {
    if (!posterRef.current) return;
    setDownloading(true);
    try {
      const dataUrl = await toPng(posterRef.current, { pixelRatio: 2, backgroundColor: "#090b10" });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `rotifer-alpha-leaderboard-${now.toISOString().slice(0, 10)}.png`;
      a.click();
    } catch (e) {
      console.error("Poster export failed:", e);
    } finally {
      setDownloading(false);
    }
  }, []);

  // ── Copy poster to clipboard ──
  // Uses toBlob() directly — avoids fetch(dataUrl) blob-type issues across browsers.
  const handleCopyPoster = useCallback(async () => {
    if (!posterRef.current) return;
    setCopyingPoster(true);
    try {
      const blob = await toBlob(posterRef.current, { pixelRatio: 2, backgroundColor: "#090b10" });
      if (!blob) throw new Error("toBlob returned null");
      if (typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      } else {
        // Fallback: trigger download
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `rotifer-alpha-poster-${now.toISOString().slice(0, 10)}.png`;
        a.click();
        URL.revokeObjectURL(url);
      }
      setCopiedPoster(true);
      flashPosterSuccess();
      setTimeout(() => setCopiedPoster(false), 2000);
    } catch (e) {
      console.error("Copy poster failed:", e);
    } finally {
      setCopyingPoster(false);
    }
  }, [flashPosterSuccess]);

  // ── Share to X ──
  // Pre-copies the poster to clipboard, then opens X intent with pre-filled text.
  const handleShareX = useCallback(async () => {
    setXStep("preparing");

    if (posterRef.current && typeof ClipboardItem !== "undefined") {
      try {
        const blob = await toBlob(posterRef.current, { pixelRatio: 2, backgroundColor: "#090b10" });
        if (blob) {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          flashPosterSuccess();
        }
      } catch { /* clipboard write unsupported */ }
    }

    const text = generateText();
    const maxLen = 240;
    const truncated = text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
      const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(truncated)}&url=${encodeURIComponent(BRAND_URL)}`;
    window.open(tweetUrl, "_blank", "noopener,noreferrer");

    setXStep("ready");
    setTimeout(() => setXStep(null), 7000);
  }, [generateText, flashPosterSuccess]);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    // Bottom-sheet on mobile (items-end, rounded-t), centered modal on sm+
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="glass-card w-full sm:max-w-md max-h-[96vh] sm:max-h-[90vh] flex flex-col overflow-hidden rounded-t-2xl sm:rounded-2xl">

        {/* ── Modal header ── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--r-border)] shrink-0">
          <div className="flex items-center gap-2">
            <Share2 className="w-4 h-4 text-[var(--r-accent)]" />
            <h2 className="font-semibold text-sm">{t("shareModalTitle")}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-[var(--r-text-faint)] hover:text-[var(--r-text)] hover:bg-[var(--r-border)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--r-accent)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── 1. Poster hero (centered, drop-shadow) ── */}
          <div className="px-6 pt-6 pb-0">
            <div
              ref={posterContainerRef}
              className="relative mx-auto"
              style={{ maxWidth: POSTER_W }}
            >
              {/* Scale wrapper for responsive fit */}
              <div
                style={{
                  overflow: "hidden",
                  height: posterNaturalH > 0 ? posterNaturalH * posterScale : undefined,
                  display: "flex",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    flexShrink: 0,
                    transform: `scale(${posterScale})`,
                    transformOrigin: "top center",
                    filter: "drop-shadow(0 12px 36px rgba(0,0,0,0.7))",
                  }}
                >
                  <div ref={posterRef}>
                    <PosterCard
                      funds={sortedFunds}
                      totalReturnPct={totalReturnPct}
                      totalPnl={totalPnl}
                      todayChangeAbs={todayChangeAbs}
                      daysRunning={daysRunning}
                      topN={topN}
                      isZh={isZh}
                      dateStr={dateStr}
                      t={t as any}
                    />
                  </div>
                </div>
              </div>

              {/* ── Copy/share success overlay ── */}
              <div
                className={`absolute inset-0 flex items-center justify-center rounded-[14px] transition-all duration-300 pointer-events-none ${
                  posterSuccess ? "opacity-100" : "opacity-0"
                }`}
                style={{ background: "rgba(0,212,170,0.18)", backdropFilter: "blur(1px)" }}
              >
                <div className="flex flex-col items-center gap-2">
                  <div className="w-12 h-12 rounded-full bg-[var(--r-accent)] flex items-center justify-center shadow-xl">
                    <Check className="w-6 h-6 text-[#090b10]" strokeWidth={3} />
                  </div>
                  <span className="text-xs font-semibold text-white" style={{ textShadow: "0 1px 4px rgba(0,0,0,0.6)" }}>
                    {isZh ? "已复制" : "Copied!"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* ── 2. TopN toggle (coupled directly to poster) ── */}
          <div className="flex justify-center items-center gap-2 mt-4 mb-5">
            <span className="text-[11px] text-[var(--r-text-faint)]">{t("shareTopN")}:</span>
            {([3, 5] as const).map(n => (
              <button
                key={n}
                onClick={() => handleSetTopN(n)}
                className={`px-3 py-1 text-xs rounded-full font-medium transition-all focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--r-accent)] ${
                  topN === n
                    ? "bg-[var(--r-accent)] text-[#090b10] shadow-sm"
                    : "border border-[var(--r-border)] text-[var(--r-text-muted)] hover:border-[var(--r-accent)] hover:text-[var(--r-accent)]"
                }`}
              >
                {n}
              </button>
            ))}
          </div>

          {/* ── 3. Share destinations ── */}
          <div className="px-5 pb-5">
            <p className="text-[10px] font-semibold text-[var(--r-text-faint)] uppercase tracking-widest mb-3">
              {isZh ? "分享至" : "Share via"}
            </p>

            <div className="grid grid-cols-3 gap-3">

              {/* Share to X */}
              <button
                onClick={handleShareX}
                disabled={xStep === "preparing"}
                className={`flex flex-col items-center gap-2.5 py-4 px-2 rounded-xl border transition-all group focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--r-accent)] disabled:cursor-wait ${
                  xStep
                    ? "border-[var(--r-accent)]/40 bg-[var(--r-accent)]/8"
                    : "border-[var(--r-border)] hover:border-[var(--r-accent)]/50 hover:bg-white/[0.03] active:scale-[0.97]"
                }`}
              >
                <svg
                  className={`w-5 h-5 shrink-0 transition-colors ${
                    xStep ? "text-[var(--r-accent)]" : "text-[var(--r-text-muted)] group-hover:text-[var(--r-accent)]"
                  }`}
                  viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
                >
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.736l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                <span className={`text-[11px] font-medium transition-colors leading-tight text-center ${
                  xStep ? "text-[var(--r-accent)]" : "text-[var(--r-text-faint)] group-hover:text-[var(--r-text-muted)]"
                }`}>
                  {t("shareToX")}
                </span>
              </button>

              {/* Copy poster */}
              <button
                onClick={handleCopyPoster}
                disabled={copyingPoster}
                className={`flex flex-col items-center gap-2.5 py-4 px-2 rounded-xl border transition-all group focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--r-accent)] disabled:cursor-wait ${
                  copiedPoster
                    ? "border-[var(--r-accent)]/40 bg-[var(--r-accent)]/8"
                    : "border-[var(--r-border)] hover:border-[var(--r-accent)]/50 hover:bg-white/[0.03] active:scale-[0.97]"
                }`}
              >
                {copiedPoster
                  ? <Check className="w-5 h-5 text-[var(--r-accent)]" />
                  : <ClipboardCopy className={`w-5 h-5 shrink-0 transition-colors ${
                      copyingPoster ? "text-[var(--r-text-faint)] animate-pulse" : "text-[var(--r-text-muted)] group-hover:text-[var(--r-accent)]"
                    }`} />
                }
                <span className={`text-[11px] font-medium transition-colors leading-tight text-center ${
                  copiedPoster ? "text-[var(--r-accent)]" : "text-[var(--r-text-faint)] group-hover:text-[var(--r-text-muted)]"
                }`}>
                  {copyingPoster ? t("shareCopyingPoster") : copiedPoster ? t("shareCopiedPoster") : t("shareCopyPoster")}
                </span>
              </button>

              {/* Download — primary CTA */}
              <button
                onClick={handleDownload}
                disabled={downloading}
                className="flex flex-col items-center gap-2.5 py-4 px-2 rounded-xl border transition-all focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--r-accent)] disabled:opacity-50 active:scale-[0.97]"
                style={{ borderColor: "rgba(0,212,170,0.35)", background: "rgba(0,212,170,0.09)" }}
              >
                <Download className={`w-5 h-5 text-[var(--r-accent)] ${downloading ? "animate-bounce" : ""}`} />
                <span className="text-[11px] font-medium text-[var(--r-accent)] leading-tight text-center">
                  {downloading ? t("shareDownloading") : t("shareDownloadPoster")}
                </span>
              </button>
            </div>

            {/* ── X share step guide (appears after clicking Share to X) ── */}
            <div
              className={`mt-3 overflow-hidden transition-all duration-300 ${
                xStep ? "max-h-20 opacity-100" : "max-h-0 opacity-0"
              }`}
            >
              <div className="flex items-center gap-1.5 flex-wrap text-[11px] bg-[var(--r-accent)]/5 border border-[var(--r-accent)]/20 rounded-xl px-4 py-3">
                {xStep === "preparing" ? (
                  <span className="text-[var(--r-text-muted)] animate-pulse">
                    {isZh ? "正在准备海报..." : "Preparing poster..."}
                  </span>
                ) : (
                  <>
                    <StepBadge done label={isZh ? "文案已预填" : "Text pre-filled"} />
                    <span className="text-[var(--r-border)]">›</span>
                    <StepBadge done label={isZh ? "海报已复制" : "Poster copied"} />
                    <span className="text-[var(--r-border)]">›</span>
                    <StepBadge active label={isZh ? "在 X 中粘贴图片（⌘V）" : "Paste image in X (⌘V)"} />
                  </>
                )}
              </div>
            </div>
          </div>

          {/* ── 4. Text accordion ── */}
          <div className="px-5 pb-6 border-t border-[var(--r-border)] pt-4">
            <button
              type="button"
              onClick={() => setTextExpanded(e => !e)}
              className="flex items-center justify-between w-full text-[11px] font-medium text-[var(--r-text-faint)] hover:text-[var(--r-text-muted)] transition-colors"
            >
              <span>
                {isZh ? (textExpanded ? "收起文案" : "查看文案") : (textExpanded ? "Hide copy" : "View copy")}
              </span>
              <div className="flex items-center gap-2">
                {/* Inline copy button when collapsed */}
                {!textExpanded && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={e => { e.stopPropagation(); handleCopyText(); }}
                    onKeyDown={e => { if (e.key === "Enter") { e.stopPropagation(); handleCopyText(); } }}
                    className="flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--r-border)] hover:border-[var(--r-accent)] hover:text-[var(--r-accent)] transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--r-accent)]"
                  >
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {copied ? t("shareCopied") : t("shareCopyText")}
                  </span>
                )}
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${textExpanded ? "rotate-180" : ""}`} />
              </div>
            </button>

            {/* Accordion body */}
            <div
              className={`overflow-hidden transition-all duration-300 ${
                textExpanded ? "max-h-[320px] mt-3 opacity-100" : "max-h-0 opacity-0"
              }`}
            >
              <div className="flex flex-col gap-2">
                <textarea
                  readOnly
                  value={generateText()}
                  className="w-full resize-none rounded-lg border border-[var(--r-border)] bg-[var(--r-bg-2,var(--r-bg))] text-[var(--r-text)] text-xs font-mono p-3 leading-relaxed focus:outline-none focus:border-[var(--r-accent)] transition-colors"
                  style={{ height: 200, whiteSpace: "pre", overflowWrap: "normal", overflowX: "auto" }}
                />
                <button
                  onClick={handleCopyText}
                  className="self-end flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--r-border)] text-[var(--r-text-muted)] hover:border-[var(--r-accent)] hover:text-[var(--r-accent)] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--r-accent)]"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? t("shareCopied") : t("shareCopyText")}
                </button>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── Exported component (portal wrapper) ─────────────────────────────────────

export function ShareModal(props: ShareModalProps) {
  if (!props.isOpen) return null;
  return createPortal(<ShareModalInner {...props} />, document.body);
}
