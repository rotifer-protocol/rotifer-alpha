import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n/context";

const GITHUB_PETRI = "https://github.com/rotifer-protocol/rotifer-alpha";
const GITHUB_SPEC = "https://github.com/rotifer-protocol/rotifer-spec";

const SECTIONS = [
  { id: "about",    zh: "关于实验室",    en: "About the Lab" },
  { id: "funds",    zh: "基金说明",      en: "Fund Guide" },
  { id: "pbt",      zh: "进化算法 PBT",  en: "PBT Algorithm" },
  { id: "fitness",  zh: "适应度 F(g)",   en: "Fitness F(g)" },
  { id: "arena",    zh: "竞技场 Arena",  en: "Arena" },
  { id: "glossary", zh: "术语词典",      en: "Glossary" },
  { id: "data",     zh: "数据说明",      en: "Data Notes" },
];

function Section({ id, zh, en, children }: {
  id: string; zh: string; en: string; children: React.ReactNode;
}) {
  const { locale } = useI18n();
  const isZh = locale === "zh";
  const primary   = isZh ? zh : en;
  const secondary = isZh ? en : zh;
  return (
    <section id={id} className="scroll-mt-28">
      <h2 className="text-lg font-bold mb-4 pb-2 border-b border-[var(--r-border)]">
        {primary}<span className="ml-2 text-xs font-normal text-[var(--r-text-faint)]">{secondary}</span>
      </h2>
      <div className="space-y-3 text-sm text-[var(--r-text-muted)] leading-relaxed">
        {children}
      </div>
    </section>
  );
}

function Term({ term, en, def }: { term: string; en?: string; def: string }) {
  return (
    <div className="flex gap-3 py-2 border-b border-[var(--r-border)]/50 last:border-0">
      <div className="w-36 shrink-0">
        <span className="font-medium text-[var(--r-text)]">{term}</span>
        {en && <span className="block text-[10px] text-[var(--r-text-faint)] mt-0.5">{en}</span>}
      </div>
      <p className="flex-1 text-[var(--r-text-muted)]">{def}</p>
    </div>
  );
}

function FormulaBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="glass-card px-4 py-3 font-mono text-sm text-[var(--r-accent)] my-2">
      {children}
    </div>
  );
}

