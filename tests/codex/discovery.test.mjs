// No model/provider calls: the installed CLI renders its effective local input.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { stripShimFromPath } from '../../extensions/task-workspace/cli.ts';

const version = spawnSync('codex', ['--version'], { encoding: 'utf8' });
test('live Codex 0.166.0 discovers installed shared symlink skills and combined global instructions without a model', {
  skip: version.status !== 0 || !version.stdout.includes('0.166.0') ? 'requires codex-cli 0.166.0 (no model calls)' : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-kit-discovery-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const env = { ...process.env, HOME: home, CODEX_HOME: join(root, 'codex-config'), XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), PATH: stripShimFromPath(process.env.PATH ?? '') };
    for (const key of ['AGENT_KIT_ROOT', 'PI_AGENT_DIR', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[key];
    const install = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../bin/agent-kit'), 'install', 'codex'], { cwd: home, env, encoding: 'utf8' });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const prompt = spawnSync('codex', ['debug', 'prompt-input', 'Local discovery check only.'], { cwd: home, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(prompt.status, 0, prompt.stderr);
    const data = JSON.parse(prompt.stdout);
    const serialized = JSON.stringify(data);
    for (const expected of ['Codex host binding', 'Communication contract', 'Git task discipline', 'references/codex/workflow.md', 'spec', 'dev', `- \`r0\` = \`${join(home, '.agents/skills')}\``, '(file: r0/git-task/SKILL.md)', '(file: r0/spec/SKILL.md)', '(file: r0/dev/SKILL.md)']) {
      assert.ok(serialized.includes(expected), `missing ${expected}`);
    }
    assert.ok(!serialized.includes(join(env.CODEX_HOME, 'skills/git-task')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
