/**
 * Routing-script outcome shapes carried by accepted notifications.
 */

/**
 * The terminal action a routing script resolved for a listener context.
 *
 * Values are the mxRaven worker enum names. Every accepted event carries one,
 * including when the listener-type default applied.
 *
 * @public
 */
export const terminalAction = {
  /** The server did not record a terminal action. */
  unspecified: "TERMINAL_ACTION_TYPE_UNSPECIFIED",
  /** Deliver through a dedicated IP pool. */
  deliverDedicated: "TERMINAL_ACTION_TYPE_DELIVER_DEDICATED",
  /** Relay through the configured smarthost. */
  smarthostRelay: "TERMINAL_ACTION_TYPE_SMARTHOST_RELAY",
  /**
   * Deliver to a webhook endpoint.
   *
   * @deprecated `DELIVER_WEBHOOK` was removed with webhook delivery. The value
   * is retained because the wire enum keeps it for compatibility.
   */
  deliverWebhook: "TERMINAL_ACTION_TYPE_DELIVER_WEBHOOK",
  /** Forward the message to an SMTP destination. */
  smtpForward: "TERMINAL_ACTION_TYPE_SMTP_FORWARD",
  /** Relay the message to another MX. */
  relay: "TERMINAL_ACTION_TYPE_RELAY",
  /** Store the message in object storage. */
  s3Store: "TERMINAL_ACTION_TYPE_S3_STORE",
  /** Send an automatic reply. */
  autoReply: "TERMINAL_ACTION_TYPE_AUTO_REPLY",
  /** Accept and discard the message. */
  drop: "TERMINAL_ACTION_TYPE_DROP",
  /** Reject the message. */
  reject: "TERMINAL_ACTION_TYPE_REJECT",
  /** Deliver the message normally. */
  deliver: "TERMINAL_ACTION_TYPE_DELIVER",
  /** Handle a DSN at an SRS return address. */
  srsReturn: "TERMINAL_ACTION_TYPE_SRS_RETURN",
  /** Generate a local DSN. */
  localDsn: "TERMINAL_ACTION_TYPE_LOCAL_DSN",
} as const;

/** The terminal action a routing script resolved for a listener context. @public */
export type TerminalAction = (typeof terminalAction)[keyof typeof terminalAction];

/**
 * The kind of effect a routing script staged.
 *
 * Values are the routing script's own effect names. The first three edit a
 * header, `recipients.add` adds an envelope recipient, the next two are
 * side-effect egress tasks, and the rest are terminal.
 *
 * @public
 */
export const routingIntentKind = {
  /** Set a header to a single value. */
  headerSet: "header.set",
  /** Append a header occurrence. */
  headerAppend: "header.append",
  /** Remove every occurrence of a header. */
  headerRemove: "header.remove",
  /** Add an envelope recipient. Submission listeners only. */
  recipientAdd: "recipients.add",
  /** Archive the message to object storage. MTA listeners only. */
  archiveS3: "archive.s3",
  /** Send a copy to an SMTP forward destination. MTA listeners only. */
  forwardSmtp: "forward.smtp",
  /** Deliver through the platform shared pool. */
  deliverShared: "deliver.shared",
  /** Deliver through a dedicated IP pool. */
  deliverDedicated: "deliver.dedicated",
  /** Deliver through a smarthost relay. */
  deliverSmarthost: "deliver.smarthost",
  /** Relay the message through a smarthost. */
  relaySmtp: "relay.smtp",
  /** Send an automatic reply from a template. */
  reply: "reply",
  /** Accept and discard the message. */
  drop: "drop",
  /** Reject the transaction with a 5xx reply. */
  reject: "reject",
  /** Defer the transaction with a 4xx reply. */
  defer: "defer",
} as const;

/**
 * The kind of effect a routing script staged.
 *
 * A server may add a kind before this SDK knows it; {@link RoutingIntent.kind}
 * preserves the value so a caller can handle it itself.
 *
 * @public
 */
export type RoutingIntentKind = (typeof routingIntentKind)[keyof typeof routingIntentKind];

/**
 * One effect a routing script staged.
 *
 * The wire shape is one flat object whose populated fields depend on `kind`;
 * this type mirrors it rather than modelling each kind as a separate union, so
 * a kind the server adds still decodes without losing its fields.
 *
 * `intents` in {@link RoutingDecision} contains executed non-terminal effects.
 * The same shape describes the effect inside a {@link RoutingSkip}.
 *
 * @public
 */
