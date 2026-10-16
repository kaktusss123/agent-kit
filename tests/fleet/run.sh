#!/usr/bin/env bash
# Fleet skill tests; no mock CLI, remote connections, probes, or Fleet mutations.
# Layers:
#   static — instruction review, not behavior: structure and portability of docs.
#   installer — real isolated install and Pi SDK discovery, with uninstall control.
#               Claude Code is checked for link presence only, not process discovery.
#   real-cli — optional real Fleet CLI, read-only/local; ssh -G never connects.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
REPO="$SELF_DIR"
PASS=0 FAIL=0 SKIP=0
pass() { PASS=$((PASS + 1)); printf 'pass %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$*" >&2; }
skip() { SKIP=$((SKIP + 1)); printf 'skip %s\n' "$*"; }
check() { local label="$1"; shift; if "$@"; then pass "$label"; else fail "$label"; fi; }
summary() { printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"; }
has_all() { local file="$1" pat; shift; for pat in "$@"; do grep -qF -- "$pat" "$file" || return 1; done; }
no_match() { if grep -qiE -- "$1" "${@:2}"; then return 1; else [ "$?" -eq 1 ]; fi; }
has_lines() { local file="$1" pat; shift; for pat in "$@"; do grep -qxF -- "$pat" "$file" || return 1; done; }
if SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/agent-kit-fleet.XXXXXX")"; then
	trap 'rm -rf -- "$SANDBOX"' EXIT
else
	fail 'sandbox creation'; summary; exit 1
fi
SKMD="$REPO/skills/fleet/SKILL.md"
ACCESS="$REPO/skills/fleet/references/access.md"
MAINT="$REPO/skills/fleet/references/maintenance.md"
DOCS=("$SKMD" "$ACCESS" "$MAINT")

# Static assertions deliberately inspect instructions, not their execution.
check 'static: SKILL.md has closed frontmatter' awk '
NR == 1 && $0 != "---" { exit 1 }
NR > 1 && $0 == "---" { closed=1; exit }
END { if (!closed) exit 1 }' "$SKMD"
check 'static: access reference exists' test -f "$ACCESS"
check 'static: maintenance reference exists' test -f "$MAINT"
check 'static: entrypoint references and discovery/routing instructions' has_all "$SKMD" \
	'references/access.md' 'references/maintenance.md' 'command -v fleet' 'skill://git-task' 'ssh -G -F'
check 'static: access semantics and failure vocabulary' has_all "$ACCESS" \
	'absent or `none`' 'ProxyCommand /usr/bin/false' '(stopped' 'Connection refused' \
	'Host key verification failed' 'Permission denied' 'not symlink-safe' 'config.py' \
	'counts as reachable' 'full public key lines'
check 'static: maintenance gates and verification instructions' has_all "$MAINT" \
	'explicit exception' 'sudo -n true' 'sudo -n id -u' 'fleet_target=' \
	'inventory/fleet_inventory.py' 'baseline: true' 'eligibility, not proof'
check 'static: no IPv4 literals' no_match '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' "${DOCS[@]}"
check 'static: no personal absolute paths' no_match '/Users/' "${DOCS[@]}"
check 'static: no private key material' no_match '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----|PuTTY-User-Key-File:' "${DOCS[@]}"
check 'static: no real homelab hostnames' no_match 'vikunja|torrserver|docker-junk' "${DOCS[@]}"

# Keep module resolution at REPO, but discovery at an empty workspace and HOME.
ISO="$SANDBOX/iso"
ENV_ISO=(env -i "PATH=$PATH" "HOME=$ISO/home" "XDG_STATE_HOME=$ISO/state"
	"PI_AGENT_DIR=$ISO/pi/agent" "PI_CODING_AGENT_DIR=$ISO/pi/agent" "CLAUDE_CONFIG_DIR=$ISO/claude")
isolated() { "${ENV_ISO[@]}" "$@"; }
LOADER='
import {DefaultResourceLoader, getAgentDir} from "@earendil-works/pi-coding-agent";
const loader = new DefaultResourceLoader({cwd: process.argv[1], agentDir: getAgentDir()});
await loader.reload();
const {skills, diagnostics} = loader.getSkills();
console.log(JSON.stringify({fleet: skills.some(s => s.name === "fleet"),
  tdd: skills.some(s => s.name === "tdd"),
  diagnostics: Array.isArray(diagnostics) ? diagnostics.length : -1}));'
discovery() {
	(cd "$REPO" && isolated node --input-type=module -e "$LOADER" "$ISO/workspaces") \
		> "$ISO/discovery.json" 2> "$ISO/loader.err" &&
	python3 -c 'import json, sys
with open(sys.argv[1]) as f: d = json.load(f)
expected = sys.argv[2] == "true"
assert d["fleet"] is expected and d["tdd"] is expected and d["diagnostics"] == 0
print("  Pi SDK: " + json.dumps(d))' "$ISO/discovery.json" "$1"
}
install_real() {
	isolated "$REPO/bin/agent-kit" install pi claude-code > "$ISO/install.log" 2>&1 &&
	has_all "$ISO/install.log" 'Installing (pi root:' 'Installing (claude-code root:' 'entity(ies)' &&
	no_match 'conflict|error:' "$ISO/install.log"
}
uninstall_real() { isolated "$REPO/bin/agent-kit" uninstall > "$ISO/uninstall.log" 2>&1; }
links_gone() {
	local path
	for path in "$ISO/pi/agent/skills/fleet" "$ISO/claude/skills/fleet"; do
		[ ! -L "$path" ] && [ ! -e "$path" ] || return 1
	done
}
if ! command -v node >/dev/null 2>&1 || [ ! -d "$REPO/node_modules/@earendil-works/pi-coding-agent" ]; then
	skip 'installer: node or project-local Pi SDK missing'
elif mkdir -p "$ISO/home" "$ISO/workspaces"; then
	check 'installer: real isolated install and successful log' install_real
	check 'installer: Pi fleet symlink present' test -L "$ISO/pi/agent/skills/fleet"
	check 'installer: Claude fleet symlink present (link proof only)' test -L "$ISO/claude/skills/fleet"
	check 'installer: Pi discovers fleet and tdd, zero diagnostics' discovery true
	check 'installer: real isolated uninstall' uninstall_real
	check 'installer: fleet links removed, including dangling links' links_gone
	check 'installer: Pi discovers neither fleet nor tdd after uninstall' discovery false
else
	fail 'installer: sandbox directories'
fi

# Resolve the actual wrapper, not the invoking cwd or a symlink location.
CLI="" ROOT="" CHECKOUT=""
if [ -n "${FLEET_TEST_CHECKOUT:-}" ] && [ -x "$FLEET_TEST_CHECKOUT/bin/fleet" ]; then
	CLI="$FLEET_TEST_CHECKOUT/bin/fleet"; CHECKOUT="$FLEET_TEST_CHECKOUT"
elif CLI="$(command -v fleet)"; then :
else CLI=""
fi
root_check() {
	CLI="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$CLI")" &&
	ROOT="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[2]) if sys.argv[2] else os.path.dirname(os.path.dirname(sys.argv[1])))' "$CLI" "$CHECKOUT")" &&
	python3 -c 'import ast, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
tree = ast.parse((root / "fleet/config.py").read_text())
assert any(isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "REPO_ROOT" for t in n.targets) for n in tree.body)
ops = (root / "fleet/ops.py").read_text()
probe = ops[ops.index("def probe_address"):ops.index("\ndef ", ops.index("def probe_address"))]
assert "ConnectionRefusedError" in probe and "reachable" in probe.split("ConnectionRefusedError", 1)[1]
with (root / "inventory/fleet.json").open() as f: data = json.load(f)
assert isinstance(data["machines"], list)
print("  Registry machines: " + str(len(data["machines"])))' "$ROOT"
}
inventory_check() {
	"$CLI" inventory list --format json > "$SANDBOX/list.json" 2> "$SANDBOX/list.err" &&
	python3 -c 'import json, sys
with open(sys.argv[1]) as f: d = json.load(f)
assert isinstance(d, dict) and {"schema", "count", "machines"} <= d.keys()
assert isinstance(d["machines"], list) and len(d["machines"]) == d["count"]
assert all(isinstance(m, dict) and "name" in m and not {"notes", "baseline", "discovered"} & m.keys() for m in d["machines"])
print("  List machines: " + str(d["count"]))' "$SANDBOX/list.json"
}
profile_check() {
	"$CLI" ssh generate --profile agent --output - > "$SANDBOX/agent.conf" 2> "$SANDBOX/generate.err" &&
	python3 -c 'import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text()
assert "(stopped" not in text
blocks = []
for line in text.splitlines():
    words = line.split()
    if not words or words[0].startswith("#"): continue
    if words[0] == "Host": blocks.append((words[1:], []))
    elif blocks: blocks[-1][1].append(words)
catch = [opts for hosts, opts in blocks if hosts == ["*"]]
hosts = [(names, opts) for names, opts in blocks if names != ["*"]]
assert len(catch) == 1 and ["ProxyCommand", "/usr/bin/false"] in catch[0]
assert hosts and all(["User", "agent"] in opts and ["StrictHostKeyChecking", "yes"] in opts for _, opts in hosts)
pathlib.Path(sys.argv[2]).write_text(hosts[0][0][0])
print("  Agent host blocks: " + str(len(hosts)))' "$SANDBOX/agent.conf" "$SANDBOX/alias"
}
unknown_check() {
	ssh -G -F "$SANDBOX/agent.conf" "agent-kit-unknown-$RANDOM-$RANDOM.invalid" \
		> "$SANDBOX/unknown.effective" 2> "$SANDBOX/unknown.err" &&
	# Any real proxycommand denies the alias — do not trust it to be exactly
	# the documented catch-all; a tampered file must be denied either way.
	awk '$1 == "proxycommand" && $2 != "none" { found = 1 } END { exit !found }' \
		"$SANDBOX/unknown.effective"
}
known_check() {
	local alias
	alias="$(< "$SANDBOX/alias")" && [ -n "$alias" ] &&
	ssh -G -F "$SANDBOX/agent.conf" "$alias" > "$SANDBOX/known.effective" 2> "$SANDBOX/known.err" &&
	has_lines "$SANDBOX/known.effective" 'user agent' 'identitiesonly yes' &&
	# OpenSSH versions serialize the strict "yes" setting as either yes or true,
	# and may print the identity path ~-expanded: compare the normalized path.
	grep -qxE -- 'stricthostkeychecking (yes|true)' "$SANDBOX/known.effective" &&
	grep -qxE -- 'identityfile [^ ]*\.ssh/id_fleet_agent' "$SANDBOX/known.effective" &&
	awk '$1 == "proxycommand" && $0 != "proxycommand none" { bad=1 } END { exit bad }' "$SANDBOX/known.effective"
}
lint_check() {
	local rc=0
	if "$CLI" keys lint > "$SANDBOX/lint.txt" 2>&1; then rc=0; else rc=$?; fi
	[ "$rc" -eq 0 ] || [ "$rc" -eq 1 ] || return 1
	[ -s "$SANDBOX/lint.txt" ]
}
if [ -z "$CLI" ]; then
	skip 'real-cli: no Fleet CLI; set FLEET_TEST_CHECKOUT or add fleet to PATH'
else
	check 'real-cli: resolved root, config REPO_ROOT, registry readable (counts only)' root_check
	check 'real-cli: --version succeeds' "$CLI" --version
	check 'real-cli: JSON inventory is a counted flat projection' inventory_check
	check 'real-cli: strict agent host blocks, fail-closed catch-all, no stopped markers' profile_check
	if command -v ssh >/dev/null 2>&1; then
		check 'real-cli: ssh -G unknown alias is refused locally' unknown_check
		check 'real-cli: ssh -G real alias uses agent identity and no proxy' known_check
	else
		skip 'real-cli: ssh unavailable for local -G resolution'
	fi
	check 'real-cli: keys lint reports with rc 0 or 1' lint_check
fi
summary
[ "$FAIL" -eq 0 ]
