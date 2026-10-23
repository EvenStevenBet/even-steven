#!/usr/bin/env bash
# Tests run.sh with a stub `node`: no network, no real key. Run: bash run.test.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
FAKE="bk_RUNSH_TEST_fake_$(date +%s)_zzz"

# stub node: v22, reports only the LENGTH of BANKR_API_KEY, never the value
mkdir "$tmp/bin"
cat > "$tmp/bin/node" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  -p) echo "${STUB_MAJOR:-22}" ;;
  -v) echo "v${STUB_MAJOR:-22}.0.0" ;;
  probe.mjs) echo "stub-node args=[$*] keylen=${#BANKR_API_KEY}" ;;
esac
STUB
chmod +x "$tmp/bin/node"
mkdir -p "$here/node_modules"   # exists already after npm install

out="$(printf '  %s \r\n' "$FAKE" | PATH="$tmp/bin:$PATH" bash "$here/run.sh" --market 0xabc 2>&1)"; rc=$?
[ $rc -eq 0 ] && ok "runs with a valid-looking key" || bad "valid key rc=$rc"
echo "$out" | grep -q "keylen=${#FAKE}\$" && ok "whitespace trimmed (length ${#FAKE})" || bad "trim: $out"
echo "$out" | grep -q "args=\[probe.mjs --market 0xabc\]" && ok "extra args passed through" || bad "args: $out"
echo "$out" | grep -q "starts with bk_: yes" && ok "prints prefix check" || bad "prefix line"
echo "$out" | grep -qF "$FAKE" && bad "KEY WAS PRINTED" || ok "key never printed"

out="$(printf 'not_a_key\n' | PATH="$tmp/bin:$PATH" bash "$here/run.sh" 2>&1)"; rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q "does not look like" && ok "rejects a key without bk_ prefix" || bad "prefix reject"
echo "$out" | grep -q "stub-node" && bad "node ran on a bad key" || ok "node not run on a bad key"

out="$(printf '\n' | PATH="$tmp/bin:$PATH" bash "$here/run.sh" 2>&1)"; rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q "No key entered" && ok "rejects an empty key" || bad "empty"

out="$(printf '%s\n' "$FAKE" | STUB_MAJOR=18 PATH="$tmp/bin:$PATH" bash "$here/run.sh" 2>&1)"; rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q "Node 20 or newer" && ok "refuses Node 18" || bad "node18"

# the key must not leak into the caller's environment or into files
printf '%s\n' "$FAKE" | PATH="$tmp/bin:$PATH" bash "$here/run.sh" >/dev/null 2>&1
[ -z "${BANKR_API_KEY:-}" ] && ok "caller env has no key" || bad "env leak"
grep -rqF "$FAKE" "$here" --include='*' --exclude-dir=node_modules --exclude=run.test.sh && bad "key found in files" || ok "key not written to disk"
exit $fail
