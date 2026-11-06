import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Cached sessions created before persisted thinking aux was returned must be
// re-fetched once; otherwise completed turns keep their old aux and the
// thinking cards stay missing until the cache is cleared manually.
const service = readFileSync(
  new URL("../src/services/session.ts", import.meta.url),
  "utf8",
);

assert.match(
  service,
  /const SESSION_CACHE_VERSION = 4;/,
  "the session cache version should invalidate pre-thinking caches",
);
assert.match(
  service,
  /oldVersion < 4[\s\S]*?deleteObjectStore\(SESSION_CACHE_STORE\)/,
  "upgrading to v4 should drop the stale session store",
);

console.log("session cache migration guard passed");
