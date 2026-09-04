/**
 * The Azure Blob Storage {@link ObjectSink}: the hosted half of ADR 0024.
 *
 * Two REST calls and one HMAC, over plain `fetch` with a managed-identity
 * bearer token — no storage SDK, for the reasons ADR 0022 gives about
 * `@azure/identity` and ADR 0024 repeats for `@azure/storage-blob`.
 *
 * 1. `PUT <account>/<container>/<name>` uploads the bytes.
 * 2. `POST <account>/?restype=service&comp=userdelegationkey` fetches the key
 *    that signs a short-lived read link, which is what a chat client can
 *    actually render.
 *
 * Neither the bearer token nor the delegation key is ever put in a message.
 */

import { createHmac } from "node:crypto";
import { ImagineError } from "./errors.js";
import {
  MAX_COLLISION_ATTEMPTS,
  candidateName,
  type ObjectSink,
  type StoredImage,
} from "./output.js";

export type FetchLike = typeof globalThis.fetch;
export type AccessTokenProvider = () => Promise<string>;

/** What a token for the storage data plane has to be issued for. */
export const AZURE_STORAGE_SCOPE = "https://storage.azure.com/.default";

/**
 * The service version every request declares and every SAS is signed for. The
 * string-to-sign layout below is the one this exact version documents, so the
 * two constants move together or not at all.
 */
export const STORAGE_API_VERSION = "2020-12-06";

/** The service refuses a delegation key more than seven days out. */
const KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Re-fetch this far before the key expires, so a signature never races it. */
const KEY_SLACK_MS = 10 * 60 * 1000;
/** Clock skew allowance on both the key start and the SAS start. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_KEY_TIMEOUT_MS = 10_000;

export interface BlobSinkOptions {
  /** e.g. `https://mystorage.blob.core.windows.net`; a trailing slash is fine. */
  accountUrl: string;
  container: string;
  /** How long a returned link stays valid. Defaults to one hour. */
  urlTtlHours?: number;
  getAccessToken: AccessTokenProvider;
  fetch?: FetchLike;
  now?: () => number;
  uploadTimeoutMs?: number;
  keyTimeoutMs?: number;
}

export interface UserDelegationKey {
  signedOid: string;
  signedTid: string;
  signedStart: string;
  signedExpiry: string;
  signedService: string;
  signedVersion: string;
  value: string;
}

export interface SasFields {
  permissions: string;
  start: string;
  expiry: string;
  canonicalizedResource: string;
  key: UserDelegationKey;
  protocol: string;
  version: string;
  resource: string;
}

/**
 * The string-to-sign for a user delegation SAS at service version 2020-12-06,
 * field for field as `create-user-delegation-sas` documents it. Twenty-four
 * fields, twenty-three newlines, and the optional ones present as empty
 * strings — a missing empty line is a 403 that says nothing useful, which is
 * why a unit test pins this byte for byte.
 */
export function userDelegationStringToSign(fields: SasFields): string {
  return [
    fields.permissions,
    fields.start,
    fields.expiry,
    fields.canonicalizedResource,
    fields.key.signedOid,
    fields.key.signedTid,
    fields.key.signedStart,
    fields.key.signedExpiry,
    fields.key.signedService,
    fields.key.signedVersion,
    "", // saoid
    "", // suoid
    "", // scid
    "", // sip
    fields.protocol,
    fields.version,
    fields.resource,
    "", // signed snapshot time
    "", // ses
    "", // rscc
    "", // rscd
    "", // rsce
    "", // rscl
    "", // rsct
  ].join("\n");
}

/** HMAC-SHA256 over the UTF-8 string-to-sign, keyed by the decoded key value. */
export function signUserDelegationSas(fields: SasFields): string {
  return createHmac("sha256", Buffer.from(fields.key.value, "base64"))
    .update(userDelegationStringToSign(fields), "utf8")
    .digest("base64");
}

