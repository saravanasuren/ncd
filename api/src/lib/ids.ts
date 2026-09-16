/**
 * An id as it arrives in a JSON request body.
 *
 * Every id in this schema is BIGSERIAL, and node-postgres hands BIGINT back as
 * a STRING (int8 has no safe JS number). So an id that has been out to the
 * browser and come back — a row the operator clicked in a search result, say —
 * is `"42"`, not `42`, and `z.number()` rejects it as "Invalid request" with no
 * clue why. That is how assigning a referrer on Approvals broke (#426), and it
 * is the same trap dashboard search already guards against by casting on the
 * way out (dashboard/service.ts).
 *
 * Cast ids to numbers as they LEAVE the API, and parse bodies with this so a
 * browser tab still holding yesterday's JSON keeps working across a deploy.
 */
import { z } from 'zod';

/** A positive integer id, whether it arrives as 42 or "42". */
export const idFromJson = z.union([
  z.number().int().positive(),
  z.string().regex(/^[1-9]\d*$/, 'must be an id').transform(Number),
]);
