import assert from "node:assert/strict";
import {
  buildStreamAAD,
  concatBytes,
  decryptBufferedStream,
  decryptResponseToBlob,
  E2EE_STREAM_CHUNK_SIZE,
  E2EE_STREAM_MAGIC,
  E2EE_STREAM_PURPOSE_DOWNLOAD,
  E2EE_STREAM_PURPOSE_UPLOAD,
  encryptedStreamSize,
  StreamDecryptor,
  StreamEncryptor,
} from "../src/services/e2eeStream.ts";

const keyBytes = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
const nonce = "MDEyMzQ1Njc4OWFiY2RlZg";

async function encryptStream(plaintext, options = {}) {
  const frames = [];
  const encryptor = new StreamEncryptor(
    options.key || key,
    options.purpose || E2EE_STREAM_PURPOSE_UPLOAD,
    options.nonce || nonce,
    (frame) => frames.push(frame.slice()),
  );
  const chunkSize = options.writeChunkSize || 0;
  if (chunkSize > 0) {
    for (let offset = 0; offset < plaintext.length; offset += chunkSize) {
      await encryptor.write(plaintext.subarray(offset, Math.min(offset + chunkSize, plaintext.length)));
    }
  } else {
    await encryptor.write(plaintext);
  }
  await encryptor.close();
  return concatBytes(frames);
}

async function decryptStream(ciphertext, options = {}) {
  const decryptor = new StreamDecryptor(
    options.key || key,
    options.purpose || E2EE_STREAM_PURPOSE_UPLOAD,
    options.nonce || nonce,
  );
  const parts = [];
  const chunkSize = options.readChunkSize || 0;
  if (chunkSize > 0) {
    for (let offset = 0; offset < ciphertext.length; offset += chunkSize) {
      parts.push(...await decryptor.push(ciphertext.subarray(offset, Math.min(offset + chunkSize, ciphertext.length))));
    }
  } else {
    parts.push(...await decryptor.push(ciphertext));
  }
  decryptor.finish();
  return concatBytes(parts);
}

function splitFrames(ciphertext) {
  assert.deepEqual([...ciphertext.subarray(0, E2EE_STREAM_MAGIC.length)], [...E2EE_STREAM_MAGIC], "magic");
  const frames = [];
  let offset = E2EE_STREAM_MAGIC.length;
  while (offset < ciphertext.length) {
    const view = new DataView(ciphertext.buffer, ciphertext.byteOffset, ciphertext.byteLength);
    const length = view.getUint32(offset, false);
    const end = offset + 17 + length;
    assert.ok(end <= ciphertext.length, "frame must fit");
    frames.push({
      start: offset,
      end,
      length,
      flags: ciphertext[offset + 4],
      nonce: ciphertext.slice(offset + 5, offset + 17),
      ciphertext: ciphertext.slice(offset + 17, end),
    });
    offset = end;
  }
  return frames;
}

function joinFrames(frames) {
  return concatBytes([
    E2EE_STREAM_MAGIC,
    ...frames.map(frame => frame.bytes),
  ]);
}

function frameBytes(ciphertext, frame) {
  return ciphertext.slice(frame.start, frame.end);
}

const sizes = [0, 1, E2EE_STREAM_CHUNK_SIZE - 1, E2EE_STREAM_CHUNK_SIZE, E2EE_STREAM_CHUNK_SIZE + 1, 2 * E2EE_STREAM_CHUNK_SIZE + 7];
for (const size of sizes) {
  const plaintext = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    plaintext[i] = (i * 31 + 7) & 0xff;
  }
  const ciphertext = await encryptStream(plaintext, { writeChunkSize: 100003 });
  assert.equal(ciphertext.length, encryptedStreamSize(size), `ciphertext size for ${size}`);
  const decrypted = await decryptStream(ciphertext);
  assert.equal(decrypted.length, plaintext.length, `decrypted length for ${size}`);
  assert.deepEqual(decrypted, plaintext, `round trip for ${size}`);
}

const exact = await encryptStream(new Uint8Array(E2EE_STREAM_CHUNK_SIZE));
const exactFrames = splitFrames(exact);
assert.equal(exactFrames.length, 2, "exact chunk emits a trailing empty final frame");
assert.equal(exactFrames[0].flags, 0);
assert.equal(exactFrames[0].length, E2EE_STREAM_CHUNK_SIZE + 16);
assert.equal(exactFrames[1].flags, 1);
assert.equal(exactFrames[1].length, 16);

