import { describe, expect, it } from "vitest";

import { parseMessageRef } from "./result.js";

describe("parseMessageRef", () => {
  it.each([
    {
      name: "submission reply",
      message: "2.0.0 accepted; message_ref=86a33087-51ab-40a2-a020-d2745fe08d34",
      expected: "86a33087-51ab-40a2-a020-d2745fe08d34",
    },
    {
      name: "angle bracketed",
      message: "2.0.0 accepted; message_ref=<abc-123>",
      expected: "abc-123",
    },
    {
      name: "trailing semicolon",
      message: "2.0.0 accepted; message_ref=abc; extra",
      expected: "abc",
    },
    { name: "missing", message: "2.0.0 accepted", expected: "" },
    { name: "empty", message: "", expected: "" },
  ])("parses $name", ({ message, expected }) => {
    expect(parseMessageRef(message)).toBe(expected);
  });
});
