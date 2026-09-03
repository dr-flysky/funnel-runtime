// Типы ответов берутся из серверных модулей: это `import type`, он стирается при
// сборке, поэтому серверный код в бандл не попадает, а формы не расходятся.
import type { SessionView as ServerSessionView } from '@server/sessions';
import type { ActivationRow, VersionSummary } from '@server/versions';
import type { AnalyticsReport } from '@server/analytics';

export type { ActivationRow, AnalyticsReport, VersionSummary };

/** Ответ на запись: вид сессии плюс поля, которые сервер добавляет только к нему. */
export interface SessionView extends ServerSessionView {
  answerSummary?: Record<string, unknown>;
  reachedResult?: boolean;
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
    request<{ funnelKey: string; versions: VersionSummary[]; activations: ActivationRow[] }>(
      `/api/admin/versions?funnelKey=${encodeURIComponent(funnelKey)}`,
    ),

  configFiles: () =>
    request<{
      files: {
        file: string;
        key: string | null;
        name: string;
        steps: number;
        sourceVersion: number | null;
      }[];
    }>('/api/admin/config-files'),

  publishFile: (file: string, note?: string) =>
    post<VersionSummary>('/api/admin/publish-file', { file, note }),

  activate: (funnelKey: string, versionId: number) =>
    post<VersionSummary>('/api/admin/activate', { funnelKey, versionId }),

  rollback: (funnelKey: string) => post<VersionSummary>('/api/admin/rollback', { funnelKey }),

  analytics: (params: Record<string, string>) =>
    request<AnalyticsReport>(`/api/analytics?${new URLSearchParams(params).toString()}`),
};
