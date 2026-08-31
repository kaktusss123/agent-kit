export interface GitExecResult { exitCode: number; stdout: string; stderr: string; command: string; durationMs: number; }
export interface GitExecOptions { env?: Record<string, string>; timeoutMs?: number; throwOnError?: boolean; }
export interface GitExec { exec(args: string[], cwd: string, options?: GitExecOptions): Promise<GitExecResult>; execQuiet(args: string[], cwd: string, options?: GitExecOptions): Promise<GitExecResult>; }
export class GitExecError extends Error { constructor(message: string, public readonly result: GitExecResult) { super(message); this.name = "GitExecError"; } }

export class ChildProcessGitExec implements GitExec {
  async exec(args: string[], cwd: string, options: GitExecOptions = {}): Promise<GitExecResult> {
    const command = `git ${args.join(" ")}`;
    const started = Date.now();
    const child = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const exitCode = await child.exited;
    if (timer) clearTimeout(timer);
    const result = { exitCode, stdout: stdout.trim(), stderr: stderr.trim(), command, durationMs: Date.now() - started };
    if ((options.throwOnError ?? true) && exitCode !== 0) throw new GitExecError(`${command} failed with exit ${exitCode}`, result);
    return result;
  }
  async execQuiet(args: string[], cwd: string, options: GitExecOptions = {}): Promise<GitExecResult> { return this.exec(args, cwd, { ...options, throwOnError: false }); }
}
export function createGitExec(): GitExec { return new ChildProcessGitExec(); }
