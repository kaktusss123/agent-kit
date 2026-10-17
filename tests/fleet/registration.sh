#!/usr/bin/env bash
# OFFLINE equivalent of registration/profile refresh and verified host-key setup.
# ssh -G is resolution, not authentication. Real registration requires a live
# probe, which these tests deliberately do not perform. All keys are ephemeral.
set -euo pipefail
PASS=0 FAIL=0
pass() { PASS=$((PASS + 1)); printf 'pass %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$*" >&2; }
check() { local label="$1"; shift; if "$@"; then pass "$label"; else fail "$label"; fi; }
summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; }
if SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/agent-kit-fleet-registration.XXXXXX")"; then
	trap 'rm -rf -- "$SANDBOX"' EXIT
else
	fail 'sandbox creation'; summary; exit 1
fi
T="$SANDBOX/fixtures"
ENV_ISO=(env -i "PATH=$PATH" "HOME=$SANDBOX/home")
isolated() { "${ENV_ISO[@]}" "$@"; }
PROFILE="$SANDBOX/home/.fleet/ssh-agent.conf"
if [ -z "${FLEET_TEST_CHECKOUT:-}" ] || [ ! -x "$FLEET_TEST_CHECKOUT/bin/fleet" ]; then
	fail 'FLEET_TEST_CHECKOUT must provide an executable bin/fleet'; summary; exit 1
