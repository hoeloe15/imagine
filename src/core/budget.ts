/**
 * The cost ledger: what each generation cost, what has been spent this session
 * and today, and whether the next request may go ahead.
 *
 * The ledger is the only place spend is counted. Adapters report a cost when
 * their provider gives one; the curated price in `data/models.json` (see
 * `knowledge.ts`) is the fallback, and every record says which of the two it
 * used. Persistence is append-only JSONL at `logging.cost_log`, which doubles
 * as the day accumulator across process restarts. See ADR 0008.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { OnBudgetExceeded } from "./config-schema.js";
import { ImagineError } from "./errors.js";

/** Where a recorded amount came from. */
export type CostSource = "provider" | "estimate" | "unknown";

/** Which limit a decision is about. */
export type BudgetScope = "session" | "day";

/** The `budget` section of the config, as PLAN.md §7 defines it. */
export interface BudgetConfig {
  max_usd_per_session: number | null;
  max_usd_per_day: number | null;
  on_exceed: OnBudgetExceeded;
}

/** One generation as the caller describes it to the ledger. */
export interface CostEntry {
  provider: string;
  model: string;
  /**
   * What the provider said it charged. Preferred over `estimated_cost_usd`
   * whenever it is a number — including `0`, which free models really do report.
   */
  reported_cost_usd?: number | null;
  /** The curated per-image estimate, used only when the provider reports none. */
  estimated_cost_usd?: number | null;
  /**
   * Whether the attempt was charged for. `false` keeps it out of the totals;
   * see {@link recordFailure}, which reads it off an {@link ImagineError}.
   */
  billed?: boolean;
  /** Why the attempt failed, when it did. */
  failure_reason?: string | null;
  prompt?: string;
  image_path?: string | null;
}

/** One line of the JSONL cost log. */
export interface CostRecord {
  timestamp: string;
  /** Local calendar day of `timestamp`, as `YYYY-MM-DD`. */
  day: string;
  session_id: string;
  provider: string;
  model: string;
  /** Zero for an unbilled attempt: nothing was charged, so nothing is counted. */
  cost_usd: number;
  cost_source: CostSource;
  billed: boolean;
  failure_reason: string | null;
  prompt: string | null;
  image_path: string | null;
}

export interface BudgetSnapshot {
  session_spent_usd: number;
  session_limit_usd: number | null;
  day_spent_usd: number;
  day_limit_usd: number | null;
  /** The local day the `day_*` figures are about, as `YYYY-MM-DD`. */
  day: string;
  /** Local midnight at which the daily figure returns to zero. */
  day_resets_at: string;
}

/** The answer to "would this next request exceed the budget?". */
export interface BudgetDecision {
  /** False only when a limit would be exceeded and `on_exceed` is `refuse`. */
  allowed: boolean;
  exceeded: boolean;
  /**
   * The limit this decision is about: the tighter one, by headroom left.
   * `null` only when neither limit is configured.
   */
  scope: BudgetScope | null;
  limit_usd: number | null;
  spent_usd: number;
  estimated_cost_usd: number;
  projected_usd: number;
  on_exceed: OnBudgetExceeded;
  /** Present when a limit would be exceeded: limit, spend, and when it resets. */
  message: string | null;
  snapshot: BudgetSnapshot;
}

export interface CostLedgerOptions {
  budget: BudgetConfig;
  /** The JSONL cost log. `null` or omitted keeps the ledger in memory only. */
  costLog?: string | null;
  /** Defaults to a fresh uuid; a session is one server process (PLAN.md §7). */
  sessionId?: string;
  /** The clock, injectable so tests can cross midnight. */
  now?: () => Date;
}

const USD_PRECISION = 1e6;

/** Slack for binary floating point, far below a hundredth of a cent. */
const EPSILON = 1e-9;

export function roundUsd(amount: number): number {
  return Math.round(amount * USD_PRECISION) / USD_PRECISION;
}

/** The local calendar day of `at`, as `YYYY-MM-DD`. */
export function localDay(at: Date): string {
  const year = String(at.getFullYear()).padStart(4, "0");
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The next local midnight after `at`, when the daily figure resets. */
export function nextLocalMidnight(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, 0, 0, 0, 0);
}

