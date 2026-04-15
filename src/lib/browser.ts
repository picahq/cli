import open from 'open';

const ONE_APP_URL = 'https://app.withone.ai';

export interface ConnectionUrlParams {
  orgId?: string;
  projectId?: string;
  env?: 'live' | 'test';
}

export function getConnectionUrl(platform: string, params?: ConnectionUrlParams): string {
  const searchParams = new URLSearchParams();
  if (params?.orgId) searchParams.set('orgId', params.orgId);
  if (params?.projectId) searchParams.set('projectId', params.projectId);
  if (params?.env) searchParams.set('env', params.env);

  const qs = searchParams.toString();
  return `${ONE_APP_URL}/${qs ? `?${qs}` : ''}#open=${platform}`;
}

export function getApiKeyUrl(): string {
  return `${ONE_APP_URL}/settings/api-keys`;
}

export async function openConnectionPage(platform: string, params?: ConnectionUrlParams): Promise<void> {
  const url = getConnectionUrl(platform, params);
  await open(url);
}

export async function openApiKeyPage(): Promise<void> {
  await open(getApiKeyUrl());
}

export function getCliAuthUrl(port: number, state: string): string {
  return `${ONE_APP_URL}/cli/auth?port=${port}&state=${encodeURIComponent(state)}`;
}

export async function openCliAuthPage(port: number, state: string): Promise<void> {
  const url = getCliAuthUrl(port, state);
  await open(url);
}
