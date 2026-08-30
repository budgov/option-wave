import { spawn } from "node:child_process";
import crypto from "node:crypto";

function safeDiagnostic(value) {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:access|refresh)[_-]?token["'=:\s]+[^\s"&]+/gi, "token=[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 2000);
}

function workerError(message, kind = "worker") {
  const error = new Error(message);
  error.workerKind = kind;
  return error;
}

export class JsonLineWorker {
  constructor({
    file,
    args = [],
    cwd,
    env = process.env,
    startupTimeoutMs = 15_000,
    requestTimeoutMs = 30_000,
    shutdownTimeoutMs = 10_000,
    maxLineBytes = 8 * 1024 * 1024,
    validateReady = () => true
  }) {
    this.file = file;
    this.args = [...args];
    this.cwd = cwd;
    this.env = { ...env };
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.maxLineBytes = maxLineBytes;
    this.validateReady = validateReady;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    this.ready = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.recycleBeforeNext = false;
    this.closed = false;
  }

  async start() {
    if (this.closed) throw workerError("Worker is closed.", "closed");
    if (this.child && this.ready) return this.ready;

    const child = spawn(this.file, this.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const startupTimer = setTimeout(() => {
      this.#fail(workerError("Worker startup timed out.", "startup_timeout"));
    }, this.startupTimeoutMs);
    startupTimer.unref?.();
    this.ready.finally(() => clearTimeout(startupTimer)).catch(() => {});

    child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = safeDiagnostic(`${this.stderr} ${chunk.toString("utf8")}`);
    });
    child.once("error", (error) => this.#fail(workerError(`Worker process error: ${safeDiagnostic(error.message)}`, "process")));
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      const details = this.stderr ? `: ${this.stderr}` : "";
      this.#rejectOutstanding(workerError(`Worker exited (${code ?? signal ?? "unknown"})${details}`, "exit"));
      this.#clearReady();
    });
    return this.ready;
  }

  request(payload, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(workerError("Worker is closed.", "closed"));
    const task = this.queue.then(() => this.#execute(payload, timeoutMs));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  status() {
    return {
      running: Boolean(this.child && !this.child.killed),
      pid: this.child?.pid ?? null,
      queued: this.pending.size,
      recycle_pending: this.recycleBeforeNext
    };
  }

  async #execute(payload, timeoutMs) {
    if (this.recycleBeforeNext) {
      this.recycleBeforeNext = false;
      await this.#stopProcess();
    }
    await this.start();
    const id = crypto.randomUUID();
    const line = Buffer.from(`${JSON.stringify({ ...payload, id })}\n`, "utf8");
    if (line.length > 256 * 1024) throw workerError("Worker request exceeds the size limit.", "request_size");

    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(workerError("Worker request timed out.", "request_timeout"));
        void this.#stopProcess();
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });

    try {
      if (!this.child?.stdin?.writable) throw workerError("Worker input is unavailable.", "stdin");
      await new Promise((resolve, reject) => {
        this.child.stdin.write(line, (error) => error ? reject(error) : resolve());
      });
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(workerError(`Worker write failed: ${safeDiagnostic(error.message)}`, "stdin"));
    }
    return response;
  }

  #onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxLineBytes && this.buffer.indexOf(0x0a) < 0) {
      this.#fail(workerError("Worker response exceeded the line limit.", "response_size"));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (raw.length === 0) continue;
      if (raw.length > this.maxLineBytes) {
        this.#fail(workerError("Worker response exceeded the line limit.", "response_size"));
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        this.#fail(workerError("Worker returned invalid JSON.", "protocol"));
        return;
      }
      if (message?.event === "ready") {
        if (!this.validateReady(message)) {
          this.#fail(workerError("Worker readiness validation failed.", "protocol"));
          return;
        }
        this.readyResolve?.(message);
        this.readyResolve = null;
        this.readyReject = null;
        continue;
      }
      const pending = this.pending.get(String(message?.id ?? ""));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      if (message.ok === true) {
        if (message.recycle_requested === true) this.recycleBeforeNext = true;
        pending.resolve(message.result);
      } else {
        pending.reject(workerError(`Worker request failed: ${safeDiagnostic(message?.error ?? "unknown error")}`, "response"));
      }
    }
  }

  #rejectOutstanding(error) {
    this.readyReject?.(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  #clearReady() {
    this.ready = null;
    this.readyResolve = null;
    this.readyReject = null;
  }

  #fail(error) {
    this.#rejectOutstanding(error);
    this.#clearReady();
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
  }

  async #stopProcess() {
    const child = this.child;
    if (!child) {
      this.#clearReady();
      return;
    }
    this.child = null;
    this.#clearReady();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    if (child.stdin.writable) child.stdin.end();
    let timeoutTimer;
    const timeout = new Promise((resolve) => {
      timeoutTimer = setTimeout(() => resolve("timeout"), this.shutdownTimeoutMs);
      timeoutTimer.unref?.();
    });
    const outcome = await Promise.race([exited, timeout]);
    clearTimeout(timeoutTimer);
    if (outcome === "timeout" && !child.killed) {
      child.kill();
      await exited;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.#stopProcess();
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
  }
}

export { safeDiagnostic };
