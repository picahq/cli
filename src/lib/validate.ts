import { ActionDetails } from './types.js';

interface MissingParam {
  flag: string;
  param: string;
  description?: string;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; missing: MissingParam[] };

const SCHEMA_GROUP_TO_FLAG: Record<string, string> = {
  path: '--path-vars',
  query: '--query-params',
  body: '-d',
};

export function validateActionInput(
  action: ActionDetails,
  args: {
    data?: Record<string, unknown>;
    pathVariables?: Record<string, unknown>;
    queryParams?: Record<string, unknown>;
  },
): ValidationResult {
  const inputSchema = action.ioSchema?.inputSchema;
  if (!inputSchema?.properties) return { valid: true };

  const argMap: Record<string, Record<string, unknown> | undefined> = {
    path: args.pathVariables,
    query: args.queryParams,
    body: args.data,
  };

  const missing: MissingParam[] = [];

  for (const [group, flag] of Object.entries(SCHEMA_GROUP_TO_FLAG)) {
    const groupSchema = inputSchema.properties[group];
    if (!groupSchema?.required?.length) continue;

    const provided = argMap[group] ?? {};
    for (const param of groupSchema.required) {
      if (provided[param] === undefined || provided[param] === null || provided[param] === '') {
        missing.push({
          flag,
          param,
          description: groupSchema.properties?.[param]?.description,
        });
      }
    }
  }

  if (missing.length === 0) return { valid: true };
  return { valid: false, missing };
}