const empty = await encryptStream(new Uint8Array(0));
const emptyFrames = splitFrames(empty);
assert.equal(emptyFrames.length, 1);
assert.equal(emptyFrames[0].flags, 1);
assert.equal(emptyFrames[0].length, 16);

assert.equal(
  new TextDecoder().decode(buildStreamAAD(E2EE_STREAM_PURPOSE_DOWNLOAD, nonce, 0, false)),
  `mindfs-stream-v1\x1f${E2EE_STREAM_PURPOSE_DOWNLOAD}\x1f${nonce}\x1f0\x1f0`,
);
assert.equal(
  new TextDecoder().decode(buildStreamAAD(E2EE_STREAM_PURPOSE_DOWNLOAD, nonce, 2, true)),
  `mindfs-stream-v1\x1f${E2EE_STREAM_PURPOSE_DOWNLOAD}\x1f${nonce}\x1f2\x1f1`,
);

const plaintext = new TextEncoder().encode("stream integrity payload ".repeat(90000));
const ciphertext = await encryptStream(plaintext);
const frames = splitFrames(ciphertext);

async function assertRejects(name, data, options = {}) {
  await assert.rejects(
    () => decryptStream(data, options),
    undefined,
    name,
  );
}

const magicTampered = ciphertext.slice();
magicTampered[0] ^= 0xff;
await assertRejects("magic tamper", magicTampered);

const flagsTampered = ciphertext.slice();
flagsTampered[frames[0].start + 4] ^= 1;
await assertRejects("flags tamper", flagsTampered);

const cipherTampered = ciphertext.slice();
cipherTampered[frames[0].start + 17] ^= 0xff;
await assertRejects("ciphertext tamper", cipherTampered);

const truncated = ciphertext.slice(0, ciphertext.length - 1);
await assertRejects("truncated final frame", truncated);

const droppedFinal = joinFrames(frames.slice(0, -1).map(frame => ({ bytes: frameBytes(ciphertext, frame) })));
await assertRejects("missing final frame", droppedFinal);

const reordered = joinFrames([
  { bytes: frameBytes(ciphertext, frames[1]) },
  { bytes: frameBytes(ciphertext, frames[0]) },
  ...frames.slice(2).map(frame => ({ bytes: frameBytes(ciphertext, frame) })),
]);
await assertRejects("reordered frames", reordered);

const duplicated = joinFrames([
  { bytes: frameBytes(ciphertext, frames[0]) },
  ...frames.map(frame => ({ bytes: frameBytes(ciphertext, frame) })),
]);
await assertRejects("duplicated frame", duplicated);

const trailing = concatBytes([ciphertext, new Uint8Array([0])]);
await assertRejects("trailing data", trailing);

await assertRejects("wrong nonce", ciphertext, { nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
await assertRejects("wrong purpose", ciphertext, { purpose: E2EE_STREAM_PURPOSE_DOWNLOAD });

const wrongKey = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode("ffffffffffffffffffffffffffffffff"),
  { name: "AES-GCM" },
  false,
  ["encrypt", "decrypt"],
);
await assertRejects("wrong key", ciphertext, { key: wrongKey });

const buffered = await decryptBufferedStream(ciphertext, key, E2EE_STREAM_PURPOSE_UPLOAD, nonce);
assert.deepEqual(buffered, plaintext);

const goFixture = new Uint8Array(Buffer.from(
  "TUZTQzEAAAAtAeNNNW5oWw2pH9QhsNieH/9EKohOLIMoP+5uBTp/C3fr+gqflkgyplWh7+EYwErxIyFr0J7xT/3yvA==",
  "base64",
));
const goPlaintext = await decryptStream(goFixture);
assert.equal(new TextDecoder().decode(goPlaintext), "cross-language stream fixture");

const response = new Response(ciphertext, { headers: { "Content-Type": "application/octet-stream" } });
const blob = await decryptResponseToBlob(response, key, E2EE_STREAM_PURPOSE_UPLOAD, nonce, "image/png");
assert.equal(blob.type, "image/png");
assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), plaintext);

console.log("e2ee stream tests passed");
