import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { stripShimFromPath } from '../../extensions/task-workspace/cli.ts';

const repo = resolve(import.meta.dirname, '../..');
let sandbox;
afterEach(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

function fresh() {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'agent-kit-antigravity-')));
  const home = join(sandbox, 'home');
  const kit = join(sandbox, 'kit');
  const state = join(home, '.local/state/agent-kit');
  const config = join(home, '.gemini/config');
  mkdirSync(home, { recursive: true });
  mkdirSync(kit, { recursive: true });
  for (const dir of ['bin', 'rules', 'skills', 'antigravity']) {
    cpSync(join(repo, dir), join(kit, dir), { recursive: true });
  }
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, '.local/state'), PATH: stripShimFromPath(process.env.PATH ?? '') };
  for (const key of ['AGENT_KIT_ROOT', 'CODEX_HOME', 'PI_AGENT_DIR', 'CLAUDE_CONFIG_DIR', 'ANTIGRAVITY_CONFIG_DIR', 'AGENT_TASK_ROOT']) {
    delete env[key];
  }
  function cli(args, checkout = kit) {
    return spawnSync(process.execPath, [join(checkout, 'bin/agent-kit'), ...args], { env, cwd: home, encoding: 'utf8' });
  }
  return { home, kit, env, cli, state, config };
}

function ok(proc) { assert.equal(proc.status, 0, proc.stdout + proc.stderr); }
function text(path) { return readFileSync(path, 'utf8'); }

test('Antigravity install links skills (/spec, /dev, shared) and agent-kit plugin without touching foreign config', () => {
  const f = fresh();
  mkdirSync(join(f.config, 'skills'), { recursive: true });
  writeFileSync(join(f.config, 'hooks.json'), '{"user-hook": {}}\n');
  symlinkSync('/foreign/orchestration', join(f.config, 'skills/orchestration'));

  ok(f.cli(['install', 'antigravity']));
  assert.equal(text(join(f.state, 'hosts')), 'antigravity\n');

  // Foreign files remain untouched.
  assert.equal(text(join(f.config, 'hooks.json')), '{"user-hook": {}}\n');
  assert.equal(readlinkSync(join(f.config, 'skills/orchestration')), '/foreign/orchestration');

  // Shared and entrypoint skills are linked.
  assert.equal(readlinkSync(join(f.config, 'skills/git-task')), join(f.kit, 'skills/git-task'));
  assert.equal(readlinkSync(join(f.config, 'skills/spec')), join(f.kit, 'antigravity/skills/spec'));
  assert.equal(readlinkSync(join(f.config, 'skills/dev')), join(f.kit, 'antigravity/skills/dev'));

  // All installed-addressable references inside spec/dev/workflow resolve.
  for (const file of [
    'skills/spec/SKILL.md',
    'skills/dev/SKILL.md',
    'skills/git-task/references/antigravity/workflow.md',
  ]) {
    const content = text(join(f.config, file));
    const refs = [...content.matchAll(/\$HOME\/\.gemini\/config\/skills\/[A-Za-z0-9._/-]+\.md/g)];
    assert.ok(refs.length, `missing installed-addressable references in ${file}`);
    for (const [ref] of refs) {
      assert.ok(existsSync(ref.replace('$HOME', f.home)), `${file}: ${ref}`);
    }
  }

  // Plugin manifest, merged rules, and hooks.json exist and are valid.
  const pluginDir = join(f.config, 'plugins/agent-kit');
  assert.equal(JSON.parse(text(join(pluginDir, 'plugin.json'))).name, 'agent-kit');
  const rules = text(join(pluginDir, 'rules/AGENTS.md'));
  assert.match(rules, /^# Antigravity host binding/);
  assert.ok(rules.includes(text(join(f.kit, 'rules/AGENTS.md'))));
  assert.ok(Buffer.byteLength(rules, 'utf8') < 24000, 'merged rules must stay under Antigravity 24 KB per-file cap');

  const hooks = JSON.parse(text(join(pluginDir, 'hooks.json')));
  assert.ok(hooks['agent-kit-routing-guard']?.PreToolUse?.[0]?.hooks?.[0]?.command.includes('antigravity/hook.ts'));

  // Repeat install is idempotent.
  const beforeRules = readlinkSync(join(pluginDir, 'rules/AGENTS.md'));
  ok(f.cli(['install']));
  assert.equal(readlinkSync(join(pluginDir, 'rules/AGENTS.md')), beforeRules);

  // Uninstall removes only owned links and leaves foreign config intact.
  ok(f.cli(['uninstall', 'antigravity']));
  assert.ok(!existsSync(join(f.config, 'skills/spec')));
  assert.ok(!existsSync(join(f.config, 'skills/git-task')));
  assert.ok(!existsSync(join(pluginDir, 'hooks.json')));
  assert.ok(!existsSync(join(pluginDir, 'rules/AGENTS.md')));
  assert.equal(text(join(f.config, 'hooks.json')), '{"user-hook": {}}\n');
  assert.equal(readlinkSync(join(f.config, 'skills/orchestration')), '/foreign/orchestration');
});
