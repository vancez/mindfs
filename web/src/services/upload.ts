import { appURL } from "./base";
import { e2eeService, type FileProofContext } from "./e2ee";
import { buildEncryptedUploadBody } from "./e2eeMultipart";
import { E2EE_STREAM_MARKER_HEADER, E2EE_STREAM_MARKER_UPLOAD } from "./e2eeStream";

export type UploadedFile = {
  path: string;
  agent_path?: string;
  name: string;
  mime: string;
  size: number;
};

export type UploadProgress = {
  loaded: number;
  total: number;
  percent: number;
  speedBps: number;
};

type UploadResponse = {
  files?: UploadedFile[];
};

export async function uploadFiles(params: {
  rootId: string;
  files: File[];
  dir?: string;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<UploadedFile[]> {
  const query = new URLSearchParams({ root: params.rootId });
  const requestURL = appURL("/api/upload", query);
  let body: FormData | Blob;
  let headers: Headers | undefined;
  let proof: FileProofContext | null = null;
  if (e2eeService.isRequired()) {
    proof = await e2eeService.fileProofContext("POST", requestURL);
    const encrypted = await buildEncryptedUploadBody({
      files: params.files,
      dir: params.dir,
      key: proof.key,
      requestNonce: proof.nonce,
      signal: params.signal,
    });
    headers = new Headers(proof.headers);
    headers.set("Content-Type", `multipart/form-data; boundary=${encrypted.boundary}`);
    headers.set(E2EE_STREAM_MARKER_HEADER, E2EE_STREAM_MARKER_UPLOAD);
    body = encrypted.blob;
  } else {
    const formData = new FormData();
    params.files.forEach((file) => {
      formData.append("files", file);
    });
    if (params.dir) {
      formData.append("dir", params.dir);
    }
    body = formData;
  }

  const response = await uploadBody(requestURL, body, headers, params.onProgress, params.signal);
  if (!response.ok) {
    if (response.status === 401 && e2eeService.isRequired()) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (e2eeService.handleServerError(String(payload.error || ""))) {
        return uploadFiles(params);
      }
      throw new Error(payload.error || `Upload failed: ${response.status}`);
    }
    let message = `Upload failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload?.error) {
        message = payload.error;
      }
    } catch {
    }
    throw new Error(message);
  }
  const payload = await e2eeService.parseProtectedJSONResponse<UploadResponse>(
    response,
    proof ? { context: proof.context } : undefined,
  );
  return Array.isArray(payload.files) ? payload.files : [];
}

export function isUploadAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function uploadBody(
  requestURL: string,
  body: FormData | Blob,
  headers: Headers | undefined,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(uploadAbortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    const startTime = performance.now();
    let lastLoaded = 0;
    let lastTime = startTime;
    let lastSpeedBps = 0;
    xhr.open("POST", requestURL, true);
    headers?.forEach((value, key) => {
      xhr.setRequestHeader(key, value);
    });
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        return;
      }
      const now = performance.now();
      const elapsedSeconds = Math.max((now - lastTime) / 1000, 0.001);
      lastSpeedBps = Math.max(0, (event.loaded - lastLoaded) / elapsedSeconds);
      lastLoaded = event.loaded;
      lastTime = now;
      onProgress?.({
        loaded: event.loaded,
        total: event.total,
        percent: Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100))),
        speedBps: lastSpeedBps,
      });
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      xhr.abort();
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Upload failed: network error"));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new Error("Upload failed: timeout"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(uploadAbortError());
    };
    xhr.onload = () => {
      cleanup();
      onProgress?.({ loaded: 1, total: 1, percent: 100, speedBps: lastSpeedBps });
      resolve(new Response(xhr.responseText, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: parseXHRHeaders(xhr.getAllResponseHeaders()),
      }));
    };
    xhr.send(body);
  });
}

function parseXHRHeaders(rawHeaders: string): Headers {
  const headers = new Headers();
  rawHeaders.trim().split(/[\r\n]+/).forEach((line) => {
    const index = line.indexOf(":");
    if (index <= 0) {
      return;
    }
    headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
  });
  return headers;
}

function uploadAbortError(): Error {
  const error = new Error("Upload aborted");
  error.name = "AbortError";
  return error;
}
