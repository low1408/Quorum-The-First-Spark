export const TERMINAL_RUN_STATUSES = [
  'COMPLETED',
  'PARTIAL_SUCCESS',
  'FAILED',
  'CANCELLED',
  'INTERVENTION_REQUIRED'
] as const;

export type TerminalRunStatus = typeof TERMINAL_RUN_STATUSES[number];
export type RunStatus = 'IN_PROGRESS' | 'AWAITING_HUMAN_REVIEW' | TerminalRunStatus;
export type TaskStatus = 'PENDING' | 'RUNNING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'CANCELLED' | 'INTERVENTION_REQUIRED';

export const TERMINAL_RUN_STATUS_SET = new Set<string>(TERMINAL_RUN_STATUSES);

export function isTerminalRunStatus(status: string | null | undefined): status is TerminalRunStatus {
  return !!status && TERMINAL_RUN_STATUS_SET.has(status);
}

export function isAbortError(error: unknown): boolean {
  const err = error as { name?: string; code?: string; message?: string } | null | undefined;
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.code === 'CANCELLED' || /aborted|cancelled/i.test(err?.message || '');
}

export function createCancelledError(message = 'Operation cancelled.'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  (err as any).code = 'CANCELLED';
  return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createCancelledError(signal.reason instanceof Error ? signal.reason.message : 'Operation cancelled.');
  }
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(cleanupAndResolve, ms);
    const onAbort = () => cleanupAndReject(createCancelledError(signal?.reason instanceof Error ? signal.reason.message : 'Operation cancelled.'));

    function cleanup(): void {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }

    function cleanupAndResolve(): void {
      cleanup();
      resolve();
    }

    function cleanupAndReject(error: Error): void {
      cleanup();
      reject(error);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function abortableRace<T>(promise: Promise<T>, signal?: AbortSignal, message = 'Operation cancelled.'): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;

  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(createCancelledError(signal.reason instanceof Error ? signal.reason.message : message));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    })
  ]);
}
