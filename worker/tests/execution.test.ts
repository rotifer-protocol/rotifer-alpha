import test from "node:test";
import assert from "node:assert/strict";

import {
  isKillSwitchActive,
  getExecutionMode,
  setKillSwitch,
  setExecutionMode,
  getSystemConfig,
  getPipelineErrors,
  getGuardrailEventCount,
  DUPLICATE_OPEN_GUARDRAIL_MESSAGE,
  recordShadowOpen,
  recordShadowClose,
} from "../src/execution";

class FakeStatement {
  public boundArgs: unknown[] = [];
  constructor(
    private readonly sql: string,
    private readonly store: Map<string, string>,
    private readonly inserts: Array<{ sql: string; args: unknown[] }>,
    private readonly pipelineErrors: Array<Record<string, unknown>>,
  ) {}

  private resolveKey(): string | undefined {
    if (this.boundArgs.length > 0) return this.boundArgs[0] as string;
    const m = this.sql.match(/key\s*=\s*'([^']+)'/);
    return m?.[1];
  }

  bind(...args: unknown[]) {
    this.boundArgs = args;
    return this;
  }

  async run() {
    if (this.sql.includes("INSERT OR REPLACE INTO system_config")) {
      const keyMatch = this.sql.match(/VALUES\s*\('([^']+)'/);
      if (keyMatch) {
        this.store.set(keyMatch[1], this.boundArgs[0] as string);
      } else {
        this.store.set(this.boundArgs[0] as string, this.boundArgs[1] as string);
      }
    }
    if (this.sql.includes("INSERT INTO shadow_orders")) {
      this.inserts.push({ sql: this.sql, args: [...this.boundArgs] });
    }
    return {};
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM system_config WHERE key")) {
      const key = this.resolveKey();
      if (!key) return null;
      const val = this.store.get(key);
      return val !== undefined ? { value: val } as unknown as T : null;
    }
    if (this.sql.includes("COUNT(*) AS n FROM pipeline_errors")) {
      const needle = this.boundArgs[0] as string;
      return {
        n: this.pipelineErrors.filter(e => String(e.message ?? "").includes(needle)).length,
      } as unknown as T;
    }
    return null;
  }

  async all() {
    if (this.sql.includes("SELECT key, value FROM system_config")) {
      return {
        results: Array.from(this.store.entries()).map(([key, value]) => ({ key, value })),
      };
    }
    if (this.sql.includes("FROM pipeline_errors")) {
      const needle = this.boundArgs[0] as string;
      return {
        results: this.pipelineErrors.filter(e => !String(e.message ?? "").includes(needle)),
      };
    }
    return { results: [] };
  }
}

class FakeDb {
  private store = new Map<string, string>();
  public inserts: Array<{ sql: string; args: unknown[] }> = [];
  public pipelineErrors: Array<Record<string, unknown>> = [];

  constructor(initial?: Record<string, string>, pipelineErrors?: Array<Record<string, unknown>>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        this.store.set(k, v);
      }
    }
    this.pipelineErrors = pipelineErrors ?? [];
  }

  prepare(sql: string) {
    return new FakeStatement(sql, this.store, this.inserts, this.pipelineErrors);
  }
}

test("isKillSwitchActive returns false when not set", async () => {
  const db = new FakeDb();
  assert.equal(await isKillSwitchActive(db as unknown as D1Database), false);
});

test("isKillSwitchActive returns true when set to true", async () => {
  const db = new FakeDb({ KILL_SWITCH: "true" });
  assert.equal(await isKillSwitchActive(db as unknown as D1Database), true);
});

test("setKillSwitch toggles the value", async () => {
  const db = new FakeDb({ KILL_SWITCH: "false" });
  await setKillSwitch(db as unknown as D1Database, true);
  assert.equal(await isKillSwitchActive(db as unknown as D1Database), true);
  await setKillSwitch(db as unknown as D1Database, false);
  assert.equal(await isKillSwitchActive(db as unknown as D1Database), false);
});

test("getExecutionMode returns paper by default", async () => {
  const db = new FakeDb();
  assert.equal(await getExecutionMode(db as unknown as D1Database), "paper");
});

test("setExecutionMode changes the mode", async () => {
  const db = new FakeDb({ EXECUTION_MODE: "paper" });
  await setExecutionMode(db as unknown as D1Database, "shadow");
  assert.equal(await getExecutionMode(db as unknown as D1Database), "shadow");
});

test("getSystemConfig returns all config values", async () => {
  const db = new FakeDb({ KILL_SWITCH: "false", EXECUTION_MODE: "shadow" });
  const config = await getSystemConfig(db as unknown as D1Database);
  assert.equal(config.KILL_SWITCH, "false");
  assert.equal(config.EXECUTION_MODE, "shadow");
});

test("getPipelineErrors hides duplicate-open guardrail noise", async () => {
  const db = new FakeDb({}, [
    { id: "guardrail", message: DUPLICATE_OPEN_GUARDRAIL_MESSAGE },
    { id: "real", message: "Scanner failed" },
  ]);

  const errors = await getPipelineErrors(db as unknown as D1Database);
  assert.deepEqual(errors.map(e => e.id), ["real"]);
  assert.equal(await getGuardrailEventCount(db as unknown as D1Database), 1);
});

test("recordShadowOpen inserts a shadow order", async () => {
  const db = new FakeDb();
  const id = await recordShadowOpen(
    db as unknown as D1Database,
    "paper-123", "turtle", "market-1", "test-slug", "Will it rain?",
    "BUY_YES", 0.45, 222.2, 100,
  );

  assert.ok(id);
  assert.equal(db.inserts.length, 1);
  assert.match(db.inserts[0].sql, /INSERT INTO shadow_orders/);
  assert.equal(db.inserts[0].args[1], "paper-123");
  assert.equal(db.inserts[0].args[2], "turtle");
  assert.equal(db.inserts[0].args[7], "BUY");
});

test("recordShadowClose inserts a close shadow order with PnL comparison", async () => {
  const db = new FakeDb();
  const id = await recordShadowClose(
    db as unknown as D1Database,
    "paper-456", "shark", "market-2", "slug-2", "Will BTC hit 100k?",
    "BUY_YES", 0.75, 133.3, 15.5,
  );

  assert.ok(id);
  assert.equal(db.inserts.length, 1);
  assert.match(db.inserts[0].sql, /paper_pnl/);
  assert.equal(db.inserts[0].args[7], "SELL");
});
