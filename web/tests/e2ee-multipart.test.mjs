import assert from "node:assert/strict";
import {
  buildEncryptedUploadBody,
  escapeMultipartParam,
} from "../src/services/e2eeMultipart.ts";
import {
  decryptBufferedStream,
  E2EE_STREAM_PURPOSE_UPLOAD,
  encryptedStreamSize,
  E2EE_STREAM_MARKER_UPLOAD,
} from "../src/services/e2eeStream.ts";

const keyBytes = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
const requestNonce = "MDEyMzQ1Njc4OWFiY2RlZg";
const encoder = new TextEncoder();

async function decryptUpload(result) {
  const encrypted = new Uint8Array(await result.blob.arrayBuffer());
  const plaintext = await decryptBufferedStream(encrypted, key, E2EE_STREAM_PURPOSE_UPLOAD, requestNonce);
  return { encrypted, plaintext: new TextDecoder().decode(plaintext) };
}

assert.equal(escapeMultipartParam('a"b\\c\r\nd'), "a%22b_c%0D%0Ad");

const note = new File([encoder.encode("hello")], "note.txt", { type: "text/plain" });
const result = await buildEncryptedUploadBody({
  files: [note],
  dir: "docs",
  key,
  requestNonce,
});
assert.match(result.boundary, /^----MindFSBoundary[0-9a-f]{32}$/);
assert.equal(
  result.blob.type,
  `multipart/form-data; boundary=${result.boundary}`.toLowerCase(),
  "Blob types are normalized to lowercase; the request sets the exact boundary header explicitly",
);
assert.equal(E2EE_STREAM_MARKER_UPLOAD, "upload");

const { encrypted, plaintext } = await decryptUpload(result);
assert.equal(
  plaintext,
  `--${result.boundary}\r\n`
    + `Content-Disposition: form-data; name="files"; filename="note.txt"\r\n`
    + `Content-Type: text/plain\r\n`
    + `\r\n`
    + `hello\r\n`
    + `--${result.boundary}\r\n`
    + `Content-Disposition: form-data; name="dir"\r\n`
    + `\r\n`
    + `docs\r\n`
    + `--${result.boundary}--\r\n`,
);
assert.equal(encrypted.length, encryptedStreamSize(encoder.encode(plaintext).length));

const empty = new File([], "empty.bin", { type: "" });
const emptyResult = await buildEncryptedUploadBody({
  files: [empty, new File(["second"], 'quote"file.bin', { type: "application/octet-stream" })],
  key,
  requestNonce,
});
const emptyPlaintext = (await decryptUpload(emptyResult)).plaintext;
assert.ok(emptyPlaintext.includes('filename="empty.bin"\r\n\r\n\r\n'), "empty file part must keep its boundary separator");
assert.ok(
  emptyPlaintext.includes('filename="quote%22file.bin"'),
  "quotes in filenames must be percent-encoded",
);
assert.ok(emptyPlaintext.endsWith(`--${emptyResult.boundary}--\r\n`));

const controller = new AbortController();
controller.abort();
await assert.rejects(
  () => buildEncryptedUploadBody({
    files: [note],
    key,
    requestNonce,
    signal: controller.signal,
  }),
  (error) => error instanceof Error && error.name === "AbortError",
);

console.log("e2ee multipart tests passed");
