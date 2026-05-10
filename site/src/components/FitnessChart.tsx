import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  ReferenceLine, ReferenceArea,
} from "recharts";
import { useI18n } from "../i18n/context";

interface EvolutionLog {
  epoch: number;
  fund_id: string;
  fitness_before: number | null;
  action: string;
}

interface Props {
  logs: EvolutionLog[];
}

import { FUND_HEX_COLORS, fundDisplayName } from "../lib/fundMeta";
const FUND_COLORS = FUND_HEX_COLORS;

export function FitnessChart({ logs }: Props) {
  const { t } = useI18n();
  const fundIds = [...new Set(logs.map(l => l.fund_id))];
  const epochs = [...new Set(logs.map(l => l.epoch))].sort((a, b) => a - b);

  if (epochs.length === 0) {
    return (
      <div className="glass-card p-6 text-center text-sm text-[var(--r-text-muted)]">
        {t("fitnessEmpty")}
      </div>
    );
  }

  const data = epochs.map(epoch => {
    const point: Record<string, number | string> = { epoch: `E${epoch}` };
    const vals: number[] = [];
    for (const fid of fundIds) {
      const log = logs.find(l => l.epoch === epoch && l.fund_id === fid);
      if (log?.fitness_before !== null && log?.fitness_before !== undefined) {
        point[fid] = log.fitness_before;
        vals.push(log.fitness_before);
      }
    }
    if (vals.length > 0) point._avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return point;
  });

  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3">
        {t("fitnessTitle")}
      </h3>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
          <XAxis
            dataKey="epoch"
            tick={{ fill: "#a1a1aa", fontSize: 11 }}
            axisLine={{ stroke: "#27272a" }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "#a1a1aa", fontSize: 11 }}
            axisLine={{ stroke: "#27272a" }}
            tickLine={false}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => v.toFixed(2)}
          />
          <Tooltip
            contentStyle={{
              background: "#111113",
              border: "1px solid #27272a",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "#fafafa" }}
            formatter={(value: unknown, name: unknown) => {
              const fid = String(name);
              return [Number(value).toFixed(4), fundDisplayName(fid, t)];
            }}
          />
          <Legend
            formatter={(value: string) => (
              <span style={{ color: "#a1a1aa", fontSize: 11 }}>
                {fundDisplayName(value, t)}
              </span>
            )}
          />
          <ReferenceArea y1={0} y2={0.2} fill="#ef4444" fillOpacity={0.04} />
          <ReferenceArea y1={0.6} y2={1.2} fill="#22c55e" fillOpacity={0.04} />
          <ReferenceLine y={0.6} stroke="#22c55e" strokeDasharray="4 4" strokeOpacity={0.4} />
          <ReferenceLine y={0.2} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.4} />
          <Line
            type="monotone"
            dataKey="_avg"
            stroke="#a1a1aa"
            strokeWidth={1.5}
            strokeDasharray="6 3"
            dot={false}
            connectNulls
            legendType="none"
          />
          {fundIds.map(fid => (
            <Line
              key={fid}
              type="monotone"
              dataKey={fid}
              stroke={FUND_COLORS[fid] || "#a1a1aa"}
              strokeWidth={2}
              dot={{ r: 3, fill: FUND_COLORS[fid] || "#a1a1aa" }}
              activeDot={{ r: 5 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div className="flex justify-between text-[10px] text-[var(--r-text-muted)] mt-1 px-2">
        <span>--- {t("thresholdReset")}</span>
        <span>--- {t("thresholdGood")}</span>
      </div>
    </div>
  );
}
