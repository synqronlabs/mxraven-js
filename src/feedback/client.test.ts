import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { Client, FeedbackError, disposition, type Disposition, type FetchLike } from "./index.js";

interface CapturedRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: string;
}

const encoder = new TextEncoder();

function basicAuth(username: string, secret: string): string {
  return `Basic ${Buffer.from(`${username}:${secret}`, "utf8").toString("base64")}`;
}

const failingFetch: FetchLike = async () => {
  throw new Error("network down");
};

function captureFetch(handler: (request: CapturedRequest) => Response): {
  fetch: FetchLike;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    let body = "";
    if (typeof init?.body === "string") {
      body = init.body;
    } else if (init?.body instanceof Uint8Array) {
      body = new TextDecoder().decode(init.body);
    }
    const request: CapturedRequest = {
      url,
      method: init?.method,
      headers: new Headers(init?.headers),
      body,
    };
    requests.push(request);
    return handler(request);
  };
  return { fetch: fetchImpl, requests };
}

describe("Client options", () => {
  it.each([
    [{ baseUrl: "" }, /base URL/],
    [{ baseUrl: "https://feedback.example.com", username: "user" }, /both/],
    [{ baseUrl: "https://feedback.example.com", secret: "secret" }, /both/],
    [{ baseUrl: "https://feedback.example.com", timeout: 0 }, /timeout/],
  ])("rejects invalid options %#", (options, pattern) => {
    expect(() => new Client(options)).toThrow(pattern);
  });

  it("accepts a base URL without credentials", () => {
    expect(() => new Client({ baseUrl: "https://feedback.example.com" })).not.toThrow();
  });
});

describe("learn", () => {
  const rawMime = "From: a@example.com\r\nSubject: sample\r\n\r\nbody\r\n";
  const username = "mxr_tx_ab12cd34ef56";
  const secret = "supersecret";

  it("submits a spam example with basic auth", async () => {
    const { fetch, requests } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            status: "learned",
            disposition: "spam",
            tenant_id: "t1",
            listener_id: "l1",
            matched_hash_kind: "rendered_eml_sha256",
          }),
        ),
    );
    const client = new Client({ baseUrl: "https://feedback.example.com", username, secret, fetch });

    const result = await client.learnSpam(encoder.encode(rawMime));

    const request = requests[0];
    expect(request?.url).toBe("https://feedback.example.com/v1/feedback/learn/spam");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("Content-Type")).toBe("message/rfc822");
    expect(request?.headers.get("Authorization")).toBe(basicAuth(username, secret));
    expect(request?.body).toBe(rawMime);
    expect(result.status).toBe("learned");
    expect(result.disposition).toBe(disposition.spam);
    expect(result.tenantId).toBe("t1");
    expect(result.listenerId).toBe("l1");
    expect(result.matchedHashKind).toBe("rendered_eml_sha256");
  });

  it("submits a ham example", async () => {
    const { fetch, requests } = captureFetch(
      () => new Response(JSON.stringify({ status: "learned", disposition: "ham" })),
    );
    const client = new Client({ baseUrl: "https://feedback.example.com", username, secret, fetch });

    const result = await client.learnHam(encoder.encode("message"));

    expect(requests[0]?.url).toBe("https://feedback.example.com/v1/feedback/learn/ham");
    expect(result.disposition).toBe(disposition.ham);
  });

  it("returns a FeedbackError for a non-success response", async () => {
    const { fetch } = captureFetch(
      () => new Response(JSON.stringify({ error: "message evidence not found" }), { status: 404 }),
    );
    const client = new Client({ baseUrl: "https://feedback.example.com", username, secret, fetch });

    const error = await client
      .learnSpam(encoder.encode("message"))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FeedbackError);
    const feedbackError = error as FeedbackError;
    expect(feedbackError.statusCode).toBe(404);
    expect(feedbackError.detail).toBe("message evidence not found");
    expect(feedbackError.retryable).toBe(false);
  });

  it("marks 429 and 5xx responses retryable", async () => {
    const { fetch } = captureFetch(
      () => new Response(JSON.stringify({ error: "rate limit exceeded" }), { status: 429 }),
    );
    const client = new Client({ baseUrl: "https://feedback.example.com", username, secret, fetch });

    const error = (await client
      .learnSpam(encoder.encode("message"))
      .catch((e: unknown) => e)) as FeedbackError;
    expect(error).toBeInstanceOf(FeedbackError);
    expect(error.retryable).toBe(true);
  });

  it("requires credentials", async () => {
    const client = new Client({ baseUrl: "https://feedback.example.com" });
    await expect(client.learnSpam(encoder.encode("message"))).rejects.toThrow(/credentials/);
  });

  it("rejects an invalid disposition", async () => {
    const client = new Client({ baseUrl: "https://feedback.example.com", username, secret });
    await expect(client.learn("bogus" as Disposition, encoder.encode("message"))).rejects.toThrow(
      /invalid disposition/,
    );
  });

  it("wraps transport failures", async () => {
    const client = new Client({
      baseUrl: "https://feedback.example.com",
      username,
      secret,
      fetch: failingFetch,
    });
    await expect(client.learnSpam(encoder.encode("message"))).rejects.toThrow(
      /submit learning request/,
    );
  });
});

describe("unsubscribe", () => {
  it("posts the one-click body to the token endpoint", async () => {
    const token = "header.payload.signature";
    const { fetch, requests } = captureFetch(
      () => new Response(JSON.stringify({ status: "unsubscribed" })),
    );
    const client = new Client({ baseUrl: "https://feedback.example.com/", fetch });

    await client.unsubscribe(token);

    const request = requests[0];
    expect(request?.url).toBe(`https://feedback.example.com/v1/feedback/unsubscribe/${token}`);
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(request?.body).toBe("List-Unsubscribe=One-Click");
  });

  it("rejects an empty token", async () => {
    const client = new Client({ baseUrl: "https://feedback.example.com" });
    await expect(client.unsubscribe("  ")).rejects.toThrow(/token is empty/);
  });
});
