import { describe, expect, it } from "vitest";
import {
  clearedCookie,
  cookie,
  csrfToken,
  equal,
  parseCookies,
  readLoginState,
  readSession,
  seal,
  sessionKey,
  unseal,
  type PortalSession,
} from "../../src/portal/session.js";

const key = sessionKey("a-secret-that-is-long-enough-to-be-one");

const session: PortalSession = {
  callerId: "https://issuer.example:user_01",
  subject: "user_01",
  email: "owner@example.com",
  name: "Owner",
  sid: "session_01",
  exp: 2_000,
};

describe("sessionKey", () => {
  it("derives the same key from the same secret and a different one otherwise", () => {
    expect(sessionKey("one").equals(sessionKey("one"))).toBe(true);
    expect(sessionKey("one").equals(sessionKey("two"))).toBe(false);
  });

  it("is random per process when no secret is configured", () => {
    expect(sessionKey(null).equals(sessionKey(null))).toBe(false);
  });
});

describe("seal and unseal", () => {
  it("round-trips a payload", () => {
    expect(unseal(key, seal(key, { hello: "there" }))).toEqual({ hello: "there" });
  });

  it("refuses a payload signed with another key", () => {
    expect(unseal(key, seal(sessionKey("other"), { hello: "there" }))).toBeNull();
  });

  it("refuses a tampered payload", () => {
    const sealed = seal(key, { admin: false });
    const tampered = `${Buffer.from(JSON.stringify({ admin: true }), "utf8").toString(
      "base64url",
    )}.${sealed.slice(sealed.lastIndexOf(".") + 1)}`;
    expect(unseal(key, tampered)).toBeNull();
  });

  it("refuses something that is not a sealed value at all", () => {
    expect(unseal(key, undefined)).toBeNull();
    expect(unseal(key, "")).toBeNull();
    expect(unseal(key, "no-signature")).toBeNull();
  });
});

describe("readSession", () => {
  it("reads back what was sealed", () => {
    expect(readSession(key, seal(key, session), 1_000)).toEqual(session);
  });

  it("refuses an expired session rather than renewing it", () => {
    expect(readSession(key, seal(key, session), 2_000)).toBeNull();
    expect(readSession(key, seal(key, session), 9_999)).toBeNull();
  });

  it("refuses a session with no subject", () => {
    expect(readSession(key, seal(key, { ...session, subject: "" }), 1_000)).toBeNull();
  });
});

describe("readLoginState", () => {
  it("reads back a pending login and refuses a stale one", () => {
    const sealed = seal(key, { state: "s", verifier: "v", exp: 500 });
    expect(readLoginState(key, sealed, 400)).toEqual({
      state: "s",
      verifier: "v",
      exp: 500,
    });
    expect(readLoginState(key, sealed, 500)).toBeNull();
  });
});

describe("csrfToken", () => {
  it("is bound to the session, so one visitor's token is useless in another's form", () => {
    const other = { ...session, callerId: "https://issuer.example:user_02" };
    expect(csrfToken(key, session)).not.toBe(csrfToken(key, other));
    expect(csrfToken(key, session)).toBe(csrfToken(key, { ...session }));
  });
});

describe("equal", () => {
  it("compares without throwing on a length mismatch", () => {
    expect(equal("abc", "abc")).toBe(true);
    expect(equal("abc", "abcd")).toBe(false);
    expect(equal("", "")).toBe(true);
  });
});

describe("cookie", () => {
  it("is HttpOnly, SameSite=Lax and scoped to the portal", () => {
    const header = cookie("n", "v", {
      maxAgeSeconds: 60,
      secure: true,
      path: "/portal",
    });
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/portal");
    expect(header).toContain("Secure");
    expect(header).toContain("Max-Age=60");
  });

  it("omits Secure only when it was told to", () => {
    expect(
      cookie("n", "v", { maxAgeSeconds: 60, secure: false, path: "/portal" }),
    ).not.toContain("Secure");
  });

  it("expires immediately when cleared", () => {
    expect(clearedCookie("n", "/portal", true)).toContain("Max-Age=0");
  });
});

describe("parseCookies", () => {
  it("reads a jar and keeps the first value for a repeated name", () => {
    const jar = parseCookies("a=1; b = 2 ;a=3; broken");
    expect(jar.get("a")).toBe("1");
    expect(jar.get("b")).toBe("2");
    expect(jar.has("broken")).toBe(false);
  });

  it("is empty without a header", () => {
    expect(parseCookies(undefined).size).toBe(0);
  });
});
