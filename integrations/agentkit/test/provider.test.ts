import { describe, it, expect } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { evenStevenActionProvider, EvenStevenActionProvider } from "../dist";
import { CLAIM_SENTENCE, deriveNonce, USDC } from "../dist/shared";
// @ts-ignore helpers are plain JS shared with the MCP package
import { wallet, MK1, MK2, SALT, NOW, world, chain, signTd, okBet } from "./helpers.mjs";
import fs from "node:fs";

// AgentKit's own @CreateAction wrapper posts an analytics event (with the wallet address) to cca-lite.coinbase.com on every action.
// That is AgentKit behavior, not this provider. Tests stub the global fetch so nothing leaves the machine, and record the hosts.
const globalCalls: string[] = [];
globalThis.fetch = (async (url: any) => { globalCalls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; }) as any;

const BASE = { protocolFamily: "evm", networkId: "base-mainnet", chainId: "8453" };
const strTd = (td: any) => ({ ...td, message: { ...td.message, value: String(td.message.value), validAfter: String(td.message.validAfter), validBefore: String(td.message.validBefore) } });

function setup(over: any = {}, cfg: any = {}, signer: any = wallet, network: any = BASE) {
  const w = world(over);
  const pc = chain(w);
  const fetches: any[] = [];
  const queue: any[] = [];
  const fetchImpl = async (url: string, init: any = {}) => {
    fetches.push({ url, body: init.body ? JSON.parse(init.body) : null });
    const r = queue.shift() ?? { status: 200, body: okBet() };
    return { status: r.status, ok: r.status < 300, text: async () => JSON.stringify(r.body) } as any;
  };
  let nowT = NOW;
  const signs: any[] = [];
  const forbidden = (name: string) => () => { throw new Error(`${name} must never be called`); };
  const walletProvider: any = {
    getName: () => "test-wallet",
    getAddress: () => signer.address,
    getNetwork: () => network,
    getPublicClient: () => pc,
    signTypedData: async (td: any) => { signs.push(td); return signTd(signer, strTd(td)); },
    sendTransaction: forbidden("sendTransaction"), signTransaction: forbidden("signTransaction"), sign: forbidden("sign"), signMessage: forbidden("signMessage"),
  };
  const provider = evenStevenActionProvider({ fetch: fetchImpl as any, now: () => nowT, randomSalt: () => SALT, ...cfg });
  const actions = provider.getActions(walletProvider);
  const run = async (name: string, args: any) => {
    const a = actions.find((x: any) => x.name.endsWith("_" + name))!;
    return (await a.invoke(args)) as string;
  };
  return { provider, actions, run, w, pc, fetches, queue, signs, walletProvider, setNow: (t: number) => (nowT = t) };
}
const idOf = (text: string) => /Intent id: ([0-9a-f]{8})/.exec(text)![1];
const prep = (s: any) => s.run("prepare_even_steven_bet", { game: "Packers Cowboys", side: "away", stake: "10" });

