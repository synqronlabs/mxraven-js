import { describe, expect, it } from "vitest";

import { SMTPError } from "./errors.js";

describe("SMTPError", () => {
  it("reports permanent failures", () => {
    const error = new SMTPError({ code: 550, enhancedCode: "5.1.1", message: "no such user" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SMTPError");
    expect(error.permanent).toBe(true);
    expect(error.transient).toBe(false);
    expect(error.enhancedCode).toBe("5.1.1");
  });

  it("reports transient failures", () => {
    const error = new SMTPError({ code: 451, message: "try later" });
    expect(error.permanent).toBe(false);
    expect(error.transient).toBe(true);
    expect(error.enhancedCode).toBeUndefined();
  });

  it("treats success codes as neither permanent nor transient", () => {
    const error = new SMTPError({ code: 250, message: "ok" });
    expect(error.permanent).toBe(false);
    expect(error.transient).toBe(false);
  });
});
