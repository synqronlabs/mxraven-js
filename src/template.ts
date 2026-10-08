/**
 * Template rendering contracts.
 *
 * A template renderer is the only thing a templating plugin needs to provide.
 * It receives an engine-specific input — a React element, a Vue node, an MJML
 * source, a handlebars context — and returns the message content.
 */

/**
 * The content a {@link TemplateRenderer} produces.
 *
 * All engines ultimately produce HTML, so `html` is the only required field.
 * A plain-text alternative is optional but recommended: when both `html` and
 * `text` are present, the message is sent as `multipart/alternative`, which
 * improves deliverability compared with HTML-only mail.
 *
 * @public
 */
export interface RenderedTemplate {
  /** The rendered HTML body. */
  readonly html: string;
  /** The rendered plain-text alternative. */
  readonly text?: string;
  /**
   * A default subject. It is used only when the message does not set an
   * explicit subject.
   */
  readonly subject?: string;
}

/**
 * Renders a template into message content.
 *
 * Implementations live in separate plugin packages, so the core SDK carries
 * no templating dependencies.
 *
 * The renderer runs inside `Client.send`, so implementations may be
 * asynchronous. The input is passed through untouched.
 *
 * @typeParam TInput - The template representation the renderer understands.
 *
 * @example
 * ```ts
 * const renderer: TemplateRenderer<{ name: string }> = {
 *   render: ({ name }) => ({ html: `<p>Hello ${name}</p>`, text: `Hello ${name}` }),
 * };
 * ```
 *
 * @public
 */
export interface TemplateRenderer<TInput> {
  /**
   * @param input - The template representation to render.
   * @returns The rendered content, or a promise for it.
   */
  render(input: TInput): RenderedTemplate | Promise<RenderedTemplate>;
}
