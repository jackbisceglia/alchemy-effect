import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

type RequirementsOf<T> =
  T extends Effect.Effect<unknown, unknown, infer Req> ? Req : never;
type ContainerRequirementsOf<T> = Extract<
  RequirementsOf<T>,
  Cloudflare.Container.Application<any>
>;
type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export const BasicFunctionalWorker = Cloudflare.Worker(
  "BasicFunctionalWorker",
  {
    main: import.meta.url,
    compatibility: { date: "2026-06-02", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
);

export class BasicClassWorker extends Cloudflare.Worker<BasicClassWorker>()(
  "BasicClassWorker",
  {
    main: import.meta.url,
    compatibility: { date: "2026-06-02", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}

export const BasicFunctionalStack = Alchemy.Stack(
  "BasicFunctionalWorkerStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    return yield* BasicFunctionalWorker;
  }),
);

const TestDatabase = Cloudflare.D1.Database("WorkerInferenceDatabase");

export const D1FunctionalWorker = Cloudflare.Worker(
  "D1FunctionalWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.QueryDatabase(TestDatabase);
    return {
      fetch: database
        .prepare("SELECT 1")
        .first()
        .pipe(Effect.as(HttpServerResponse.text("ok"))),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
);

export class D1ClassWorker extends Cloudflare.Worker<D1ClassWorker>()(
  "D1ClassWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.QueryDatabase(TestDatabase);
    return {
      fetch: database
        .prepare("SELECT 1")
        .first()
        .pipe(Effect.as(HttpServerResponse.text("ok"))),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}

class TestContainer extends Cloudflare.Container<TestContainer, {}>()(
  "WorkerInferenceContainer",
) {}

export const ContainerFunctionalWorker = Cloudflare.Worker(
  "ContainerFunctionalWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* TestContainer;
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
);

export class ContainerClassWorker extends Cloudflare.Worker<ContainerClassWorker>()(
  "ContainerClassWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* TestContainer;
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}

type _BasicFunctionalHasNoContainer = Assert<
  Equal<ContainerRequirementsOf<typeof BasicFunctionalWorker>, never>
>;
type _BasicClassHasNoContainer = Assert<
  Equal<ContainerRequirementsOf<typeof BasicClassWorker>, never>
>;
type _BasicFormsHaveEquivalentRequirements = Assert<
  Equal<
    RequirementsOf<typeof BasicFunctionalWorker>,
    RequirementsOf<typeof BasicClassWorker>
  >
>;
type _D1FunctionalHasNoContainer = Assert<
  Equal<ContainerRequirementsOf<typeof D1FunctionalWorker>, never>
>;
type _D1ClassHasNoContainer = Assert<
  Equal<ContainerRequirementsOf<typeof D1ClassWorker>, never>
>;
type _D1FormsHaveEquivalentRequirements = Assert<
  Equal<
    RequirementsOf<typeof D1FunctionalWorker>,
    RequirementsOf<typeof D1ClassWorker>
  >
>;
type _FunctionalContainerRequirementIsPreserved = Assert<
  Equal<
    ContainerRequirementsOf<typeof ContainerFunctionalWorker>,
    Cloudflare.Container.Application<TestContainer>
  >
>;
type _ClassContainerRequirementIsPreserved = Assert<
  Equal<
    ContainerRequirementsOf<typeof ContainerClassWorker>,
    Cloudflare.Container.Application<TestContainer>
  >
>;
type _ContainerFormsHaveEquivalentRequirements = Assert<
  Equal<
    RequirementsOf<typeof ContainerFunctionalWorker>,
    RequirementsOf<typeof ContainerClassWorker>
  >
>;
