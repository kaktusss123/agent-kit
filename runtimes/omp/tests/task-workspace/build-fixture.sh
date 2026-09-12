#!/usr/bin/env bash
# Disposable multi-repo fixture for task-workspace + workspace_agent verification.
# Fixture root /var/tmp/omp-taskws is disposable and rebuilt from scratch every run;
# the harness scripts in this directory import the extensions from the repo
# working tree (override with TW_EXTENSIONS_DIR) or the deployed agent dir.
set -euo pipefail

ROOT=${TW_FIXTURE_ROOT:-/var/tmp/omp-taskws}
rm -rf "$ROOT"
mkdir -p "$ROOT/remotes" "$ROOT/work"

git config --global init.defaultBranch main >/dev/null 2>&1 || true

# ---------- producer: default branch main, develop exists ----------
git init -q --bare -b main "$ROOT/remotes/producer.git"
git init -q -b main "$ROOT/work/producer"
cd "$ROOT/work/producer"
git config user.email fixture@local
git config user.name fixture
git remote add origin "$ROOT/remotes/producer.git"
mkdir -p lib
echo '{ "version": 1, "endpoint": "/api/v1" }' > lib/api.json
echo "# producer (A)" > README.md
echo "AGENTS-PRODUCER-MARKER-A: producer project context" > AGENTS.md
mkdir -p .omp/prompts .omp/extensions
printf '# producer project settings (marker A)\ndefaultThinkingLevel: high\n' > .omp/config.yml
cat > .omp/prompts/producer-only.md <<'EOF'
---
description: producer-only prompt marker
---
Producer prompt body (marker A).
EOF
cat > .omp/extensions/producer-tool.ts <<'EOF'
export default function (pi: any) {
	pi.registerTool({
		name: "producer_tool",
		label: "Producer Tool",
		description: "project-local tool of producer (A)",
		parameters: pi.typebox.Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "PRODUCER-A" }] }),
	});
}
EOF
git add -A
git commit -qm "chore: producer baseline"
git branch -q develop
git push -q origin main develop
git checkout -q develop
echo "producer work-in-progress dirt (never touch)" > WIP-PRODUCER.txt
git checkout -q main

# ---------- consumer: default branch develop, no main ----------
git init -q --bare -b develop "$ROOT/remotes/consumer.git"
git init -q -b develop "$ROOT/work/consumer"
cd "$ROOT/work/consumer"
git config user.email fixture@local
git config user.name fixture
git remote add origin "$ROOT/remotes/consumer.git"
mkdir -p tools
cat > tools/check-api.sh <<'EOF'
#!/usr/bin/env bash
# marker B helper script
test -f lib/api.json && echo api-ok
EOF
chmod +x tools/check-api.sh
echo "# consumer (B)" > README.md
echo "AGENTS-CONSUMER-MARKER-B: consumer project context" > AGENTS.md
mkdir -p .omp/prompts .omp/extensions
printf '# consumer project settings (marker B)\ndefaultThinkingLevel: low\n' > .omp/config.yml
cat > .omp/prompts/consumer-only.md <<'EOF'
---
description: consumer-only prompt marker
---
Consumer prompt body (marker B).
EOF
cat > .omp/extensions/consumer-tool.ts <<'EOF'
export default function (pi: any) {
	pi.registerTool({
		name: "consumer_tool",
		label: "Consumer Tool",
		description: "project-local tool of consumer (B)",
		parameters: pi.typebox.Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "CONSUMER-B" }] }),
	});
}
EOF
git add -A
git commit -qm "chore: consumer baseline"
git push -q origin develop
echo "consumer work-in-progress dirt (never touch)" > WIP-CONSUMER.txt

# ---------- remote-only task branch on producer remote ----------
TMP=$(mktemp -d)
git clone -q "$ROOT/remotes/producer.git" "$TMP/producer"
cd "$TMP/producer"
git config user.email fixture@local
git config user.name fixture
git checkout -q -b feat/EVODP-70001_remote_only origin/main
echo "remote-only branch content" > remote-only.txt
git add -A
git commit -qm "feat(EVODP-70001): remote only work"
git push -q origin feat/EVODP-70001_remote_only
rm -rf "$TMP"

# ---------- manual (non-managed) worktree on a task-named branch ----------
cd "$ROOT/work/producer"
git branch feat/EVODP-80001_manual main
git worktree add -q "$ROOT/work/producer-manual-wt" feat/EVODP-80001_manual

echo "fixture ready: $ROOT"
