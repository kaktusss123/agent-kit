import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { stripShimFromPath } from '../../extensions/task-workspace/cli.ts';

const repo = resolve(import.meta.dirname, '../..');
const portable = ['arena', 'swarm', 'correct', 'reflect', 'benchmark-checklist', 'formal-verification'];

test('normal installation discovers portable workflows for all hosts and the reminder only for Pi', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-install-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, '.local/state'), PATH: stripShimFromPath(process.env.PATH ?? '') };
    for (const key of ['AGENT_KIT_ROOT', 'CODEX_HOME', 'PI_AGENT_DIR', 'CLAUDE_CONFIG_DIR', 'AGENT_TASK_ROOT']) delete env[key];
    const run = (op) => {
      const result = spawnSync(process.execPath, [join(repo, 'bin/agent-kit'), op, 'pi', 'claude-code', 'codex'], { env, cwd: home, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    };
    run('install');
    for (const hostRoot of [join(home, '.pi/agent'), join(home, '.claude'), join(home, '.agents')]) {
      for (const skill of portable) {
        const installed = join(hostRoot, 'skills', skill);
        assert.equal(readlinkSync(installed), join(repo, 'skills', skill));
        assert.ok(existsSync(join(installed, 'SKILL.md')));
      }
      // The coverage map belongs to this repository, not all installed projects.
      assert.equal(existsSync(join(hostRoot, 'skills/verify')), false);
    }
    const reminder = join(home, '.pi/agent/extensions/skill-reflection');
    assert.equal(readlinkSync(reminder), join(repo, 'extensions/skill-reflection'));
    assert.ok(existsSync(join(reminder, 'index.ts')));
    for (const hostRoot of [join(home, '.claude'), join(home, '.codex')]) {
      assert.equal(existsSync(join(hostRoot, 'extensions/skill-reflection')), false);
    }
    run('install');
    run('uninstall');
    assert.equal(existsSync(reminder), false);
    assert.ok(existsSync(join(repo, '.agents/skills/verify/features/README.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
