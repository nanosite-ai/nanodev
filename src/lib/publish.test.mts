import { describe, expect, it } from "vitest";
import { ApiError } from "./api.mjs";
import { isTerminal, newLogLines, publishErrorMessage, PUBLISH_ERROR, short } from "./publish.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const refused = (code: string) => new ApiError("POST failed (409)", 409, { success: false, code, error: "x" });

describe("publish helpers", () => {
  it("maps every refusal code to a clear message naming the commit when it matters", () => {
    expect(publishErrorMessage(refused(PUBLISH_ERROR.shaNotOnMain), SHA)).toMatch(/0123456 is not on nano-site's main/);
    expect(publishErrorMessage(refused(PUBLISH_ERROR.commitNotFound), SHA)).toMatch(/doesn't have commit 0123456/);
    expect(publishErrorMessage(refused(PUBLISH_ERROR.agentChangeParked), SHA)).toMatch(/agent change/);
    expect(publishErrorMessage(refused(PUBLISH_ERROR.projectBusy), SHA)).toMatch(/busy/);
    expect(publishErrorMessage(refused(PUBLISH_ERROR.planRequired), SHA)).toMatch(/choose a plan/);
    expect(publishErrorMessage(refused(PUBLISH_ERROR.shaUnsupported), SHA)).toMatch(/git isn't enabled/);
  });

  it("leaves unknown errors alone", () => {
    expect(publishErrorMessage(refused("something_else"), SHA)).toBeNull();
    expect(publishErrorMessage(new ApiError("boom", 500, null), SHA)).toBeNull();
    expect(publishErrorMessage(new Error("network"), SHA)).toBeNull();
  });

  it("streams only new log lines and knows when a job is done", () => {
    const logs = [{ at: "t", message: "a" }, { at: "t", message: "b" }];
    expect(newLogLines({ logs }, 0)).toEqual(["a", "b"]);
    expect(newLogLines({ logs }, 1)).toEqual(["b"]);
    expect(newLogLines({ logs }, 2)).toEqual([]);
    expect(isTerminal({ status: "running" })).toBe(false);
    expect(isTerminal({ status: "succeeded" })).toBe(true);
    expect(isTerminal({ status: "failed" })).toBe(true);
    expect(short(SHA)).toBe("0123456");
    expect(short(null)).toBe("?");
  });
});
