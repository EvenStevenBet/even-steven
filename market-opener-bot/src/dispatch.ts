import { config } from './config.js';

/**
 * Starts the kickoff closer (.github/workflows/kickoff-closer.yml) so a newly opened market
 * is watched from the moment it exists, instead of waiting for that workflow's cron, which
 * GitHub fires hours apart. workflow_dispatch is one of the events the Actions GITHUB_TOKEN
 * may trigger (it needs `actions: write` in market-opener.yml).
 */
export async function dispatchKickoffCloser(): Promise<void> {
  const url =
    `https://api.github.com/repos/${config.githubRepoOwner}/${config.githubRepoName}` +
    '/actions/workflows/kickoff-closer.yml/dispatches';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (res.status !== 204) {
    throw new Error(`workflow dispatch failed: ${res.status} ${res.statusText} — ${await res.text()}`);
  }
}
