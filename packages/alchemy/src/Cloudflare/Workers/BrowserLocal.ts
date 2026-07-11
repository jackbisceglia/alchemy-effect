import * as browser from "@distilled.cloud/cloudflare/browser-rendering";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import {
  Browser,
  type BrowserClient,
  type BrowserContentResult,
  BrowserError,
  type BrowserJsonResult,
  type BrowserLinksResult,
  type BrowserMarkdownResult,
  type BrowserScrapeResult,
  type BrowserSnapshotResult,
} from "./Browser.ts";
import type { BrowserBinding } from "./BrowserBinding.ts";

/** A byte stream produced by a binary {@link BrowserClient} action. */
type BrowserByteStream = Stream.Stream<
  Uint8Array,
  BrowserError,
  RuntimeContext
>;

/**
 * Local implementation of the {@link Browser} binding — drives Cloudflare
 * Browser Rendering over its REST data-plane (`/accounts/{id}/browser-rendering/*`)
 * using the **current credentials** instead of a native Worker binding
 * (`BrowserBinding`).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) to run the JSON
 * quick actions — `content`, `markdown`, `scrape`, `links`, `snapshot`,
 * `json` — with the same client you'd use inside a Worker; no Worker host, no
 * `host.bind`, no minted token:
 *
 * @example Convert a page to Markdown from an Action
 * ```typescript
 * const Scrape = Alchemy.Action(
 *   "Scrape",
 *   Effect.gen(function* () {
 *     const browser = yield* Cloudflare.Browser("BROWSER");
 *     return Effect.fn(function* () {
 *       const { result } = yield* browser.markdown({
 *         url: "https://example.com",
 *       });
 *       return result;
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Workers.BrowserLocal)),
 * );
 * ```
 *
 * The following client members `Effect.die` (or fail the stream) because they
 * have no Cloudflare REST equivalent — use a native {@link BrowserBinding}
 * inside a deployed Worker for them:
 * - `raw` / `fetch` — the raw `BrowserRun` transport used by
 *   `@cloudflare/puppeteer` is a Worker-runtime object, not an HTTP call.
 * - `screenshot` / `pdf` — the binary endpoints stream image/PDF bytes, which
 *   the distilled REST codec models as JSON status, not a byte stream.
 *
 * Because the REST data-plane only returns the action `result` (not the
 * runtime binding's `meta` envelope), `content`/`snapshot` populate `meta`
 * with a best-effort placeholder.
 */
export const BrowserLocal = Layer.effect(
  Browser,
  Effect.gen(function* () {
    // Account + credentials are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so the REST ops run with the
    // current credentials — no `host.bind`, no minted token.
    const { accountId } = yield* yield* CloudflareEnvironment;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();

    return Effect.fn(function* (_binding: BrowserBinding) {
      // Browser Rendering is account-scoped; the binding carries no cloud
      // resource id, so nothing to resolve — the client only needs the account
      // + captured credentials.
      return makeLocalBrowserClient({ accountId, context });
    });
  }),
);

interface LocalContext {
  accountId: string;
  context: Context.Context<Credentials | HttpClient.HttpClient>;
}

const makeLocalBrowserClient = (ctx: LocalContext): BrowserClient => {
  // Run a distilled Browser Rendering op with the captured credentials and
  // surface transport/API failures as {@link BrowserError} (matching the
  // native binding's declared error channel).
  const run = <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ): Effect.Effect<A, BrowserError, RuntimeContext> =>
    eff.pipe(
      Effect.provideContext(ctx.context),
      Effect.mapError(
        (cause) =>
          new BrowserError({
            message: "Browser Rendering request failed",
            cause,
          }),
      ),
    );

  // The cf option types (`url`/`html` + puppeteer options) are structurally the
  // REST request body; add the account id and let distilled's encoder drop any
  // fields it doesn't model.
  const req = (options: unknown) =>
    ({ accountId: ctx.accountId, ...(options as object) }) as never;

  const content = (options: unknown) =>
    run(browser.createContent(req(options))).pipe(
      Effect.map(
        (result): BrowserContentResult => ({
          success: true,
          result,
          meta: { status: 200, title: "" },
        }),
      ),
    );

  const markdown = (options: unknown) =>
    run(browser.createMarkdown(req(options))).pipe(
      Effect.map(
        (result): BrowserMarkdownResult => ({ success: true, result }),
      ),
    );

  const links = (options: unknown) =>
    run(browser.createLink(req(options))).pipe(
      Effect.map(
        (result): BrowserLinksResult => ({
          success: true,
          result: [...result],
        }),
      ),
    );

  const json = (options: unknown) =>
    run(browser.createJson(req(options))).pipe(
      Effect.map((result): BrowserJsonResult => ({ success: true, result })),
    );

  const scrape = (options: unknown) =>
    run(browser.createScrape(req(options))).pipe(
      Effect.map(
        (result): BrowserScrapeResult => ({
          success: true,
          result: result.map((item) => ({
            selector: item.selector,
            // distilled models per-selector `results` as a single object; the
            // native shape is an array of matched elements.
            results: (Array.isArray(item.results)
              ? item.results
              : [
                  item.results,
                ]) as BrowserScrapeResult["result"][number]["results"],
          })),
        }),
      ),
    );

  const snapshot = (options: unknown) =>
    run(browser.createSnapshot(req(options))).pipe(
      Effect.map(
        (result): BrowserSnapshotResult => ({
          success: true,
          result: {
            content: result.content ?? "",
            screenshot: result.screenshot ?? "",
          },
          meta: { status: 200, title: "" },
        }),
      ),
    );

  // Binary actions have no REST byte-stream equivalent through the distilled
  // codec — fail the stream with a defect explaining the native-binding path.
  const binaryUnsupported = (action: string): BrowserByteStream =>
    Stream.fromEffect(
      Effect.die(
        new Error(
          `BrowserLocal: '${action}' returns binary data and is only available inside a Worker via the native BrowserBinding; the Local client supports the JSON quick actions (content/markdown/scrape/links/snapshot/json).`,
        ),
      ),
    ) as BrowserByteStream;

  const quickAction = ((action: string, options: unknown) => {
    switch (action) {
      case "content":
        return content(options);
      case "markdown":
        return markdown(options);
      case "links":
        return links(options);
      case "json":
        return json(options);
      case "scrape":
        return scrape(options);
      case "snapshot":
        return snapshot(options);
      default:
        return binaryUnsupported(action);
    }
  }) as BrowserClient["quickAction"];

  return {
    raw: Effect.die(
      new Error(
        "BrowserLocal: `raw` (the native BrowserRun binding) is only available inside a deployed Worker — use BrowserBinding.",
      ),
    ),
    fetch: () =>
      Effect.die(
        new Error(
          "BrowserLocal: `fetch` proxies the raw Browser Run transport used by @cloudflare/puppeteer and is only available inside a Worker via BrowserBinding.",
        ),
      ),
    quickAction,
    screenshot: () => binaryUnsupported("screenshot"),
    pdf: () => binaryUnsupported("pdf"),
    content,
    scrape,
    links,
    snapshot,
    json,
    markdown,
  } satisfies BrowserClient;
};
