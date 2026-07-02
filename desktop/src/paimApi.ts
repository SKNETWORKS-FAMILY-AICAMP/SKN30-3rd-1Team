const PAIM_API_ROOT_URL = (
  (import.meta.env.VITE_PAIM_API_BASE_URL as string | undefined) || "http://127.0.0.1:8000"
)
  .replace(/\/+$/, "")
  .replace(/\/api\/v1$/, "");

const PAIM_API_V1_BASE_URL = `${PAIM_API_ROOT_URL}/api/v1`;

type PaimApiErrorPayload = {
  detail?: unknown;
  code?: unknown;
};

export class PaimApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "PaimApiError";
    this.status = status;
    this.code = code;
  }
}

export function isPaimApiError(error: unknown): error is PaimApiError {
  return error instanceof PaimApiError;
}

async function readPaimResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as PaimApiErrorPayload | null;
    const detail = typeof payload?.detail === "string" ? payload.detail : "PaiM API 요청 실패";
    const code = typeof payload?.code === "string" ? payload.code : undefined;

    throw new PaimApiError(detail, response.status, code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

// PaiM FastAPI JSON 엔드포인트를 동일한 에러 형태로 호출한다.
async function fetchPaimJsonFrom<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  return readPaimResponse<T>(response);
}

// 일반 PaiM API는 /api/v1 prefix를 사용한다.
export async function fetchPaimJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetchPaimJsonFrom<T>(PAIM_API_V1_BASE_URL, path, init);
}

// FormData 업로드는 브라우저가 multipart boundary를 붙이도록 Content-Type을 지정하지 않는다.
export async function fetchPaimFormData<T>(
  path: string,
  formData: FormData,
  init?: Omit<RequestInit, "body">,
): Promise<T> {
  const response = await fetch(`${PAIM_API_V1_BASE_URL}${path}`, {
    ...init,
    method: init?.method ?? "POST",
    body: formData,
  });

  return readPaimResponse<T>(response);
}

// GitHub App API와 health check는 서버 루트 경로를 사용한다.
export async function fetchPaimRootJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetchPaimJsonFrom<T>(PAIM_API_ROOT_URL, path, init);
}

export function getErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "string" && error) {
    return error;
  }

  return error instanceof Error && error.message ? error.message : fallback;
}
