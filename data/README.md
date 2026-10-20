# data/markets.csv

The market list read by the opener bot, the kickoff closer, watcher-health and the website. 11 columns, no quotes or commas in values.

**Every row appears on the live site as a "coming soon" card as soon as it is on `main`, whether or not it is approved.** Add rows only a day or two before the game.

Build a row with `node scripts/add-market-row.mjs --help`. It prints one validated line and, with `--write`, appends it to your local copy; you review and commit it yourself.
