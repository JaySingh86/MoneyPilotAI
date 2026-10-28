// Copyable example of a household module (route recipe in ../module.ts). NOT registered in
// src/modules/index.ts, so it is never served and never appears in the OpenAPI document; tests mount it.
// A real module keeps schemas in @mp/contracts/src/<module>/, logic in service.ts and SQL in repo.ts,
// and reads/writes through `db.withHouseholdTx(dbContext(request), tx => …)`.
import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { AppError, Cents, HouseholdParams, IsoDate, Uuid, Version } from "@mp/contracts";
import { assertVersion, requireIfMatch, setVersionTag } from "../if-match";
import { defineModule } from "../module";
import { dbContext } from "../../plugins/request-context";

// Contracts (in a real module: packages/contracts/src/<module>/index.ts).
export const ExampleNote = z.object({
  id: Uuid,
  householdId: Uuid,
  title: z.string().min(1).max(120),
  amountCents: Cents,
  dueOn: IsoDate,
  version: Version,
});
export type ExampleNote = z.infer<typeof ExampleNote>;
const CreateExampleNote = ExampleNote.pick({ title: true, amountCents: true, dueOn: true });
const PatchExampleNote = CreateExampleNote.partial();
const NoteParams = HouseholdParams.extend({ id: Uuid });

/** Stand-in for repo.ts. Real modules use the database; this one keeps rows in memory for tests. */
export function exampleModule(rows = new Map<string, ExampleNote>()) {
  const routes: FastifyPluginAsyncZod = async (scope) => {
    // Create: Idempotency-Key required, auth-sensitive shared budget, 201 + Location + ETag.
    scope.post(
      "/households/:hid/example-notes",
      {
        schema: { params: HouseholdParams, body: CreateExampleNote, response: { 201: ExampleNote } },
        config: { idempotency: "required", rateLimitGroup: "authSensitive" },
      },
      async (request, reply) => {
        const ctx = dbContext(request); // { userId, authSubject, householdId } for withHouseholdTx
        const note: ExampleNote = {
          id: crypto.randomUUID(),
          householdId: ctx.householdId ?? request.params.hid,
          ...request.body,
          version: 1,
        };
        rows.set(note.id, note);
        return setVersionTag(reply, note.version)
          .code(201)
          .header("location", `/v1/households/${note.householdId}/example-notes/${note.id}`)
          .send(note);
      },
    );

    // Update: If-Match required; a stale version is 409 with the current resource.
    scope.patch(
      "/households/:hid/example-notes/:id",
      {
        schema: { params: NoteParams, body: PatchExampleNote, response: { 200: ExampleNote } },
        config: { idempotency: "optional" },
      },
      async (request, reply) => {
        dbContext(request);
        const expected = requireIfMatch(request);
        const current = rows.get(request.params.id);
        if (!current || current.householdId !== request.params.hid) {
          throw new AppError("not_found", 404, "Note not found.");
        }
        assertVersion(expected, current);
        const updated: ExampleNote = { ...current, ...request.body, version: current.version + 1 };
        rows.set(updated.id, updated);
        return setVersionTag(reply, updated.version).send(updated);
      },
    );
  };
  return defineModule({ name: "example", routes });
}
