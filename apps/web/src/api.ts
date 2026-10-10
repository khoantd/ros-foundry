export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function parseBody(text: string, status: number): unknown {
  if (!text) {
    if (status >= 200 && status < 300) return undefined;
    throw new ApiError(
      status === 429
        ? "Too many requests. Wait a moment, then retry."
        : "Couldn’t reach the API. Retry in a moment.",
      status || 502,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(
      status >= 200 && status < 300
        ? "Unexpected response from the server"
        : "Couldn’t reach the API. Retry in a moment.",
      status || 502,
    );
  }
}

export async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
  extraHeaders?: Record<string, string>,
  options?: Pick<RequestInit, "keepalive">,
): Promise<T> {
  const res = await fetch("/api/v1" + path, {
    ...options,
    credentials: "same-origin",
    method: method || (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const data = parseBody(await res.text(), res.status) as any;
  if (!res.ok)
    throw new ApiError(
      typeof data?.error === "string" ? data.error : "Request failed",
      res.status,
    );
  return data;
}
export const number = (n: number | undefined) =>
  new Intl.NumberFormat("en-US").format(n || 0);
export const relative = (date: string) => {
  const min = Math.floor((Date.now() - Date.parse(date)) / 60000);
  return min < 1
    ? "just now"
    : min < 60
      ? `${min}m ago`
      : min < 1440
        ? `${Math.floor(min / 60)}h ago`
        : new Date(date).toLocaleDateString();
};
