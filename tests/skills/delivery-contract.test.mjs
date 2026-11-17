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

test('publication contract permits proven PR-only CI without waiving pre-publication gates', () => {
  for (const path of ['skills/full-send/SKILL.md', 'skills/change-request/SKILL.md']) {
    const skill = text(path);
    assert.match(skill, /all available local verification evidence, the candidate commit and hook results/i);
    assert.match(skill, /required local checks must pass/i);
    assert.match(skill, /required checks that do not depend on PR\/MR publication must pass before creation, including branch CI available after push/i);
    assert.match(skill, /known required-check failures, deferred-hook gaps and explicit hard project publication restrictions.*block creation/i);
    assert.match(skill, /workflow configuration or authoritative forge evidence.*branch filters and draft behavior/i);
    assert.match(skill, /unknown policy or an empty\/transient checks response.*(?:not proof|does not prove).*PR-only CI/i);
    assert.match(skill, /(?:existing scoped grant permits|existing scoped publication authority permits) provisional create\/update/i);
    assert.match(skill, /prefer draft only when (?:the|that) workflow runs on drafts; otherwise use an authorized ordinary PR\/MR with honest pending status/i);
    assert.match(skill, /a draft that skips (?:the required )?CI is not a solution/i);
    assert.match(skill, /(?:override|bypass).*hard (?:pre-publication|project publication) rule/i);
  }
  const publication = text('skills/change-request/SKILL.md');
  assert.match(publication, /unexplained missing checks still block publication/i);
  assert.match(publication, /exception does not grant publication authority/i);
  assert.doesNotMatch(publication, /any are known to be failing or incomplete, do not create/i);
});

test('provisional publication is not readiness and description rules preserve pending evidence', () => {
  const skill = text('skills/full-send/SKILL.md');
  assert.match(skill, /all required checks and independent review must pass for the exact current base\/head before `READY` or merge/i);
  assert.match(skill, /do not enable auto-merge before readiness and merge authority/i);
  assert.match(skill, /only controlled required-queue admission under Full send below may precede queue-only checks/i);
  assert.match(skill, /full stop never permits either auto-merge or queue entry/i);
  const publication = text('skills/change-request/SKILL.md');
  assert.match(publication, /failed, missing, unknown or pending required checks remain readiness blockers after publication/i);
  assert.match(publication, /auto-merge requires readiness and merge authority/i);
  assert.match(publication, /any required independent review must pass for the exact current candidate and target base/i);
  assert.match(skill, /review-loop or council acceptance is blocked solely by proven PR- or queue-dependent checks/i);
  assert.match(skill, /retain that pending\/blocked result.*complete acceptance after those checks run/i);
  assert.match(skill, /do not consume rounds waiting for CI, reset the budget, or call provisional publication `PASS` or convergence/i);
  const description = text('skills/change-request/references/description.md');
  assert.match(description, /provisional publication for proven PR-dependent CI/i);
  assert.match(description, /pending checks and their trigger evidence in `Review notes`/i);
  assert.match(description, /do not list them as passes or claim `READY`/i);
  assert.match(description, /known required-check failures, deferred-hook gaps and hard project publication restrictions still block creation/i);
  assert.match(description, /unknown policy or empty results do not prove that exception applies/i);
});

test('queue-only CI has a controlled full-send admission gate, not premature readiness', () => {
  const skill = text('skills/full-send/SKILL.md');
  const send = section(skill, 'Full send');
  assert.match(send, /workflow configuration or authoritative forge evidence proves a required queue has queue-only CI \(for example `merge_group`\)/i);
  assert.match(send, /full send may enter that controlled queue within its merge grant after all pre-queue checks and independent review pass for the current base\/head/i);
  assert.match(send, /queue enforces all final required checks on the current merge-group revision before merging/i);
  assert.match(send, /keep queue-only checks pending until they actually pass/i);
  assert.match(send, /unknown policy or empty results do not prove this exception/i);
  assert.match(send, /does not authorize arbitrary auto-merge before unverified CI/i);
  assert.match(send, /queued or auto-enabled is not merged/i);
  const stop = section(skill, 'Full stop');
  assert.match(stop, /required check can only run after queue entry.*`BLOCKED`, not `READY`/i);
  assert.match(stop, /full stop cannot obtain it by entering the queue/i);
  const publication = text('skills/change-request/SKILL.md');
  assert.match(publication, /this skill never merges or enters a queue/i);
  assert.match(publication, /queue admission is not final readiness: final queue checks must pass before merge/i);
  const description = text('skills/change-request/references/description.md');
  assert.match(description, /queue-only checks may remain pending at controlled required-queue admission under full send after its pre-queue gates and independent review pass/i);
  assert.match(description, /must pass on the current merge-group revision before merge/i);
  assert.match(description, /full stop never enters the queue.*queue-only check as a blocker/i);
});

test('generic publication follows applicable review policy without weakening autonomous review', () => {
  const publication = text('skills/change-request/SKILL.md');
  assert.match(publication, /all required checks and any required independent review must pass/i);
  assert.match(publication, /project's review policy and the `skill:\/\/git-task` review decision point outside autonomous modes/i);
  assert.match(publication, /full send\/full stop retain their mandatory independent review/i);
  const description = text('skills/change-request/references/description.md');
  assert.match(description, /all required checks and any required independent review/i);
  assert.match(description, /outside autonomous modes, follow project policy and the git-task review decision point, not a universal independent-review requirement/i);
  assert.match(description, /full send\/full stop still require independent review/i);
  assert.match(text('skills/full-send/SKILL.md'), /all required checks and independent review must pass for the exact current base\/head/i);
});

test('complex ordinary decisions may use non-binding read-only fresh-context advice', () => {
  for (const path of ['skills/full-send/SKILL.md', 'skills/specification/SKILL.md']) {
    const skill = text(path);
    assert.match(skill, /for a complex ordinary decision, you may/i);
    assert.match(skill, /fresh-context subagent/i);
    assert.match(skill, /goal, constraints and established facts.*without priming the expected answer/i);
    assert.match(skill, /advisory assignment bounded and read-only/i);
    assert.match(skill, /(?:inherits no|no inherited) execution, push or merge grant/i);
    assert.match(skill, /consider its arguments.*risks/i);
    assert.match(skill, /not binding: the controller remains responsible and may reject it with reasons/i);
    assert.match(skill, /optional, not a mandatory council or per-choice approval gate/i);
  }
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
