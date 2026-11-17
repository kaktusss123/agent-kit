import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { stripShimFromPath } from '../../extensions/task-workspace/cli.ts';

const repo = resolve(import.meta.dirname, '../..');
const portable = ['arena', 'swarm', 'correct', 'reflect', 'benchmark-checklist', 'formal-verification', 'modernize', 'full-send', 'council'];

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
    const hostRoots = [join(home, '.pi/agent'), join(home, '.claude'), join(home, '.agents')];
    const rules = join(home, '.codex/AGENTS.md');
    const expectedRules = `${readFileSync(join(repo, 'rules/codex.md'), 'utf8')}\n\n${readFileSync(join(repo, 'rules/AGENTS.md'), 'utf8')}`;
    const checkRules = () => {
      assert.equal(readFileSync(rules, 'utf8'), expectedRules);
      assert.equal(readlinkSync(join(home, '.pi/agent/AGENTS.md')), join(repo, 'rules/AGENTS.md'));
      assert.equal(readlinkSync(join(home, '.claude/rules/agent-kit.md')), join(repo, 'rules/AGENTS.md'));
    };
    run('install');
    checkRules();
    for (const hostRoot of hostRoots) {
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
    const generatedRules = readlinkSync(rules);
    run('install');
    checkRules();
    assert.equal(readlinkSync(rules), generatedRules);
    unlinkSync(rules);
    run('install');
    checkRules();
    assert.equal(readlinkSync(rules), generatedRules);
    for (const hostRoot of hostRoots) {
      for (const skill of portable) assert.equal(readlinkSync(join(hostRoot, 'skills', skill)), join(repo, 'skills', skill));
    }
    run('uninstall');
    for (const hostRoot of hostRoots) {
      for (const skill of portable) assert.equal(existsSync(join(hostRoot, 'skills', skill)), false);
    }
    assert.equal(existsSync(rules), false);
    assert.equal(existsSync(join(home, '.pi/agent/AGENTS.md')), false);
    assert.equal(existsSync(join(home, '.claude/rules/agent-kit.md')), false);
    assert.equal(existsSync(reminder), false);
    assert.ok(existsSync(join(repo, '.agents/skills/verify/features/README.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
