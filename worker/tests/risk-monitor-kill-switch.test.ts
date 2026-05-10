/**
 * Round-2 fix regression: RiskMonitor DO alarm must respect KILL_SWITCH.
 *
 * Pre-fix incident (2026-05-10): the cron-driven runPipeline checked
 * KILL_SWITCH at the top, but the RiskMonitor Durable Object ran on its
 * own 60s alarm independent of the cron. When the operator flipped
 * KILL_SWITCH=true to halt trading, the DO kept reading the bogus
 * last_price=0.5 marks and triggered ~36 stop-loss closures across
 * existing positions, producing -$25M of new corrupt PnL in 17 minutes.
 *
 * Fix: alarm() reads isKillSwitchActive() and, when on, skips runRiskScan
 * but re-arms the next alarm (so the DO resumes immediately when off).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { RiskMonitor } from "../src/risk-monitor";

interface MockState {
  storage: {
    data: Map<string, unknown>;
    alarms: number[];
    get: <T>(key: string) => Promise<T | undefined>;
    put: <T>(key: string, value: T) => Promise<void>;
    setAlarm: (when: number) => Promise<void>;
    deleteAlarm: () => Promise<void>;
    getAlarm: () => Promise<number | null>;
  };
}

function makeMockState(): MockState {
  const data = new Map<string, unknown>();
  const alarms: number[] = [];
  return {
    storage: {
      data,
      alarms,
      async get<T>(key: string): Promise<T | undefined> {
        return data.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        data.set(key, value);
      },
      async setAlarm(when: number): Promise<void> {
        alarms.push(when);
      },
      async deleteAlarm(): Promise<void> {
        // not asserted in these tests
      },
      async getAlarm(): Promise<number | null> {
        return alarms.length > 0 ? alarms[alarms.length - 1] : null;
      },
    },
  };
}

interface MockEnv {
  DB: D1Database;
  LIVE_HUB: DurableObjectNamespace;
  selectsToOpenTrades: number;
}

function makeMockEnv(killSwitch: "true" | "false"): MockEnv {
  let selectsToOpenTrades = 0;
  const env: MockEnv = {
    selectsToOpenTrades: 0,
    DB: {
      prepare(sql: string) {
        const bound: unknown[] = [];
        return {
          bind: (...args: unknown[]) => {
            bound.push(...args);
            return this;
          },
          first: async () => {
            if (sql.includes("FROM system_config WHERE key = 'KILL_SWITCH'")) {
              return { value: killSwitch };
            }
            if (sql.includes("FROM system_config WHERE key = 'EXECUTION_MODE'")) {
              return { value: "paper" };
            }
            return null;
          },
          all: async () => {
            if (sql.includes("FROM paper_trades WHERE status = 'OPEN'")) {
              selectsToOpenTrades++;
              env.selectsToOpenTrades = selectsToOpenTrades;
              return { results: [] };
            }
            return { results: [] };
          },
          run: async () => ({}),
        };
      },
    } as unknown as D1Database,
    LIVE_HUB: {} as DurableObjectNamespace,
  };
  return env;
}

test("RiskMonitor alarm: KILL_SWITCH=true skips risk scan but re-arms", async () => {
  const state = makeMockState();
  const env = makeMockEnv("true");
  const monitor = new RiskMonitor(state as unknown as DurableObjectState, env);
  await state.storage.put("config", {
    armed: true,
    funds: [{ id: "fund-1", emoji: "X", stopLossPercent: 0.2 } as unknown],
  });

  await monitor.alarm();

  // Critical: NO read of paper_trades happened — kill switch blocked the scan.
  assert.equal(env.selectsToOpenTrades, 0);
  // Re-armed for next cycle so the DO resumes immediately when switch flips off.
  assert.equal(state.storage.alarms.length, 1);
});

test("RiskMonitor alarm: KILL_SWITCH=false runs risk scan as normal", async () => {
  const state = makeMockState();
  const env = makeMockEnv("false");
  const monitor = new RiskMonitor(state as unknown as DurableObjectState, env);
  await state.storage.put("config", {
    armed: true,
    funds: [{ id: "fund-1", emoji: "X", stopLossPercent: 0.2 } as unknown],
  });

  await monitor.alarm();

  // Risk scan ran (SELECT executed, even though no rows returned).
  assert.equal(env.selectsToOpenTrades, 1);
  // Still re-armed.
  assert.equal(state.storage.alarms.length, 1);
});

test("RiskMonitor alarm: not armed → no scan, no alarm regardless of switch", async () => {
  const state = makeMockState();
  const env = makeMockEnv("false");
  const monitor = new RiskMonitor(state as unknown as DurableObjectState, env);
  await state.storage.put("config", { armed: false, funds: [] });

  await monitor.alarm();

  assert.equal(env.selectsToOpenTrades, 0);
  assert.equal(state.storage.alarms.length, 0);
});
