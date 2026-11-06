import assert from "node:assert/strict";
import { responseProtectionError } from "../src/services/e2eeResponse.ts";

assert.equal(responseProtectionError({
  required: true,
  ok: true,
  protectedResponse: true,
  hasContext: true,
}), null);

assert.equal(responseProtectionError({
  required: true,
  ok: true,
  protectedResponse: true,
  hasContext: false,
}), "e2ee_response_context_missing", "encrypted responses need the request AAD context");

assert.equal(responseProtectionError({
  required: true,
  ok: true,
  protectedResponse: false,
  hasContext: false,
}), "e2ee_response_unprotected", "successful responses must be encrypted while E2EE is on");

assert.equal(responseProtectionError({
  required: true,
  ok: true,
  protectedResponse: false,
  hasContext: false,
  allowPlaintext: true,
}), null, "public bootstrap responses may opt into plaintext");

assert.equal(responseProtectionError({
  required: true,
  ok: false,
  protectedResponse: false,
  hasContext: false,
}), null, "plaintext error responses remain parseable");

assert.equal(responseProtectionError({
  required: false,
  ok: true,
  protectedResponse: false,
  hasContext: false,
}), null, "E2EE-disabled responses are plaintext");

console.log("e2ee response protection tests passed");
