import type * as cf from "@cloudflare/workers-types";
import * as flagship from "@distilled.cloud/cloudflare/flagship";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import type { App } from "./App.ts";
import {
  type EvaluationContext,
  type EvaluationDetails,
  FlagshipError,
  ReadFlags,
  type ReadFlagsClient,
} from "./ReadFlags.ts";

/**
 * Local implementation of the {@link ReadFlags} binding — evaluates Flagship
 * feature flags over the Cloudflare HTTP API (`GET .../flagship/apps/{appId}/evaluate`)
 * using the **current credentials** instead of a native Worker binding
 * ({@link ReadFlagsBinding}).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can read
 * flag values with the same `getBooleanValue`/`getStringValue`/… client you'd
 * use inside a Worker:
 *
 * @example Reading a flag from an Action
 * ```typescript
 * const CheckFlag = Alchemy.Action(
 *   "CheckFlag",
 *   Effect.gen(function* () {
 *     const flags = yield* Cloudflare.Flagship.ReadFlags(app);
 *     return Effect.fn(function* () {
 *       return yield* flags.getBooleanValue("new-checkout", false);
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Flagship.ReadFlagsLocal)),
 * );
 * ```
 *
 * The app id is resolved at apply time through the ambient {@link RuntimeContext}
 * (in an Action, that's the resolve context the engine provides around the
 * body), so `ReadFlags(app)` works even though the app is created in the same
 * deploy.
 *
 * Limitations vs. the Worker binding: the HTTP evaluate endpoint only accepts a
 * single `targetingKey` (read from `context.targetingKey`), so attribute-based
 * targeting rules that key off other context fields cannot be exercised locally.
 * The `raw` runtime binding has no HTTP equivalent and dies if used.
 */
export const ReadFlagsLocal = Layer.effect(
  ReadFlags,
  Effect.gen(function* () {
    // Account + credentials are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so the evaluate op can run
    // with the current credentials — no `host.bind`, no minted token.
    const { accountId } = yield* yield* CloudflareEnvironment;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();

    return Effect.fn(function* (app: App) {
      // Deferred accessor — resolves the appId against the tracker at apply
      // time (in an Action, that's the engine's resolve context).
      const appId = yield* app.appId;
      return makeLocalFlagshipClient({ accountId, appId, context });
    });
  }),
);

interface LocalCtx {
  accountId: string;
  appId: Effect.Effect<string>;
  context: Context.Context<Credentials | HttpClient.HttpClient>;
}

/**
 * The HTTP evaluate endpoint only supports a single `targetingKey` query
 * param, not the full flat evaluation context the Worker binding accepts.
 */
const targetingKeyOf = (
  context: EvaluationContext | undefined,
): string | undefined => {
  const value = context?.["targetingKey"];
  return value === undefined ? undefined : String(value);
};

const evaluate = (
  ctx: LocalCtx,
  flagKey: string,
  context?: EvaluationContext,
) =>
  ctx.appId.pipe(
    Effect.flatMap((appId) =>
      flagship
        .getAppEvaluate({
          accountId: ctx.accountId,
          appId,
          flagKey,
          targetingKey: targetingKeyOf(context),
        })
        .pipe(Effect.provideContext(ctx.context)),
    ),
  );

/**
 * HTTP-backed {@link ReadFlagsClient}. Mirrors the Worker binding's
 * fall-back-to-default semantics: evaluation never fails the effect — an HTTP
 * error or a value whose type does not match the requested method resolves to
 * `defaultValue` instead.
 */
const makeLocalFlagshipClient = (ctx: LocalCtx): ReadFlagsClient => {
  const details = <T>(
    flagKey: string,
    defaultValue: T,
    match: (value: unknown) => value is T,
    context?: EvaluationContext,
  ): Effect.Effect<EvaluationDetails<T>, FlagshipError, RuntimeContext> =>
    evaluate(ctx, flagKey, context).pipe(
      Effect.map(
        (r): EvaluationDetails<T> =>
          match(r.value)
            ? { flagKey, value: r.value, variant: r.variant, reason: r.reason }
            : {
                flagKey,
                value: defaultValue,
                variant: r.variant,
                reason: r.reason,
                errorCode: "TYPE_MISMATCH",
              },
      ),
      Effect.catch((error) =>
        Effect.succeed<EvaluationDetails<T>>({
          flagKey,
          value: defaultValue,
          reason: "ERROR",
          errorCode: error._tag,
        }),
      ),
    );

  const value = <T>(
    flagKey: string,
    defaultValue: T,
    match: (value: unknown) => value is T,
    context?: EvaluationContext,
  ): Effect.Effect<T, FlagshipError, RuntimeContext> =>
    evaluate(ctx, flagKey, context).pipe(
      Effect.map((r) => (match(r.value) ? r.value : defaultValue)),
      Effect.catch(() => Effect.succeed(defaultValue)),
    );

  const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
  const isString = (v: unknown): v is string => typeof v === "string";
  const isNumber = (v: unknown): v is number => typeof v === "number";
  const isObjectLike = (v: unknown): boolean =>
    v !== null && typeof v === "object";

  return {
    // The raw runtime binding is a workerd object with no HTTP surface.
    raw: Effect.die(
      new FlagshipError({
        message:
          "the raw Flagship runtime binding is unavailable over HTTP; use ReadFlagsBinding inside a Worker",
        cause: undefined,
      }),
    ) as Effect.Effect<cf.Flagship, never, RuntimeContext>,
    get: (flagKey, defaultValue, context) =>
      evaluate(ctx, flagKey, context).pipe(
        Effect.map((r) => r.value ?? defaultValue),
        Effect.catch(() => Effect.succeed(defaultValue)),
      ),
    getBooleanValue: (flagKey, defaultValue, context) =>
      value(flagKey, defaultValue, isBoolean, context),
    getStringValue: (flagKey, defaultValue, context) =>
      value(flagKey, defaultValue, isString, context),
    getNumberValue: (flagKey, defaultValue, context) =>
      value(flagKey, defaultValue, isNumber, context),
    getObjectValue: (flagKey, defaultValue, context) =>
      evaluate(ctx, flagKey, context).pipe(
        Effect.map((r) =>
          isObjectLike(r.value)
            ? (r.value as typeof defaultValue)
            : defaultValue,
        ),
        Effect.catch(() => Effect.succeed(defaultValue)),
      ),
    getBooleanDetails: (flagKey, defaultValue, context) =>
      details(flagKey, defaultValue, isBoolean, context),
    getStringDetails: (flagKey, defaultValue, context) =>
      details(flagKey, defaultValue, isString, context),
    getNumberDetails: (flagKey, defaultValue, context) =>
      details(flagKey, defaultValue, isNumber, context),
    getObjectDetails: (flagKey, defaultValue, context) =>
      evaluate(ctx, flagKey, context).pipe(
        Effect.map(
          (r): EvaluationDetails<typeof defaultValue> =>
            isObjectLike(r.value)
              ? {
                  flagKey,
                  value: r.value as typeof defaultValue,
                  variant: r.variant,
                  reason: r.reason,
                }
              : {
                  flagKey,
                  value: defaultValue,
                  variant: r.variant,
                  reason: r.reason,
                  errorCode: "TYPE_MISMATCH",
                },
        ),
        Effect.catch((error) =>
          Effect.succeed<EvaluationDetails<typeof defaultValue>>({
            flagKey,
            value: defaultValue,
            reason: "ERROR",
            errorCode: error._tag,
          }),
        ),
      ),
  } satisfies ReadFlagsClient;
};