export function DocsPage() {
  const { locale } = useI18n();
  const isZh = locale === "zh";
  const [activeId, setActiveId] = useState("about");
  const sectionEntries = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(e => { sectionEntries.current[e.target.id] = e.isIntersecting; });
        const first = SECTIONS.find(s => sectionEntries.current[s.id]);
        if (first) setActiveId(first.id);
      },
      { rootMargin: "-15% 0px -70% 0px" },
    );
    SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div>
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-2">
          {isZh ? "文档中心" : "Documentation"}
        </h1>
        <p className="text-sm text-[var(--r-text-muted)] max-w-xl">
          {isZh
            ? "了解 Petri 实验室的工作原理、基金机制、进化算法与协议细节。"
            : "Learn how Petri Lab works — funds, evolution algorithm, fitness formula, and protocol details."}
        </p>
        <div className="flex items-center gap-4 mt-3">
          <a href={GITHUB_PETRI} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--r-text-faint)] hover:text-[var(--r-accent)] transition-colors">
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            {isZh ? "查看源代码" : "View Source"}
          </a>
          <a href={GITHUB_SPEC} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--r-text-faint)] hover:text-[var(--r-accent)] transition-colors">
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            rotifer-spec
          </a>
        </div>
      </div>

      {/* Mobile TOC — horizontal pill tabs */}
      <div className="md:hidden mb-6">
        <div className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-none">
          {SECTIONS.map(s => (
            <button key={s.id} onClick={() => scrollTo(s.id)}
              className={`px-2.5 py-1.5 rounded-full text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                activeId === s.id
                  ? "bg-[var(--r-accent)] text-white"
                  : "border border-[var(--r-border)] text-[var(--r-text-muted)] hover:text-[var(--r-text)]"
              }`}>
              {isZh ? s.zh : s.en}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-10 relative">
        {/* Desktop sticky TOC */}
        <aside className="hidden md:block w-40 shrink-0">
          <nav className="sticky top-24 space-y-0.5">
            {SECTIONS.map(s => (
              <button key={s.id} onClick={() => scrollTo(s.id)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm transition-all ${
                  activeId === s.id
                    ? "bg-[var(--r-accent)]/10 text-[var(--r-accent)] font-medium border-l-2 border-[var(--r-accent)]"
                    : "text-[var(--r-text-muted)] hover:text-[var(--r-text)] hover:bg-[var(--r-surface)]"
                }`}>
                {isZh ? s.zh : s.en}
              </button>
            ))}
            <div className="pt-4 px-3 space-y-2">
              <a href={GITHUB_PETRI} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-[11px] text-[var(--r-text-faint)] hover:text-[var(--r-accent)] transition-colors">
                <svg viewBox="0 0 24 24" className="w-3 h-3 shrink-0" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
                </svg>
                GitHub
              </a>
            </div>
          </nav>
        </aside>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-14">

          {/* ── 1. About ── */}
          <Section id="about" zh="关于实验室" en="About the Lab">
            {isZh ? (
              <>
                <p>Petri 是 Rotifer Protocol 的 <strong className="text-[var(--r-text)]">AI 基金进化实验室</strong>。实验室中运行着由 AI Gene（基因程序）管理的多只模拟基金，每只基金独立执行交易策略，参与 <a href="https://polymarket.com" className="text-[var(--r-accent)] hover:underline" target="_blank" rel="noopener noreferrer">Polymarket</a> 预测市场。</p>
                <p>这不是人工管理的基金，而是一场进化实验。每只 AI 基金从基线参数出发，通过真实交易表现持续进化——适者存活，劣者接受参数变异，实验室永不停机。</p>
                <p className="glass-card px-3 py-2 text-xs border-l-2 border-[var(--r-accent)]">
                  ⚠️ 所有交易均为<strong>模拟交易（Paper Trading）</strong>，不涉及任何真实资金。本实验室仅供研究与演示用途。
                </p>
              </>
            ) : (
              <>
                <p>Petri is the <strong className="text-[var(--r-text)]">AI fund evolution lab</strong> of Rotifer Protocol. It runs multiple simulated funds managed by AI Genes — autonomous trading programs that participate in the <a href="https://polymarket.com" className="text-[var(--r-accent)] hover:underline" target="_blank" rel="noopener noreferrer">Polymarket</a> prediction market.</p>
                <p>This isn't human-managed — it's an evolution experiment. Each AI fund starts from baseline parameters and evolves through real trading performance. The fittest survive; underperformers mutate. The lab runs continuously, never stopping.</p>
                <p className="glass-card px-3 py-2 text-xs border-l-2 border-[var(--r-accent)]">
                  ⚠️ All trades are <strong>paper trades</strong> — no real money is involved. This lab is for research and demonstration purposes only.
                </p>
              </>
            )}
          </Section>

          {/* ── 2. Funds ── */}
          <Section id="funds" zh="基金说明" en="Fund Guide">
            {isZh ? (
              <>
                <p>实验室按资本规模划分为三个档位（Tier），每个档位独立验证不同资金量下策略的适应能力：</p>
                <div className="grid grid-cols-3 gap-3 my-3">
                  {[
                    { tier: "S 级", cap: "$10,000", note: "小资本·灵活探索", color: "border-yellow-500/40" },
                    { tier: "M 级", cap: "$100,000", note: "中资本·平衡效率", color: "border-blue-500/40" },
                    { tier: "L 级", cap: "$1,000,000", note: "大资本·规模验证", color: "border-purple-500/40" },
                  ].map(item => (
                    <div key={item.tier} className={`glass-card p-3 border-l-2 ${item.color}`}>
                      <p className="font-bold text-[var(--r-text)]">{item.tier}</p>
                      <p className="text-xs font-mono text-[var(--r-accent)]">{item.cap}</p>
                      <p className="text-[11px] mt-1">{item.note}</p>
                    </div>
                  ))}
                </div>
                <p><strong className="text-[var(--r-text)]">命名格式</strong>：基金名称由"动物名"构成，S 级基金末尾附加 <code className="text-[var(--r-accent)] bg-[var(--r-surface)] px-1 rounded text-xs">·S</code> 后缀以区分档位（如"鲨鱼·S"）。</p>
                <p><strong className="text-[var(--r-text)]">收益计算</strong>：总收益率 = (当前净值 − 初始本金) ÷ 初始本金 × 100%。已实现盈亏（Realized P&L）来自已平仓交易；未实现盈亏（Unrealized P&L）基于当前持仓的市场中间价估算，部分头寸的 CLOB 报价可能延迟或不可用。</p>
              </>
            ) : (
              <>
                <p>The lab operates three capital tiers, each independently validating strategy effectiveness at different scales:</p>
                <div className="grid grid-cols-3 gap-3 my-3">
                  {[
                    { tier: "S Tier", cap: "$10,000", note: "Small cap · Agile", color: "border-yellow-500/40" },
                    { tier: "M Tier", cap: "$100,000", note: "Mid cap · Balanced", color: "border-blue-500/40" },
                    { tier: "L Tier", cap: "$1,000,000", note: "Large cap · Scale", color: "border-purple-500/40" },
                  ].map(item => (
                    <div key={item.tier} className={`glass-card p-3 border-l-2 ${item.color}`}>
                      <p className="font-bold text-[var(--r-text)]">{item.tier}</p>
                      <p className="text-xs font-mono text-[var(--r-accent)]">{item.cap}</p>
                      <p className="text-[11px] mt-1">{item.note}</p>
                    </div>
                  ))}
                </div>
                <p><strong className="text-[var(--r-text)]">Naming</strong>: Fund names are animal names. S-tier funds carry a <code className="text-[var(--r-accent)] bg-[var(--r-surface)] px-1 rounded text-xs">·S</code> suffix (e.g. "Shark·S").</p>
                <p><strong className="text-[var(--r-text)]">Return calculation</strong>: Total Return % = (Current NAV − Initial Capital) ÷ Initial Capital × 100%. Realized P&L comes from closed positions; unrealized P&L is estimated from current CLOB mid-prices (some positions may have stale or unavailable quotes).</p>
              </>
            )}
          </Section>

          {/* ── 3. PBT ── */}
          <Section id="pbt" zh="进化算法 PBT" en="PBT Algorithm">
            {isZh ? (
              <>
                <p>实验室采用 <strong className="text-[var(--r-text)]">PBT（Population-Based Training，种群训练）</strong>算法驱动基金进化。PBT 是一种无需人工干预的超参数优化方法，通过淘汰-变异-继承循环让种群自发寻优。</p>
                <p><strong className="text-[var(--r-text)]">世代机制</strong>：每隔固定笔数（EPOCH_TRADE_THRESHOLD）完成一次世代迭代。每个世代结束后，适应度最低的基金进入变异流程。</p>
                <p><strong className="text-[var(--r-text)]">生产主路径公式</strong>：每个资本层级（S / M / L）内独立选择冠军与最弱基金，最弱基金继承冠军参数后加入小幅随机扰动。</p>
                <FormulaBlock>
                  <div>g_best = argmax F(g)</div>
                  <div>g_worst = argmin F(g)</div>
                  <div>theta_worst ← clamp(theta_best + epsilon)</div>
                  <div>epsilon ~ N(0, 0.05 × parameter_range)</div>
                </FormulaBlock>
                <p className="text-xs text-[var(--r-text-faint)]">若同层基金全部 F(g) &gt; 0.6，则跳过本轮变异；若全部 F(g) &lt; 0.2，则触发全局重置。</p>
                <p><strong className="text-[var(--r-text)]">变异类型</strong>：</p>
                <div className="space-y-1.5 pl-3">
                  {[
                    ["FULL_MUTATE", "完整变异", "完全随机生成新参数集"],
                    ["MICRO_MUTATE", "微调变异", "在现有参数上进行小幅扰动"],
                    ["INHERIT_MUTATE", "继承变异", "复制高适应度基金的参数后微调"],
                    ["PBT_RESPAWN", "重生", "以新标识重置参数，重新开始探索"],
                  ].map(([code, name, desc]) => (
                    <div key={code} className="flex gap-2 text-xs">
                      <code className="text-[var(--r-accent)] bg-[var(--r-surface)] px-1.5 py-0.5 rounded shrink-0">{code}</code>
                      <span><strong className="text-[var(--r-text)]">{name}</strong>：{desc}</span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-[var(--r-text-faint)]">注：基因进化页面的"世代"计数器（Gene Epoch）与各基金的 PBT 世代（Fund Epoch）是独立的两套计数体系，分别跟踪基因层面的进化历史与单只基金的进化历史。</p>
              </>
            ) : (
              <>
                <p>The lab uses <strong className="text-[var(--r-text)]">PBT (Population-Based Training)</strong> to drive fund evolution. PBT is a hyperparameter optimization method that requires no human intervention — a population of agents self-optimizes via an exploit-explore loop.</p>
                <p><strong className="text-[var(--r-text)]">Epoch mechanism</strong>: One evolution cycle completes after a fixed number of trades (EPOCH_TRADE_THRESHOLD). After each epoch, the lowest-fitness fund enters the mutation pipeline.</p>
                <p><strong className="text-[var(--r-text)]">Production-path formula</strong>: within each capital tier (S / M / L), the system selects the champion and weakest fund independently. The weakest fund inherits the champion's parameters plus a small random perturbation.</p>
                <FormulaBlock>
                  <div>g_best = argmax F(g)</div>
                  <div>g_worst = argmin F(g)</div>
                  <div>theta_worst ← clamp(theta_best + epsilon)</div>
                  <div>epsilon ~ N(0, 0.05 × parameter_range)</div>
                </FormulaBlock>
                <p className="text-xs text-[var(--r-text-faint)]">If all funds in a tier have F(g) &gt; 0.6, mutation is skipped. If all have F(g) &lt; 0.2, the tier enters global reset.</p>
                <p><strong className="text-[var(--r-text)]">Mutation types</strong>:</p>
                <div className="space-y-1.5 pl-3">
                  {[
                    ["FULL_MUTATE", "Full Mutation", "Completely randomize the parameter set"],
                    ["MICRO_MUTATE", "Micro Mutation", "Small perturbation of existing parameters"],
                    ["INHERIT_MUTATE", "Inherit Mutation", "Copy a high-fitness fund's params, then perturb"],
                    ["PBT_RESPAWN", "Respawn", "Reset with a new identity and start fresh exploration"],
                  ].map(([code, name, desc]) => (
                    <div key={code} className="flex gap-2 text-xs">
                      <code className="text-[var(--r-accent)] bg-[var(--r-surface)] px-1.5 py-0.5 rounded shrink-0">{code}</code>
                      <span><strong className="text-[var(--r-text)]">{name}</strong>: {desc}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Section>

          {/* ── 4. Fitness ── */}
          <Section id="fitness" zh="适应度 F(g)" en="Fitness F(g)">
            {isZh ? (
              <>
                <p>适应度 F(g) 是 Petri 实验室衡量基因交易质量的核心指标，综合四个维度，输出 0–1 范围内的单一分数。</p>
                <FormulaBlock>
                  F(g) = Sharpe × 0.4 + WinRate × 0.2 + (1 − MaxDrawdown) × 0.3 − complexity × 0.1
                </FormulaBlock>
                <div className="space-y-2 pl-1">
                  {[
                    ["Sharpe Ratio (×0.4)", "夏普比率——衡量每单位风险创造的超额收益，权重最高"],
                    ["WinRate (×0.2)", "胜率——盈利交易占所有已平仓交易的比例"],
                    ["1 − MaxDrawdown (×0.3)", "最大回撤的逆指标——回撤越小，该项得分越高"],
                    ["complexity (×0.1, 惩罚项)", "参数复杂度——过于复杂的策略会被惩罚，抑制过拟合"],
                  ].map(([label, desc]) => (
                    <div key={label} className="flex gap-2 text-xs border-b border-[var(--r-border)]/40 pb-2 last:border-0">
                      <code className="text-[var(--r-accent)] shrink-0 w-52">{label}</code>
                      <span>{desc}</span>
                    </div>
                  ))}
                </div>
                <p>F(g) 越高代表该基因的交易质量越好。PBT 进化算法以 F(g) 为唯一依据决定哪些基金需要参数变异——分数持续低于阈值的基金将在下一世代接受进化。</p>
                <p className="glass-card px-3 py-2 text-xs border-l-2 border-[var(--r-border)] text-[var(--r-text-faint)]">
                  ⚠️ 以上公式为 Petri worker 的<strong>参考实现版本</strong>，仅供理解用途。Rotifer Protocol 规范层对 F(g) 的抽象定义以{" "}
                  <a href={GITHUB_SPEC} target="_blank" rel="noopener noreferrer" className="text-[var(--r-accent)] hover:underline">rotifer-spec</a> 为准，两者可能存在差异。
                </p>
              </>
            ) : (
              <>
                <p>Fitness F(g) is Petri Lab's core metric for measuring gene trading quality. It combines four dimensions into a single score in the 0–1 range.</p>
                <FormulaBlock>
                  F(g) = Sharpe × 0.4 + WinRate × 0.2 + (1 − MaxDrawdown) × 0.3 − complexity × 0.1
                </FormulaBlock>
                <div className="space-y-2 pl-1">
                  {[
                    ["Sharpe Ratio (×0.4)", "Risk-adjusted return — the highest-weight component"],
                    ["WinRate (×0.2)", "Fraction of closed trades that were profitable"],
                    ["1 − MaxDrawdown (×0.3)", "Inverse of peak-to-trough drawdown — lower drawdown scores higher"],
                    ["complexity (×0.1, penalty)", "Parameter complexity penalty — discourages overfitting"],
                  ].map(([label, desc]) => (
                    <div key={label} className="flex gap-2 text-xs border-b border-[var(--r-border)]/40 pb-2 last:border-0">
                      <code className="text-[var(--r-accent)] shrink-0 w-52">{label}</code>
                      <span>{desc}</span>
                    </div>
                  ))}
                </div>
                <p>Higher F(g) means better gene trading quality. PBT uses F(g) as the sole criterion for deciding which funds need parameter mutation — funds consistently below the threshold will evolve in the next epoch.</p>
                <p className="glass-card px-3 py-2 text-xs border-l-2 border-[var(--r-border)] text-[var(--r-text-faint)]">
                  ⚠️ The formula above is Petri's <strong>reference implementation</strong> for F(g), provided for understanding purposes. The authoritative abstract definition of F(g) at the Rotifer Protocol spec level is in{" "}
                  <a href={GITHUB_SPEC} target="_blank" rel="noopener noreferrer" className="text-[var(--r-accent)] hover:underline">rotifer-spec</a>. The two may differ.
                </p>
              </>
            )}
          </Section>

          {/* ── 5. Arena ── */}
          <Section id="arena" zh="竞技场 Arena" en="Arena">
            {isZh ? (
              <>
                <p>
                  竞技场（Arena）是 Petri 实验室各层基金<strong className="text-[var(--r-text)]">适应度 F(g) 排名竞争</strong>的专属视图。
                  在这里，同一层（S / M / L）的 5 支基金以 F(g) 分数为唯一标准排名，
                  分数最高的基金成为<strong className="text-[var(--r-text)]">本层冠军</strong>（受保护，不被 PBT 变异），
                  分数最低的基金进入<strong className="text-[var(--r-text)]">待进化</strong>名单，在下一个世代接受参数变异。
                </p>
                <div className="glass-card px-4 py-3 space-y-2 text-xs">
                  {[
                    ["竞争规则", "仅在同层（相同资金体量）内比较，S 层 vs S 层、M 层 vs M 层、L 层 vs L 层，跨层不做横向比较。"],
                    ["冠军保护", "每层 F(g) 最高的基金在本轮进化中不会被变异，其参数作为继承来源。"],
                    ["待进化标记", "每层 F(g) 最低的基金在下一次 PBT Epoch 触发时有高概率接受 INHERIT_MUTATE（继承冠军参数后微调）。"],
                    ["F(g) 赛道图", "「F(g) 赛道」图以 Epoch 为横轴，展示各基金的适应度曲线。竞争格局的演化可通过赛道图直观查看。"],
                    ["竞技场 vs 实况", "实况（/）展示当前交易行为；竞技场（/arena）专注于适应度的历史竞争。两者共用同一份进化数据，视角不同。"],
                  ].map(([term, desc]) => (
                    <div key={term as string} className="flex gap-2 border-b border-[var(--r-border)]/40 pb-2 last:border-0">
                      <span className="text-[var(--r-accent)] font-medium shrink-0 w-24">{term}</span>
                      <span>{desc}</span>
                    </div>
                  ))}
                </div>
                <p className="glass-card px-3 py-2 text-xs border-l-2 border-[var(--r-accent)]/40 text-[var(--r-text-faint)]">
                  🏟️ 竞技场页面入口：导航栏{" "}
                  <Link to="/arena" className="text-[var(--r-accent)] hover:underline">竞技场</Link>{" "}
                  → 选择层（S / M / L）→ 查看当前排名与 F(g) 赛道。
                </p>
              </>
            ) : (
              <>
                <p>
                  The Arena is the dedicated view for <strong className="text-[var(--r-text)]">F(g) fitness competition</strong> within each tier.
                  Five funds compete within the same tier (S / M / L) ranked solely by F(g) score.
                  The highest-scoring fund becomes the <strong className="text-[var(--r-text)]">Tier Champion</strong> (protected from PBT mutation)
                  while the lowest-scoring fund is <strong className="text-[var(--r-text)]">On Notice</strong> — it is the mutation candidate for the next epoch.
                </p>
                <div className="glass-card px-4 py-3 space-y-2 text-xs">
                  {[
                    ["Competition scope", "Within-tier only (same capital size): S vs S, M vs M, L vs L. No cross-tier comparison."],
                    ["Champion protection", "The highest F(g) fund in each tier is not mutated this round — its parameters become the inheritance source for others."],
                    ["On Notice", "The lowest F(g) fund in each tier has high probability of receiving INHERIT_MUTATE (copy champion + nudge) at next epoch."],
                    ["F(g) Race chart", "The race chart plots F(g) over epochs for all funds in the selected tier — lets you track which fund is gaining or losing ground."],
                    ["Arena vs Live", "Live (/) shows current trading activity; Arena (/arena) focuses on historical fitness competition. Both share the same evolution data, different lens."],
                  ].map(([term, desc]) => (
                    <div key={term as string} className="flex gap-2 border-b border-[var(--r-border)]/40 pb-2 last:border-0">
                      <span className="text-[var(--r-accent)] font-medium shrink-0 w-40">{term}</span>
                      <span>{desc}</span>
                    </div>
                  ))}
                </div>
                <p className="glass-card px-3 py-2 text-xs border-l-2 border-[var(--r-accent)]/40 text-[var(--r-text-faint)]">
                  🏟️ Open the Arena:{" "}
                  <Link to="/arena" className="text-[var(--r-accent)] hover:underline">Arena</Link>{" "}
                  in the nav bar → select tier (S / M / L) → view current standings and F(g) race.
                </p>
              </>
            )}
          </Section>

          {/* ── 6. Glossary ── */}
          <Section id="glossary" zh="术语词典" en="Glossary">
            {isZh ? (
              <div>
                {[
                  ["Gene（基因）", "Gene", "一段可执行的交易逻辑程序。Gene 是 Rotifer Protocol 的核心抽象单位，可被编译为 WASM 字节码运行。"],
                  ["Phenotype（表现型）", "Phenotype", "Gene 的运行参数配置，决定该基因在实际交易中的行为特征（如持仓阈值、信号灵敏度等）。"],
                  ["Epoch（世代）", "Epoch", "一次完整的进化轮次。达到 EPOCH_TRADE_THRESHOLD 笔交易后触发，触发后执行一次 PBT 评估与变异。"],
                  ["Arena（竞技场）", "Arena", "Gene 适应度竞技场，各 Gene 的 F(g) 分数在此排名比较。"],
                  ["Shadow Trading（影子交易）", "Shadow Trading", "AI 基金的真实交易行为镜像，展示模拟盘与纸面盘的对比，不涉及真实资金划转。"],
                  ["Skip（跳过）", "Skip", "管线扫描后因条件不满足（如资金不足、无信号等）而跳过本次交易的情况。"],
                  ["PBT", "Population-Based Training", "种群训练算法，通过多智能体并行训练 + 定期淘汰-变异实现自动超参数优化。"],
                  ["F(g)", "Fitness Function", "基因适应度函数，综合 Sharpe、胜率、回撤、复杂度四个维度给出 0–1 的评分。"],
                  ["Readiness（就绪度）", "Fund Readiness", "综合基金当前表现、资金状态与历史交易质量计算的综合健康分，用于评估基金是否具备继续运营的条件。"],
                  ["Gene Epoch（基因世代）", "Gene Epoch", "基因层面的全局进化计数，独立于各基金的 PBT Fund Epoch，记录整个种群的进化历史轮次。"],
                ].map(([zh, en, def]) => <Term key={zh} term={zh} en={en} def={def} />)}
              </div>
            ) : (
              <div>
                {[
                  ["Gene", undefined, "An executable trading logic program. Genes are the core abstraction unit of Rotifer Protocol, compiled to WASM bytecode for execution."],
                  ["Phenotype", undefined, "The runtime parameter configuration of a Gene — determines how the gene behaves in actual trading (signal thresholds, position sizing, etc.)."],
                  ["Epoch", undefined, "One complete evolution cycle. Triggered after EPOCH_TRADE_THRESHOLD trades; runs a PBT assessment and mutation step."],
                  ["Arena", undefined, "The Gene fitness arena where F(g) scores are ranked and compared across all Genes."],
                  ["Shadow Trading", undefined, "A mirror of the AI fund's real trading activity. Shows a paper-vs-shadow comparison without real money transfers."],
                  ["Skip", undefined, "When the pipeline scanner decides not to trade this cycle due to unmet conditions (insufficient cash, no signal, etc.)."],
                  ["PBT", "Population-Based Training", "A meta-learning algorithm where a population of agents trains in parallel, with periodic exploit (copy winners) and explore (mutate) steps."],
                  ["F(g)", "Fitness Function", "Gene fitness score combining Sharpe, WinRate, MaxDrawdown, and complexity into a 0–1 metric."],
                  ["Readiness", undefined, "A composite health score for a fund based on current performance, capital status, and trading history quality."],
                  ["Gene Epoch", undefined, "A global evolution counter at the gene level, independent from each fund's PBT Fund Epoch."],
                ].map(([term, en, def]) => <Term key={term} term={term as string} en={en as string | undefined} def={def as string} />)}
              </div>
            )}
          </Section>

          {/* ── 6. Data Notes ── */}
          <Section id="data" zh="数据说明" en="Data Notes">
            {isZh ? (
              <>
                <div className="space-y-2">
                  {[
                    ["实时更新", "资金状态每 60 秒刷新一次；交易事件通过 WebSocket 实时推送。"],
                    ["价格来源", "持仓估值基于 Polymarket CLOB 中间价（best bid / best ask 均值）。部分低流动性市场的报价可能延迟或不可用，相关头寸标注为「过时价格」。"],
                    ["事件历史", "WebSocket 实时事件流在客户端内存中保留最近数百条；REST /api/events 端点提供持久化的历史事件查询。"],
                    ["模拟交易声明", "本实验室所有操作均为模拟交易（Paper Trading）。收益数字不代表任何真实投资表现，不构成投资建议。"],
                    ["数据保留", "快照数据（基金净值历史）保留最近约 60 条，涵盖约 4 天的历史。"],
                  ].map(([label, desc]) => (
                    <div key={label} className="flex gap-3 text-xs border-b border-[var(--r-border)]/40 pb-2.5 last:border-0">
                      <strong className="text-[var(--r-text)] w-24 shrink-0">{label}</strong>
                      <span>{desc}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  {[
                    ["Live updates", "Fund status refreshes every 60s; trade events are streamed via WebSocket in real time."],
                    ["Price source", "Position valuations use Polymarket CLOB mid-price (best bid + best ask / 2). Low-liquidity markets may have stale or unavailable quotes — affected positions are flagged as 'stale price'."],
                    ["Event history", "WebSocket events are buffered in client memory (recent ~hundreds); the REST /api/events endpoint provides persistent historical event queries."],
                    ["Paper trading", "Everything in this lab is paper trading. Numbers do not represent real investment performance and should not be taken as investment advice."],
                    ["Data retention", "Snapshot data (fund NAV history) retains ~60 most recent entries, covering roughly 4 days of history."],
                  ].map(([label, desc]) => (
                    <div key={label} className="flex gap-3 text-xs border-b border-[var(--r-border)]/40 pb-2.5 last:border-0">
                      <strong className="text-[var(--r-text)] w-24 shrink-0">{label}</strong>
                      <span>{desc}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Section>

          {/* Back to top / link to spec */}
          <div className="pb-8 flex items-center justify-between text-xs text-[var(--r-text-faint)]">
            <button onClick={() => scrollTo("about")} className="hover:text-[var(--r-text)] transition-colors">
              ↑ {isZh ? "回到顶部" : "Back to top"}
            </button>
            <div className="flex items-center gap-4">
              <a href={GITHUB_SPEC} target="_blank" rel="noopener noreferrer"
                className="hover:text-[var(--r-accent)] transition-colors">
                {isZh ? "完整协议规范" : "Full Protocol Spec"} ↗
              </a>
              <Link to="/" className="hover:text-[var(--r-accent)] transition-colors no-underline">
                {isZh ? "返回实况" : "Back to Live"}
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
