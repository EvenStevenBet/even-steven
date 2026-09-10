import { config } from './config.js';

export interface SheetRow {
  rowNumber: number; // 1-indexed; header is row 1, first data row is 2
  gameId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  gameDate: string;
  status: string;
  marketAddress: string;
  openLine_UNUSED: string; // intentionally never read — every market opens at 0
  bettingOpensAt: string;
  notes: string;
  approved: string; // CONTROL 4 — column K
}

// CSV schema (11 columns, fixed — no commas or quotes appear in any value):
// 0 gameId | 1 sport | 2 homeTeam | 3 awayTeam | 4 gameDate | 5 status
// 6 marketAddress | 7 openLine | 8 bettingOpensAt | 9 notes | 10 approved

const GITHUB_API = 'https://api.github.com';

function contentsUrl(): string {
  return `${GITHUB_API}/repos/${config.githubRepoOwner}/${config.githubRepoName}/contents/${config.githubCsvPath}`;
}

function apiHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/**
 * Reads the CSV straight off GitHub every call rather than caching — the file
 * is small (hundreds of rows) and this keeps readRows/writeMarketResult each
 * working off the true current SHA instead of a copy that can go stale.
 */
async function fetchCsvFile(): Promise<{ lines: string[]; sha: string }> {
  const res = await fetch(contentsUrl(), { headers: apiHeaders() });
  if (!res.ok) {
    throw new Error(
      `GitHub contents GET failed for ${config.githubCsvPath}: ${res.status} ${res.statusText} — ${await res.text()}`
    );
  }
  const json = (await res.json()) as { content: string; encoding: string; sha: string };
  const text = Buffer.from(json.content, 'base64').toString('utf-8');

  const lines = text.split('\n');
  // A trailing newline in the file produces one trailing empty element — drop
  // it so line count matches actual rows (including the header).
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return { lines, sha: json.sha };
}

async function putCsvFile(lines: string[], sha: string, message: string): Promise<void> {
  const content = Buffer.from(lines.join('\n') + '\n', 'utf-8').toString('base64');
  const res = await fetch(contentsUrl(), {
    method: 'PUT',
    headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, sha, branch: 'main' }),
  });
  if (!res.ok) {
    throw new Error(
      `GitHub contents PUT failed for ${config.githubCsvPath}: ${res.status} ${res.statusText} — ${await res.text()}`
    );
  }
}

function parseRow(line: string, rowNumber: number): SheetRow {
  const cols = line.split(',');
  return {
    rowNumber,
    gameId: (cols[0] ?? '').trim(),
    sport: (cols[1] ?? '').trim(),
    homeTeam: (cols[2] ?? '').trim(),
    awayTeam: (cols[3] ?? '').trim(),
    gameDate: (cols[4] ?? '').trim(),
    status: (cols[5] ?? '').trim(),
    marketAddress: (cols[6] ?? '').trim(),
    openLine_UNUSED: (cols[7] ?? '').trim(),
    bettingOpensAt: (cols[8] ?? '').trim(),
    notes: (cols[9] ?? '').trim(),
    approved: (cols[10] ?? '').trim(),
  };
}

export async function readRows(): Promise<SheetRow[]> {
  const { lines } = await fetchCsvFile();

  // lines[0] is the header (row 1). Data rows start at lines[1] = row 2.
  return lines
    .slice(1)
    .map((line, idx) => parseRow(line, idx + 2))
    .filter((r) => r.gameId !== ''); // skips the blank separator rows
}

/**
 * Writes back only column F (status, index 5) and G (marketAddress, index 6).
 * Every other column, including the approval in K, is left exactly as-is.
 * The commit itself is the audit trail — no PRs, direct to main.
 */
export async function writeMarketResult(
  rowNumber: number,
  marketAddress: string,
  status: string
): Promise<void> {
  const { lines, sha } = await fetchCsvFile();
  const idx = rowNumber - 1; // rowNumber is 1-indexed; lines[] is 0-indexed

  if (idx < 0 || idx >= lines.length) {
    throw new Error(
      `writeMarketResult: rowNumber ${rowNumber} is out of range for a ${lines.length}-line CSV.`
    );
  }

  const cols = lines[idx].split(',');
  const gameId = (cols[0] ?? '').trim();
  cols[5] = status;
  cols[6] = marketAddress;
  lines[idx] = cols.join(',');

  const verb =
    status === 'open' ? 'open market' : status === 'closed' ? 'close betting for' : `set status ${status} on`;

  await putCsvFile(lines, sha, `bot: ${verb} ${gameId}`);
}
