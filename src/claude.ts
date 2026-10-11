import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, object, parseJson } from './protocol.ts';
import type { Model } from './protocol.ts';

export const CLAUDE_VERSION = '2.1.296';
const exec = promisify(execFile);
const inherited = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TMPDIR', 'NODE_EXTRA_CA_CERTS'];
const routingKey = /^(ANTHROPIC_|CLAUDE_CODE_(USE_|OAUTH|PROVIDER|API_KEY|CUSTOM|MODEL)|CLAUDE_CONFIG_DIR)/;

export function childEnvironment(url: string, token: string, model: Model, source = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of inherited) if (source[key] !== undefined) env[key] = source[key];
  return {
    ...env,
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: model.id,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model.id,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model.id,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model.id,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model.id,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.min(model.output, 16384)),
    DISABLE_AUTOUPDATER: '1',
  };
}

export async function clientVersion(): Promise<string> {
  try {
    const { stdout } = await exec('claude', ['--version'], { timeout: 10_000 });
    const version = /^(\d+\.\d+\.\d+) \(Claude Code\)/.exec(stdout)?.[1];
    if (!version) throw new BridgeError('VERSION_UNSUPPORTED', 'Could not identify the installed Claude Code version.');
    return version;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new BridgeError('CLIENT_MISSING', 'Install Claude Code separately from its official distribution.');
    }
    throw error;
  }
}

export async function inspectSettings(project: string, home = homedir(), managed = '/Library/Application Support/ClaudeCode/managed-settings.json'): Promise<void> {
  const locations = [
    join(home, '.claude', 'settings.json'),
    join(project, '.claude', 'settings.json'),
    join(project, '.claude', 'settings.local.json'),
    managed,
  ];
  for (const path of locations) {
    let raw: string;
    try { raw = await readFile(path, 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw new BridgeError('CONFIG_UNREADABLE', 'A Claude Code settings source cannot be inspected.');
    }
    const settings = parseJson(raw);
    const env = settings.env === undefined ? {} : object(settings.env);
    if (Object.keys(env).some(key => routingKey.test(key))
      || ['apiKeyHelper', 'forceLoginMethod', 'forceLoginOrgUUID', 'modelOverrides'].some(key => settings[key] !== undefined)) {
      throw new BridgeError('ROUTING_CONFLICT', 'Existing Claude Code settings control authentication/provider routing. Resolve the conflict explicitly; no settings were changed.');
    }
  }
}

export async function preflight(project: string, surface: string): Promise<string> {
  if (surface !== 'cli') throw new BridgeError('CLIENT_UNSUPPORTED', 'Desktop gateway configuration exists, but this implementation only verifies the CLI profile.');
  const resolved = await realpath(project);
  if (!(await stat(resolved)).isDirectory()) throw new BridgeError('INVALID_OPTIONS', 'Project must be a directory.');
  const version = await clientVersion();
  if (version !== CLAUDE_VERSION) throw new BridgeError('VERSION_UNSUPPORTED', `This experimental profile is pinned to Claude Code ${CLAUDE_VERSION}; installed ${version}.`);
  await inspectSettings(resolved);
  return resolved;
}

export interface ClaudeOptions {
  url: string;
  token: string;
  model: Model;
  project: string;
  prompt?: string;
  probe?: boolean;
  capture?: boolean;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  autocompact?: 'auto' | `${number}k` | number;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
}

export async function runClaude(options: ClaudeOptions): Promise<{ code: number; stdout: string; stderr: string }> {
  if (options.model.context < 200000) throw new BridgeError('CONTEXT_UNSUPPORTED', 'This initial client profile requires at least a catalog-reported 200K context window.');
  const print = options.prompt !== undefined;
  const args = [
    '--safe-mode', '--permission-mode', 'manual', '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome',
    '--model', options.model.id, '--session-id', randomUUID(),
    '--tools', options.probe ? '' : (options.tools ?? ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']).join(','),
  ];
  if (options.probe) {
    args.push('--system-prompt', 'This is an isolated connection probe. Reply with exactly CCGC_READY. Do not use tools.');
    // Configured user env takes precedence over the shell, including the probe's output cap.
    args.push('--settings', JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128' } }));
  }
  if (print) args.push('--print', '--no-session-persistence');
  if (options.capture) args.push('--output-format', 'json');
  if (options.autocompact !== undefined) args.push('--autocompact', String(options.autocompact));
  if (options.allowedTools?.length) args.push('--allowedTools', options.allowedTools.join(','));
  if (options.disallowedTools?.length) args.push('--disallowedTools', options.disallowedTools.join(','));
  const env = childEnvironment(options.url, options.token, options.model, options.environment);
  if (options.probe) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.min(options.model.output, 128));
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: options.project, env,
      stdio: [print ? 'pipe' : 'inherit', options.capture ? 'pipe' : 'inherit', options.capture ? 'pipe' : 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    let force: NodeJS.Timeout | undefined;
    const abort = () => {
      child.kill('SIGTERM');
      force ??= setTimeout(() => child.kill('SIGKILL'), 5000);
      force.unref();
    };
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
      if (stdout.length + stderr.length > 1024 * 1024) { overflow = true; abort(); }
    };
    child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(force);
      options.signal?.removeEventListener('abort', abort);
      if (overflow) reject(new BridgeError('CLIENT_OUTPUT_LIMIT', 'Captured client output exceeded the local limit.'));
      else if (options.signal?.aborted) reject(new BridgeError('CANCELLED_OR_TIMEOUT', 'Claude Code was cancelled.', 499));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    if (print) child.stdin?.end(options.prompt);
    if (options.signal?.aborted) abort();
  });
}
