const API_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:5000";

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(
    `${API_URL}${path}`,
    {
      ...options,

      credentials: "include",

      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    },
  );

  if (!response.ok) {
    let message =
      "Something went wrong";
    let code: string | undefined;

    try {
      const body =
        await response.json();

      message =
        body.message ?? message;
      if (typeof body.code === "string") {
        code = body.code;
      }
    } catch {
      const err = new Error(message);
      throw err;
    }

    // Phase 4A: preserve stable server error codes (e.g. GIT_NOT_CONNECTED)
    // so callers can branch on them. Additive — existing catch sites that
    // read only `.message` are unaffected.
    const err = new Error(message) as Error & { code?: string; status?: number };
    if (code) err.code = code;
    err.status = response.status;
    throw err;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const api = {
  get<T>(path: string) {
    return request<T>(path);
  },

  post<T>(
    path: string,
    body: unknown,
  ) {
    return request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  put<T>(
    path: string,
    body: unknown,
  ) {
    return request<T>(path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  patch<T>(
    path: string,
    body: unknown,
  ) {
    return request<T>(path, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  delete<T>(path: string) {
    return request<T>(path, {
      method: "DELETE",
    });
  },
};