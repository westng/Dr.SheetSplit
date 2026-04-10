export interface HttpRequestOptions extends RequestInit {
  timeoutMs?: number;
}

async function request(
  url: string,
  { timeoutMs = 8_000, headers, ...options }: HttpRequestOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      ...options,
      signal: controller.signal,
      headers: {
        ...headers,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function getJson<T>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<T> {
  const response = await request(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
  });
  return (await response.json()) as T;
}

export async function getText(url: string, options: HttpRequestOptions = {}): Promise<string> {
  const response = await request(url, options);
  return await response.text();
}
