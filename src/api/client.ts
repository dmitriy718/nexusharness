export class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    const raw = (payload as { error?: unknown }).error;
    const message = typeof raw === "string" ? raw : JSON.stringify(raw ?? payload);
    throw new ApiError(message, response.status, payload);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.payload && typeof error.payload === "object") {
    const raw = (error.payload as { error?: unknown }).error;
    if (Array.isArray(raw)) return raw.map((issue) => {
      if (!issue || typeof issue !== "object") return String(issue);
      const value = issue as { path?: unknown[]; message?: unknown };
      const path = Array.isArray(value.path) && value.path.length ? `${value.path.join(".")}: ` : "";
      return `${path}${String(value.message ?? "Invalid value")}`;
    }).join(" · ");
    if (typeof raw === "string") return raw;
  }
  return error instanceof Error ? error.message : String(error);
}
