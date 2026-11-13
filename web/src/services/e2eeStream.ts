const textEncoder = new TextEncoder();

export const E2EE_STREAM_MAGIC = textEncoder.encode("MFSC1");
export const E2EE_STREAM_CHUNK_SIZE = 1 << 20;
export const E2EE_STREAM_MARKER_HEADER = "X-MindFS-E2EE-Stream";
export const E2EE_STREAM_MARKER_UPLOAD = "upload";
export const E2EE_STREAM_MARKER_DOWNLOAD = "download";
export const E2EE_STREAM_META_HEADER = "X-MindFS-E2EE-Meta";
export const E2EE_STREAM_PURPOSE_UPLOAD = "upload";
export const E2EE_STREAM_PURPOSE_DOWNLOAD = "download";

const FRAME_HEADER_SIZE = 4 + 1 + 12;
const TAG_SIZE = 16;
const MAX_CIPHERTEXT_SIZE = E2EE_STREAM_CHUNK_SIZE + TAG_SIZE;
const FINAL_FLAG = 1;

export function buildStreamAAD(
  purpose: string,
  requestNonce: string,
  index: number,
  final: boolean,
): Uint8Array {
  return textEncoder.encode(
    `mindfs-stream-v1\x1f${purpose}\x1f${requestNonce}\x1f${index}\x1f${final ? "1" : "0"}`,
  );
}

export function encryptedStreamSize(plaintextSize: number): number {
  if (!Number.isFinite(plaintextSize) || plaintextSize < 0) {
    return 0;
  }
  const frames = Math.floor(plaintextSize / E2EE_STREAM_CHUNK_SIZE) + 1;
  return E2EE_STREAM_MAGIC.length + plaintextSize + frames * (FRAME_HEADER_SIZE + TAG_SIZE);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error("Upload aborted");
  error.name = "AbortError";
  throw error;
}

export class StreamEncryptor {
  private readonly key: CryptoKey;
  private readonly purpose: string;
  private readonly requestNonce: string;
  private readonly emit: (frame: Uint8Array) => void;
  private readonly buffer = new Uint8Array(E2EE_STREAM_CHUNK_SIZE);
  private buffered = 0;
  private index = 0;
  private started = false;
  private closed = false;

  constructor(
    key: CryptoKey,
    purpose: string,
    requestNonce: string,
    emit: (frame: Uint8Array) => void,
  ) {
    this.key = key;
    this.purpose = purpose;
    this.requestNonce = requestNonce;
    this.emit = emit;
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      throw new Error("e2ee_stream_closed");
    }
    throwIfAborted(signal);
    this.start();
    let offset = 0;
    while (offset < data.length) {
      const room = E2EE_STREAM_CHUNK_SIZE - this.buffered;
      const take = Math.min(room, data.length - offset);
      this.buffer.set(data.subarray(offset, offset + take), this.buffered);
      this.buffered += take;
      offset += take;
      if (this.buffered === E2EE_STREAM_CHUNK_SIZE) {
        await this.flush(false);
        throwIfAborted(signal);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.start();
    await this.flush(true);
    this.closed = true;
  }

  private start(): void {
    if (this.started) {
      return;
    }
    this.emit(E2EE_STREAM_MAGIC.slice());
    this.started = true;
  }

  private async flush(final: boolean): Promise<void> {
    const plaintext = this.buffer.slice(0, this.buffered);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const aad = buildStreamAAD(this.purpose, this.requestNonce, this.index, final);
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(aad),
        tagLength: 128,
      },
      this.key,
      toArrayBuffer(plaintext),
    );
    const ciphertext = new Uint8Array(encrypted);
    const frame = new Uint8Array(FRAME_HEADER_SIZE + ciphertext.length);
    new DataView(frame.buffer).setUint32(0, ciphertext.length, false);
    frame[4] = final ? FINAL_FLAG : 0;
    frame.set(nonce, 5);
    frame.set(ciphertext, FRAME_HEADER_SIZE);
    this.emit(frame);
    this.buffered = 0;
    this.index += 1;
  }
}

