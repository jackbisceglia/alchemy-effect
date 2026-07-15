import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

interface User {
  id: string;
  name: string;
}

// Binding a D1 database inside an Action via `QueryDatabaseLocal` — the local
// (current-credentials) implementation of the `QueryDatabase` binding. Exercises
// both the binding client (exec/prepare/run/all) and the accessor mechanism
// (`yield* database.databaseId` resolved at apply time).
test.provider(
  "QueryDatabaseLocal: seed and query a database from an Action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* Cloudflare.D1.Database("SeedDatabase");

          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const db = yield* Cloudflare.D1.QueryDatabase(database);
              // Accessor — resolved at apply time against the tracker.
              const databaseId = yield* database.databaseId;

              return Effect.fn(function* () {
                yield* db.exec(
                  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT)",
                );
                yield* db.prepare("DELETE FROM users").run();
                yield* db
                  .prepare("INSERT INTO users (id, name) VALUES (?, ?)")
                  .bind("1", "Ada")
                  .run();
                yield* db
                  .prepare("INSERT INTO users (id, name) VALUES (?, ?)")
                  .bind("2", "Grace")
                  .run();

                const rows = yield* db
                  .prepare("SELECT id, name FROM users ORDER BY id")
                  .all<User>();

                const first = yield* db
                  .prepare("SELECT name FROM users WHERE id = ?")
                  .bind("1")
                  .first<string>("name");

                return {
                  databaseId: yield* databaseId,
                  users: rows.results,
                  first,
                };
              });
            }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
          );

          return yield* Seed({});
        }),
      );

      expect(out.databaseId).toBeTruthy();
      expect(out.users).toEqual([
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
      ]);
      expect(out.first).toBe("Ada");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Expected to fail before reaching D1: Distilled validates params as string[],
// so .bind(42) throws "Expected string, got 42" during request encoding.
test.provider(
  "QueryDatabaseLocal: binds numeric prepared-statement parameters",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* Cloudflare.D1.Database("NumericBindDatabase");

          const Query = Action(
            "QueryNumericBind",
            Effect.gen(function* () {
              const db = yield* Cloudflare.D1.QueryDatabase(database);

              return Effect.fn(function* () {
                // Selecting the parameter directly rules out table schema or seed behavior.
                return yield* db
                  .prepare("SELECT ? AS value")
                  .bind(42)
                  .first<number>("value");
              });
            }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
          );

          return yield* Query({});
        }),
      );

      expect(out).toBe(42);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
