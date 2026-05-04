import { getByDotPath } from '../../dot-path.js';
import type { PaginationConfig, ParsedPassAs } from './types.js';

/** Parse "query:paramName", "header:paramName", or "body:paramName" format */
export function parsePassAs(passAs: string): ParsedPassAs {
  const colonIdx = passAs.indexOf(':');
  if (colonIdx === -1) {
    return { location: 'query', paramName: passAs };
  }
  const location = passAs.slice(0, colonIdx) as 'query' | 'header' | 'body';
  const paramName = passAs.slice(colonIdx + 1);
  if (location === 'header') return { location: 'header', paramName };
  if (location === 'body') return { location: 'body', paramName };
  return { location: 'query', paramName };
}

export interface NextPageParams {
  queryParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  bodyParams?: Record<string, unknown>;
}

/**
 * Given an API response and pagination config, return the params for the next page request.
 * Returns null when there are no more pages.
 */
export function getNextPageParams(
  response: unknown,
  config: PaginationConfig,
  currentPage: number,
  pageSize: number,
  records: unknown[],
): NextPageParams | null {
  switch (config.type) {
    case 'cursor':
    case 'token':
    case 'link':
      return handleCursorLike(response, config);

    case 'offset':
      return handleOffset(response, config, currentPage, pageSize, records);

    case 'id':
      return handleId(response, config, records);

    case 'none':
      return null;

    default:
      return null;
  }
}

function buildParam(location: 'query' | 'header' | 'body', paramName: string, value: unknown): NextPageParams {
  if (location === 'header') return { headers: { [paramName]: String(value) } };
  if (location === 'body') return { bodyParams: { [paramName]: value } };
  return { queryParams: { [paramName]: value } };
}

function handleCursorLike(response: unknown, config: PaginationConfig): NextPageParams | null {
  if (!config.nextPath || !config.passAs) return null;

  const nextValue = getByDotPath(response, config.nextPath);
  if (nextValue === null || nextValue === undefined || nextValue === '') return null;

  const { location, paramName } = parsePassAs(config.passAs);
  return buildParam(location, paramName, nextValue);
}

function handleOffset(
  response: unknown,
  config: PaginationConfig,
  currentPage: number,
  pageSize: number,
  records: unknown[],
): NextPageParams | null {
  if (records.length === 0) return null;

  const nextOffset = (currentPage + 1) * pageSize;

  // If totalPath is provided, check if we've fetched everything
  if (config.totalPath) {
    const total = getByDotPath(response, config.totalPath);
    if (typeof total === 'number' && nextOffset >= total) return null;
  }

  if (!config.passAs) return null;
  const { location, paramName } = parsePassAs(config.passAs);
  return buildParam(location, paramName, nextOffset);
}

function handleId(
  response: unknown,
  config: PaginationConfig,
  records: unknown[],
): NextPageParams | null {
  if (records.length === 0) return null;

  // Check has_more flag
  if (config.hasMorePath) {
    const hasMore = getByDotPath(response, config.hasMorePath);
    if (hasMore === false) return null;
  }

  // Get last record's ID
  const lastRecord = records[records.length - 1];
  const idFieldName = config.idField || 'id';
  const lastId = typeof lastRecord === 'object' && lastRecord !== null
    ? (lastRecord as Record<string, unknown>)[idFieldName]
    : null;

  if (lastId === null || lastId === undefined) return null;
  if (!config.passAs) return null;

  const { location, paramName } = parsePassAs(config.passAs);
  return buildParam(location, paramName, lastId);
}
