// npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getWithRetry } from './http.js';

const NO_WAIT = [0, 0, 0];

/** A fetch that answers each call with the next status in `seq` (repeating the last); 'throw' rejects. */
function fakeFetch(seq: (number | 'throw')[]) {
  let calls = 0;
  const impl = (async () => {
    const s = seq[Math.min(calls, seq.length - 1)];
    calls++;
    if (s === 'throw') throw new TypeError('fetch failed');
    return new Response(`status ${s}`, { status: s });
  }) as typeof fetch;
  return { impl, calls: () => calls };
}

test('503, 503, 200 returns the 200 after 3 calls', async () => {
  const f = fakeFetch([503, 503, 200]);
  const res = await getWithRetry('https://api.github.com/x', {}, NO_WAIT, f.impl);
  assert.equal(res.status, 200);
  assert.equal(f.calls(), 3);
});

test('a 404 is not retried', async () => {
  const f = fakeFetch([404, 200]);
  const res = await getWithRetry('https://api.github.com/x', {}, NO_WAIT, f.impl);
  assert.equal(res.status, 404);
  assert.equal(f.calls(), 1);
});

test('four 503s return the last response', async () => {
  const f = fakeFetch([503, 503, 503, 503, 200]);
  const res = await getWithRetry('https://api.github.com/x', {}, NO_WAIT, f.impl);
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'status 503');
  assert.equal(f.calls(), 4);
});

test('a network error is retried, and rethrown once retries run out', async () => {
  const ok = fakeFetch(['throw', 200]);
  assert.equal((await getWithRetry('https://api.github.com/x', {}, NO_WAIT, ok.impl)).status, 200);
  assert.equal(ok.calls(), 2);

  const down = fakeFetch(['throw']);
  await assert.rejects(getWithRetry('https://api.github.com/x', {}, NO_WAIT, down.impl), /fetch failed/);
  assert.equal(down.calls(), 4);
});
