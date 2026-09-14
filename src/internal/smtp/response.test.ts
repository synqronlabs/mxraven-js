import { describe, expect, it } from "vitest";

import { SMTPError } from "../../errors.js";
import {
  isIntermediate,
  isPermanent,
  isSuccess,
  isTransient,
  parseEnhancedCode,
  responseError,
} from "./response.js";

describe("parseEnhancedCode", () => {
  it.each([
    ["2.0.0 Ok", "2.0.0"],
    ["5.1.1 User unknown", "5.1.1"],
    ["4.7.0 Try again later", "4.7.0"],
    ["Ok", ""],
    ["", ""],
    ["abc", ""],
    ["2.0 short", ""],
    ["2.0.0", "2.0.0"],
    ["notanum.0.0 test", ""],
    ["2.notanum.0 test", ""],
    ["2.0.notanum test", ""],
    ["12.34.56 large numbers", "12.34.56"],
  ])("parses %j", (input, expected) => {
    expect(parseEnhancedCode(input)).toBe(expected);
  });
});

describe("reply code classification", () => {
  it.each([
    [199, false, false, false, false],
    [200, true, false, false, false],
    [299, true, false, false, false],
    [300, false, true, false, false],
    [399, false, true, false, false],
    [400, false, false, true, false],
    [499, false, false, true, false],
    [500, false, false, false, true],
    [599, false, false, false, true],
    [600, false, false, false, false],
    [100, false, false, false, false],
    [0, false, false, false, false],
  ])("classifies %d", (code, success, intermediate, transient, permanent) => {
    expect(isSuccess(code)).toBe(success);
    expect(isIntermediate(code)).toBe(intermediate);
    expect(isTransient(code)).toBe(transient);
    expect(isPermanent(code)).toBe(permanent);
  });
});

describe("responseError", () => {
  it("returns undefined for a success reply", () => {
    expect(
      responseError({ code: 250, message: "Ok", lines: ["Ok"], enhancedCode: "" }),
    ).toBeUndefined();
  });

  it("returns undefined for an intermediate reply", () => {
    expect(
      responseError({
        code: 354,
        message: "Start input",
        lines: ["Start input"],
        enhancedCode: "",
      }),
    ).toBeUndefined();
  });

  it("returns an SMTPError for a transient reply", () => {
    const error = responseError({
      code: 421,
      message: "Service not available",
      lines: ["Service not available"],
      enhancedCode: "",
    });
    expect(error).toBeInstanceOf(SMTPError);
    expect(error?.code).toBe(421);
    expect(error?.transient).toBe(true);
  });

  it("returns an SMTPError carrying the enhanced code for a permanent reply", () => {
    const error = responseError({
      code: 550,
      message: "Mailbox not found",
      lines: ["Mailbox not found"],
      enhancedCode: "5.1.1",
    });
    expect(error).toBeInstanceOf(SMTPError);
    expect(error?.code).toBe(550);
    expect(error?.enhancedCode).toBe("5.1.1");
    expect(error?.permanent).toBe(true);
  });
});
