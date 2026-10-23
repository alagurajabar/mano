interface ApiError {
  error?: string;
}

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let csrfToken: string | undefined;

async function requestJson<T>(response: Response): Promise<T & ApiError> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    if (response.status >= 500) {
      throw new ApiRequestError(
        "DriveVault API is not responding. Start it with start-all.bat, then refresh this page.",
        response.status,
      );
    }
    throw new ApiRequestError("DriveVault returned an unexpected response. Please refresh.", response.status);
  }

  let result: T & ApiError;
  try {
    result = (await response.json()) as T & ApiError;
  } catch {
    throw new ApiRequestError(
      "DriveVault returned an invalid response. Check the API window, then refresh this page.",
      response.status,
    );
  }

  if (!response.ok) {
    throw new ApiRequestError(result.error ?? `Request failed (HTTP ${response.status}).`, response.status);
  }
  return result;
}

async function fetchApi(path: string, options?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, options);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Cannot reach DriveVault API. Start both services with start-all.bat and refresh.");
    }
    throw error;
  }
}

async function refreshCsrfToken(): Promise<void> {
  const response = await fetchApi("/api/auth/csrf", { credentials: "include" });
  const result = await requestJson<{ csrfToken: string }>(response);
  csrfToken = result.csrfToken;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !csrfToken) {
    await refreshCsrfToken();
  }

  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  const response = await fetchApi(path, {
    ...options,
    method,
    headers,
    credentials: "include",
  });
  if (response.status === 204) return undefined as T;

  const result = (await requestJson<T>(response)) as T & { csrfToken?: string };
  if (result.csrfToken) csrfToken = result.csrfToken;
  return result;
}

export function clearCsrfToken(): void {
  csrfToken = undefined;
}
