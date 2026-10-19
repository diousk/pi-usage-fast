import { errorMessage, redactUsageError } from "./core.js";
import type { ResolvedUsageAuth } from "./types.js";

const MAX_SUCCESS_BODY_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;

export async function fetchProviderJson(
  url: string,
  auth: ResolvedUsageAuth,
  signal: AbortSignal,
  timeoutMs: number,
  description: string,
  request: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    redirect?: RequestRedirect;
    userAgent?: boolean;
    responseError?: (status: number, text: string) => string | undefined;
  } = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const headers = { ...auth.headers };
    if (request.userAgent !== false && !hasHeader(headers, "User-Agent")) {
      headers["User-Agent"] = "pi-usage";
    }
    if (request.body && !hasHeader(headers, "Content-Type")) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url, {
      method: request.method ?? "GET",
      headers,
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      ...(request.redirect ? { redirect: request.redirect } : {}),
      signal: controller.signal,
    });
    if (response.redirected) throw new Error(`${description} refused a redirected response.`);
    if (controller.signal.aborted) throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
    const text = await readBoundedResponse(
      response,
      response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES,
      !response.ok,
      description,
      controller.signal,
    );
    if (controller.signal.aborted) throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
    const responseError = request.responseError?.(response.status, text);
    if (responseError) throw new Error(responseError);
    if (!response.ok) {
      throw new Error(
        `${description} returned ${response.status} ${response.statusText}: ${redactUsageError(text, auth.secrets)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`${description} returned invalid JSON: ${errorMessage(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${description} response was not an object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (timedOut) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s while fetching usage.`);
    }
    if (signal.aborted) throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromCaller);
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  truncateOverflow: boolean,
  description: string,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const abort = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  if (truncated && !truncateOverflow) {
    throw new Error(`${description} response exceeded ${maxBytes} bytes.`);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  return truncated ? `${text}…` : text;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}
