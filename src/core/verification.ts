/**
 * "Does this credential actually work?" — asked once, cheaply, on demand.
 *
 * A verification is a side-effect-free call an adapter can make for free: the
 * model list, or a metadata read that needs the same permission a generation
 * would. It never generates an image, so it never costs anything.
 *
 * Two rules hold everywhere in this file and in every adapter's `verify`:
 *
 * 1. **No credential ever reaches a summary.** The sentence shown on the page
 *    and stored on disk is derived from a status code and a
 *    {@link FailureReason}, never from the provider's response body — a body
 *    can echo back what was sent, and a summary is rendered and persisted.
 * 2. **The record is a stopgap.** `verifications.json` lives beside the cost
 *    log for the same reason `audit.jsonl` does, and moves into the durable
 *    store when #45/#17 land. See ADR 0028.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isImagineError, type FailureReason } from "./errors.js";
import type { ImageProvider, VerificationResult } from "../providers/types.js";

export const VERIFICATION_FILE_NAME = "verifications.json";

/** The last verification of one provider, as it is stored and reported. */
export interface LastVerification {
  /** When the check ran, ISO-8601. */
  at: string;
  ok: boolean;
  /** One line, already safe to show: never a key, never a provider body. */
  summary: string;
  /** Why it failed, in the vocabulary the router already speaks. */
  reason: FailureReason | null;
}

export interface VerificationStore {
  get(providerId: string): Promise<LastVerification | null>;
  all(): Promise<Record<string, LastVerification>>;
  record(providerId: string, entry: LastVerification): Promise<void>;
  /**
   * Drop what is remembered about a provider. A stored key that has just been
   * replaced or deleted is not the key the last verification tested, and a
   * stamp that vouches for a credential nobody is using any more is worse than
   * no stamp at all.
   */
  forget(providerId: string): Promise<void>;
}

export interface VerificationStoreOptions {
  /** The cost log; the record is written beside it. `null` keeps it in memory. */
  costLog?: string | null;
  log?: (line: string) => void;
}

export function verificationFileFor(costLog: string | null | undefined): string | null {
  return costLog === null || costLog === undefined
    ? null
    : path.join(path.dirname(path.resolve(costLog)), VERIFICATION_FILE_NAME);
}

/**
 * Memory first, file second. The in-memory copy is what makes a verification
 * visible to `list_capabilities` on this replica the moment the portal records
 * it, and what keeps the whole feature working when there is no cost log to sit
 * beside. Every filesystem failure is logged and swallowed: a verification that
 * could not be written down still happened, and failing the request would say
 * the opposite.
 */
export function createVerificationStore(
  options: VerificationStoreOptions = {},
): VerificationStore {
  const file = verificationFileFor(options.costLog);
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const memory = new Map<string, LastVerification>();
  const forgotten = new Set<string>();

  async function fromFile(): Promise<Record<string, LastVerification>> {
    if (file === null) return {};
    try {
      return parseVerifications(await readFile(file, "utf8"));
    } catch {
      return {};
    }
  }

  async function all(): Promise<Record<string, LastVerification>> {
    const merged = { ...(await fromFile()), ...Object.fromEntries(memory) };
    for (const id of forgotten) delete merged[id];
    return merged;
  }

  async function save(): Promise<void> {
    if (file === null) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(await all(), null, 2)}\n`, "utf8");
    } catch (cause) {
      log(
        `imagine: could not write ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  return {
    all,

    async get(providerId: string): Promise<LastVerification | null> {
      if (forgotten.has(providerId)) return null;
      return memory.get(providerId) ?? (await fromFile())[providerId] ?? null;
    },

    async record(providerId: string, entry: LastVerification): Promise<void> {
      forgotten.delete(providerId);
      memory.set(providerId, entry);
      await save();
    },

    async forget(providerId: string): Promise<void> {
      memory.delete(providerId);
      forgotten.add(providerId);
      await save();
    },
  };
}

export function parseVerifications(raw: string): Record<string, LastVerification> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const entries = Object.entries(parsed as Record<string, unknown>).flatMap(
    ([id, value]) => {
      const entry = asVerification(value);
      return entry === null ? [] : [[id, entry] as const];
    },
  );
  return Object.fromEntries(entries);
}

function asVerification(value: unknown): LastVerification | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const at = record["at"];
  const ok = record["ok"];
  const summary = record["summary"];
  if (
    typeof at !== "string" ||
    typeof ok !== "boolean" ||
    typeof summary !== "string"
  ) {
    return null;
  }
  const reason = record["reason"];
  return {
    at,
    ok,
    summary,
    reason: typeof reason === "string" ? (reason as FailureReason) : null,
  };
}

/**
 * The verification of one provider: whatever the adapter offers, and otherwise
 * its model list — which is a free `GET` for every adapter that has one, and is
 * refused with the provider's own status when the credential is wrong.
 */
export async function verifyProvider(
  provider: ImageProvider,
): Promise<VerificationResult> {
  try {
    if (provider.verify !== undefined) return await provider.verify();
    const models = await provider.listModels();
    return { ok: true, summary: `${countOf(models.length, "model")} visible` };
  } catch (cause) {
    return failureFrom(cause);
  }
}

/** An `ImagineError` as a verification outcome, with nothing of the body in it. */
export function failureFrom(cause: unknown): VerificationResult {
  if (isImagineError(cause)) {
    return {
      ok: false,
      reason: cause.reason,
      summary: describeFailure(cause.reason, cause.status),
    };
  }
  return { ok: false, reason: "unknown", summary: "the check could not be completed" };
}

const REASON_PHRASES: Record<FailureReason, string> = {
  auth_failed: "the credential was refused",
  budget_exceeded: "the local budget refused the call",
  content_filtered: "the provider refused the request",
  invalid_request: "the provider rejected the request",
  provider_unavailable: "the provider could not be reached",
  rate_limited: "rate limited",
  timeout: "no answer in time",
  unknown: "the check could not be completed",
};

/**
 * The one sentence a person reads. Derived from the status and the reason and
 * from nothing else, so it cannot carry a fragment of what was sent.
 */
export function describeFailure(reason: FailureReason, status?: number): string {
  if (status === 401) return "invalid key (401)";
  if (status === 402) return "no credits (402)";
  if (status === 403) return "not authorised for this resource (403)";
  if (status === 404) return "not found on this endpoint (404)";
  if (status === 429) return "rate limited (429)";
  const phrase = REASON_PHRASES[reason];
  return status === undefined ? phrase : `${phrase} (${status})`;
}

export function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
