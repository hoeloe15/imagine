import { describe, expect, it } from "vitest";
import {
  AZURE_STORAGE_SCOPE,
  STORAGE_API_VERSION,
  createBlobSink,
  isoSeconds,
  parseUserDelegationKey,
  signUserDelegationSas,
  userDelegationSasQuery,
  userDelegationStringToSign,
  type SasFields,
  type UserDelegationKey,
} from "../../src/core/blob-sink.js";
import { isImagineError } from "../../src/core/errors.js";

const ACCOUNT_URL = "https://mystorage.blob.core.windows.net";
const CONTAINER = "images";
const FILENAME = "lighthouse-7f3ac91d.png";
const BYTES = new Uint8Array([137, 80, 78, 71]);
const NOW = Date.parse("2026-09-04T12:00:00Z");

const KEY: UserDelegationKey = {
  signedOid: "11111111-1111-1111-1111-111111111111",
  signedTid: "22222222-2222-2222-2222-222222222222",
  signedStart: "2026-09-04T11:55:00Z",
  signedExpiry: "2026-09-05T12:00:00Z",
  signedService: "b",
  signedVersion: "2020-12-06",
  value: Buffer.from("imagine-test-delegation-key").toString("base64"),
};

const FIELDS: SasFields = {
  permissions: "r",
  start: "2026-09-04T11:55:00Z",
  expiry: "2026-09-04T13:00:00Z",
  canonicalizedResource: `/blob/mystorage/${CONTAINER}/${FILENAME}`,
  key: KEY,
  protocol: "https",
  version: "2020-12-06",
  resource: "b",
};

function keyXml(key: UserDelegationKey = KEY): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<UserDelegationKey>",
    `<SignedOid>${key.signedOid}</SignedOid>`,
    `<SignedTid>${key.signedTid}</SignedTid>`,
    `<SignedStart>${key.signedStart}</SignedStart>`,
    `<SignedExpiry>${key.signedExpiry}</SignedExpiry>`,
    `<SignedService>${key.signedService}</SignedService>`,
    `<SignedVersion>${key.signedVersion}</SignedVersion>`,
    `<Value>${key.value}</Value>`,
    "</UserDelegationKey>",
  ].join("");
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A fetch that answers the delegation-key POST from a fixture and every PUT
 * from a queue of statuses, recording what it was asked.
 */
function fakeFetch(uploadStatuses: number[] = [201]) {
  const calls: Call[] = [];
  const remaining = [...uploadStatuses];

  const fetchImpl = (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? Buffer.from(init.body).toString("hex")
          : "";
    calls.push({ url, method: init?.method ?? "GET", headers, body });

    if (url.includes("comp=userdelegationkey")) {
      return Promise.resolve(new Response(keyXml(), { status: 200 }));
    }

    const status = remaining.shift() ?? 201;
    return Promise.resolve(
      status === 201 || status === 200
        ? new Response(null, { status })
        : new Response(`<Error><Code>Whatever</Code></Error>`, { status }),
    );
  };

  return { calls, fetch: fetchImpl as unknown as typeof globalThis.fetch };
}

function sink(fetchImpl: typeof globalThis.fetch) {
  return createBlobSink({
    accountUrl: `${ACCOUNT_URL}/`,
    container: CONTAINER,
    urlTtlHours: 1,
    getAccessToken: () => Promise.resolve("token-value"),
    fetch: fetchImpl,
    now: () => NOW,
  });
}

describe("the string-to-sign", () => {
  it("is the twenty-four fields of service version 2020-12-06, in order", () => {
    expect(userDelegationStringToSign(FIELDS)).toBe(
      [
        "r",
        "2026-09-04T11:55:00Z",
        "2026-09-04T13:00:00Z",
        "/blob/mystorage/images/lighthouse-7f3ac91d.png",
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
        "2026-09-04T11:55:00Z",
        "2026-09-05T12:00:00Z",
        "b",
        "2020-12-06",
        "",
        "",
        "",
        "",
        "https",
        "2020-12-06",
        "b",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ].join("\n"),
    );
  });

  it("keeps every optional field as an empty line", () => {
    expect(userDelegationStringToSign(FIELDS).split("\n")).toHaveLength(24);
  });

  it("signs it with the base64-decoded key value, and the result does not drift", () => {
    expect(signUserDelegationSas(FIELDS)).toBe(
      "JHFYwUQXSBjsutCu0kdOY333LCbe+hMNAQHRSZtEwM4=",
    );
  });

  it("carries every signed field into the query string", () => {
    const query = new URLSearchParams(userDelegationSasQuery(FIELDS));

    expect(Object.fromEntries(query)).toEqual({
      sp: "r",
      st: "2026-09-04T11:55:00Z",
      se: "2026-09-04T13:00:00Z",
      skoid: KEY.signedOid,
      sktid: KEY.signedTid,
      skt: KEY.signedStart,
      ske: KEY.signedExpiry,
      sks: "b",
      skv: "2020-12-06",
      spr: "https",
      sv: "2020-12-06",
      sr: "b",
      sig: "JHFYwUQXSBjsutCu0kdOY333LCbe+hMNAQHRSZtEwM4=",
    });
  });
});

describe("timestamps", () => {
  it("are whole seconds, which is all the service accepts", () => {
    expect(isoSeconds(Date.parse("2026-09-04T12:00:00.123Z"))).toBe(
      "2026-09-04T12:00:00Z",
    );
  });
});

