/**
 * One line per write, saying who did what to which *name*.
 *
 * Two destinations, both deliberate. Standard error is the one that matters
 * hosted: the container's log stream is shipped to Log Analytics and therefore
 * survives the revision that empties the filesystem. **That is a stopgap, and
 * it is written down as one** — when the durable store of slice 3 lands, these
 * records move there with a `type` field beside the cost records, so there is
 * one place to answer "who changed what". The JSONL file beside the cost log is
 * the local half, and is skipped when there is no cost log to sit beside.
 *
 * A secret value never reaches either. The record holds the caller, the action,
 * the secret's name and the outcome, and there is no field a value could go in.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const AUDIT_LOG_NAME = "audit.jsonl";

export type AuditAction = "secret.set" | "secret.clear";

export interface AuditRecord {
  type: "audit";
  timestamp: string;
  caller_id: string;
  action: AuditAction;
  /** The provider the action was about. */
  target: string;
  /** The *name* of the secret written, never its value. */
  secret_name: string;
  outcome: "ok" | "failed";
  /** Present only on a failure, and never the value that failed to write. */
  detail?: string;
}

export interface AuditLog {
  write(record: AuditRecord): Promise<void>;
}

export interface AuditLogOptions {
  /** The cost log; the audit file is written beside it. `null` skips the file. */
  costLog?: string | null;
  log?: (line: string) => void;
  now?: () => Date;
}

export function auditFileFor(costLog: string | null | undefined): string | null {
  return costLog === null || costLog === undefined
    ? null
    : path.join(path.dirname(path.resolve(costLog)), AUDIT_LOG_NAME);
}

export function createAuditLog(options: AuditLogOptions = {}): AuditLog {
  const file = auditFileFor(options.costLog);
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));

  return {
    async write(record: AuditRecord): Promise<void> {
      const line = JSON.stringify(record);
      log(`imagine audit: ${line}`);

      if (file === null) return;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, `${line}\n`, "utf8");
      } catch (cause) {
        // The write itself already happened and was already logged; failing the
        // request now would tell the owner the key did not land when it did.
        log(
          `imagine audit: could not append to ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    },
  };
}

export function auditRecord(
  fields: Omit<AuditRecord, "type" | "timestamp">,
  at: Date = new Date(),
): AuditRecord {
  return { type: "audit", timestamp: at.toISOString(), ...fields };
}
