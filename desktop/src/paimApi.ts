const PAIM_API_BASE_URL = (
  (import.meta.env.VITE_PAIM_API_BASE_URL as string | undefined) || "http://127.0.0.1:8000"
).replace(/\/$/, "");

// PaiM FastAPI JSON 엔드포인트를 동일한 에러 형태로 호출한다.
export async function fetchPaimJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${PAIM_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    const detail = typeof payload?.detail === "string" ? payload.detail : "PaiM API 요청 실패";

    throw new Error(detail);
  }

  return response.json() as Promise<T>;
}

export function getErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "string" && error) {
    return error;
  }

  return error instanceof Error && error.message ? error.message : fallback;
}