export interface RoutingIntent {
  /** The effect kind. See {@link routingIntentKind}. */
  readonly kind: RoutingIntentKind;
  /** The header name for `header.set`, `header.append`, and `header.remove`. */
  readonly header?: string;
  /** The header value for `header.set` and `header.append`. */
  readonly value?: string;
  /** The recipient address for `recipients.add`. */
  readonly address?: string;
  /** The destination reference for `forward`, `relay`, `deliver:smarthost`, and `archive`. */
  readonly ref?: string;
  /** The dedicated IP pool reference for the delivery kinds that accept one. */
  readonly pool?: string;
  /** The object key for `archive.s3`. */
  readonly key?: string;
  /** The template reference for `reply`. */
  readonly template?: string;
  /** The SMTP reply code for `reject` and `defer`. */
  readonly code?: number;
  /** The RFC 3463 enhanced status code for `reject` and `defer`. */
  readonly enhanced?: string;
  /** The reply text for `reject` and `defer`. */
  readonly text?: string;
  /** The machine-readable reason recorded for the effect. */
  readonly reason?: string;
}

/** A non-terminal effect that an execution-time check skipped. @public */
export interface RoutingSkip {
  /** The effect that was skipped. */
  readonly intent: RoutingIntent;
  /** Why it was skipped, for example a header covered by a passing signature. */
  readonly reason: string;
}

/**
 * Why a routing script faulted and the listener-type default applied.
 *
 * The message may contain tenant-authored text. Do not treat it as trusted
 * markup or interpolate it into a log line unchecked.
 *
 * @public
 */
export interface RoutingFault {
  /** The stable fault reason, for example `quarantined` or `routing_budget_exhausted`. */
  readonly reason: string;
  /** The human-readable failure description. */
  readonly message: string;
  /** The script line that faulted, when the fault has a source position. */
  readonly line?: number;
}

/**
 * The audit record of one `mx.http` call.
 *
 * Response bodies are never recorded. `status` is `0` when the request did not
 * produce an HTTP response.
 *
 * @public
 */
export interface RoutingHttpCall {
  /** The endpoint reference the script named. */
  readonly endpoint: string;
  /** The HTTP response status, or `0` when no response was received. */
  readonly status: number;
  /** The wall-clock duration of the call in milliseconds. */
  readonly durationMs: number;
  /** The request body size in bytes. */
  readonly requestBytes: number;
  /** The response body size in bytes, capped by the platform. */
  readonly responseBytes: number;
  /** The transport failure description, when the call failed. */
  readonly error?: string;
  /**
   * Whether an identical earlier call in the same MTA transaction answered
   * this one, so the endpoint was called only once for both.
   */
  readonly cached?: boolean;
}

/**
 * What a listener's routing script did for one accepted message.
 *
 * The decision records the terminal, the executed non-terminal effects, the
 * effects an execution-time check skipped, the script's own log lines, and any
 * fault, so a tenant can debug routing from the event stream alone.
 *
 * @public
 */
export interface RoutingDecision {
  /** The resolved terminal action. Values are the mxRaven worker enum names. */
  readonly terminalAction: TerminalAction;
  /**
   * Whether the listener-type default applied.
   *
   * The default applies when the listener has no published script, the script
   * staged no terminal, or a submission script faulted. Submission listeners
   * default to shared-pool delivery; MTA listeners default to dropping the
   * message. An MTA script fault does not use the default: it defers the
   * transaction and publishes a fault notification instead.
   */
  readonly usedListenerDefault: boolean;
  /** The published script revision that ran. Absent when no script ran. */
  readonly scriptRevisionId?: string;
  /**
   * The published script revision number that ran.
   *
   * Revision numbers start at 1, so it is absent when no script ran.
   */
  readonly scriptRevision?: number;
  /**
   * The non-terminal effects that executed with the terminal, in call order.
   *
   * The terminal effect itself is described by {@link RoutingDecision.terminalAction}.
   */
  readonly intents: readonly RoutingIntent[];
  /** Non-terminal effects skipped by an execution-time check. */
  readonly skipped?: readonly RoutingSkip[];
  /**
   * The script's `mx.log` lines, in order.
   *
   * At most 8 lines of 256 bytes each, with CR and LF escaped by the platform.
   * A fault adds a synthesized line, so this is populated even when the script
   * failed.
   */
  readonly log: readonly string[];
  /**
   * The fault that made the listener-type default apply on a submission
   * listener. An MTA script fault is reported by a
   * {@link FaultEvent} instead.
   */
  readonly fault?: RoutingFault;
  /**
   * Every `mx.http` call the invocation made. At most two.
   *
   * A repeated identical call within one MTA transaction carries
   * {@link RoutingHttpCall.cached}.
   */
  readonly httpCalls?: readonly RoutingHttpCall[];
}
