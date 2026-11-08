import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { stripShimFromPath } from '../../extensions/task-workspace/cli.ts';

const repo = resolve(import.meta.dirname, '../..');
let sandbox;
afterEach(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });
function fresh() {
  sandbox = mkdtempSync(join(tmpdir(), 'agent-kit-codex-'));
  const home = join(sandbox, 'home');
  const kit = join(sandbox, "kit's checkout");
  const state = join(home, '.local/state/agent-kit');
  mkdirSync(home);
  mkdirSync(kit);
  for (const dir of ['bin', 'rules', 'skills', 'codex']) cpSync(join(repo, dir), join(kit, dir), { recursive: true });
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, '.local/state'), PATH: stripShimFromPath(process.env.PATH ?? '') };
  for (const key of ['AGENT_KIT_ROOT', 'CODEX_HOME', 'PI_AGENT_DIR', 'CLAUDE_CONFIG_DIR', 'AGENT_TASK_ROOT']) delete env[key];
  function cli(args, checkout = kit) {
    return spawnSync(process.execPath, [join(checkout, 'bin/agent-kit'), ...args], { env, cwd: home, encoding: 'utf8' });
  }
  return { home, kit, env, cli, state, config: join(home, '.codex'), shared: join(home, '.agents') };
}
function ok(proc) { assert.equal(proc.status, 0, proc.stdout + proc.stderr); }
function text(path) { return readFileSync(path, 'utf8'); }

