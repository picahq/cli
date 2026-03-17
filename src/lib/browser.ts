import open from 'open';

const ONE_APP_URL = 'https://app.withone.ai';

export function getConnectionUrl(platform: string): string {
  return `${ONE_APP_URL}/connections?#open=${platform}`;
}

export function getApiKeyUrl(): string {
  return `${ONE_APP_URL}/settings/api-keys`;
}

export async function openConnectionPage(platform: string): Promise<void> {
  const url = getConnectionUrl(platform);
  await open(url);
}

export async function openApiKeyPage(): Promise<void> {
  await open(getApiKeyUrl());
}