class ByteQueue {
  private chunks: Uint8Array[] = [];
  private offset = 0;
  private total = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.total += chunk.length;
  }

  get size(): number {
    return this.total;
  }

  peek(count: number): Uint8Array | null {
    if (count < 0 || this.total < count) {
      return null;
    }
    const out = new Uint8Array(count);
    let written = 0;
    let offset = this.offset;
    for (const chunk of this.chunks) {
      if (written >= count) {
        break;
      }
      const available = chunk.length - offset;
      const use = Math.min(available, count - written);
      out.set(chunk.subarray(offset, offset + use), written);
      written += use;
      offset = 0;
    }
    return out;
  }

  take(count: number): Uint8Array | null {
    if (count < 0 || this.total < count) {
      return null;
    }
    const out = new Uint8Array(count);
    let written = 0;
    while (written < count) {
      const head = this.chunks[0];
      const available = head.length - this.offset;
      const use = Math.min(available, count - written);
      out.set(head.subarray(this.offset, this.offset + use), written);
      written += use;
      this.offset += use;
      this.total -= use;
      if (this.offset === head.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.offset = 0;
    this.total = 0;
  }
}

export class StreamDecryptor {
  private readonly key: CryptoKey;
  private readonly purpose: string;
  private readonly requestNonce: string;
  private readonly queue = new ByteQueue();
  private magicSeen = false;
  private index = 0;
  private finalSeen = false;
  private finished = false;

  constructor(key: CryptoKey, purpose: string, requestNonce: string) {
    this.key = key;
    this.purpose = purpose;
    this.requestNonce = requestNonce;
  }

  async push(chunk: Uint8Array): Promise<Uint8Array[]> {
    if (this.finished || this.finalSeen) {
      if (chunk.length > 0) {
        throw new Error("e2ee_stream_trailing");
      }
      return [];
    }
    this.queue.push(chunk);
    const out: Uint8Array[] = [];
    if (!this.magicSeen) {
      const magic = this.queue.peek(E2EE_STREAM_MAGIC.length);
      if (!magic) {
        return out;
      }
      if (!bytesEqual(magic, E2EE_STREAM_MAGIC)) {
        throw new Error("e2ee_stream_magic");
      }
      this.queue.take(E2EE_STREAM_MAGIC.length);
      this.magicSeen = true;
    }
    while (true) {
      const header = this.queue.peek(FRAME_HEADER_SIZE);
      if (!header) {
        break;
      }
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      const ciphertextLength = view.getUint32(0, false);
      const flags = header[4];
      if ((flags & ~FINAL_FLAG) !== 0) {
        throw new Error("e2ee_stream_flags");
      }
      const final = (flags & FINAL_FLAG) !== 0;
      if (ciphertextLength < TAG_SIZE || ciphertextLength > MAX_CIPHERTEXT_SIZE) {
        throw new Error("e2ee_stream_length");
      }
      if (!final && ciphertextLength === TAG_SIZE) {
        throw new Error("e2ee_stream_empty");
      }
      if (this.queue.size < FRAME_HEADER_SIZE + ciphertextLength) {
        break;
      }
      this.queue.take(FRAME_HEADER_SIZE);
      const ciphertext = this.queue.take(ciphertextLength);
      if (!ciphertext) {
        throw new Error("e2ee_stream_truncated");
      }
      const aad = buildStreamAAD(this.purpose, this.requestNonce, this.index, final);
      let plaintext: Uint8Array;
      try {
        plaintext = new Uint8Array(await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: toArrayBuffer(header.subarray(5, FRAME_HEADER_SIZE)),
            additionalData: toArrayBuffer(aad),
            tagLength: 128,
          },
          this.key,
          toArrayBuffer(ciphertext),
        ));
      } catch {
        throw new Error("e2ee_stream_auth");
      }
      this.index += 1;
      out.push(plaintext);
      if (final) {
        this.finalSeen = true;
        this.finished = true;
        if (this.queue.size > 0) {
          throw new Error("e2ee_stream_trailing");
        }
      }
    }
    return out;
  }

  finish(): void {
    if (this.finalSeen) {
      if (this.queue.size > 0) {
        throw new Error("e2ee_stream_trailing");
      }
      this.finished = true;
      return;
    }
    throw new Error("e2ee_stream_truncated");
  }
}

export async function decryptBufferedStream(
  data: Uint8Array,
  key: CryptoKey,
  purpose: string,
  requestNonce: string,
): Promise<Uint8Array> {
  const decryptor = new StreamDecryptor(key, purpose, requestNonce);
  const parts = await decryptor.push(data);
  decryptor.finish();
  return concatBytes(parts);
}

export async function decryptResponseToBlob(
  response: Response,
  key: CryptoKey,
  purpose: string,
  requestNonce: string,
  mimeType: string,
): Promise<Blob> {
  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const decryptor = new StreamDecryptor(key, purpose, requestNonce);
    const parts: BlobPart[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          const plaintextParts = await decryptor.push(value);
          parts.push(...plaintextParts.map(toArrayBuffer));
        }
      }
      decryptor.finish();
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // The stream may already be errored; the original error is reported.
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
    return new Blob(parts, { type: mimeType });
  }
  const data = new Uint8Array(await response.arrayBuffer());
  const plaintext = await decryptBufferedStream(data, key, purpose, requestNonce);
  return new Blob([toArrayBuffer(plaintext)], { type: mimeType });
}

export function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}
