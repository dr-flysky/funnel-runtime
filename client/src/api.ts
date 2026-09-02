import type { Answers, FunnelConfig, Progress } from '@shared/funnel';

export interface SessionView {
  sessionId: string;
  funnelKey: string;
  version: number;
  versionId: number;
  variant: string;
  variantSource: string;
  config: FunnelConfig;
  currentStep: string;
  history: string[];
  completed: boolean;
  progress: Progress;
  answers: Answers;
  utm: Record<string, string | null>;
  answerSummary?: Record<string, unknown>;
  reachedResult?: boolean;
}

export interface VersionSummary {
  id: number;
  funnelKey: string;
  version: number;
  name: string;
  note: string | null;
  createdAt: string;
  isActive: boolean;
  stepCount: number;
  variants: string[];
  experimentKey: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: string[],
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, res.status, body.issues);
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  startSession: (funnelKey: string, utm: Record<string, string>, variant?: string | null) =>
    post<SessionView>('/api/session', { funnelKey, utm, variant }),

  resumeSession: (id: string) => request<SessionView>(`/api/session/${id}`),

  answer: (id: string, stepId: string, value: unknown) =>
    post<SessionView>(`/api/session/${id}/answer`, { stepId, value }),

  back: (id: string) => post<SessionView>(`/api/session/${id}/back`),

  funnels: () =>
    request<{ funnels: { key: string; name: string; activeVersion: number | null }[] }>(
      '/api/funnels',
    ),

  versions: (funnelKey: string) =>
    request<{
      funnelKey: string;
      versions: VersionSummary[];
      activations: {
        id: number;
        version: number;
        action: string;
        note: string | null;
        created_at: string;
      }[];
    }>(`/api/admin/versions?funnelKey=${encodeURIComponent(funnelKey)}`),

  configFiles: () =>
    request<{ files: { file: string; key: string | null; name: string; steps: number }[] }>(
      '/api/admin/config-files',
    ),

  publishFile: (file: string, note?: string) =>
    post<VersionSummary>('/api/admin/publish-file', { file, note }),

  activate: (funnelKey: string, versionId: number) =>
    post<VersionSummary>('/api/admin/activate', { funnelKey, versionId }),

  rollback: (funnelKey: string) => post<VersionSummary>('/api/admin/rollback', { funnelKey }),

  analytics: (params: Record<string, string>) =>
    request<any>(`/api/analytics?${new URLSearchParams(params).toString()}`),
};
