import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { stripShimFromPath } from '../../extensions/task-workspace/cli.ts';

const repo = resolve(import.meta.dirname, '../..');
// Place fixture outside /tmp because guardManagedWriteTarget treats /tmp as scratch space.
const root = mkdtempSync(join(repo, '.tmp-antigravity-hook-'));
after(() => rmSync(root, { recursive: true, force: true }));

const env = { ...process.env, PATH: stripShimFromPath(process.env.PATH ?? '') };
const taskRoot = join(root, 'tasks');
const primary = join(root, 'primary');
const managed = join(taskRoot, 'feat_demo', 'primary');
mkdirSync(primary, { recursive: true });
mkdirSync(join(taskRoot, 'feat_demo'), { recursive: true });

function git(...args) {
  return execFileSync('git', args, { env, encoding: 'utf8' });
}
git('-C', primary, 'init', '-qb', 'main');
git('-C', primary, 'config', 'user.name', 'Fixture');
git('-C', primary, 'config', 'user.email', 'fixture@example.invalid');
writeFileSync(join(primary, 'tracked.txt'), 'v1\n');
writeFileSync(join(primary, '.gitignore'), 'ignored.log\n');
git('-C', primary, 'add', 'tracked.txt', '.gitignore');
git('-C', primary, 'commit', '-qm', 'initial');
git('-C', primary, 'worktree', 'add', '-q', '-b', 'feat/demo', managed);

function runHook(payload) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const proc = spawnSync(process.execPath, [join(repo, 'antigravity/hook.ts')], {
    input,
    env: { ...env, AGENT_TASK_ROOT: taskRoot },
    cwd: primary,
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0, proc.stderr);
  return proc.stdout.trim() ? JSON.parse(proc.stdout) : null;
}

test('blocks write_file and edit_file targeting primary checkout when managed worktree exists', () => {
  for (const [tool, key] of [
    ['write_file', 'Path'],
    ['edit_file', 'Path'],
    ['write_to_file', 'TargetFile'],
    ['replace_file_content', 'TargetFile'],
    ['multi_replace_file_content', 'TargetFile'],
  ]) {
    const res = runHook({
      hookEventName: 'PreToolUse',
      cwd: primary,
      toolCall: { id: '1', name: tool, args: { [key]: join(primary, 'tracked.txt') } },
    });
    assert.equal(res.decision, 'deny', `${tool} should deny primary checkout write`);
    assert.match(res.reason, /managed task worktree/i);
  }
});

test('passes through (empty stdout) for managed worktree writes and ignored primary files without auto-allowing', () => {
  const managedRes = runHook({
    hookEventName: 'PreToolUse',
    cwd: primary,
    toolCall: { id: '2', name: 'edit_file', args: { Path: join(managed, 'tracked.txt') } },
  });
  assert.equal(managedRes, null);

  const ignoredRes = runHook({
    hookEventName: 'PreToolUse',
    cwd: primary,
    toolCall: { id: '3', name: 'write_file', args: { Path: join(primary, 'ignored.log') } },
  });
  assert.equal(ignoredRes, null);
});

test('blocks writes to .git metadata', () => {
  const res = runHook({
    hookEventName: 'PreToolUse',
    cwd: primary,
    toolCall: { id: '4', name: 'write_file', args: { Path: join(primary, '.git/config') } },
  });
  assert.equal(res.decision, 'deny');
  assert.match(res.reason, /Git metadata/i);
});

test('blocks raw git commit --no-verify in run_command and passes normal commands through', () => {
  const denied = runHook({
    hookEventName: 'PreToolUse',
    cwd: managed,
    toolCall: { id: '5', name: 'run_command', args: { CommandLine: 'git commit --no-verify -m "wip"' } },
  });
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /--no-verify/);

  const deniedShort = runHook({
    hookEventName: 'PreToolUse',
    cwd: managed,
    toolCall: { id: '6', name: 'run_command', args: { CommandLine: 'git -C /repo commit -n -m "wip"' } },
  });
  assert.equal(deniedShort.decision, 'deny');

  const deniedAm = runHook({
    toolCall: { name: 'run_command', args: { CommandLine: 'git am -n change.patch' } },
  });
  assert.equal(deniedAm.decision, 'deny');

  const ok = runHook({
    hookEventName: 'PreToolUse',
    cwd: managed,
    toolCall: { id: '7', name: 'run_command', args: { CommandLine: 'git -C /repo status --short' } },
  });
  assert.equal(ok, null);
});

test('passes through Git operations using -n to prepare changes without committing', () => {
  for (const subcommand of ['revert', 'cherry-pick']) {
    const result = runHook({
      toolCall: { name: 'run_command', args: { CommandLine: `git ${subcommand} -n HEAD` } },
    });
    assert.equal(result, null, `${subcommand} -n should pass through`);
  }
});

test('malformed JSON fails open with empty stdout', () => {
  assert.equal(runHook('not-json'), null);
});