function isUsableAmount(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The amount to record for an entry, and where it came from. A provider figure
 * always wins; the curated estimate is the fallback; an entry with neither is
 * recorded as `unknown` at zero rather than being given an invented price.
 */
export function resolveCost(entry: CostEntry): {
  cost_usd: number;
  cost_source: CostSource;
} {
  if (isUsableAmount(entry.reported_cost_usd)) {
    return { cost_usd: roundUsd(entry.reported_cost_usd), cost_source: "provider" };
  }
  if (isUsableAmount(entry.estimated_cost_usd)) {
    return { cost_usd: roundUsd(entry.estimated_cost_usd), cost_source: "estimate" };
  }
  return { cost_usd: 0, cost_source: "unknown" };
}

function describeReset(scope: BudgetScope, snapshot: BudgetSnapshot): string {
  return scope === "day"
    ? `resets at ${snapshot.day_resets_at}`
    : "resets when the server process restarts";
}

function exceedanceMessage(
  scope: BudgetScope,
  limit: number,
  spent: number,
  estimate: number,
  snapshot: BudgetSnapshot,
): string {
  const noun = scope === "day" ? "daily" : "session";
  return (
    `The ${noun} budget of $${limit} would be exceeded: $${roundUsd(spent)} spent so far, ` +
    `and this request is estimated at $${roundUsd(estimate)} ` +
    `(projected $${roundUsd(spent + estimate)}). It ${describeReset(scope, snapshot)}.`
  );
}

/**
 * Both limits apply and the tighter one wins: when both would be exceeded, the
 * decision names the one with the least headroom left.
 */
export function decide(
  snapshot: BudgetSnapshot,
  estimatedCostUsd: number,
  onExceed: OnBudgetExceeded,
): BudgetDecision {
  const estimate = isUsableAmount(estimatedCostUsd) ? estimatedCostUsd : 0;

  const candidates: { scope: BudgetScope; limit: number; spent: number }[] = [];
  if (snapshot.session_limit_usd !== null) {
    candidates.push({
      scope: "session",
      limit: snapshot.session_limit_usd,
      spent: snapshot.session_spent_usd,
    });
  }
  if (snapshot.day_limit_usd !== null) {
    candidates.push({
      scope: "day",
      limit: snapshot.day_limit_usd,
      spent: snapshot.day_spent_usd,
    });
  }

  const breached = candidates
    .filter(({ limit, spent }) => spent + estimate > limit + EPSILON)
    .sort((a, b) => a.limit - a.spent - (b.limit - b.spent))[0];

  if (breached === undefined) {
    const tightest = candidates.sort(
      (a, b) => a.limit - a.spent - (b.limit - b.spent),
    )[0];
    return {
      allowed: true,
      exceeded: false,
      scope: tightest?.scope ?? null,
      limit_usd: tightest?.limit ?? null,
      spent_usd: tightest?.spent ?? 0,
      estimated_cost_usd: roundUsd(estimate),
      projected_usd: roundUsd((tightest?.spent ?? 0) + estimate),
      on_exceed: onExceed,
      message: null,
      snapshot,
    };
  }

  return {
    allowed: onExceed === "warn",
    exceeded: true,
    scope: breached.scope,
    limit_usd: breached.limit,
    spent_usd: roundUsd(breached.spent),
    estimated_cost_usd: roundUsd(estimate),
    projected_usd: roundUsd(breached.spent + estimate),
    on_exceed: onExceed,
    message: exceedanceMessage(
      breached.scope,
      breached.limit,
      breached.spent,
      estimate,
      snapshot,
    ),
    snapshot,
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isNotFound(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

interface HistoricRecord {
  timestamp: string;
  cost_usd: number;
  billed: boolean;
}

function parseHistoricRecord(line: string): HistoricRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Partial<CostRecord>;
  if (typeof record.timestamp !== "string") return null;
  if (Number.isNaN(Date.parse(record.timestamp))) return null;
  if (!isUsableAmount(record.cost_usd)) return null;

  return {
    timestamp: record.timestamp,
    cost_usd: record.cost_usd,
    billed: record.billed !== false,
  };
}

/**
 * Records what generations cost, keeps the running session and day totals, and
 * answers whether the next request fits inside the configured budgets.
 *
 * A session is one process; the day total also counts spend earlier processes
 * wrote to the same cost log, which is why {@link openCostLedger} exists.
 */
export class CostLedger {
  readonly sessionId: string;
  readonly budget: BudgetConfig;
  readonly costLog: string | null;

  private readonly clock: () => Date;
  private sessionSpend = 0;
  private readonly dailySpend = new Map<string, number>();
  /** Lines of an existing cost log that could not be read as records. */
  private skipped = 0;

  constructor(options: CostLedgerOptions) {
    this.budget = options.budget;
    this.costLog = options.costLog === undefined ? null : options.costLog;
    this.sessionId = options.sessionId ?? randomUUID();
    this.clock = options.now ?? (() => new Date());
  }

  get skippedHistoryLines(): number {
    return this.skipped;
  }

  /** Spend recorded by this process. Never includes history from the log. */
  spentThisSession(): number {
    return roundUsd(this.sessionSpend);
  }

  /** Spend on the local calendar day of `at`, history included. */
  spentOnDay(at: Date = this.clock()): number {
    return roundUsd(this.dailySpend.get(localDay(at)) ?? 0);
  }

  snapshot(at: Date = this.clock()): BudgetSnapshot {
    return {
      session_spent_usd: this.spentThisSession(),
      session_limit_usd: this.budget.max_usd_per_session,
      day_spent_usd: this.spentOnDay(at),
      day_limit_usd: this.budget.max_usd_per_day,
      day: localDay(at),
      day_resets_at: nextLocalMidnight(at).toISOString(),
    };
  }

  /** Would a request estimated at `estimatedCostUsd` exceed a budget? */
  check(estimatedCostUsd: number, at: Date = this.clock()): BudgetDecision {
    return decide(this.snapshot(at), estimatedCostUsd, this.budget.on_exceed);
  }

  /**
   * {@link check}, but `on_exceed: "refuse"` throws instead of returning. The
   * returned decision still carries `exceeded` and a `message` under `warn`, so
   * the caller can flag it in the response.
   */
  authorise(estimatedCostUsd: number, at: Date = this.clock()): BudgetDecision {
    const decision = this.check(estimatedCostUsd, at);
    if (!decision.allowed) {
      throw new ImagineError(
        "budget_exceeded",
        decision.message ?? "Budget exceeded.",
        {
          retryable: false,
          billed: false,
        },
      );
    }
    return decision;
  }

  /** Records a generation and appends it to the cost log. */
  async record(entry: CostEntry, at: Date = this.clock()): Promise<CostRecord> {
    const billed = entry.billed ?? true;
    const { cost_usd, cost_source } = resolveCost(entry);

    const record: CostRecord = {
      timestamp: at.toISOString(),
      day: localDay(at),
      session_id: this.sessionId,
      provider: entry.provider,
      model: entry.model,
      cost_usd: billed ? cost_usd : 0,
      cost_source,
      billed,
      failure_reason: entry.failure_reason ?? null,
      prompt: entry.prompt ?? null,
      image_path: entry.image_path ?? null,
    };

    this.accumulate(record.cost_usd, record.billed, at);
    await this.append(record);
    return record;
  }

  /**
   * Records a failed attempt. Whether it counts against the budget comes from
   * the error's `billed` flag, which defaults to "assume nothing was charged".
   */
  async recordFailure(
    entry: CostEntry,
    error: ImagineError,
    at: Date = this.clock(),
  ): Promise<CostRecord> {
    return this.record(
      {
        ...entry,
        billed: entry.billed ?? error.billed,
        failure_reason: entry.failure_reason ?? error.reason,
      },
      at,
    );
  }

  /** Sums the billed records already in the cost log into the day totals. */
  async loadHistory(): Promise<void> {
    if (this.costLog === null) return;

    let raw: string;
    try {
      raw = await readFile(path.resolve(this.costLog), "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return;
      throw new ImagineError(
        "invalid_request",
        `Could not read the cost log at ${this.costLog} (${describe(cause)})`,
        { cause },
      );
    }

    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const record = parseHistoricRecord(line);
      if (record === null) {
        this.skipped += 1;
        continue;
      }
      if (!record.billed) continue;
      this.accumulateDay(record.cost_usd, new Date(record.timestamp));
    }
  }

  private accumulate(amount: number, billed: boolean, at: Date): void {
    if (!billed || amount === 0) return;
    this.sessionSpend += amount;
    this.accumulateDay(amount, at);
  }

  private accumulateDay(amount: number, at: Date): void {
    const day = localDay(at);
    this.dailySpend.set(day, (this.dailySpend.get(day) ?? 0) + amount);
  }

  private async append(record: CostRecord): Promise<void> {
    if (this.costLog === null) return;

    const target = path.resolve(this.costLog);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await appendFile(target, `${JSON.stringify(record)}\n`, "utf8");
    } catch (cause) {
      throw new ImagineError(
        "unknown",
        `The $${record.cost_usd} for ${record.model} was counted against the budget, ` +
          `but appending it to the cost log ${target} failed (${describe(cause)})`,
        { cause },
      );
    }
  }
}

/**
 * A ledger whose day total already includes what earlier processes wrote to the
 * same cost log. This is the constructor the server should use.
 */
export async function openCostLedger(options: CostLedgerOptions): Promise<CostLedger> {
  const ledger = new CostLedger(options);
  await ledger.loadHistory();
  return ledger;
}
