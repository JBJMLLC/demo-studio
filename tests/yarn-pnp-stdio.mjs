import assert from 'node:assert/strict';

export class StdioJsonRpcClient {
  constructor(child) {
    assert(child.stdin && child.stdout, 'The installed runtime MCP child must expose piped stdio.');
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.closed = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#consume(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_000);
    });
    child.once('error', () => this.#rejectPending('The installed runtime MCP process could not start.'));
    child.once('exit', (code, signal) => {
      if (!this.closed) this.#rejectPending(`The installed runtime MCP process exited unexpectedly (${code ?? signal ?? 'unknown'}).`);
    });
  }

  #rejectPending(message) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    this.pending.clear();
  }

  #consume(chunk) {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > 16 * 1024 * 1024) {
      this.#rejectPending('The installed runtime MCP response exceeded the smoke-test limit.');
      this.child.kill('SIGTERM');
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        this.#rejectPending('The installed runtime MCP process emitted invalid stdio JSON-RPC.');
        this.child.kill('SIGTERM');
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`MCP request failed: ${pending.method} (${message.error.code ?? 'unknown'}).`));
      else pending.resolve(message.result);
    }
  }

  notify(method, params = undefined) {
    if (this.closed) throw new Error('The stdio JSON-RPC client is closed.');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  request(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error('The stdio JSON-RPC client is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }
      catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`MCP request could not be written: ${method}.`));
      }
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.#rejectPending('The stdio JSON-RPC client closed.');
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 5_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

export async function connectRuntimeMcp(child) {
  const client = new StdioJsonRpcClient(child);
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'demo-studio-yarn-pnp-smoke', version: '1.0.0' },
    });
    assert.equal(initialized?.protocolVersion, '2025-03-26');
    client.notify('notifications/initialized');
    const listed = await client.request('tools/list');
    assert(Array.isArray(listed?.tools), 'Installed runtime did not return a dynamic MCP tool list.');
    return { client, tools: listed.tools };
  } catch (error) {
    await client.close();
    throw error;
  }
}
