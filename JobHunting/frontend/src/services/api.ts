import type {
  ApiErrorBody, HealthResponse, JobResponse, PreviewRequest, PreviewResponse,
  RecruitersResponse, SendRequest, SendResponse,
} from "../types/api";

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public details: unknown[] = [],
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError("Cannot reach the API. Is the backend running?", "NETWORK_ERROR", 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const e = (body as ApiErrorBody | null)?.error;
    throw new ApiError(e?.message ?? `Request failed (${res.status}).`, e?.code ?? "HTTP_ERROR", res.status, e?.details ?? []);
  }
  return body as T;
}

const post = <T>(path: string, data: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(data) });

export const api = {
  health: () => request<HealthResponse>("/health"),
  recruiters: () => request<RecruitersResponse>("/recruiters"),
  preview: (b: PreviewRequest) => post<PreviewResponse>("/emails/preview", b),
  send: (b: SendRequest) => post<SendResponse>("/emails/send", b),
  job: (id: string) => request<JobResponse>(`/emails/jobs/${encodeURIComponent(id)}`),
};
