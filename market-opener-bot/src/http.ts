/**
 * GET with retries on GitHub 5xx/429 and network errors. A 503 from GitHub on
 * 2026-10-03 failed a whole run; the read is idempotent, so it is safe to repeat.
 * PUTs are not retried here: a 5xx PUT may have landed.
 */
export async function getWithRetry(
  url: string,
  init: RequestInit,
  delaysMs: number[] = [2_000, 4_000, 8_000],
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let error: unknown;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      error = err;
    }
    const retryable = res === undefined || res.status >= 500 || res.status === 429;
    if (!retryable || attempt >= delaysMs.length) {
      if (res) return res;
      throw error;
    }
    await new Promise((r) => setTimeout(r, delaysMs[attempt]));
  }
}
