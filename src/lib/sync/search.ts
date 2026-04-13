import { openDatabase, tableExists, listTables, listSyncedPlatforms } from './db.js';

export interface SearchResult {
  platform: string;
  model: string;
  record: Record<string, unknown>;
  rank: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
}

/**
 * Full-text search across synced models using FTS5.
 * If platform is omitted, searches all synced platforms.
 */
export async function searchSyncedData(
  query: string,
  options: { platform?: string; models?: string[]; limit?: number },
): Promise<SearchResponse> {
  const limit = options.limit ?? 20;
  const platforms = options.platform ? [options.platform] : listSyncedPlatforms();

  if (platforms.length === 0) {
    throw new Error('No synced data found. Run \'one sync run <platform>\' first.');
  }

  // Add prefix wildcard to each search term for better matching
  // "tech" → "tech*" so it matches "Technology", "technical", etc.
  const ftsQuery = query
    .split(/\s+/)
    .map(term => term.includes('*') || term.includes('"') ? term : `${term}*`)
    .join(' ');

  const allResults: SearchResult[] = [];

  for (const platform of platforms) {
    const db = await openDatabase(platform);
    try {
      const tables = options.models ?? listTables(db);

      for (const model of tables) {
        if (!tableExists(db, model)) continue;

        const ftsTable = `${model}_fts`;
        const ftsExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(ftsTable);
        if (!ftsExists) continue;

        try {
          // JOIN FTS table with main table via rowid to get full record data
          const rows = db.prepare(`
            SELECT "${model}".*, "${ftsTable}".rank
            FROM "${ftsTable}"
            JOIN "${model}" ON "${model}".rowid = "${ftsTable}".rowid
            WHERE "${ftsTable}" MATCH ?
            ORDER BY rank
            LIMIT ?
          `).all(ftsQuery, limit) as Array<Record<string, unknown> & { rank: number }>;

          for (const row of rows) {
            const rank = row.rank as number;
            const record: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(row)) {
              if (key === 'rank') continue;
              if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
                try { record[key] = JSON.parse(value); } catch { record[key] = value; }
              } else {
                record[key] = value;
              }
            }
            allResults.push({ platform, model, record, rank });
          }
        } catch {
          // FTS query failed for this table — skip it
        }
      }

      db.close();
    } catch {
      try { db.close(); } catch { /* ignore */ }
    }
  }

  // Sort by rank (more negative = better match) and apply global limit
  allResults.sort((a, b) => a.rank - b.rank);
  const limited = allResults.slice(0, limit);

  return {
    results: limited,
    total: limited.length,
  };
}
