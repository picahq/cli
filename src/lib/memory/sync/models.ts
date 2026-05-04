import type { OneApi } from '../../api.js';
import type { DiscoveredModel } from './types.js';

interface RawAvailableAction {
  title: string;
  key: string;
  modelName: string;
  method: string;
  path: string;
  tags?: string[];
}

/**
 * Parse an action key to extract action type.
 * Format: api::{platform}::{version}::{model}::{actionType}::{path}::{title}::{hash}
 */
function parseActionType(actionKey: string): string | null {
  const parts = actionKey.split('::');
  if (parts.length < 5) return null;
  return parts[4];
}

/**
 * Custom/composer actions are one-off helpers backed by small, shared servers
 * not designed for sync-scale load. Sync hard-blocks them — profiles must use
 * passthrough actions and let the sync engine handle pagination/enrichment.
 */
function isCustomAction(tags: string[] | undefined): boolean {
  return !!tags && tags.includes('custom');
}

/**
 * Discover available data models for a platform by fetching all actions
 * and filtering to list/get_many operations.
 *
 * Resolves each discovered model's action to its executable ID
 * (conn_mod_def:: format) so the returned actionId can be used directly
 * in sync profiles.
 */
export async function discoverModels(api: OneApi, platform: string): Promise<DiscoveredModel[]> {
  const actions = await api.listAvailableActions(platform) as unknown as RawAvailableAction[];

  const listActionTypes = new Set(['get_many', 'list', 'get_all']);
  const modelMap = new Map<string, DiscoveredModel>();

  for (const action of actions) {
    const actionType = parseActionType(action.key);
    if (!actionType) continue;
    if (!listActionTypes.has(actionType)) continue;
    if (isCustomAction(action.tags)) continue;

    const modelName = action.modelName;
    if (!modelName) continue;

    // Prefer get_many over others
    if (modelMap.has(modelName)) {
      const existing = modelMap.get(modelName)!;
      const existingType = parseActionType(existing.listAction.actionId);
      if (existingType === 'get_many') continue;
    }

    modelMap.set(modelName, {
      name: modelName,
      displayName: action.title,
      listAction: {
        actionId: action.key,
        path: action.path,
        method: action.method,
      },
    });
  }

  // Resolve each discovered model's executable action ID in parallel.
  // `searchActions` hits /available-actions/search which DOES return tags,
  // so we can reject custom matches here (unlike the listAvailableActions
  // result above, where tags aren't populated today).
  const models = Array.from(modelMap.values());
  await Promise.all(
    models.map(async model => {
      try {
        const searchResults = await api.searchActions(platform, model.displayName, 'execute');
        const resolved = searchResults.find(
          a =>
            a.path === model.listAction.path &&
            a.method === model.listAction.method &&
            !isCustomAction(a.tags),
        );
        if (resolved?.systemId) {
          model.listAction.actionId = resolved.systemId;
        }
      } catch {
        // Leave the api:: key if resolution fails — the filter below drops it.
      }
    }),
  );

  // Drop any model that couldn't be resolved to an executable passthrough.
  // Unresolved models either have no passthrough variant (the only match was
  // custom and got filtered) or the search API failed. Either way, sync
  // can't execute them — surfacing them in `sync init` only creates dead ends.
  const syncable = models.filter(m => m.listAction.actionId.startsWith('conn_mod_def::'));

  return syncable.sort((a, b) => a.name.localeCompare(b.name));
}
