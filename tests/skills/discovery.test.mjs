// Real host discovery through control messages only: no prompt or model calls.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { stripShimFromPath } from '../../extensions/task-workspace/cli.ts';

const repo = resolve(import.meta.dirname, '../..');
const names = ['modernize', 'full-send', 'council'];

async function discover(host, args, message, matches) {
  const root = mkdtempSync(join(tmpdir(), 'delivery-discovery-'));
  const home = join(root, 'home');
  mkdirSync(home);
  // Do not inherit credentials, active host configuration or project settings.
  const env = {
    HOME: home,
    PATH: stripShimFromPath(process.env.PATH ?? ''),
    LANG: 'C.UTF-8',
    TMPDIR: root,
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    PI_OFFLINE: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  let child;
  try {
    const installed = spawnSync(process.execPath, [join(repo, 'bin/agent-kit'), 'install', host], { env, cwd: home, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    child = spawn(args[0], args.slice(1), { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
    const response = await new Promise((resolveResponse, reject) => {
      let buffer = '';
      let diagnostics = '';
      const timer = setTimeout(() => reject(new Error(`Discovery timed out: ${diagnostics}`)), 25000);
      const finish = (error, value) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolveResponse(value);
      };
      child.on('error', (error) => finish(error));
      child.on('exit', (code) => finish(new Error(`Host exited before discovery (${code}): ${diagnostics}`)));
      child.stderr.setEncoding('utf8').on('data', (chunk) => { diagnostics += chunk; });
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let data;
          try { data = JSON.parse(line); } catch { diagnostics += line; continue; }
          if (matches(data)) finish(null, data);
        }
      });
      child.stdin.on('error', (error) => finish(error));
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
    return response;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolveExit) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(timer); resolveExit(); });
        child.kill('SIGTERM');
      });
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf8' });
test('live Pi 1.5.0 discovers delivery skills through RPC without a model', {
  skip: piVersion.status !== 0 || piVersion.stdout.trim() !== '1.5.0' ? 'requires Pi 1.5.0 control protocol' : false,
}, async () => {
  const data = await discover('pi', ['pi', '--mode', 'rpc', '--no-session', '--offline', '--no-mcp'],
    { id: 'discovery', type: 'get_commands' }, (item) => item.id === 'discovery' && item.command === 'get_commands');
  assert.equal(data.success, true);
  for (const name of names) {
    const command = data.data.commands.find((item) => item.name === `skill:${name}`);
    assert.ok(command, `missing ${name}`);
    assert.equal(command.source, 'skill');
    assert.equal(command.sourceInfo.scope, 'user');
  }
});

const claudeVersion = spawnSync('claude', ['--version'], { encoding: 'utf8' });
test('live Claude Code discovers delivery skills through initialization without a model', {
  skip: claudeVersion.status !== 0 ? 'requires Claude Code' : false,
}, async () => {
  const data = await discover('claude-code', ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'],
    { type: 'control_request', request_id: 'discovery', request: { subtype: 'initialize' } },
    (item) => item.type === 'control_response' && item.response?.request_id === 'discovery');
  assert.equal(data.response.subtype, 'success');
  for (const name of names) assert.ok(data.response.response.commands.some((item) => item.name === name), `missing ${name}`);
});
