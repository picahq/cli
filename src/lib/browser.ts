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
