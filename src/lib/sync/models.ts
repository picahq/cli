import type { OneApi } from '../api.js';
import type { DiscoveredModel } from './types.js';

interface RawAvailableAction {
  title: string;
  key: string;
  modelName: string;
  method: string;
  path: string;
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
  const models = Array.from(modelMap.values());
  await Promise.all(
    models.map(async model => {
      try {
        const searchResults = await api.searchActions(platform, model.displayName, 'execute');
        const resolved = searchResults.find(
          a => a.path === model.listAction.path && a.method === model.listAction.method,
        );
        if (resolved?.systemId) {
          model.listAction.actionId = resolved.systemId;
        }
      } catch {
        // Leave the api:: key if resolution fails — the user can still resolve manually
      }
    }),
  );

  return models.sort((a, b) => a.name.localeCompare(b.name));
}
