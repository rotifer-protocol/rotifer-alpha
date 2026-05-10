/**
 * Regression: Genome pipeline must respect KILL_SWITCH.
 *
 * Incident context (2026-05-10): legacy runPipeline() checked KILL_SWITCH, but
 * ENABLE_GENOME_PIPELINE=true routed cron/manual runs through runGenomePipeline(),
 * which skipped the guard and continued opening trades while operators believed
 * the system was halted.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runGenomePipeline } from "../src/genome";
import type { Env } from "../src/types";

function makeEnv(killSwitch: "true" | "false") {
  const calls: string[] = [];

  const db = {
    prepare(sql: string) {
      calls.push(sql);
      return {
        bind: (..._args: unknown[]) => this,
        first: async () => {
          if (sql.includes("FROM system_config WHERE key = 'KILL_SWITCH'")) {
            return { value: killSwitch };
          }
          return null;
        },
        all: async () => {
          throw new Error(`Unexpected downstream SELECT while kill switch is active: ${sql}`);
        },
        run: async () => ({}),
      };
    },
  } as unknown as D1Database;

  const env = {
    DB: db,
    ENABLE_GENOME_PIPELINE: "true",
  } as unknown as Env;

  return { env, calls };
}

test("runGenomePipeline: KILL_SWITCH=true halts before downstream stages", async () => {
  const { env, calls } = makeEnv("true");

  const result = await runGenomePipeline(env, []);

  assert.equal(result.scanner.totalFetched, 0);
  assert.equal(result.trader.trades.length, 0);
  assert.equal(result.risk.stopped.length, 0);
  assert.equal(result.microEvolver.results.length, 0);

  assert.ok(
    calls.some(sql => sql.includes("FROM system_config WHERE key = 'KILL_SWITCH'")),
    "expected kill-switch lookup",
  );
  assert.ok(
    calls.some(sql => sql.includes("INSERT OR REPLACE INTO system_config")),
    "expected halted heartbeat write",
  );
  assert.equal(
    calls.some(sql => sql.includes("FROM paper_trades WHERE status = 'OPEN'")),
    false,
    "must not run price refresh / risk / monitor queries while halted",
  );
});
