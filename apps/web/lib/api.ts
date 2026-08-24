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

    try {
      const body =
        await response.json();

      message =
        body.message ?? message;
    } catch {
      throw new Error(message);
    }

    throw new Error(message);
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