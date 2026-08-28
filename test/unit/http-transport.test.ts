import { describe, expect, it } from "vitest";
import {
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  httpRequested,
  httpSettingsFromEnv,
  isOriginAllowed,
} from "../../src/transport/http.js";

describe("httpRequested", () => {
  it("is off by default", () => {
    expect(httpRequested([], {})).toBe(false);
  });

  it("is on for --http", () => {
    expect(httpRequested(["--http"], {})).toBe(true);
  });

  it("is on for IMAGINE_TRANSPORT=http, whatever the case", () => {
    expect(httpRequested([], { IMAGINE_TRANSPORT: "HTTP" })).toBe(true);
    expect(httpRequested([], { IMAGINE_TRANSPORT: "stdio" })).toBe(false);
  });
});

describe("httpSettingsFromEnv", () => {
  it("binds loopback on 3000 with no allowed origins", () => {
    expect(httpSettingsFromEnv({})).toEqual({
      host: DEFAULT_HTTP_HOST,
      port: DEFAULT_HTTP_PORT,
      allowedOrigins: [],
    });
  });

  it("reads host, port and a comma separated origin list", () => {
    expect(
      httpSettingsFromEnv({
        IMAGINE_HTTP_HOST: "0.0.0.0",
        IMAGINE_HTTP_PORT: "8080",
        IMAGINE_HTTP_ALLOWED_ORIGINS: "https://a.example, https://b.example",
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 8080,
      allowedOrigins: ["https://a.example", "https://b.example"],
    });
  });

  it("refuses a port that is not one", () => {
    expect(() => httpSettingsFromEnv({ IMAGINE_HTTP_PORT: "not-a-port" })).toThrow(
      /IMAGINE_HTTP_PORT/,
    );
    expect(() => httpSettingsFromEnv({ IMAGINE_HTTP_PORT: "70000" })).toThrow(/65535/);
  });
});

describe("isOriginAllowed", () => {
  const host = "127.0.0.1:3000";

  it("allows a request that carries no Origin at all", () => {
    expect(isOriginAllowed(undefined, host, [])).toBe(true);
  });

  it("allows its own origin", () => {
    expect(isOriginAllowed("http://127.0.0.1:3000", host, [])).toBe(true);
  });

  it("allows loopback pages on any port", () => {
    expect(isOriginAllowed("http://localhost:5173", host, [])).toBe(true);
    expect(isOriginAllowed("http://[::1]:5173", host, [])).toBe(true);
  });

  it("refuses anything else by default", () => {
    expect(isOriginAllowed("https://evil.example", host, [])).toBe(false);
    expect(isOriginAllowed("http://notlocalhost.example", host, [])).toBe(false);
  });

  it("refuses an unparseable Origin", () => {
    expect(isOriginAllowed("not a url", host, [])).toBe(false);
  });

  it("allows what the operator listed", () => {
    expect(
      isOriginAllowed("https://portal.example", host, ["https://portal.example"]),
    ).toBe(true);
    expect(isOriginAllowed("https://evil.example", host, ["*"])).toBe(true);
  });
});
