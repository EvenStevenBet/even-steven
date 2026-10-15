// node --test (run via `npx tsx --test src/dispatch.test.ts` in market-opener-bot)
// Tests for dispatchKickoffCloser retry behaviour.
//
// config.ts is the FIRST import in dispatch.ts and reads env vars eagerly at module
// evaluation time. ESM static imports are hoisted, so we can't set process.env before
// them in the same file. We use dynamic import() to defer loading dispatch.ts until
// after the stubs are in place.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Stub env vars so config.ts initialises without a real .env file.
const STUBS = {
  RPC_URL: 'https://stub',
  PRIVATE_KEY: '0x' + 'a'.repeat(64),
  PRODUCTION_WALLET: '0x' + 'a'.repeat(40),
  FACTORY_ADDRESS: '0x' + 'b'.repeat(40),
  USDC_ADDRESS: '0x' + 'c'.repeat(40),
  GITHUB_TOKEN: 'stub-token',
  GITHUB_REPO_OWNER: 'EvenStevenBet',
  GITHUB_REPO_NAME: 'even-steven',
  GITHUB_CSV_PATH: 'data/markets.csv',
  BOT_ENABLED: 'false',
  DRY_RUN: 'true',
};
for (const [k, v] of Object.entries(STUBS)) {
  if (!process.env[k]) process.env[k] = v;
}

let dispatchKickoffCloser: (delays?: number[], fetchImpl?: typeof fetch) => Promise<void>;

before(async () => {
  ({ dispatchKickoffCloser } = await import('./dispatch.js'));
});

type FakeResponse = { status: number; statusText?: string; body?: string };

function makeFetch(responses: Array<FakeResponse | Error>): typeof fetch {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (r instanceof Error) throw r;
    const body = (r as FakeResponse).body ?? '';
    return {
      status: (r as FakeResponse).status,
      statusText: (r as FakeResponse).statusText ?? '',
      ok: (r as FakeResponse).status >= 200 && (r as FakeResponse).status < 300,
      text: async () => body,
      json: async () => ({}),
      headers: new Headers(),
      body: null,
      bodyUsed: false,
      arrayBuffer: async () => new ArrayBuffer(0),
      blob: async () => new Blob(),
      formData: async () => new FormData(),
      clone: () => { throw new Error('not implemented'); },
      redirected: false,
      type: 'basic' as ResponseType,
      url: '',
    } as unknown as Response;
  };
}

test('dispatchKickoffCloser resolves on 204', async () => {
  const fetch = makeFetch([{ status: 204 }]);
  await assert.doesNotReject(dispatchKickoffCloser([], fetch));
});

test('dispatchKickoffCloser treats 422 as success (closer already running)', async () => {
  const fetch = makeFetch([{ status: 422 }]);
  await assert.doesNotReject(dispatchKickoffCloser([], fetch));
});

test('dispatchKickoffCloser retries on 5xx and resolves when a later attempt succeeds', async () => {
  const fetch = makeFetch([{ status: 503 }, { status: 500 }, { status: 204 }]);
  await assert.doesNotReject(dispatchKickoffCloser([0, 0], fetch));
});

test('dispatchKickoffCloser retries on 429 (rate limit)', async () => {
  const fetch = makeFetch([{ status: 429 }, { status: 204 }]);
  await assert.doesNotReject(dispatchKickoffCloser([0], fetch));
});

test('dispatchKickoffCloser retries on network error', async () => {
  const fetch = makeFetch([new Error('ECONNRESET'), { status: 204 }]);
  await assert.doesNotReject(dispatchKickoffCloser([0], fetch));
});

test('dispatchKickoffCloser throws without retry on 4xx (not 422)', async () => {
  const fetch = makeFetch([{ status: 401, statusText: 'Unauthorized' }]);
  await assert.rejects(dispatchKickoffCloser([0, 0], fetch), /401/);
});

test('dispatchKickoffCloser throws on 403 without retry', async () => {
  const fetch = makeFetch([{ status: 403, statusText: 'Forbidden' }]);
  await assert.rejects(dispatchKickoffCloser([0, 0], fetch), /403/);
});

test('dispatchKickoffCloser throws after exhausting all retries', async () => {
  const fetch = makeFetch([
    { status: 503 },
    { status: 503 },
    { status: 503 },
    { status: 503 }, // never reached
  ]);
  await assert.rejects(dispatchKickoffCloser([0, 0], fetch), /workflow dispatch failed/);
});

test('dispatchKickoffCloser default delays: 3 retries succeeds on 4th attempt', async () => {
  // Verify 3 errors + 204 resolves (4 total calls with 3 explicit zero delays).
  const fetch = makeFetch([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 204 }]);
  await assert.doesNotReject(dispatchKickoffCloser([0, 0, 0], fetch));
});
