import { config } from './config.js';
import { readRows, writeMarketResult, type SheetRow } from './csv.js';
import { evaluate, parseStrictDate } from './eligibility.js';
import {
  verifyProductionWallet,
  ensureMaxApproval,
  marketExistsOnChain,
  simulateDeploy,
  deployMarket,
  getOpenMarketAddresses,
  getMarketGameId,
  isBettingOpen,
  simulateCloseBetting,
  closeMarketBetting,
  getBalances,
  botAddress,
} from './chain.js';
import { log } from './logger.js';

/**
 * Closes betting on any currently-open market whose game has reached its
 * exact kickoff time. Not gated by the approval column (K) — that column
 * governs creating new markets and handing away fee ownership; closing an
 * already-created market's betting is a routine lifecycle action, not a
 * fresh grant of anything. Gated by the kill switch and dry run exactly
 * like everything else, since it's still a real on-chain write in live mode.
 *
 * Returns the number of open markets closed in THIS run (or that would have
 * been, in dry run), so the caller can adjust its own open-market count
 * before deciding how much capacity is left for new deployments.
 */
async function closeExpiredBetting(rows: SheetRow[], now: Date): Promise<number> {
  const openAddresses = await getOpenMarketAddresses();
  log({ event: 'close_betting_check', count: openAddresses.length });

  const rowsByGameId = new Map(rows.map((r) => [r.gameId, r]));
  let closed = 0;

  for (const marketAddress of openAddresses) {
    let gameId: string;
    try {
      gameId = await getMarketGameId(marketAddress);
    } catch (err) {
      log({
        event: 'close_failed',
        marketAddress,
        error: err instanceof Error ? err.message : String(err),
        detail: 'Could not read gameId off this market — left untouched.',
      });
      continue;
    }

    const row = rowsByGameId.get(gameId);
    if (!row) {
      // A market with no matching CSV row (e.g. deployed via Remix before
      // the bot existed). Can't know its kickoff time — skip rather than guess.
      log({ event: 'close_no_csv_row', gameId, marketAddress });
      continue;
    }

    const gameDate = parseStrictDate(row.gameDate);
    if (!gameDate) {
      log({ event: 'close_failed', gameId, marketAddress, error: `invalid gameDate: ${row.gameDate}` });
      continue;
    }

    if (now < gameDate) {
      continue; // game hasn't started yet — nothing to do
    }

    try {
      // Read state before attempting the write — cheaper than letting
      // closeBetting() revert with AlreadyClosed(), and distinguishes an
      // already-closed market (routine) from a genuine failure (worth flagging).
      const stillOpen = await isBettingOpen(marketAddress);
      if (!stillOpen) {
        log({ event: 'close_already_done', gameId, marketAddress });
        continue;
      }

      if (config.dryRun) {
        await simulateCloseBetting(marketAddress);
        log({
          event: 'would_close',
          gameId,
          marketAddress,
          detail: 'DRY_RUN — simulation succeeded, nothing was broadcast.',
        });
        closed += 1;
        continue;
      }

      const { txHash } = await closeMarketBetting(marketAddress);
      log({ event: 'close_success', gameId, marketAddress, txHash });
      closed += 1;

      await writeMarketResult(row.rowNumber, row.marketAddress || marketAddress, 'closed');
      log({ event: 'csv_updated', gameId, row: row.rowNumber, status: 'closed' });
    } catch (err) {
      log({
        event: 'close_failed',
        gameId,
        marketAddress,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return closed;
}

async function main(): Promise<void> {
  const mode = !config.botEnabled ? 'KILL_SWITCH_OFF' : config.dryRun ? 'DRY_RUN' : 'LIVE';

  log({
    event: 'run_start',
    mode,
    botAddress,
    maxOpenMarkets: config.maxOpenMarkets,
  });

  // Wallet identity is checked before anything else touches the chain.
  verifyProductionWallet();
  log({ event: 'wallet_verified', botAddress });

  // ── CONTROL 1: kill switch ───────────────────────────────────────────
  if (!config.botEnabled) {
    log({
      event: 'halted_by_kill_switch',
      detail: 'BOT_ENABLED is not "true". No sheet or chain writes will occur.',
    });
    log({ event: 'run_complete', mode, deployed: 0, closed: 0 });
    return;
  }

  const balances = await getBalances();
  log({ event: 'balances', eth: balances.eth, usdc: balances.usdc });

  if (Number(balances.usdc) < 2) {
    log({ event: 'warning_low_usdc', usdc: balances.usdc, needPerMarket: '2' });
  }
  if (Number(balances.eth) < 0.0005) {
    log({ event: 'warning_low_eth', eth: balances.eth });
  }

  const approval = await ensureMaxApproval(config.dryRun);
  log({ event: 'usdc_approval', result: approval });

  const rows = await readRows();
  const now = new Date();
  log({ event: 'sheet_read', totalRows: rows.length });

  // ── Close betting on any open market whose game has reached kickoff ───
  // Runs before the capacity check below so a market that just closed
  // frees its slot for a new deployment in the very same run.
  const closedCount = await closeExpiredBetting(rows, now);

  // ── CONTROL 3: concurrent open markets cap ───────────────────────────
  let openCount = (await getOpenMarketAddresses()).length;
  const capacity = config.maxOpenMarkets - openCount;
  log({
    event: 'open_market_capacity',
    currentlyOpen: openCount,
    cap: config.maxOpenMarkets,
    remainingCapacity: Math.max(0, capacity),
  });

  const candidates: typeof rows = [];

  for (const row of rows) {
    const decision = evaluate(row, now);
    if (decision.deploy) {
      candidates.push(row);
    } else if (decision.notable) {
      // Surfaced because it's probably something you'd want to fix.
      log({ event: 'row_skipped', gameId: row.gameId, row: row.rowNumber, reason: decision.reason });
    }
  }

  // Soonest betting window first.
  candidates.sort((a, b) => {
    const da = parseStrictDate(a.bettingOpensAt)!.getTime();
    const db = parseStrictDate(b.bettingOpensAt)!.getTime();
    return da - db;
  });

  log({
    event: 'approved_and_due',
    count: candidates.length,
    gameIds: candidates.map((r) => r.gameId),
  });

  let deployed = 0;

  for (const row of candidates) {
    if (openCount >= config.maxOpenMarkets) {
      log({
        event: 'capped_skip',
        gameId: row.gameId,
        currentlyOpen: openCount,
        cap: config.maxOpenMarkets,
        detail: 'Approved and due, but the open-market cap is reached. Will retry next run.',
      });
      continue;
    }

    try {
      // A manual Remix deploy or an interrupted earlier run may have already
      // created this market without the sheet reflecting it.
      const existing = await marketExistsOnChain(row.gameId);
      if (existing) {
        log({ event: 'already_exists_onchain', gameId: row.gameId, marketAddress: existing });
        if (!config.dryRun) {
          await writeMarketResult(row.rowNumber, existing, 'open');
          log({ event: 'sheet_backfilled', gameId: row.gameId, marketAddress: existing });
        }
        continue;
      }

      // ── CONTROL 2: dry run ───────────────────────────────────────────
      if (config.dryRun) {
        await simulateDeploy(row.gameId);
        log({
          event: 'would_deploy',
          gameId: row.gameId,
          row: row.rowNumber,
          oracleZ: 0,
          detail: 'DRY_RUN — simulation succeeded, nothing was broadcast.',
        });
        openCount += 1; // model the effect so the cap is exercised realistically
        deployed += 1;
        continue;
      }

      log({ event: 'deploying', gameId: row.gameId, row: row.rowNumber, oracleZ: 0 });
      const { marketAddress, txHash } = await deployMarket(row.gameId);

      // Chain state is authoritative and already committed; log the success
      // before the sheet write so a failure there can't hide the deployment.
      log({ event: 'deploy_success', gameId: row.gameId, marketAddress, txHash });

      openCount += 1;
      deployed += 1;

      await writeMarketResult(row.rowNumber, marketAddress, 'open');
      log({ event: 'sheet_updated', gameId: row.gameId, row: row.rowNumber, marketAddress });
    } catch (err) {
      // Row is left untouched — retried next run, never guessed at.
      log({
        event: 'deploy_failed',
        gameId: row.gameId,
        row: row.rowNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log({ event: 'run_complete', mode, deployed, closed: closedCount, openMarketsNow: openCount });
}

main().catch((err) => {
  log({ event: 'fatal_error', error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
