import pc from 'picocolors';

interface Column {
  key: string;
  label: string;
  align?: 'left' | 'right';
  color?: (value: string) => string;
}

/**
 * Print a formatted table to stdout.
 * Automatically sizes columns to content with a 2-space gap.
 */
export function printTable(columns: Column[], rows: Record<string, string>[]): void {
  if (rows.length === 0) return;

  const gap = '  ';
  const indent = '  ';

  // Calculate column widths (max of header and all values, using raw string length)
  const widths = columns.map(col => {
    const headerLen = col.label.length;
    const maxValueLen = Math.max(...rows.map(row => stripAnsi(row[col.key] || '').length));
    return Math.max(headerLen, maxValueLen);
  });

  // Header
  const header = columns.map((col, i) => {
    const padded = col.align === 'right'
      ? col.label.padStart(widths[i])
      : col.label.padEnd(widths[i]);
    return pc.dim(padded);
  }).join(gap);
  console.log(`${indent}${header}`);

  // Separator
  const separator = columns.map((_, i) => pc.dim('─'.repeat(widths[i]))).join(gap);
  console.log(`${indent}${separator}`);

  // Rows
  for (const row of rows) {
    const line = columns.map((col, i) => {
      const raw = row[col.key] || '';
      const rawLen = stripAnsi(raw).length;
      const padding = widths[i] - rawLen;
      const colored = col.color ? col.color(raw) : raw;

      if (col.align === 'right') {
        return ' '.repeat(Math.max(0, padding)) + colored;
      }
      return colored + ' '.repeat(Math.max(0, padding));
    }).join(gap);
    console.log(`${indent}${line}`);
  }
}

// Strip ANSI escape codes for length calculation
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
