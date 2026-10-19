import { z } from "zod";

const game = z.string().describe('A gameId, a market address, or team names such as "49ers Commanders"');

export const ListMarketsSchema = z.object({ all: z.boolean().optional().describe("Include recent closed games") }).strip();
export const GetQuoteSchema = z.object({ game, stake: z.string().optional().describe("USDC amount, 1 to 25 (default 10)") }).strip();
export const PrepareBetSchema = z
  .object({
    game,
    side: z.string().describe("home, away, or a team name of that game"),
    stake: z.string().describe("USDC amount, 1 to 25"),
  })
  .strip();
export const ConfirmBetSchema = z.object({ intentId: z.string().describe("The intent id printed by prepare_even_steven_bet") }).strip();
export const GetBetsSchema = z.object({ game }).strip();
export const ClaimSchema = z.object({ game }).strip();
