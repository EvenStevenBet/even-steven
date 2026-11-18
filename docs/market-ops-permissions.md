# Claude Code permission rules for scripts/market-ops.mjs

Draft only. Jeff applies these with `/permissions` (or in `~/.claude/settings.json`); Claude does not edit settings.

```json
{
  "permissions": {
    "allow": [
      "Bash(node scripts/market-ops.mjs status:*)",
      "Bash(node scripts/market-ops.mjs open-market:*)",
      "Bash(node scripts/market-ops.mjs close-betting:*)",
      "Bash(node scripts/market-ops.mjs trigger-refund:*)",
      "Bash(node scripts/market-ops.mjs approve-bond:*)",
      "Bash(node scripts/market-ops.mjs request-settlement:*)",
      "Bash(node scripts/market-ops.mjs execute-settlement:*)",
      "Bash(node scripts/market-ops.mjs cancel-market:*)",
      "Bash(node scripts/market-ops.mjs pause:*)",
      "Bash(node scripts/market-ops.mjs unpause:*)",
      "Bash(node --test scripts/market-ops.test.mjs)"
    ],
    "ask": [
      "Bash(node scripts/market-ops.mjs*--confirm*)"
    ],
    "deny": [
      "Read(~/.even-steven/**)",
      "Read(//Users/jeff/.even-steven/**)",
      "Read(**/bot.env)",
      "Edit(~/.even-steven/**)",
      "Write(~/.even-steven/**)",
      "Bash(*bot.env*)",
      "Bash(*.even-steven*)",
      "Bash(*PRIVATE_KEY*)",
      "Bash(printenv*)",
      "Bash(env)",
      "Bash(env *)"
    ]
  }
}
```

How it fits the house rule: simulations run without a prompt; any command containing `--confirm` hits the
`ask` rule, so it only runs after Jeff has named the exact action in the thread and clicks approve. Deny wins over ask and allow.

Optional, after the scripts are merged: stop Claude from editing the signing code itself.

```json
"deny": ["Edit(scripts/market-ops.mjs)", "Write(scripts/market-ops.mjs)", "Edit(scripts/lib/**)", "Write(scripts/lib/**)"]
```

Limits (so nobody over-trusts this):
- Permission rules gate Claude's tools. They do not stop the allowed script reading the env file; that is by design.
- `Bash(...)` deny patterns are string matches. A determined command (variable indirection, `node -e`, a new script) can get around
  them. They stop accidents, not an adversary. The only hard boundary is OS-level: keep the key where Claude's process cannot read it
  (a separate macOS user, or a keychain item the script alone is allowed to use).
- Rule syntax varies a little by Claude Code version; check each rule appears in `/permissions` after pasting.
