import { config } from './config.js';
import { log } from './logger.js';

/**
 * Starts the kickoff closer (.github/workflows/kickoff-closer.yml) so a newly opened market
 * is watched from the moment it exists, instead of waiting for that workflow's cron, which
 * GitHub fires hours apart. workflow_dispatch is one of the events the Actions GITHUB_TOKEN
 * may trigger (it needs `actions: write` in market-opener.yml).
 *
 * Retries up to 3 times on 5xx / network errors, with exponential back-off (2s, 4s, 8s),
 * and logs each failure clearly. A 4xx is never retried — it is a configuration problem.
 */
export async function dispatchKickoffCloser(
  delaysMs: number[] = [2_000, 4_000, 8_000],
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const url =
    `https://api.github.com/repos/${config.githubRepoOwner}/${config.githubRepoName}` +
    '/actions/workflows/kickoff-closer.yml/dispatches';
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main' }),
  };

  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let error: unknown;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      error = err;
    }

    // 204 = accepted; 422 = already running (treat as success — closer is up)
    if (res?.status === 204 || res?.status === 422) return;

    const retryable =
      res === undefined /* network error */ ||
      res.status >= 500 ||
      res.status === 429;

    if (!retryable || attempt >= delaysMs.length) {
      const detail = res ? `${res.status} ${res.statusText} — ${await res.text()}` : String(error);
      throw new Error(`workflow dispatch failed: ${detail}`);
    }

    const delayMs = delaysMs[attempt];
    log({
      event: 'kickoff_closer_dispatch_retrying',
      attempt: attempt + 1,
      maxAttempts: delaysMs.length + 1,
      status: res?.status ?? 'network_error',
      delayMs,
    });
    await new Promise((r) => setTimeout(r, delayMs));
  }
}
