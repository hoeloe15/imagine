import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CostLedger,
  localDay,
  nextLocalMidnight,
  openCostLedger,
  resolveCost,
  roundUsd,
  type BudgetConfig,
  type CostRecord,
} from "../../src/core/budget.js";
import { ImagineError } from "../../src/core/errors.js";

const MORNING = new Date(2026, 7, 26, 9, 0, 0);
const LATE = new Date(2026, 7, 26, 23, 59, 0);
const NEXT_DAY = new Date(2026, 7, 27, 0, 1, 0);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "imagine-budget-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function budget(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    max_usd_per_session: 5,
    max_usd_per_day: 10,
    on_exceed: "refuse",
    ...overrides,
  };
}

function ledger(
  overrides: {
    budget?: Partial<BudgetConfig>;
    costLog?: string | null;
    now?: () => Date;
  } = {},
): CostLedger {
  return new CostLedger({
    budget: budget(overrides.budget),
    costLog: overrides.costLog === undefined ? null : overrides.costLog,
    now: overrides.now ?? (() => MORNING),
  });
}

function generation(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openrouter",
    model: "google/gemini-3.1-flash-image",
    reported_cost_usd: 0.039,
    ...overrides,
  };
}

async function logLines(file: string): Promise<CostRecord[]> {
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as CostRecord);
}

describe("resolveCost", () => {
  it("prefers the provider-reported cost over the curated estimate", () => {
    expect(
      resolveCost({
        provider: "openrouter",
        model: "m",
        reported_cost_usd: 0.039,
        estimated_cost_usd: 0.19,
      }),
    ).toEqual({ cost_usd: 0.039, cost_source: "provider" });
  });

  it("treats a reported zero as a real price, not as a missing one", () => {
    expect(
      resolveCost({
        provider: "openrouter",
        model: "m",
        reported_cost_usd: 0,
        estimated_cost_usd: 0.19,
      }),
    ).toEqual({ cost_usd: 0, cost_source: "provider" });
  });

  it("falls back to the estimate when the provider reports nothing", () => {
    expect(
      resolveCost({
        provider: "azure",
        model: "gpt-image-2",
        reported_cost_usd: null,
        estimated_cost_usd: 0.19,
      }),
    ).toEqual({ cost_usd: 0.19, cost_source: "estimate" });
  });

  it("records an uncurated model as unknown rather than inventing a price", () => {
    expect(resolveCost({ provider: "azure", model: "mystery" })).toEqual({
      cost_usd: 0,
      cost_source: "unknown",
    });
  });
});

describe("day boundaries", () => {
  it("keys a day by the local calendar date", () => {
    expect(localDay(MORNING)).toBe("2026-08-26");
    expect(localDay(LATE)).toBe("2026-08-26");
    expect(localDay(NEXT_DAY)).toBe("2026-08-27");
  });

  it("resets at the next local midnight", () => {
    expect(nextLocalMidnight(LATE).getTime()).toBe(new Date(2026, 7, 27).getTime());
  });
});

describe("accumulation", () => {
  it("adds up billed generations for the session and the day", async () => {
    const subject = ledger();

    await subject.record(generation());
    await subject.record(
      generation({ reported_cost_usd: null, estimated_cost_usd: 0.19 }),
    );

    expect(subject.spentThisSession()).toBe(0.229);
    expect(subject.spentOnDay(MORNING)).toBe(0.229);
    expect(subject.snapshot(MORNING)).toMatchObject({
      session_spent_usd: 0.229,
      session_limit_usd: 5,
      day_spent_usd: 0.229,
      day_limit_usd: 10,
      day: "2026-08-26",
    });
  });

  it("does not carry yesterday's spend into today", async () => {
    let now = LATE;
    const subject = ledger({ now: () => now });

    await subject.record(generation({ reported_cost_usd: 2 }));
    now = NEXT_DAY;
    await subject.record(generation({ reported_cost_usd: 0.5 }));

    expect(subject.spentOnDay(LATE)).toBe(2);
    expect(subject.spentOnDay(NEXT_DAY)).toBe(0.5);
    expect(subject.spentThisSession()).toBe(2.5);
  });

  it("keeps floating point noise out of the totals", async () => {
    const subject = ledger();
    for (let i = 0; i < 3; i += 1)
      await subject.record(generation({ reported_cost_usd: 0.1 }));
    expect(subject.spentThisSession()).toBe(0.3);
  });
});

