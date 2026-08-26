import { describe, expect, it } from "vitest";
import { ImagineError, isImagineError } from "../../src/core/errors.js";

describe("ImagineError", () => {
  it("defaults to not retryable and not billed", () => {
    const error = new ImagineError("unknown", "something went wrong");

    expect(error.retryable).toBe(false);
    expect(error.billed).toBe(false);
  });

  it("carries reason, message and flags", () => {
    const error = new ImagineError("rate_limited", "Slow down.", {
      retryable: true,
      billed: false,
    });

    expect(error.reason).toBe("rate_limited");
    expect(error.message).toBe("Slow down.");
    expect(error.retryable).toBe(true);
  });

  it("keeps a billed failure billed", () => {
    const error = new ImagineError("content_filtered", "Rejected.", {
      billed: true,
    });

    expect(error.billed).toBe(true);
  });

  it("is an Error with a stable name and preserved cause", () => {
    const cause = new Error("socket hang up");
    const error = new ImagineError("timeout", "Provider timed out.", { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ImagineError");
    expect(error.cause).toBe(cause);
  });

  it("is recognised by isImagineError, unlike a plain Error", () => {
    expect(isImagineError(new ImagineError("auth_failed", "No key."))).toBe(true);
    expect(isImagineError(new Error("No key."))).toBe(false);
    expect(isImagineError({ reason: "auth_failed" })).toBe(false);
  });
});
