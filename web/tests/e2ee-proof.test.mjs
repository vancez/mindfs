import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildEnvelopeAAD,
  buildRequestProof,
  buildStreamMetadataProof,
  buildWSAAD,
  encodeBase64Url,
  generateRequestNonce,
} from "../src/services/e2eeProof.ts";

const key = new TextEncoder().encode("0123456789abcdef0123456789abcdef");

const proof = await buildRequestProof(
  key,
  "GET",
  "/api/file?path=a.txt&raw=1&root=r",
  "2026-01-01T00:00:00Z",
  "MDEyMzQ1Njc4OWFiY2RlZg",
  "test-client",
);
assert.equal(proof, "l3lM8gycLcCFW1t3jusJVhq26goHGVmXOS4uahoAcGg=", "proof must match the Go golden vector");

const other = await buildRequestProof(
  key,
  "GET",
  "/api/file?path=a.txt&raw=1&root=r",
  "2026-01-01T00:00:00Z",
  "AAAAAAAAAAAAAAAAAAAAAA",
  "test-client",
);
assert.notEqual(other, proof, "changing the nonce must change the proof");

const nonces = new Set();
for (let i = 0; i < 64; i += 1) {
  const nonce = generateRequestNonce();
  assert.match(nonce, /^[A-Za-z0-9_-]{22}$/, "nonce must be 16-byte base64url without padding");
  nonces.add(nonce);
}
assert.equal(nonces.size, 64, "nonces must be unique");

assert.equal(encodeBase64Url(new Uint8Array([0, 1, 2, 251, 252, 253, 254, 255])), "AAEC-_z9_v8");

const decoder = new TextDecoder();
assert.equal(
  decoder.decode(buildEnvelopeAAD("request", "POST", "/api/x", "nonce")),
  "mindfs-envelope-v1\x1frequest\x1fPOST\x1f/api/x\x1fnonce",
);
assert.equal(
  decoder.decode(buildEnvelopeAAD("response", "GET", "/api/x", "nonce")),
  "mindfs-envelope-v1\x1fresponse\x1fGET\x1f/api/x\x1fnonce",
);
assert.equal(
  decoder.decode(buildWSAAD("c2s", 0)),
  "mindfs-ws-frame-v1\x1fc2s\x1f0",
);
assert.notEqual(
  decoder.decode(buildWSAAD("c2s", 1)),
  decoder.decode(buildWSAAD("s2c", 1)),
);

const metadataProof = await buildStreamMetadataProof(
  key,
  "GET",
  "/api/file?path=a.txt&raw=1&root=r",
  "MDEyMzQ1Njc4OWFiY2RlZg",
  "image/png",
  "1234",
  "",
  "download",
);
assert.equal(metadataProof, "yJZgeh+1F9rNRcaHqagoPaWjQsmLzjq8rVHTH8zBmFQ=", "metadata proof must match the Go golden vector");

const e2eeSource = readFileSync(new URL("../src/services/e2ee.ts", import.meta.url), "utf8");
assert.match(e2eeSource, /responseProtectionError/, "successful JSON responses must fail closed when E2EE is required");
assert.match(e2eeSource, /buildEnvelopeAAD\("request"/, "request bodies must be bound to the request context");
assert.match(e2eeSource, /buildEnvelopeAAD\("response"/, "response bodies must be bound to the request context");

const fileSource = readFileSync(new URL("../src/services/file.ts", import.meta.url), "utf8");
assert.match(fileSource, /e2ee_metadata_invalid/, "raw download metadata must be authenticated");
assert.match(fileSource, /E2EE_STREAM_META_HEADER/, "raw download metadata proof header must be read");

console.log("e2ee proof tests passed");
