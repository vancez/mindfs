const textEncoder = new TextEncoder();

export const REQUEST_NONCE_HEADER = "X-MindFS-Nonce";

export type RequestProofContext = {
  nonce: string;
  proof: string;
  ts: string;
};

export function generateRequestNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export type EnvelopeDirection = "request" | "response";
export type WSFrameDirection = "c2s" | "s2c";

export function buildEnvelopeAAD(
  direction: EnvelopeDirection,
  method: string,
  path: string,
  nonce: string,
): Uint8Array {
  return textEncoder.encode(["mindfs-envelope-v1", direction, method, path, nonce].join("\x1f"));
}

export function buildWSAAD(direction: WSFrameDirection, sequence: number): Uint8Array {
  return textEncoder.encode(["mindfs-ws-frame-v1", direction, String(sequence)].join("\x1f"));
}

export async function buildRequestProof(
  key: Uint8Array,
  method: string,
  path: string,
  ts: string,
  nonce: string,
  clientId: string,
): Promise<string> {
  return buildTransportProof(key, "mindfs-request-proof", [method, path, ts, nonce, clientId]);
}

export async function buildStreamMetadataProof(
  key: Uint8Array,
  method: string,
  path: string,
  nonce: string,
  contentType: string,
  contentLength: string,
  contentDisposition: string,
  streamMarker: string,
): Promise<string> {
  return buildTransportProof(key, "mindfs-stream-meta-v1", [
    method,
    path,
    nonce,
    contentType,
    contentLength,
    contentDisposition,
    streamMarker,
  ]);
}

async function buildTransportProof(key: Uint8Array, label: string, parts: string[]): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    toArrayBuffer(textEncoder.encode([label, ...parts].join("\x1f"))),
  );
  const signature = await crypto.subtle.sign("HMAC", hmacKey, digest);
  return encodeBase64(new Uint8Array(signature));
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
