// Static checks on written guardrails, not an evaluation of model behavior.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const repo = resolve(import.meta.dirname, '../..');
const text = (path) => readFileSync(resolve(repo, path), 'utf8');
const section = (content, heading) => {
  const match = content.match(new RegExp(`^#{1,2} ${heading}$`, 'm'));
  assert.ok(match, `missing section: ${heading}`);
  const start = match.index;
  const rest = content.slice(start + match[0].length);
  const end = rest.search(/\n#{1,2} /);
  return content.slice(start, end < 0 ? undefined : start + match[0].length + end);
};

test('routing distinguishes explicit mode assignments from background mentions', () => {
  const rules = section(text('rules/AGENTS.md'), 'Autonomous task routing');
  for (const spelling of ['full send', 'full-send', 'full stop', 'full-stop']) assert.ok(rules.includes(spelling));
  assert.match(rules, /quote.*discussion.*not an execution grant/i);
  assert.match(rules, /delegates receive only their explicit assignment/i);
  const skill = text('skills/full-send/SKILL.md');
  assert.match(skill, /do not use a keyword as an authorizer/i);
  assert.match(skill, /cannot waive a mandatory tracker policy/i);
});

test('full stop forbids merging and lease pushes are limited to the owned branch', () => {
  const skill = text('skills/full-send/SKILL.md');
  const stop = section(skill, 'Full stop');
  assert.match(stop, /never merge, enable auto-merge, enter a merge queue, push the default branch/i);
  assert.match(stop, /before each push/i);
  assert.match(skill, /--force-with-lease.*previously observed remote head/i);
  assert.match(skill, /no other live writer/i);
  assert.match(skill, /ungranted production consequence blocks/i);
});

test('council requires current mandatory assessments and blockers override scores', () => {
  const skill = text('skills/council/SKILL.md');
  const convergence = section(skill, 'Convergence and report');
  assert.match(convergence.replaceAll('*', ''), /every mandatory participant/i);
  assert.match(convergence, /minimum score, never an average/i);
  assert.match(convergence, /blocker overrides a high score/i);
  assert.match(convergence, /missing score.*timeout.*invalid.*stale/i);
  assert.match(convergence, /configured budget \(default three rounds\) without convergence.*NOT CONVERGED/i);
  assert.match(convergence, /absence of configured hosted CI.*unknown policy/i);
  assert.match(skill, /models or threshold are missing/i);
});

test('council model seats and rubric cannot silently change to achieve convergence', () => {
  const skill = text('skills/council/SKILL.md');
  assert.match(skill, /user-selected model seats/);
  assert.match(skill, /actual host registry/);
  assert.match(skill, /never silently substitute a model/i);
  assert.match(skill, /do not reclassify a failing seat/i);
  assert.match(skill, /subjective readiness judgment, not a probability/);
  assert.match(skill, /same rubric across rounds/);
  assert.match(skill, /not a nested full review-loop/);
  assert.match(skill, /only that participant's reassessment can change its score/);
  assert.match(skill, /never drop a strict reviewer or lower the threshold/i);
});

test('autonomous policy delegates ordinary choices without waiving identity or side-effect boundaries', () => {
  const spec = text('skills/specification/SKILL.md');
  assert.match(spec, /ordinary product and technical choices within the agreed goal and constraints are delegated/);
  assert.match(spec, /do not ask merely because two reasonable implementations exist/);
  assert.match(spec, /mandatory contract\/base, compatibility or an ungranted risk remains a blocker/);
  assert.match(spec, /limited read-only assignment do not grant this autonomy/);
  const identity = text('skills/git-task/SKILL.md');
  assert.match(identity, /ticketless permission never waives mandatory tracker policy/);
  assert.match(identity, /If the runtime reports base ambiguity, ask the user instead of guessing/);
  const commit = text('skills/git-commit/SKILL.md');
  assert.match(commit, /A checkpoint never pushes/);
  assert.match(commit, /Do not re-ask for a push already delegated/);
  assert.match(commit, /mandatory tracker policy requires a real ticket/);
  const publication = text('skills/change-request/SKILL.md');
  assert.match(publication, /grants creation\/update of the task's PR\/MR/);
  assert.match(publication, /--squash-before-merge=true/);
  assert.match(publication, /never silently convert `create` into `update`/i);
});

test('autonomous completion requires actual current forge state and preserves stronger policy', () => {
  const skill = text('skills/full-send/SKILL.md');
  assert.match(skill, /one live owner per physical worktree/);
  assert.match(skill, /verify the final candidate after that commit/);
  assert.match(skill, /Finish only when the forge confirms `MERGED` at the accepted head/);
  assert.match(skill, /queued or auto-enabled is not merged/);
  assert.match(skill, /no protection bypass, `--admin`, or raw `--no-verify`/i);
  assert.match(skill, /Re-read live head, base, checks, reviews, mergeability/);
  assert.match(skill, /If someone else merged it, report the actual state/);
  const watch = text('skills/pr-babysitter/SKILL.md');
  assert.match(watch, /Discover obtainable facts/);
  assert.match(watch, /never hand-edit another owner's tree or create raw temporary writing clones/);
  assert.match(watch, /If the user says work is still in progress, hands off/);
  assert.match(watch, /does not authorize silent model substitution/);
});

test('modernization assessment does not grant delivery or closing authority', () => {
  const skill = text('skills/modernize/SKILL.md');
  assert.match(skill, /assessment request is read-only/i);
  assert.match(skill, /do not infer full-send/i);
  assert.match(skill, /recommendation, not permission to close/i);
  assert.match(skill, /clean rebase does not prove/i);
});

test('review-loop is bounded and missing review is not approval', () => {
  const loop = text('skills/code-review/references/review-loop.md');
  assert.match(loop, /at most three review rounds, including the initial pass/i);
  assert.match(loop, /timeout, failed run, missing response, or exhausted budget is not approval/i);
  assert.match(loop, /delta-only review cannot become plain `PASS`/i);
});