test('Codex-only fresh/repeat install, two explicit scope roots and independent uninstall', () => {
  const f = fresh();
  ok(f.cli(['install', 'codex']));
  assert.equal(text(join(f.state, 'hosts')), 'codex\n');
  assert.equal(readlinkSync(join(f.shared, 'skills/git-task')), join(f.kit, 'skills/git-task'));
  assert.equal(readlinkSync(join(f.shared, 'skills/spec')), join(f.kit, 'codex/skills/spec'));
  for (const file of ['skills/spec/SKILL.md', 'skills/dev/SKILL.md', 'skills/git-task/references/codex/workflow.md']) {
    const content = text(join(f.shared, file));
    const references = [...content.matchAll(/\$HOME\/\.agents\/skills\/[A-Za-z0-9._/-]+\.md/g)];
    assert.ok(references.length, `missing installed-addressable references in ${file}`);
    for (const [reference] of references) assert.ok(existsSync(reference.replace('$HOME', f.home)), `${file}: ${reference}`);
  }
  assert.ok(text(join(f.config, 'AGENTS.md')).includes(text(join(f.kit, 'rules/AGENTS.md'))));
  assert.match(text(join(f.config, 'AGENTS.md')), /^# Codex host binding/);
  const hooks = JSON.parse(text(join(f.config, 'hooks.json')));
  assert.equal(hooks.hooks.PreToolUse[0].matcher, '^(Bash|apply_patch)$');
  assert.match(text(join(f.state, 'links-codex.tsv')), /^AGENTS.md\t/m);
  assert.match(text(join(f.state, 'links-codex-skills.tsv')), /^skills\/git-task\t/m);
  assert.ok(!existsSync(join(f.home, '.pi')));
  assert.ok(!existsSync(join(f.config, 'skills')));
  const before = readlinkSync(join(f.config, 'AGENTS.md'));
  ok(f.cli(['install']));
  assert.equal(readlinkSync(join(f.config, 'AGENTS.md')), before);
  ok(f.cli(['install', 'pi']));
  ok(f.cli(['uninstall', 'codex']));
  assert.ok(!existsSync(join(f.shared, 'skills/git-task')));
  assert.ok(!existsSync(join(f.config, 'AGENTS.md')));
  assert.ok(existsSync(join(f.home, '.pi/agent/skills/git-task')));
});
test('fresh default all hosts; existing selection never acquires Codex; CODEX_HOME does not move skills', () => {
  const f = fresh();
  ok(f.cli(['install', 'pi']));
  ok(f.cli(['install']));
  assert.ok(!existsSync(f.config));
  f.env.CODEX_HOME = join(sandbox, 'custom config');
  ok(f.cli(['install', 'codex']));
  assert.ok(existsSync(join(f.env.CODEX_HOME, 'AGENTS.md')));
  assert.ok(existsSync(join(f.shared, 'skills/git-task')));
  assert.ok(!existsSync(join(f.env.CODEX_HOME, 'skills')));
  assert.ok(!existsSync(f.config));
  ok(f.cli(['uninstall']));
  ok(f.cli(['install']));
  assert.equal(text(join(f.state, 'hosts')), 'pi\nclaude-code\ncodex\n');
});
test('foreign global rules/hooks/skills and redirected owned links survive install/uninstall', () => {
  const f = fresh();
  mkdirSync(f.config);
  mkdirSync(join(f.shared, 'skills'), { recursive: true });
  writeFileSync(join(f.config, 'config.toml'), 'model = "preserved-user-choice"\n');
  writeFileSync(join(f.config, 'AGENTS.md'), 'foreign rules');
  writeFileSync(join(f.config, 'hooks.json'), 'foreign hooks');
  symlinkSync('/foreign/skill', join(f.shared, 'skills/git-task'));
  assert.equal(f.cli(['install', 'codex']).status, 1);
  assert.equal(text(join(f.config, 'AGENTS.md')), 'foreign rules');
  assert.equal(text(join(f.config, 'hooks.json')), 'foreign hooks');
  assert.equal(readlinkSync(join(f.shared, 'skills/git-task')), '/foreign/skill');
  rmSync(join(f.config, 'AGENTS.md'));
  ok(f.cli(['uninstall', 'codex']));
  assert.equal(text(join(f.config, 'hooks.json')), 'foreign hooks');
  assert.equal(readlinkSync(join(f.shared, 'skills/git-task')), '/foreign/skill');
  rmSync(join(f.config, 'hooks.json'));
  rmSync(join(f.shared, 'skills/git-task'));
  ok(f.cli(['install', 'codex']));
  rmSync(join(f.config, 'AGENTS.md'));
  symlinkSync('/foreign/rules', join(f.config, 'AGENTS.md'));
  assert.equal(f.cli(['install', 'codex']).status, 1);
  ok(f.cli(['uninstall', 'codex']));
  assert.equal(readlinkSync(join(f.config, 'AGENTS.md')), '/foreign/rules');
  assert.equal(text(join(f.config, 'config.toml')), 'model = "preserved-user-choice"\n');
});
test('override shadow is diagnosed, including dangling override links, without claiming active rules', () => {
  const f = fresh();
  mkdirSync(f.config);
  symlinkSync('/missing/override', join(f.config, 'AGENTS.override.md'));
  assert.equal(f.cli(['install', 'codex']).status, 1);
  assert.ok(existsSync(join(f.config, 'hooks.json')));
  assert.match(f.cli(['status']).stdout, /override.md shadows global rules; rules are not active/);
  assert.equal(readlinkSync(join(f.config, 'AGENTS.override.md')), '/missing/override');
});
test('checkout/source changes relink owned skills and immutable generated content; corruption fails closed', () => {
  const f = fresh();
  ok(f.cli(['install', 'codex']));
  const previous = readlinkSync(join(f.config, 'AGENTS.md'));
  const second = join(sandbox, 'second checkout');
  cpSync(f.kit, second, { recursive: true });
  writeFileSync(join(second, 'rules/AGENTS.md'), text(join(second, 'rules/AGENTS.md')) + '\n# Source change\n');
  ok(f.cli(['install'], second));
  assert.equal(readlinkSync(join(f.shared, 'skills/git-task')), join(second, 'skills/git-task'));
  assert.notEqual(readlinkSync(join(f.config, 'AGENTS.md')), previous);
  assert.match(text(join(f.config, 'AGENTS.md')), /Source change/);
  assert.match(text(join(f.config, 'hooks.json')), /second checkout/);
  assert.ok(existsSync(previous)); // never delete an unrecorded generated source
  writeFileSync(readlinkSync(join(f.config, 'AGENTS.md')), 'externally modified');
  assert.notEqual(f.cli(['install'], second).status, 0);
  assert.equal(text(join(f.config, 'AGENTS.md')), 'externally modified');
});
test('selected-host update through local upstream reconciles Codex source additions', () => {
  const f = fresh();
  const git = (...args) => execFileSync('git', args, { env: f.env, encoding: 'utf8' });
  git('-C', f.kit, 'init', '-qb', 'main');
  git('-C', f.kit, 'config', 'user.name', 'Fixture');
  git('-C', f.kit, 'config', 'user.email', 'fixture@example.invalid');
  git('-C', f.kit, 'add', 'bin', 'rules', 'skills', 'codex');
  git('-C', f.kit, 'commit', '-qm', 'initial');
  const remote = join(sandbox, 'remote.git');
  git('init', '--bare', '-q', remote);
  git('-C', f.kit, 'remote', 'add', 'origin', remote);
  git('-C', f.kit, 'push', '-qu', 'origin', 'main');
  const seed = join(sandbox, 'seed');
  git('clone', '-qb', 'main', remote, seed);
  git('-C', seed, 'config', 'user.name', 'Fixture');
  git('-C', seed, 'config', 'user.email', 'fixture@example.invalid');
  ok(f.cli(['install', 'codex']));
  mkdirSync(join(seed, 'skills/new-skill'));
  writeFileSync(join(seed, 'skills/new-skill/SKILL.md'), 'new skill');
  git('-C', seed, 'add', 'skills/new-skill');
  git('-C', seed, 'commit', '-qm', 'new skill');
  git('-C', seed, 'push', '-q');
  ok(f.cli(['update']));
  assert.ok(existsSync(join(f.shared, 'skills/new-skill')));
  assert.equal(text(join(f.state, 'hosts')), 'codex\n');
  assert.ok(!existsSync(join(f.home, '.pi')));
});