describe("provider shape", () => {
  it("is named even-steven and exposes exactly six actions with schemas", () => {
    const s = setup();
    expect(s.provider.name).toBe("even-steven");
    expect(s.actions.map((a: any) => a.name.replace(/^.*?_(?=[a-z]+_even)/, "")).sort()).toEqual([
      "claim_even_steven_payout", "confirm_even_steven_bet", "get_even_steven_bets", "get_even_steven_quote", "list_even_steven_markets", "prepare_even_steven_bet",
    ]);
    for (const a of s.actions) expect(a.description.length).toBeGreaterThan(40);
  });
  it("supports Base mainnet only", () => {
    const p = new EvenStevenActionProvider();
    expect(p.supportsNetwork(BASE)).toBe(true);
    for (const n of [{ protocolFamily: "evm", networkId: "base-sepolia" }, { protocolFamily: "evm", networkId: "ethereum-mainnet" }, { protocolFamily: "evm" },
      { protocolFamily: "svm", networkId: "solana-mainnet" }]) expect(p.supportsNetwork(n as any)).toBe(false);
  });
  it("action descriptions follow the copy rules and carry the exact claiming sentence", () => {
    const s = setup();
    const text = s.actions.map((a: any) => a.description).join("\n");
    expect(text).toContain(CLAIM_SENTENCE);
    expect(text).not.toMatch(/builder|points|affiliate|airdrop|reward|audited|guaranteed|permissionless|alpha|at liquidity|profit/i);
    expect(s.actions.find((a: any) => a.name.endsWith("_confirm_even_steven_bet"))!.description).toMatch(/ONLY after the user/);
  });
  it("never imports or calls a transaction sender or key API in its own source", () => {
    for (const f of ["evenStevenActionProvider.ts", "core.ts", "shared.ts", "index.ts"]) {
      const src = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/privateKeyToAccount|generatePrivateKey|\.sendTransaction\(|\.signTransaction\(|\.signMessage\(|writeContract|createWalletClient|PRIVATE_KEY|BANKR|mnemonic/i);
    }
  });
});

describe("reads", () => {
  it("list and quote are chain reads with no HTTP call", async () => {
    const s = setup();
    expect(JSON.parse(await s.run("list_even_steven_markets", {})).markets).toHaveLength(3);
    expect(await s.run("get_even_steven_quote", { game: "packers", stake: "10" })).toMatch(/set at settlement from the final pool/);
    expect(s.fetches).toHaveLength(0);
  });
});

describe("two-step bet", () => {
  it("prepare signs and sends nothing, prints the value order, and uses the wallet's own address", async () => {
    const s = setup();
    const out = await prep(s);
    expect(s.signs).toHaveLength(0); expect(s.fetches).toHaveLength(0);
    expect(out.indexOf("1. Even money")).toBeLessThan(out.indexOf("2. The early line"));
    expect(out.indexOf("2. The early line")).toBeLessThan(out.indexOf("3. Cost"));
    expect(out).toMatch(/total 10\.20 USDC from 0x/); expect(out.trim().endsWith("Reply confirm.")).toBe(true);
    expect(out).not.toMatch(/profit|guarantee|\$100|builder|points/i);
  });
  it("confirm without a prepared intent, with a bad id, or after expiry never signs", async () => {
    const s = setup();
    expect(await s.run("confirm_even_steven_bet", { intentId: "deadbeef" })).toMatch(/No prepared bet/);
    const id = idOf(await prep(s));
    s.setNow(NOW + 301);
    expect(await s.run("confirm_even_steven_bet", { intentId: id })).toMatch(/expired/);
    expect(s.signs).toHaveLength(0);
  });
  it("confirm signs one ReceiveWithAuthorization through the wallet's signTypedData and posts the exact payload", async () => {
    const s = setup();
    const id = idOf(await prep(s));
    const out = await s.run("confirm_even_steven_bet", { intentId: id });
    expect(out).toMatch(/Bet placed\. Cowboys -3\.5/); expect(out).toMatch(/basescan\.org\/tx\/0xabab/);
    expect(s.signs).toHaveLength(1);
    const td = s.signs[0];
    expect(td.domain).toEqual({ name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC });
    expect(td.primaryType).toBe("ReceiveWithAuthorization"); expect(Object.keys(td.types)).toEqual(["ReceiveWithAuthorization"]);
    expect(td.message.from).toBe(wallet.address); expect(td.message.to).toBe(MK2); expect(td.message.value).toBe(10200000n);
    expect(td.message.nonce).toBe(deriveNonce(SALT, false)); expect(td.message.validBefore).toBe(BigInt(NOW + 600)); expect(td.message.validAfter).toBe(0n);
    expect(s.fetches).toHaveLength(1);
    expect(Object.keys(s.fetches[0].body).sort()).toEqual(["bettor", "greaterThan", "marketAddress", "nonce", "salt", "signature", "stake", "validAfter", "validBefore"]);
    expect(await s.run("confirm_even_steven_bet", { intentId: id })).toMatch(/already placed/);
    expect(s.signs).toHaveLength(1);
  });
  it("two concurrent confirms sign once and place one bet", async () => {
    const s = setup();
    const id = idOf(await prep(s));
    const [a, b] = await Promise.all([s.run("confirm_even_steven_bet", { intentId: id }), s.run("confirm_even_steven_bet", { intentId: id })]);
    expect([a, b].filter((x) => /Bet placed/.test(x))).toHaveLength(1);
    expect([a, b].filter((x) => /already being confirmed/.test(x))).toHaveLength(1);
    expect(s.signs).toHaveLength(1); expect(s.fetches).toHaveLength(1);
  });
  it("refuses on the wrong network, a changed wallet, a closed market, or a changed fee, all before signing", async () => {
    let s = setup({}, {}, wallet, { protocolFamily: "evm", networkId: "base-sepolia" });
    let id = idOf(await prep(s));
    expect(await s.run("confirm_even_steven_bet", { intentId: id })).toMatch(/not on Base mainnet/); expect(s.signs).toHaveLength(0);

    s = setup(); id = idOf(await prep(s));
    s.walletProvider.getAddress = () => "0x1111111111111111111111111111111111111111";
    expect(await s.run("confirm_even_steven_bet", { intentId: id })).toMatch(/wallet changed/); expect(s.signs).toHaveLength(0);

    s = setup(); id = idOf(await prep(s)); s.w.markets[MK2.toLowerCase()].open = false;
    expect(await s.run("confirm_even_steven_bet", { intentId: id })).toMatch(/Nothing was signed/); expect(s.signs).toHaveLength(0);

    s = setup(); id = idOf(await prep(s)); s.w.fee = 300n;
    expect(await s.run("confirm_even_steven_bet", { intentId: id })).toMatch(/cost changed/); expect(s.signs).toHaveLength(0);
  });
  it("stake limits and ambiguity: asks, never guesses", async () => {
    const s = setup();
    expect(await s.run("prepare_even_steven_bet", { game: "Packers", side: "home", stake: "0.5" })).toMatch(/minimum stake is 1 USDC/);
    expect(await s.run("prepare_even_steven_bet", { game: "Packers", side: "home", stake: "26" })).toMatch(/maximum stake of 25/);
    expect(await s.run("prepare_even_steven_bet", { game: "cowboys", side: "home", stake: "5" })).toMatch(/More than one market/);
    expect(await s.run("prepare_even_steven_bet", { game: "Packers Cowboys", side: "cheesehead", stake: "5" })).toMatch(/Which side/);
    expect(s.signs).toHaveLength(0);
  });
  it("a signature the wallet returns for the wrong key never reaches the relay", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const s = setup(); s.walletProvider.signTypedData = async (td: any) => signTd(other, strTd(td));
    const id = idOf(await prep(s));
    expect(await s.run("confirm_even_steven_bet", { intentId: id })).toMatch(/does not verify/); expect(s.fetches).toHaveLength(0);
  });
  it("retry rule: a retry resends the identical request without signing again; a status error never re-signs", async () => {
    let s = setup(); let id = idOf(await prep(s));
    s.queue.push({ status: 429, body: { error: "RateLimited", retryAfterSeconds: 20 } });
    expect(await s.run("confirm_even_steven_bet", { intentId: id })).toMatch(/identical request after 20 seconds/);
    s.setNow(NOW + 25);
    expect(await s.run("confirm_even_steven_bet", { intentId: id })).toMatch(/Bet placed/);
    expect(s.signs).toHaveLength(1); expect(s.fetches[0].body).toEqual(s.fetches[1].body);

    s = setup(); id = idOf(await prep(s));
    s.queue.push({ status: 504, body: { error: "SubmissionPending", txHash: "0x" + "cd".repeat(32) } });
    expect(await s.run("confirm_even_steven_bet", { intentId: id })).toMatch(/Do not re-sign/);
    s.setNow(NOW + 30);
    expect(await s.run("confirm_even_steven_bet", { intentId: id })).toMatch(/Do not re-sign\. Check again after that/);
    s.w.bets[MK2.toLowerCase()] = [{ bettor: wallet.address, stake: 10_000_000n, greaterThan: false, lockedZ: -35000n, claimed: false }];
    s.setNow(NOW + 60);
    expect(await s.run("confirm_even_steven_bet", { intentId: id })).toMatch(/The bet did land/);
    expect(s.signs).toHaveLength(1); expect(s.fetches).toHaveLength(1);
  });
});

describe("bets and claims", () => {
  it("get bets reads the wallet's own bets; claim posts for the wallet and carries the exact sentence", async () => {
    const s = setup(); s.w.bets[MK1.toLowerCase()] = [{ bettor: wallet.address, stake: 5_000_000n, greaterThan: true, lockedZ: 0n, claimed: false }];
    expect(await s.run("get_even_steven_bets", { game: MK1 })).toMatch(/Dolphins PICK'EM/);
    s.queue.push({ status: 200, body: { success: true, claimedCount: 1, remainingCount: 0, amount: "9800000", txHashes: ["0x" + "aa".repeat(32)] } });
    const out = await s.run("claim_even_steven_payout", { game: MK1 });
    expect(out).toMatch(/Claimed 1 bet\(s\): 9\.8 USDC/); expect(out).toContain(CLAIM_SENTENCE);
    expect(s.fetches[0].body.bettor).toBe(wallet.address);
    s.queue.push({ status: 503, body: { error: "RelayUnderfunded" } });
    expect(await s.run("claim_even_steven_payout", { game: MK1 })).toContain(CLAIM_SENTENCE);
  });
});

describe("network egress", () => {
  it("the provider itself only talks to the relay; the only other call is AgentKit's own analytics event", async () => {
    globalCalls.length = 0;
    const s = setup();
    await s.run("list_even_steven_markets", {});
    const id = idOf(await prep(s));
    await s.run("confirm_even_steven_bet", { intentId: id });
    expect(s.fetches.every((f: any) => f.url.startsWith("https://evensteven.bet/api/"))).toBe(true);
    expect(globalCalls.every((u) => u.startsWith("https://cca-lite.coinbase.com"))).toBe(true);
  });
});
