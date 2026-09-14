import { describe, expect, it } from "vitest";

import { defaultAddressPort } from "./index.js";

describe("@mxraven/mail", () => {
  it("exposes the default submission port", () => {
    expect(defaultAddressPort).toBe(587);
  });
});
