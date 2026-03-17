import * as p from '@clack/prompts';

let _agentMode = false;

export function setAgentMode(value: boolean): void {
  _agentMode = value;
}

export function isAgentMode(): boolean {
  return _agentMode || process.env.ONE_AGENT === '1';
}

export function createSpinner(): { start(msg: string): void; stop(msg: string): void } {
  if (isAgentMode()) {
    return { start() {}, stop() {} };
  }
  return p.spinner();
}

export function intro(msg: string): void {
  if (!isAgentMode()) p.intro(msg);
}

export function outro(msg: string): void {
  if (!isAgentMode()) p.outro(msg);
}

export function note(msg: string, title?: string): void {
  if (!isAgentMode()) p.note(msg, title);
}

export function cancel(msg: string): void {
  if (!isAgentMode()) p.cancel(msg);
}

export function json(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + '\n');
}

export function error(message: string, exitCode = 1): never {
  if (isAgentMode()) {
    json({ error: message });
  } else {
    p.cancel(message);
  }
  process.exit(exitCode);
}
