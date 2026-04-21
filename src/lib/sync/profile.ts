import fs from 'node:fs';
import path from 'node:path';
import type { Connection } from '../types.js';
import type { OneApi } from '../api.js';
import type { SyncProfile } from './types.js';

const PROFILES_DIR = path.join('.one', 'sync', 'profiles');

function profilePath(platform: string, model: string): string {
  return path.join(PROFILES_DIR, `${platform}_${model}.json`);
}

export function readProfile(platform: string, model: string): SyncProfile | null {
  const filePath = profilePath(platform, model);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as SyncProfile;
  } catch {
    return null;
  }
}

export function writeProfile(profile: SyncProfile): void {
  const required: (keyof SyncProfile)[] = ['platform', 'model', 'actionId', 'idField', 'pagination'];
  for (const field of required) {
    if (!profile[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
  // Either `connectionKey` (legacy literal) or `connection` (late-bound ref)
  // must be set — never both, never neither. The two forms are mutually
  // exclusive at write time so a profile has one source of truth for which
  // connection it targets.
  const hasKey = !!profile.connectionKey;
  const hasRef = !!profile.connection?.platform;
  if (hasKey && hasRef) {
    throw new Error(
      'Profile has both `connectionKey` and `connection` — set exactly one. ' +
      'Prefer `connection: { platform, tag? }` so re-auth doesn\'t break the profile.'
    );
  }
  if (!hasKey && !hasRef) {
    throw new Error(
      'Missing connection: set `connection: { platform: "<name>" }` ' +
      '(or legacy `connectionKey: "<key>"`).'
    );
  }
  // resultsPath is required but empty string / "$" / "." all mean "root array",
  // so we only reject `undefined` (not explicitly set by the caller).
  if (profile.resultsPath === undefined) {
    throw new Error('Missing required field: resultsPath (use "" or "$" for root-array responses)');
  }
  if (!profile.pagination.type) {
    throw new Error('Missing required field: pagination.type');
  }

  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const filePath = profilePath(profile.platform, profile.model);
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
}

/**
 * Resolve a profile's connection to a literal key. Returns the existing
 * `connectionKey` if set, otherwise resolves the `connection` ref via the
 * API. Pass `cache` (a pre-fetched connection list) when resolving many
 * profiles in a row to avoid duplicate listConnections calls.
 *
 * Throws with a descriptive message if neither field is set or the ref
 * doesn't resolve to a single connection.
 */
export async function resolveProfileConnectionKey(
  api: OneApi,
  profile: SyncProfile,
  cache?: Connection[]
): Promise<string> {
  if (profile.connectionKey) return profile.connectionKey;
  if (!profile.connection?.platform) {
    throw new Error(
      `Profile ${profile.platform}/${profile.model} has no connectionKey or connection ref.`
    );
  }
  const conn = await api.resolveConnection(profile.connection, cache);
  return conn.key;
}

/**
 * Write a partial/draft profile without validation. Used by `sync init`
 * (no --config) so the user can later patch missing fields via --config.
 */
export function writeDraftProfile(platform: string, model: string, draft: Record<string, unknown>): void {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const filePath = profilePath(platform, model);
  fs.writeFileSync(filePath, JSON.stringify(draft, null, 2));
}

export function listProfiles(platform?: string): SyncProfile[] {
  if (!fs.existsSync(PROFILES_DIR)) return [];

  const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'));
  const profiles: SyncProfile[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(PROFILES_DIR, file), 'utf-8');
      const profile = JSON.parse(raw) as SyncProfile;
      if (!platform || profile.platform === platform) {
        profiles.push(profile);
      }
    } catch {
      // Skip corrupted profile files
    }
  }

  return profiles;
}

export function removeProfile(platform: string, model: string): boolean {
  const filePath = profilePath(platform, model);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function generateTemplate(platform: string, model: string, actionId?: string): Record<string, unknown> {
  return {
    platform,
    model,
    // Late-bound ref — survives re-auth. Use { platform, tag } when the
    // platform has multiple connections (e.g. multiple Gmail accounts).
    connection: { platform },
    actionId: actionId ?? 'FILL_IN',
    resultsPath: 'FILL_IN',
    idField: 'FILL_IN',
    pagination: {
      type: 'FILL_IN (cursor | token | offset | id | link | none)',
      nextPath: 'FILL_IN',
      passAs: 'FILL_IN (query:name | body:name | header:name)',
    },
    // Optional. Set to "body" for POST-body list endpoints (e.g. Notion /v1/search).
    // limitLocation: "query",
    // Optional. Page size param name. Set to "" to disable sending any page size.
    // limitParam: "limit",
    // Optional. Default page size (100).
    // defaultLimit: 100,
  };
}