/** The SAS query string, in the order the documented example lists it. */
export function userDelegationSasQuery(fields: SasFields): string {
  const query = new URLSearchParams([
    ["sp", fields.permissions],
    ["st", fields.start],
    ["se", fields.expiry],
    ["skoid", fields.key.signedOid],
    ["sktid", fields.key.signedTid],
    ["skt", fields.key.signedStart],
    ["ske", fields.key.signedExpiry],
    ["sks", fields.key.signedService],
    ["skv", fields.key.signedVersion],
    ["spr", fields.protocol],
    ["sv", fields.version],
    ["sr", fields.resource],
    ["sig", signUserDelegationSas(fields)],
  ]);
  return query.toString();
}

/** `2026-09-04T12:00:00Z`: the service rejects sub-second precision here. */
export function isoSeconds(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}

/**
 * The seven elements of a `UserDelegationKey` document. Reaching for an XML
 * parser for a flat, fixed, service-generated shape would be a dependency to
 * read seven strings.
 */
export function parseUserDelegationKey(xml: string): UserDelegationKey {
  const read = (element: string): string => {
    const match = new RegExp(`<${element}>([^<]*)</${element}>`).exec(xml);
    const value = match?.[1];
    if (value === undefined || value === "") {
      throw new ImagineError(
        "auth_failed",
        `The user delegation key Azure Storage returned has no ${element}, so no read link can be signed.`,
      );
    }
    return value;
  };

  return {
    signedOid: read("SignedOid"),
    signedTid: read("SignedTid"),
    signedStart: read("SignedStart"),
    signedExpiry: read("SignedExpiry"),
    signedService: read("SignedService"),
    signedVersion: read("SignedVersion"),
    value: read("Value"),
  };
}