describe("the user delegation key document", () => {
  it("is read element by element", () => {
    expect(parseUserDelegationKey(keyXml())).toEqual(KEY);
  });

  it("is an auth failure when an element the signature needs is missing", () => {
    const broken = keyXml().replace(/<Value>[^<]*<\/Value>/, "");

    expect(() => parseUserDelegationKey(broken)).toThrowError(/Value/);
  });
});

describe("uploading", () => {
  it("PUTs a block blob with the identity's bearer token", async () => {
    const { calls, fetch } = fakeFetch();

    await sink(fetch).put(FILENAME, BYTES, "image/png");

    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toBe(`${ACCOUNT_URL}/${CONTAINER}/${FILENAME}`);
    expect(put?.headers).toMatchObject({
      Authorization: "Bearer token-value",
      "x-ms-version": STORAGE_API_VERSION,
      "x-ms-blob-type": "BlockBlob",
      "x-ms-blob-content-type": "image/png",
      "If-None-Match": "*",
    });
    expect(put?.body).toBe(Buffer.from(BYTES).toString("hex"));
  });

  it("asks for a user delegation key with the documented POST", async () => {
    const { calls, fetch } = fakeFetch();

    await sink(fetch).put(FILENAME, BYTES, "image/png");

    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toBe(`${ACCOUNT_URL}/?restype=service&comp=userdelegationkey`);
    expect(post?.headers["x-ms-version"]).toBe(STORAGE_API_VERSION);
    expect(post?.body).toContain("<KeyInfo>");
    expect(post?.body).toContain("<Start>2026-09-04T11:55:00Z</Start>");
    expect(post?.body).toContain("<Expiry>2026-09-05T12:00:00Z</Expiry>");
  });

  it("answers a bare blob URL as the path and a signed one as the url", async () => {
    const { fetch } = fakeFetch();

    const stored = await sink(fetch).put(FILENAME, BYTES, "image/png");

    expect(stored.path).toBe(`${ACCOUNT_URL}/${CONTAINER}/${FILENAME}`);
    expect(stored.path).not.toContain("sig=");
    expect(stored.url).toContain(`${ACCOUNT_URL}/${CONTAINER}/${FILENAME}?`);

    const query = new URLSearchParams(stored.url?.split("?")[1] ?? "");
    expect(query.get("sr")).toBe("b");
    expect(query.get("sp")).toBe("r");
    expect(query.get("se")).toBe("2026-09-04T13:00:00Z");
    expect(query.get("sig")).not.toBeNull();
  });

  it("reuses the delegation key across uploads", async () => {
    const { calls, fetch } = fakeFetch([201, 201]);
    const blob = sink(fetch);

    await blob.put(FILENAME, BYTES, "image/png");
    await blob.put("other-abcdef12.png", BYTES, "image/png");

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("never overwrites: a taken name becomes -2", async () => {
    const { fetch } = fakeFetch([409, 201]);

    const stored = await sink(fetch).put(FILENAME, BYTES, "image/png");

    expect(stored.path).toBe(`${ACCOUNT_URL}/${CONTAINER}/lighthouse-7f3ac91d-2.png`);
  });
});

describe("failures", () => {
  const cases = [
    { status: 403, reason: "auth_failed", retryable: false },
    { status: 404, reason: "invalid_request", retryable: false },
    { status: 429, reason: "rate_limited", retryable: true },
    { status: 503, reason: "provider_unavailable", retryable: true },
  ] as const;

  for (const { status, reason, retryable } of cases) {
    it(`maps ${status} to ${reason}`, async () => {
      const { fetch } = fakeFetch([status]);

      const failure: unknown = await sink(fetch)
        .put(FILENAME, BYTES, "image/png")
        .catch((cause: unknown) => cause);

      expect(isImagineError(failure)).toBe(true);
      expect(isImagineError(failure) ? failure.reason : "").toBe(reason);
      expect(isImagineError(failure) ? failure.retryable : null).toBe(retryable);
    });
  }

  it("maps an unreachable account to a retryable provider_unavailable", async () => {
    const failing = (() =>
      Promise.reject(new Error("ENOTFOUND"))) as unknown as typeof globalThis.fetch;

    const failure: unknown = await sink(failing)
      .put(FILENAME, BYTES, "image/png")
      .catch((cause: unknown) => cause);

    expect(isImagineError(failure) ? failure.reason : "").toBe("provider_unavailable");
    expect(isImagineError(failure) ? failure.retryable : null).toBe(true);
  });

  it("refuses a plain-HTTP account URL", () => {
    expect(() =>
      createBlobSink({
        accountUrl: "http://mystorage.blob.core.windows.net",
        container: CONTAINER,
        getAccessToken: () => Promise.resolve("t"),
      }),
    ).toThrowError(/not https/);
  });

  it("refuses an empty token rather than sending a bare Bearer", async () => {
    const { fetch } = fakeFetch();
    const blob = createBlobSink({
      accountUrl: ACCOUNT_URL,
      container: CONTAINER,
      getAccessToken: () => Promise.resolve("   "),
      fetch,
      now: () => NOW,
    });

    const failure: unknown = await blob
      .put(FILENAME, BYTES, "image/png")
      .catch((cause: unknown) => cause);

    expect(isImagineError(failure) ? failure.reason : "").toBe("auth_failed");
    expect(isImagineError(failure) ? failure.message : "").toContain(
      AZURE_STORAGE_SCOPE,
    );
  });
});