describe("unbilled failures", () => {
  it("does not count an unbilled failure against the budget", async () => {
    const subject = ledger();
    const error = new ImagineError("content_filtered", "rejected");

    const record = await subject.recordFailure(
      generation({ estimated_cost_usd: 0.19, reported_cost_usd: null }),
      error,
    );

    expect(record).toMatchObject({
      cost_usd: 0,
      billed: false,
      failure_reason: "content_filtered",
    });
    expect(subject.spentThisSession()).toBe(0);
    expect(subject.spentOnDay(MORNING)).toBe(0);
  });

  it("counts a failure the provider did charge for", async () => {
    const subject = ledger();
    const error = new ImagineError("timeout", "no response", { billed: true });

    await subject.recordFailure(generation({ reported_cost_usd: 0.039 }), error);

    expect(subject.spentThisSession()).toBe(0.039);
  });

  it("still writes the unbilled attempt to the cost log", async () => {
    const file = path.join(dir, "costs.jsonl");
    const subject = ledger({ costLog: file });

    await subject.recordFailure(
      generation(),
      new ImagineError("rate_limited", "slow down"),
    );

    const lines = await logLines(file);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ billed: false, failure_reason: "rate_limited" });
  });
});

describe("limits", () => {
  it("allows a request that exactly reaches the limit", async () => {
    const subject = ledger({
      budget: { max_usd_per_session: 1, max_usd_per_day: null },
    });
    await subject.record(generation({ reported_cost_usd: 0.9 }));

    const decision = subject.check(0.1);
    expect(decision).toMatchObject({
      allowed: true,
      exceeded: false,
      projected_usd: 1,
    });
  });

  it("refuses when the session limit would be exceeded", async () => {
    const subject = ledger({
      budget: { max_usd_per_session: 1, max_usd_per_day: 100 },
    });
    await subject.record(generation({ reported_cost_usd: 0.95 }));

    const decision = subject.check(0.1);
    expect(decision).toMatchObject({
      allowed: false,
      exceeded: true,
      scope: "session",
      limit_usd: 1,
      spent_usd: 0.95,
      projected_usd: 1.05,
    });
    expect(decision.message).toContain("session budget");
    expect(decision.message).toContain("restarts");
  });

  it("refuses when the daily limit would be exceeded", async () => {
    const subject = ledger({
      budget: { max_usd_per_session: 100, max_usd_per_day: 1 },
    });
    await subject.record(generation({ reported_cost_usd: 0.95 }));

    const decision = subject.check(0.1);
    expect(decision).toMatchObject({ exceeded: true, scope: "day", limit_usd: 1 });
    expect(decision.message).toContain("daily budget");
    expect(decision.message).toContain(nextLocalMidnight(MORNING).toISOString());
  });

  it("lets the tighter limit win when both would be exceeded", async () => {
    const subject = ledger({ budget: { max_usd_per_session: 2, max_usd_per_day: 3 } });
    await subject.record(generation({ reported_cost_usd: 1.9 }));

    expect(subject.check(1.5)).toMatchObject({ exceeded: true, scope: "session" });
  });

  it("never refuses when neither limit is configured", async () => {
    const subject = ledger({
      budget: { max_usd_per_session: null, max_usd_per_day: null },
    });
    await subject.record(generation({ reported_cost_usd: 500 }));

    expect(subject.check(500)).toMatchObject({
      allowed: true,
      exceeded: false,
      scope: null,
      limit_usd: null,
    });
  });
});

