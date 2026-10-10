import { dropTestSchemas } from "./backends.js";

// Per-test Postgres schemas are dropped here, after every worker is done.
// See openTestDatabase for why they aren't dropped as each test finishes.
export async function setup(): Promise<() => Promise<void>> {
  await dropTestSchemas();
  return dropTestSchemas;
}
