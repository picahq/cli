/**
 * Access resolution — turning the configured access control (permission level,
 * connection scope, action allowlist) into a concrete answer to "what can I run
 * on this connection?".
 *
 * `one list` reports this per connection so an agent knows its reach up front,
 * instead of discovering it as a 403 halfway through a workflow. The shapes
 * mirror the One MCP server's `list_one_integrations` `access` field, so an
 * agent that has learned one surface already understands the other.
 *
 * Precedence (same as the MCP server and One core):
 *   action allowlist  >  permission level  >  full access
 */

import type { OneApi } from './api.js';
import { PERMISSION_METHODS } from './api.js';
import { resolveActionDetails } from './action-details.js';
import type {
  ConnectionAccess,
  PermissionLevel,
  ResolvedAllowedAction,
} from './types.js';

/**
 * Resolves an allowlist of action ids to their metadata (title, method, and
 * owning platform), so each connection can report the exact actions it may run.
 *
 * `['*']` (unrestricted) resolves to an empty list — there is no allowlist to
 * enumerate, and no network call is made. Ids that fail to resolve, or that
 * carry no platform, are skipped rather than failing the whole listing; the
 * caller reports them separately so nothing is dropped silently.
 *
 * Resolution goes through the knowledge cache, so a scoped config pays the
 * lookup once and reads from disk afterwards.
 */
export async function resolveAllowedActions(
  api: Pick<OneApi, 'getActionDetailsWithMeta'>,
  actionIds: string[]
): Promise<ResolvedAllowedAction[]> {
  if (actionIds.includes('*')) return [];

  const resolved = await Promise.all(
    actionIds.map(async (actionId): Promise<ResolvedAllowedAction | null> => {
      try {
        // Silence the stale-cache warning: a listing shouldn't print a network
        // notice per allowlisted action.
        const { details } = await resolveActionDetails(api, actionId, { warn: () => {} });
        if (!details.connectionPlatform) return null;
        return {
          actionId,
          title: details.title,
          method: details.method,
          platform: details.connectionPlatform,
        };
      } catch {
        return null;
      }
    })
  );

  return resolved.filter((a): a is ResolvedAllowedAction => a !== null);
}

/**
 * What the current access config lets you run on a connection of `platform`.
 *
 * `grantedActions` is the allowlist already resolved by `resolveAllowedActions`
 * and filtered by the permission level — pass `[]` when the allowlist is `['*']`.
 */
export function computeConnectionAccess(
  platform: string,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  grantedActions: ResolvedAllowedAction[]
): ConnectionAccess {
  if (!allowedActionIds.includes('*')) {
    const actions = grantedActions
      .filter(a => a.platform === platform)
      .map(({ actionId, title, method }) => ({ actionId, title, method }));
    return { policy: 'actions', actions };
  }

  const methods = PERMISSION_METHODS[permissions];
  if (methods !== null) {
    return { policy: 'methods', methods };
  }

  return { policy: 'full' };
}

/**
 * One-line rendering of a connection's access for the human-readable table.
 * Action lists are truncated — the full list is in `--agent` output.
 */
export function formatAccess(access: ConnectionAccess, maxActions = 2): string {
  switch (access.policy) {
    case 'full':
      return 'full';
    case 'methods':
      return access.methods.join(', ');
    case 'actions': {
      if (access.actions.length === 0) return 'none';
      const shown = access.actions.slice(0, maxActions).map(a => `${a.title} (${a.method})`);
      const rest = access.actions.length - shown.length;
      return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
    }
  }
}
