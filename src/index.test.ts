import { describe, expect, it } from "vitest";

import { defaultAddressPort, parseAddress, parseAddressList } from "./index.js";
import type { MailboxAddress } from "./index.js";

describe("@mxraven/mail", () => {
  it("exposes the default submission port", () => {
    expect(defaultAddressPort).toBe(587);
  });

  it("exposes address parsing", () => {
    const mailbox: MailboxAddress = parseAddress("Noreply <Noreply@例え.jp>");
    expect(mailbox).toEqual({
      localPart: "Noreply",
      domain: "xn--r8jz45g.jp",
      displayName: "Noreply",
    });
    expect(parseAddressList("a@example.com, b@example.com").map((m) => m.domain)).toEqual([
      "example.com",
      "example.com",
    ]);
  });
});