export function createBlobSink(options: BlobSinkOptions): ObjectSink {
  const account = new URL(options.accountUrl);
  if (account.protocol !== "https:") {
    throw new ImagineError(
      "invalid_request",
      `output.blob.account_url is ${options.accountUrl}, which is not https. Image bytes and a read token travel over this URL, so plain HTTP is refused.`,
    );
  }

  const accountName = account.hostname.split(".")[0] ?? "";
  const origin = account.origin;
  const container = options.container;
  const ttlMs = (options.urlTtlHours ?? 1) * 60 * 60 * 1000;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  const keyTimeoutMs = options.keyTimeoutMs ?? DEFAULT_KEY_TIMEOUT_MS;

  let cachedKey: UserDelegationKey | null = null;
  let inFlightKey: Promise<UserDelegationKey> | null = null;

  const blobUrl = (name: string): string =>
    `${origin}/${encodeURIComponent(container)}/${encodeURIComponent(name)}`;

  async function authorization(): Promise<string> {
    const token = await options.getAccessToken();
    if (token.trim() === "") {
      throw new ImagineError(
        "auth_failed",
        `The token provider returned an empty token for ${AZURE_STORAGE_SCOPE}, so nothing can be uploaded to ${origin}.`,
      );
    }
    return `Bearer ${token}`;
  }

  async function fetchDelegationKey(): Promise<UserDelegationKey> {
    const start = isoSeconds(now() - CLOCK_SKEW_MS);
    const expiry = isoSeconds(now() + KEY_LIFETIME_MS);
    const body = `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${start}</Start><Expiry>${expiry}</Expiry></KeyInfo>`;

    const response = await send(
      `${origin}/?restype=service&comp=userdelegationkey`,
      {
        method: "POST",
        headers: {
          Authorization: await authorization(),
          "x-ms-version": STORAGE_API_VERSION,
          "Content-Type": "application/xml",
        },
        body,
        signal: AbortSignal.timeout(keyTimeoutMs),
      },
      `requesting a user delegation key from ${origin}`,
    );

    if (!response.ok) {
      throw storageError(
        response.status,
        await bodyText(response),
        `Azure Storage refused to issue a user delegation key for ${origin}`,
        `The identity needs the Storage Blob Delegator role on the storage account (not only on the container).`,
      );
    }

    return parseUserDelegationKey(await bodyText(response));
  }

  async function delegationKey(): Promise<UserDelegationKey> {
    const current = cachedKey;
    if (current !== null && now() + KEY_SLACK_MS < Date.parse(current.signedExpiry)) {
      return current;
    }

    inFlightKey ??= fetchDelegationKey();
    try {
      const fresh = await inFlightKey;
      cachedKey = fresh;
      return fresh;
    } finally {
      inFlightKey = null;
    }
  }

  async function upload(name: string, bytes: Uint8Array, mimeType: string) {
    return send(
      blobUrl(name),
      {
        method: "PUT",
        headers: {
          Authorization: await authorization(),
          "x-ms-version": STORAGE_API_VERSION,
          "x-ms-blob-type": "BlockBlob",
          "x-ms-blob-content-type": mimeType,
          "Content-Type": mimeType,
          // The blob-level answer to ADR 0006's never-overwrite rule: the
          // service decides, so two concurrent generations cannot both win.
          "If-None-Match": "*",
        },
        body: bytes,
        signal: AbortSignal.timeout(uploadTimeoutMs),
      },
      `uploading the image to ${blobUrl(name)}`,
    );
  }

  async function send(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await fetchImpl(url, init);
    } catch (cause) {
      throw new ImagineError(
        "provider_unavailable",
        `Could not reach Azure Storage while ${what}: ${describe(cause)}`,
        { cause, retryable: true },
      );
    }
  }

  async function readLink(name: string): Promise<string> {
    const key = await delegationKey();
    const startMs = now() - CLOCK_SKEW_MS;
    const expiryMs = Math.min(now() + ttlMs, Date.parse(key.signedExpiry));

    const query = userDelegationSasQuery({
      permissions: "r",
      start: isoSeconds(startMs),
      expiry: isoSeconds(expiryMs),
      canonicalizedResource: `/blob/${accountName}/${container}/${name}`,
      key,
      protocol: "https",
      version: STORAGE_API_VERSION,
      resource: "b",
    });

    return `${blobUrl(name)}?${query}`;
  }

  return {
    async put(filename, bytes, mimeType): Promise<StoredImage> {
      for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt += 1) {
        const name = candidateName(filename, attempt);
        const response = await upload(name, bytes, mimeType);

        if (response.status === 409 || response.status === 412) {
          await bodyText(response);
          continue;
        }

        if (!response.ok) {
          throw storageError(
            response.status,
            await bodyText(response),
            `Azure Storage refused the upload of ${blobUrl(name)}`,
            `The identity needs the Storage Blob Data Contributor role on container "${container}", and the container has to exist — this sink never creates it.`,
          );
        }

        await bodyText(response);
        return { path: blobUrl(name), url: await readLink(name) };
      }

      throw new ImagineError(
        "unknown",
        `No free blob name for ${filename} in ${container} after ${MAX_COLLISION_ATTEMPTS} attempts.`,
      );
    },
  };
}

function storageError(
  status: number,
  body: string,
  what: string,
  hint: string,
): ImagineError {
  const detail = `${what} with status ${status}: ${truncate(body)}`;

  if (status === 401 || status === 403) {
    return new ImagineError("auth_failed", `${detail} ${hint}`);
  }
  if (status === 404) {
    return new ImagineError(
      "invalid_request",
      `${detail} Check output.blob.account_url and output.blob.container.`,
    );
  }
  if (status === 429) {
    return new ImagineError("rate_limited", detail, { retryable: true });
  }
  if (status >= 500) {
    return new ImagineError("provider_unavailable", detail, { retryable: true });
  }
  return new ImagineError("unknown", detail);
}

async function bodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(raw: string, limit = 300): string {
  const trimmed = raw.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