describe("on_exceed", () => {
  it("throws a budget_exceeded ImagineError on refuse", async () => {
    const subject = ledger({ budget: { max_usd_per_session: 1, on_exceed: "refuse" } });
    await subject.record(generation({ reported_cost_usd: 0.95 }));

    try {
      subject.authorise(0.1);
      expect.unreachable("authorise should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ImagineError);
      const imagine = error as ImagineError;
      expect(imagine.reason).toBe("budget_exceeded");
      expect(imagine.billed).toBe(false);
      expect(imagine.retryable).toBe(false);
      expect(imagine.message).toContain("$1");
      expect(imagine.message).toContain("$0.95");
    }
  });

  it("proceeds but flags it on warn", async () => {
    const subject = ledger({ budget: { max_usd_per_session: 1, on_exceed: "warn" } });
    await subject.record(generation({ reported_cost_usd: 0.95 }));

    const decision = subject.authorise(0.1);
    expect(decision.allowed).toBe(true);
    expect(decision.exceeded).toBe(true);
    expect(decision.message).not.toBeNull();
  });

  it("returns a decision with no message when nothing is exceeded", () => {
    expect(ledger().authorise(0.1).message).toBeNull();
  });
});

describe("the cost log", () => {
  it("appends one JSONL record per generation, naming the cost source", async () => {
    const file = path.join(dir, "nested", "costs.jsonl");
    const subject = ledger({ costLog: file });

    await subject.record(
      generation({ prompt: "a distribution network", image_path: "/tmp/a.png" }),
    );
    await subject.record(
      generation({ reported_cost_usd: null, estimated_cost_usd: 0.19 }),
    );

    const lines = await logLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      day: "2026-08-26",
      session_id: subject.sessionId,
      provider: "openrouter",
      cost_usd: 0.039,
      cost_source: "provider",
      billed: true,
      prompt: "a distribution network",
      image_path: "/tmp/a.png",
    });
    expect(lines[1]).toMatchObject({ cost_usd: 0.19, cost_source: "estimate" });
  });

  it("counts today's history from an existing log but not as session spend", async () => {
    const file = path.join(dir, "costs.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          timestamp: MORNING.toISOString(),
          cost_usd: 1.5,
          billed: true,
        }),
        JSON.stringify({
          timestamp: new Date(2026, 7, 25, 12).toISOString(),
          cost_usd: 4,
          billed: true,
        }),
        JSON.stringify({
          timestamp: MORNING.toISOString(),
          cost_usd: 9,
          billed: false,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const subject = await openCostLedger({
      budget: budget(),
      costLog: file,
      now: () => MORNING,
    });

    expect(subject.spentOnDay(MORNING)).toBe(1.5);
    expect(subject.spentThisSession()).toBe(0);

    await subject.record(generation({ reported_cost_usd: 0.5 }));
    expect(subject.spentOnDay(MORNING)).toBe(2);
    expect(subject.spentThisSession()).toBe(0.5);
  });

  it("enforces the daily limit against history from an earlier process", async () => {
    const file = path.join(dir, "costs.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        timestamp: MORNING.toISOString(),
        cost_usd: 9.95,
        billed: true,
      }) + "\n",
      "utf8",
    );

    const subject = await openCostLedger({
      budget: budget(),
      costLog: file,
      now: () => MORNING,
    });

    expect(subject.check(0.1)).toMatchObject({ exceeded: true, scope: "day" });
  });

  it("skips unreadable lines instead of refusing to start", async () => {
    const file = path.join(dir, "costs.jsonl");
    await writeFile(
      file,
      [
        "not json",
        JSON.stringify({ cost_usd: 1 }),
        "",
        JSON.stringify({
          timestamp: MORNING.toISOString(),
          cost_usd: 0.25,
          billed: true,
        }),
      ].join("\n"),
      "utf8",
    );

    const subject = await openCostLedger({
      budget: budget(),
      costLog: file,
      now: () => MORNING,
    });

    expect(subject.skippedHistoryLines).toBe(2);
    expect(subject.spentOnDay(MORNING)).toBe(0.25);
  });

  it("treats a missing cost log as an empty one", async () => {
    const subject = await openCostLedger({
      budget: budget(),
      costLog: path.join(dir, "does-not-exist", "costs.jsonl"),
      now: () => MORNING,
    });

    expect(subject.spentOnDay(MORNING)).toBe(0);
  });

  it("keeps the ledger in memory when no cost log is configured", async () => {
    const subject = ledger({ costLog: null });
    await subject.record(generation());
    expect(subject.spentThisSession()).toBe(0.039);
  });
});

describe("roundUsd", () => {
  it("rounds to a millionth of a dollar", () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
    expect(roundUsd(0.1234564999)).toBe(0.123456);
  });
});
