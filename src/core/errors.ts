/**
 * The single failure shape that crosses the seam. Adapters map their provider's
 * errors onto it; the router decides whether to retry or fall back from it; the
 * MCP layer renders it as a tool result the calling model can act on.
 */

/**
 * Why a generation failed, in terms every provider can be mapped onto.
 *
 * - `auth_failed` — missing, invalid or unauthorised credentials
 * - `budget_exceeded` — refused locally before any provider was called
 * - `content_filtered` — the provider rejected the prompt or the output
 * - `invalid_request` — the provider rejected the request as malformed
 * - `provider_unavailable` — 5xx, connection failure, model not deployed
 * - `rate_limited` — quota or throughput limit hit
 * - `timeout` — no response within the allotted time
 * - `unknown` — nothing recognisable to map onto; treat as not retryable
 */
export type FailureReason =
  | "auth_failed"
  | "budget_exceeded"
  | "content_filtered"
  | "invalid_request"
  | "provider_unavailable"
  | "rate_limited"
  | "timeout"
  | "unknown";

export interface ImagineErrorOptions extends ErrorOptions {
  /** Whether retrying the same request could plausibly succeed. */
  retryable?: boolean;
  /**
   * Whether the failed attempt still cost money. Drives the cost ledger:
   * an unbilled failure must not count against a budget.
   */
  billed?: boolean;
  /**
   * The HTTP status the provider answered with, when there was one. Carried so
   * that a caller can tell apart two failures the same reason covers — a 401
   * and a 402 are both `auth_failed`, and only one of them is a bad key.
   */
  status?: number;
}

/**
 * Thrown by adapters and by the core. Both flags default to the safe answer:
 * do not retry, and assume nothing was charged unless a provider says it was.
 */
export class ImagineError extends Error {
  override readonly name = "ImagineError";
  readonly reason: FailureReason;
  readonly retryable: boolean;
  readonly billed: boolean;
  readonly status: number | undefined;

  constructor(
    reason: FailureReason,
    message: string,
    options: ImagineErrorOptions = {},
  ) {
    super(message, options);
    this.reason = reason;
    this.retryable = options.retryable ?? false;
    this.billed = options.billed ?? false;
    this.status = options.status;
  }
}

export function isImagineError(value: unknown): value is ImagineError {
  return value instanceof ImagineError;
}
