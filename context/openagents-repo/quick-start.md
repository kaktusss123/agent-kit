# OpenAgents Control Repository - Quick Start

**Purpose**: Get oriented in this repo in 2 minutes

---

## What Is This Repo?

OpenAgents Control is an AI agent framework with:
- **Category-based agents** (core, development, content, data, product, learning)
- **Eval framework** for testing agent behavior
- **Registry system** for component distribution
- **Install system** for easy setup

---

## Start Here

Suggested orientation files available in this context set:

1. **Quick start** → `quick-start.md` (this file)
2. **Registry dependencies** → `quality/registry-dependencies.md`
3. **Add a skill** → `guides/adding-skill.md`
4. **Claude Code helpers** → `../to-be-consumed/claude-code-docs/create-subagents.md`

---

## I Need To...

| Task | Load These Files |
|------|------------------|
| Add a new skill | `guides/adding-skill.md` |
| Validate registry dependencies | `quality/registry-dependencies.md` |
| Use Claude Code helpers | `../to-be-consumed/claude-code-docs/create-subagents.md` + `../to-be-consumed/claude-code-docs/agent-skills.md` |

---

## Essential Paths (Top 15)

```
.opencode/agent/core/                    # Core agents (openagent, opencoder)
.opencode/agent/{category}/              # Category agents
.opencode/agent/subagents/               # Subagents
evals/agents/{category}/{agent}/         # Agent tests
evals/framework/src/                     # Eval framework code
registry.json                            # Component catalog
install.sh                               # Installer
scripts/registry/validate-registry.sh    # Validate registry
scripts/registry/auto-detect-components.sh # Auto-detect components
scripts/validation/validate-test-suites.sh # Validate tests
/Users/vekomarnitskiy/.config/opencode/context/                       # Context files
.opencode/command/                       # Slash commands
docs/                                    # Documentation
VERSION                                  # Current version
package.json                             # Node dependencies
```

---

## Common Commands (Top 10)

```bash
# Add new agent (auto-detect)
./scripts/registry/auto-detect-components.sh --auto-add

# Validate registry
./scripts/registry/validate-registry.sh

# Test agent
cd evals/framework && npm run eval:sdk -- --agent={category}/{agent}

# Run smoke test
cd evals/framework && npm run eval:sdk -- --agent={agent} --pattern="smoke-test.yaml"

# Test with debug
cd evals/framework && npm run eval:sdk -- --agent={agent} --debug

# Validate test suites
./scripts/validation/validate-test-suites.sh

# Install locally (test)
REGISTRY_URL="file://$(pwd)/registry.json" ./install.sh --list

# Bump version
echo "0.X.Y" > VERSION && jq '.version = "0.X.Y"' package.json > tmp && mv tmp package.json

# Check version consistency
cat VERSION && cat package.json | jq '.version'

# Run full validation
./scripts/registry/validate-registry.sh && ./scripts/validation/validate-test-suites.sh
```

---

## Repository Structure (Quick View)

```
opencode-agents/
├── .opencode/
│   ├── agent/{category}/        # Agents by domain
│   │   ├── core/                # Core system agents
│   │   ├── development/         # Dev specialists
│   │   ├── content/             # Content creators
│   │   ├── data/                # Data analysts
│   │   ├── product/             # Product managers
│   │   ├── learning/            # Educators
│   │   └── subagents/           # Delegated specialists
│   ├── command/                 # Slash commands
│   └── context/                 # Shared knowledge
├── evals/
│   ├── agents/{category}/       # Test suites
│   └── framework/               # Eval framework
├── scripts/
│   ├── registry/                # Registry tools
│   └── validation/              # Validation tools
├── docs/                        # Documentation
├── registry.json                # Component catalog
└── install.sh                   # Installer
```

---

## Quick Troubleshooting

| Problem | Solution |
|---------|----------|
| Registry validation fails | `./scripts/registry/auto-detect-components.sh --auto-add` |
| Install fails | Check: `which curl jq` |
| Path resolution issues | Review `quality/registry-dependencies.md` |

---

## Next Steps

1. **First time?** → Read `quick-start.md` and `quality/registry-dependencies.md`
2. **Adding a skill?** → Load `guides/adding-skill.md`
3. **Claude Code helpers?** → Load `../to-be-consumed/claude-code-docs/create-subagents.md`

---

**Last Updated**: 2026-01-13  
**Version**: 0.5.1
