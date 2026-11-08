import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { shellQuote } from '../../bin/lib/codex.mjs';

const repo = resolve(import.meta.dirname, '../..');
// Not /tmp: shared routing policy intentionally exempts scratch directories.
const root = mkdtempSync(join(repo, 'node_modules/codex-hook-'));
after(() => rmSync(root, { recursive: true, force: true }));
const source = join(root, 'source');
const taskRoot = join(root, "task's workspaces");
const worktree = join(taskRoot, 'task/repo');
const home = join(root, 'home');
mkdirSync(source, { recursive: true });
mkdirSync(home);
const env = { ...process.env, HOME: home, AGENT_TASK_ROOT: taskRoot };
delete env.CODEX_HOME;
delete env.CLAUDE_ENV_FILE;
const git = (...args) => execFileSync('git', args, { env, encoding: 'utf8' });
git('-C', source, 'init', '-qb', 'main');
git('-C', source, 'config', 'user.name', 'Fixture');
git('-C', source, 'config', 'user.email', 'fixture@example.invalid');
writeFileSync(join(source, 'tracked'), 'initial\n');
git('-C', source, 'add', 'tracked');
git('-C', source, 'commit', '-qm', 'initial');
mkdirSync(join(taskRoot, 'task'), { recursive: true });
git('-C', source, 'worktree', 'add', '-qb', 'feat/test', worktree);

function hook(tool_name, command, cwd = source) {
  return raw(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command }, cwd }));
}
function raw(input, extraEnv = {}) {
  const proc = spawnSync(process.execPath, [join(repo, 'codex/hook.ts')], { input, env: { ...env, ...extraEnv }, cwd: root, encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout);
}
function run(command, cwd = source) {
  const result = hook('Bash', command, cwd);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'allow');
  return spawnSync('bash', ['-c', result.hookSpecificOutput.updatedInput.command], { cwd, env, encoding: 'utf8' });
}
const patch = (body) => `*** Begin Patch\n${body}\n*** End Patch`;
function denied(result) {
  assert.equal(result.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
  assert.ok(result.hookSpecificOutput.permissionDecisionReason);
}

test('rewritten Bash positive controls: read-only, real tool cwd and managed mutation', () => {
  assert.equal(run('git status --porcelain').status, 0);
  assert.equal(run('git tag allowed', worktree).status, 0);
  assert.equal(run('git rev-parse --show-toplevel', worktree).stdout.trim(), worktree);
  assert.equal(run("printf '%s' \"$AGENT_TASK_ROOT\"").stdout, taskRoot);
  assert.equal(run("printf '%s' 'quoted command stays intact'").stdout, 'quoted command stays intact');
});
test('primary Git mutations blocked after cd, -C and nested shells', () => {
  for (const [command, cwd] of [
    ['git add tracked', source],
    [`cd '${source}' && git add tracked`, worktree],
    [`git -C '${source}' tag forbidden`, worktree],
    [`bash -c 'git add tracked'`, source],
    [`sh -c 'git add tracked'`, source],
  ]) {
    const proc = run(command, cwd);
    assert.notEqual(proc.status, 0, command);
    assert.match(proc.stderr, /Blocked:.*primary checkout/);
  }
});
test('raw no-verify is forbidden even in managed worktrees; CLI checkpoint remains reachable', () => {
  assert.match(run('git commit --no-verify -m forbidden', worktree).stderr, /Blocked:.*no-verify/);
  const command = `${shellQuote(process.execPath)} ${shellQuote(join(repo, 'bin/agent-kit'))} task status ${shellQuote(JSON.stringify({ path: worktree }))}`;
  const proc = run(command, worktree);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(JSON.parse(proc.stdout).classification, 'MANAGED_TASK_WORKTREE');
});
test('every native patch source and move destination is guarded with actual tool cwd', () => {
  for (const body of ['*** Update File: tracked\n@@\n-initial\n+new', '*** Delete File: tracked', '*** Add File: new\n+new']) {
    denied(hook('apply_patch', patch(body)));
    assert.deepEqual(hook('apply_patch', patch(body), worktree), {});
  }
  denied(hook('apply_patch', patch(`*** Update File: tracked\n*** Move to: ${join(source, 'moved')}\n@@\n-initial\n+new`), worktree));
  denied(hook('apply_patch', patch(`*** Update File: ${join(source, 'tracked')}\n*** Move to: moved\n@@\n-initial\n+new`), worktree));
  denied(hook('apply_patch', patch(`*** Add File: safe\n+x\n*** Delete File: ${join(source, 'tracked')}`), worktree));
  denied(hook('apply_patch', patch('*** Delete File: source/tracked'), root));
  denied(hook('apply_patch', patch(`*** Delete File:  ${join(source, 'tracked')} `), worktree));
  denied(hook('apply_patch', patch(`*** Update File: tracked\n*** Move to:  ${join(source, 'moved')} \n@@\n-initial\n+new`), worktree));
});
test('malformed input and adapter errors explicitly deny (not a nonzero fail-open hook error)', () => {
  for (const input of ['{', 'null', '[]', '{}', JSON.stringify({ hook_event_name: 'PreToolUse', cwd: source, tool_name: 'Bash', tool_input: { command: 5 } })]) denied(raw(input));
  for (const text of ['garbage', patch('*** Move to: tracked'), patch('*** Delete File: https://example.invalid/x')]) denied(hook('apply_patch', text));
  denied(raw(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: source, tool_name: 'Bash', tool_input: { command: 'git status' } }), { PATH: '' }));
});