fi
# Manifest includes filenames as well as bytes, so additions/removals also fail.
manifest() {
	isolated python3 - "$FLEET_TEST_CHECKOUT" <<'PY'
import hashlib
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
paths = [root / "bin/fleet", root / "inventory/fleet.json", *sorted((root / "fleet").glob("*.py"))]
for path in paths:
    print(hashlib.sha256(path.read_bytes()).hexdigest(), path.relative_to(root))
PY
}
fixtures() {
	mkdir -p "$T" "$SANDBOX/home/.ssh" "$SANDBOX/home/.fleet" || return 1
	# Human SSH state exists BEFORE any agent install, with sentinel bytes:
	# the proof is byte-unchanged content, not mere absence.
	printf '# human sentinel ssh config\nHost *\n  User human\n' > "$SANDBOX/home/.ssh/config" || return 1
	printf '# human sentinel fleet managed profile\nHost legacy\n  User human\n' > "$SANDBOX/home/.fleet/ssh-config" || return 1
	cp "$SANDBOX/home/.ssh/config" "$T/sentinel.ssh" || return 1
	cp "$SANDBOX/home/.fleet/ssh-config" "$T/sentinel.fleet" || return 1
	manifest > "$SANDBOX/source.before" || return 1
	local root
	for root in "$T/old" "$T/new"; do
		mkdir -p "$root/bin" "$root/fleet" "$root/inventory" || return 1
		cp "$FLEET_TEST_CHECKOUT/bin/fleet" "$root/bin/" || return 1
		cp "$FLEET_TEST_CHECKOUT"/fleet/*.py "$root/fleet/" || return 1
	done
	isolated python3 - "$T" <<'PY'
import json
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
old = {"id": "homelab/lxc/9101", "name": "reg-old", "type": "pve-lxc", "baseline": True,
       "addresses": [{"address": "reg-old.invalid", "source": "manual"}], "discovered": {"status": "running"}}
new = {"id": "homelab/qemu/9102", "name": "reg-new", "type": "pve-vm", "baseline": True,
       "addresses": [{"address": "reg-new.invalid", "source": "manual"}],
       "connect": {"port": 2222}, "discovered": {"status": "running"}}
for name, machines in (("old", [old]), ("new", [old, new])):
    (root / name / "inventory/fleet.json").write_text(json.dumps({"schema": "fleet-inventory/1", "machines": machines}))
PY
}
if ! fixtures; then fail 'fixture preparation'; summary; exit 1; fi
resolve() {
	isolated ssh -G -F "$PROFILE" reg-new > "$T/effective" 2> "$T/ssh.err"
}
value() { awk -v key="$1" '$1 == key { print $2; exit }' "$T/effective"; }
refused() {
	resolve && awk '$1 == "proxycommand" && $2 != "none" { found=1 } END { exit !found }' "$T/effective"
}
install_old() {
	isolated "$T/old/bin/fleet" ssh install --profile agent > "$T/install-old.log" 2>&1 &&
	test -f "$PROFILE"
}
stale_root() {
	(cd "$SANDBOX/home" && isolated "$T/old/bin/fleet" ssh install --profile agent) > "$T/install-stale.log" 2>&1 &&
	refused
}
resolved_new() {
	resolve && [ "$(value hostname)" = reg-new.invalid ] && [ "$(value port)" = 2222 ] &&
	[ "$(value user)" = agent ] &&
	awk '$1 == "proxycommand" && $0 != "proxycommand none" { bad=1 } END { exit bad }' "$T/effective"
}
refresh_profile() {
	# The stale state from A3a is re-established deterministically, then the
	# fix is installed from the CORRECT root's absolute path (neutral cwd).
	stale_root &&
	(cd "$SANDBOX/home" && isolated "$T/new/bin/fleet" ssh install --profile agent) > "$T/install-new.log" 2>&1 &&
	resolved_new
}
check_profile() { isolated "$T/new/bin/fleet" ssh check --profile agent > "$T/check.log" 2>&1; }
human_untouched() {
	cmp -s "$SANDBOX/home/.ssh/config" "$T/sentinel.ssh" &&
	cmp -s "$SANDBOX/home/.fleet/ssh-config" "$T/sentinel.fleet"
}
check 'A1: old inventory installs the HOME-scoped agent profile' install_old
check 'A2: new alias is refused before refresh' refused
check 'A3: stale PATH-primary CLI from a neutral cwd cannot fix the profile' stale_root
check 'A4: correct-root refresh resolves hostname, port, user without proxy' refresh_profile
check 'A5: same CLI verifies the installed agent profile with ssh -G' check_profile
check 'A6: human SSH config and human fleet profile stay byte-unchanged' human_untouched

# Fingerprints and material are independently compared; comments are irrelevant.
fingerprint() { isolated ssh-keygen -lf "$1" | awk 'NR == 1 { print $2 }'; }
material() { awk 'NR == 1 { print $2 }' "$1"; }
CONFIRMED="$T/confirmed_host_key.pub"
DECOY="$T/decoy_host_key.pub"
KH="$T/known_hosts"
FORM=""
keys() {
	isolated ssh-keygen -q -t ed25519 -N '' -f "$T/confirmed_host_key" -C reg-confirmed &&
	isolated ssh-keygen -q -t ed25519 -N '' -f "$T/decoy_host_key" -C reg-decoy &&
	[ -n "$(fingerprint "$CONFIRMED")" ] &&
	[ "$(fingerprint "$CONFIRMED")" != "$(fingerprint "$DECOY")" ]
}
lookup_facts() {
	resolve || return 1
	local hostname port known_hosts hostkeyalias
	hostname="$(value hostname)"; port="$(value port)"
	known_hosts="$(value userknownhostsfile)"; hostkeyalias="$(value hostkeyalias)"
	[ -n "$hostname" ] && [ -n "$port" ] && [ -n "$known_hosts" ] || return 1
	if [ -n "$hostkeyalias" ] && [ "$hostkeyalias" != none ]; then
		FORM="$hostkeyalias"
	elif [ "$port" != 22 ]; then FORM="[$hostname]:$port"
	else FORM="$hostname"
	fi
	[ "$FORM" = '[reg-new.invalid]:2222' ]
}
# Distinguish no match (rc 1) from malformed invocations or unreadable files.
absent() {
	local rc=0
	isolated ssh-keygen -F "$2" -f "$1" > "$T/absent.out" 2> "$T/absent.err" || rc=$?
	[ "$rc" -eq 1 ]
}
empty_lookup() { touch "$KH" && absent "$KH" "$FORM"; }
verify_and_install() {
	local kh="$1" form="$2" confirmed="$3" candidate="$4" expected actual expected_fp actual_fp
	expected="$(material "$confirmed")"; actual="$(material "$candidate")"
	expected_fp="$(fingerprint "$confirmed")" || return 1
	actual_fp="$(fingerprint "$candidate")" || return 1
	if [ -z "$expected" ] || [ -z "$expected_fp" ] ||
		[ "$expected" != "$actual" ] || [ "$expected_fp" != "$actual_fp" ]; then
		printf 'candidate refused: key material or fingerprint differs from independent confirmation\n' >&2
		return 1
	fi
	# No destination is created or modified until BOTH comparisons succeed.
	touch "$kh" && chmod 600 "$kh" &&
	awk -v form="$form" 'NR == 1 { print form, $1, $2 }' "$candidate" >> "$kh"
}
found_material() {
	isolated ssh-keygen -F "$2" -f "$1" > "$T/found" || return 1
	awk '!/^#/ { print $2, $3 }' "$T/found" > "$T/found.pub" || return 1
	[ "$(awk 'END { print NR }' "$T/found.pub")" -eq 1 ] &&
	[ "$(material "$T/found.pub")" = "$(material "$3")" ]
}
confirmed_install() {
	verify_and_install "$KH" "$FORM" "$CONFIRMED" "$CONFIRMED" &&
	found_material "$KH" "$FORM" "$CONFIRMED" &&
	[ "$(fingerprint "$T/found.pub")" = "$(fingerprint "$CONFIRMED")" ]
}
exact_form() { absent "$KH" reg-new.invalid && absent "$KH" reg-new; }
sha256() {
	isolated python3 -c 'import hashlib, pathlib, sys; print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())' "$1"
}
mismatch() {
	local before
	before="$(sha256 "$KH")" || return 1
	cp "$KH" "$T/known_hosts.before" || return 1
	if verify_and_install "$KH" "$FORM" "$CONFIRMED" "$DECOY"; then return 1; fi
	cmp -s "$KH" "$T/known_hosts.before" && [ "$(sha256 "$KH")" = "$before" ] || return 1
	# A rejected candidate must not create a destination either.
	if verify_and_install "$T/rejected_hosts" "$FORM" "$CONFIRMED" "$DECOY"; then return 1; fi
	test ! -e "$T/rejected_hosts"
}
changed_key() {
	local kh2="$T/known_hosts.changed"
	verify_and_install "$kh2" "$FORM" "$CONFIRMED" "$CONFIRMED" &&
	verify_and_install "$kh2" reg-old.invalid "$DECOY" "$DECOY" || return 1
	awk '$1 == "reg-old.invalid"' "$kh2" > "$T/unrelated.before" || return 1
	cp "$kh2" "$kh2.bak" || return 1
	# The presented decoy is NOT approved: preserve the old entry and evidence.
	if verify_and_install "$kh2" "$FORM" "$CONFIRMED" "$DECOY"; then return 1; fi
	cmp -s "$kh2" "$kh2.bak" && found_material "$kh2" "$FORM" "$CONFIRMED" || return 1
	# Simulated owner approval independently confirms the replacement key.
	# Select exact first fields, never substring-delete aliases or other hosts.
	awk -v form="$FORM" '$1 != form' "$kh2" > "$T/replacement" || return 1
	mv "$T/replacement" "$kh2" || return 1
	verify_and_install "$kh2" "$FORM" "$DECOY" "$DECOY" &&
	found_material "$kh2" "$FORM" "$DECOY" &&
	found_material "$kh2" reg-old.invalid "$DECOY" || return 1
	awk '$1 == "reg-old.invalid"' "$kh2" > "$T/unrelated.after" || return 1
	cmp -s "$T/unrelated.before" "$T/unrelated.after" &&
	found_material "$kh2.bak" "$FORM" "$CONFIRMED"
}
check 'B1: local ephemeral confirmed and decoy fingerprints differ' keys
check 'B2: effective SSH facts yield the exact nondefault-port lookup form' lookup_facts
check 'B3: lookup form is absent before installation (rc 1)' empty_lookup
check 'B4/B5: independently verified install is found with matching material and fingerprint' confirmed_install
check 'B6: neither unbracketed hostname nor Fleet alias matches' exact_form
check 'B7: mismatching candidate leaves known_hosts byte-identical' mismatch
check 'B8: changed key waits for approval; replacement preserves unrelated record and backup' changed_key
unchanged() { manifest > "$SANDBOX/source.after" && cmp -s "$SANDBOX/source.before" "$SANDBOX/source.after"; }
check 'evidence: source CLI, modules and inventory SHA-256 manifest unchanged' unchanged
summary
[ "$FAIL" -eq 0 ]
