import {
  E2EE_STREAM_CHUNK_SIZE,
  E2EE_STREAM_PURPOSE_UPLOAD,
  StreamEncryptor,
  throwIfAborted,
  toArrayBuffer,
} from "./e2eeStream.ts";

const textEncoder = new TextEncoder();

export type EncryptedUploadBody = {
  blob: Blob;
  boundary: string;
};

export function createMultipartBoundary(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let boundary = "----MindFSBoundary";
  for (const byte of bytes) {
    boundary += byte.toString(16).padStart(2, "0");
  }
  return boundary;
}

export function escapeMultipartParam(value: string): string {
  return String(value || "")
    .replace(/\\/g, "_")
    .replace(/"/g, "%22")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

export async function buildEncryptedUploadBody(input: {
  files: File[];
  dir?: string;
  key: CryptoKey;
  requestNonce: string;
  signal?: AbortSignal;
}): Promise<EncryptedUploadBody> {
  const boundary = createMultipartBoundary();
  const parts: BlobPart[] = [];
  const encryptor = new StreamEncryptor(
    input.key,
    E2EE_STREAM_PURPOSE_UPLOAD,
    input.requestNonce,
    (frame) => {
      parts.push(new Blob([toArrayBuffer(frame)]));
    },
  );
  const writeText = async (text: string) => {
    throwIfAborted(input.signal);
    await encryptor.write(textEncoder.encode(text), input.signal);
  };

  for (const file of input.files) {
    const contentType = String(file.type || "").replace(/[\r\n]/g, "");
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${escapeMultipartParam(file.name)}"\r\n`;
    if (contentType) {
      header += `Content-Type: ${contentType}\r\n`;
    }
    header += "\r\n";
    await writeText(header);
    for (let offset = 0; offset < file.size; offset += E2EE_STREAM_CHUNK_SIZE) {
      throwIfAborted(input.signal);
      const end = Math.min(offset + E2EE_STREAM_CHUNK_SIZE, file.size);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      await encryptor.write(bytes, input.signal);
    }
    await writeText("\r\n");
  }
  if (input.dir) {
    await writeText(`--${boundary}\r\nContent-Disposition: form-data; name="dir"\r\n\r\n${input.dir}\r\n`);
  }
  await writeText(`--${boundary}--\r\n`);
  throwIfAborted(input.signal);
  await encryptor.close();
  return {
    blob: new Blob(parts, { type: `multipart/form-data; boundary=${boundary}` }),
    boundary,
  };
}
