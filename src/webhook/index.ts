/**
 * Endpoint request verification for routing-script `mx.http` calls.
 *
 * Routing scripts call tenant-registered endpoints with `mx.http`, and mxRaven
 * signs each call with the endpoint's key. The signature scheme is the one
 * mxRaven used for webhook deliveries, so this entry point is still published
 * as `@mxraven/mail/webhook`. The script decides the request body, so
 * verification stops at the signature: parse the body your endpoint defines.
 *
 * ```ts
 * import { Verifier } from "@mxraven/mail/webhook";
 *
 * const verifier = new Verifier({ secret });
 *
 * export default {
 *   async fetch(request: Request) {
 *     await verifier.verify(request);
 *     const payload = await request.json();
 *     // ...
 *     return new Response(null, { status: 204 });
 *   },
 * };
 * ```
 *
 * The signing secret is shown only once, when the endpoint is created or its
 * secret is rotated. The secret is used as literal key bytes; do not
 * base64-decode it. Map `WebhookError.status` onto the response status: `400`
 * malformed, `401` bad signature, and `413` body too large.
 *
 * An endpoint configured with a stored credential is called with that credential
 * header instead of mxRaven's signature. Those calls carry no `X-MxRaven-*`
 * headers, so {@link Verifier} does not apply; authenticate the credential the
 * endpoint expects.
 *
 * @packageDocumentation
 */

export {
  InvalidSignatureError,
  PayloadTooLargeError,
  WebhookError,
  WebhookRequestError,
} from "./errors.js";
export type { WebhookStatus } from "./errors.js";
export { Verifier, webhookHeaders } from "./verifier.js";
export type { VerifierOptions, VerifyOptions, WebhookRequestParts } from "./verifier.js";
