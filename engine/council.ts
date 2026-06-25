import crypto from 'crypto';
import { DBService } from '../db/database.ts';
import { OrchestrationRunner, type RunnerTimeoutBudgets } from './runner.ts';
import { validateCouncilRequestText, type ValidatedCouncilContext } from '../mcp/contextValidation.ts';
import { createCancelledError, isAbortError } from './statuses.ts';
import { classifyFailure, type FailureClassification } from './failures.ts';
import { ProviderSessionPool } from './providerSessionPool.ts';

export type SessionPoolItem = any;

export type CouncilConsultationRequest = {
  question: string;
  context: ValidatedCouncilContext;
  constraints?: string;
  providers?: string[];
  maxWaitMs?: number;
  providerTimeoutMs?: number;
  timeouts?: Partial<RunnerTimeoutBudgets>;
  maxConcurrency?: number;
  maxRetries?: number;
  runnerFactory?: CouncilRunnerFactory;
};

export type CouncilConsultationResult = {
  run_id: string;
  status: 'COMPLETED' | 'PARTIAL_SUCCESS';
  report: string;
  warnings: string[];
  analyses: CouncilAnalysis[];
};

export type CouncilAnalysis = {
  provider: string;
  taskId: string;
  response: string;
};

export type CouncilRunner = {
  executeTask(prompt: string, poolItem?: SessionPoolItem, options?: {
    pasteOnly?: boolean;
    signal?: AbortSignal;
    timeouts?: Partial<RunnerTimeoutBudgets>;
    attemptNo?: number;
  }): Promise<string>;
  close(): Promise<void>;
};

export type CouncilRunnerFactory = (params: {
  runId: string;
  taskId: string;
  provider: string;
}) => CouncilRunner;

const SUPPORTED_PROVIDERS = new Set(['mock', 'chatgpt', 'openai', 'gemini', 'claude', 'anthropic']);

const DEFAULT_PROVIDERS = (process.env.COUNCIL_PROVIDERS || 'mock,chatgpt,gemini,claude')
  .split(',')
  .map(provider => provider.trim().toLowerCase())
  .filter(Boolean);

export function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

export function validateProviderList(providers: string[], label = 'providers'): string[] {
  if (providers.length === 0) {
    throw new Error(`At least one ${label} entry is required.`);
  }

  const normalized = providers.map(normalizeProviderId);
  if (normalized.some(provider => !provider)) {
    throw new Error(`${label} cannot contain empty provider IDs.`);
  }

  const duplicates = normalized.filter((provider, index) => normalized.indexOf(provider) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate provider IDs are not allowed after normalization: ${Array.from(new Set(duplicates)).join(', ')}`);
  }

  const unsupported = normalized.filter(provider => !SUPPORTED_PROVIDERS.has(provider));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported provider IDs: ${unsupported.join(', ')}. Supported providers: ${Array.from(SUPPORTED_PROVIDERS).join(', ')}`);
  }

  return normalized;
}

export function uniqueProviders(providers?: string[]): string[] {
  const selected = providers?.length ? providers : DEFAULT_PROVIDERS;
  return validateProviderList(selected.map(normalizeProviderId), 'council providers');
}

export function createFreshProviderSession(source?: SessionPoolItem): SessionPoolItem {
  return null;
}

function lineNumberContent(content: string, startLine = 1): string {
  const lines = content.replace(/\s+$/u, '').split(/\r?\n/u);
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, ' ')} | ${line}`)
    .join('\n');
}

export function renderContextWarnings(warnings: string[]): string {
  if (warnings.length === 0) return '';
  return [
    'VALIDATION AND COMPLETENESS WARNINGS:',
    'Treat these as coverage limitations, not findings by themselves.',
    ...warnings.map(warning => `- ${warning}`)
  ].join('\n');
}

export function renderRepositoryEvidence(context: ValidatedCouncilContext): string {
  return context.files.map((file, index) => {
    const sourceNo = index + 1;
    const content = lineNumberContent(file.content, file.startLine);
    return [
      `<<<SOURCE ${sourceNo}`,
      `id=${file.evidenceId}`,
      `path=${file.normalizedPath}`,
      `sha256=${file.computedSha256}`,
      `role=${file.role}`,
      `provenance=${file.provenance}`,
      `relevance=${file.relevance || 'unspecified'}`,
      `range=${file.startLine}-${file.endLine}`,
      `total_lines=${file.totalLines}`,
      `excerpt=${file.isExcerpt}`,
      `length_chars=${file.content.length}`,
      '>>>',
      content,
      `<<<END SOURCE ${sourceNo}>>>`
    ].join('\n');
  }).join('\n\n');
}

export function reviewerContract(): string {
  return [
    'REQUIRED REVIEWER FORMAT:',
    'Classify each finding as exactly one of: Confirmed defect, Likely defect, Architectural risk, Hardening recommendation, Unverifiable.',
    'For every finding include: severity, confidence, exact path:line evidence, reasoning, missing context, and a validation test.',
    'Claims without exact supporting evidence from the supplied repository context must be classified as Unverifiable.',
    'Do not treat validation or completeness warnings as defects unless source evidence independently supports the finding.'
  ].join('\n');
}

export function buildCouncilAnalysisPrompt(params: {
  question: string;
  context: ValidatedCouncilContext;
  constraints?: string;
}): string {
  const structured = params.context.structured_review
    ? [
      `REVIEW OBJECTIVE:\n${params.context.structured_review.review_objective}`,
      `ARCHITECTURE:\n${params.context.structured_review.architecture}`,
      `EXECUTION FLOW:\n${params.context.structured_review.execution_flow}`,
      `ASSUMPTIONS AND INVARIANTS:\n${params.context.structured_review.assumptions_and_invariants}`,
      `CORE EVIDENCE:\n${params.context.structured_review.core_evidence}`,
      `SUPPORTING CONTRACTS:\n${params.context.structured_review.supporting_contracts}`,
      `PRIVACY AND PERSISTENCE:\n${params.context.structured_review.privacy_and_persistence}`,
      `TESTS AND RUNTIME EVIDENCE:\n${params.context.structured_review.tests_and_runtime_evidence}`,
      `OMITTED MATERIAL:\n${params.context.structured_review.omitted_material}`
    ].join('\n\n')
    : '';
  const warnings = renderContextWarnings(params.context.warnings);
  const repositoryEvidence = renderRepositoryEvidence(params.context);

  return [
    'You are one independent reviewer in a private council advising a coding agent.',
    'Analyze the request and repository context independently. Do not write final code.',
    'Return practical implementation options, risks, missing context, and tests. Be specific and concise.',
    reviewerContract(),
    '',
    `QUESTION:\n${params.question}`,
    params.constraints ? `CONSTRAINTS:\n${params.constraints}` : '',
    params.context.notes ? `CALLER CONTEXT NOTES:\n${params.context.notes}` : '',
    structured ? `STRUCTURED REVIEW CONTEXT:\n${structured}` : '',
    `CONTEXT DIGEST:\n${params.context.context_digest}`,
    warnings,
    `REPOSITORY EVIDENCE:\n${repositoryEvidence}`
  ].filter(Boolean).join('\n\n');
}

export function buildDirectReport(analyses: CouncilAnalysis[]): string {
  return analyses.map((analysis, index) =>
    `## Council Member ${index + 1}\n\n${analysis.response}`
  ).join('\n\n---\n\n');
}

export function providerTimeoutMs(request: { providerTimeoutMs?: number; maxWaitMs?: number }, providerCount: number): number {
  if (request.providerTimeoutMs && request.providerTimeoutMs > 0) return request.providerTimeoutMs;
  if (request.maxWaitMs && request.maxWaitMs > 0) return Math.max(1_000, request.maxWaitMs);
  return 6 * 60 * 1000;
}

export function maxConcurrency(request: { maxConcurrency?: number }): number {
  const raw = request.maxConcurrency ?? Number.parseInt(process.env.COUNCIL_MAX_CONCURRENCY || '', 10);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 2;
}

export function maxRetries(request: { maxRetries?: number }): number {
  const raw = request.maxRetries ?? Number.parseInt(process.env.COUNCIL_MAX_RETRIES || '', 10);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 1;
}

export function retryBackoffMs(attemptNo: number): number {
  const base = Number.parseInt(process.env.COUNCIL_RETRY_BACKOFF_MS || '', 10);
  const backoff = Number.isFinite(base) && base >= 0 ? base : 750;
  return backoff * attemptNo;
}

function defaultRunnerFactory(params: { runId: string; taskId: string; provider: string }): CouncilRunner {
  return new OrchestrationRunner(params.runId, params.taskId, params.provider, { manageRunStatus: false });
}

export async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

function conciseFailureDetail(provider: string, reason: unknown): string {
  const failure = classifyFailure(reason);
  const rawMessage = reason instanceof Error ? reason.message : String(reason);
  const firstLine = rawMessage.split('\n').map(line => line.trim()).find(Boolean);
  return `${provider}: ${failure.code}${firstLine ? ` (${firstLine.slice(0, 180)})` : ''}`;
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      try {
        results[currentIndex] = { status: 'fulfilled', value: await mapper(items[currentIndex], currentIndex) };
      } catch (reason) {
        results[currentIndex] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function timeoutSignal(ms: number, message: string): AbortController {
  const controller = new AbortController();
  setTimeout(() => controller.abort(createCancelledError(message)), ms).unref();
  return controller;
}

async function runProviderWithTimeout(params: {
  provider: string;
  index: number;
  runId: string;
  prompt: string;
  pool: ProviderSessionPool;
  timeoutMs: number;
  timeouts?: Partial<RunnerTimeoutBudgets>;
  attemptNo: number;
  runnerFactory: CouncilRunnerFactory;
}): Promise<CouncilAnalysis> {
  const { provider, index, runId, prompt, pool, timeoutMs, timeouts, attemptNo, runnerFactory } = params;
  const taskId = `council_${runId}_${index + 1}_${provider}_attempt_${attemptNo}`;
  const runner = runnerFactory({ runId, taskId, provider });
  const controller = timeoutSignal(timeoutMs, `${provider} timed out after ${timeoutMs}ms.`);

  try {
    const session = pool.acquire(provider);
    const response = await runner.executeTask(prompt, session, {
      signal: controller.signal,
      timeouts: { providerExecutionMs: timeoutMs, ...timeouts },
      attemptNo
    });
    return { provider, taskId, response };
  } catch (err) {
    controller.abort(createCancelledError(`${provider} failed.`));
    await runner.close().catch(() => { });
    await pool.invalidate(provider, err instanceof Error ? err.message : String(err)).catch(() => { });
    throw err;
  }
}

async function runProviderWithRetry(params: {
  provider: string;
  index: number;
  runId: string;
  prompt: string;
  pool: ProviderSessionPool;
  timeoutMs: number;
  timeouts?: Partial<RunnerTimeoutBudgets>;
  maxRetries: number;
  runnerFactory: CouncilRunnerFactory;
  warnings: string[];
}): Promise<CouncilAnalysis> {
  const { maxRetries, warnings, ...base } = params;
  let lastFailure: FailureClassification | null = null;

  for (let attemptNo = 1; attemptNo <= maxRetries + 1; attemptNo++) {
    try {
      return await runProviderWithTimeout({ ...base, attemptNo });
    } catch (err) {
      const failure = classifyFailure(err);
      lastFailure = failure;
      warnings.push(`${base.provider} attempt ${attemptNo} failed with ${failure.code}: ${failure.publicMessage}`);

      if (!failure.retryable || attemptNo > maxRetries) {
        throw err;
      }

      await delay(retryBackoffMs(attemptNo));
    }
  }

  throw new Error(lastFailure?.message || `${base.provider} failed after retries.`);
}

async function runCouncilConsultationInner(request: CouncilConsultationRequest, runId: string): Promise<CouncilConsultationResult> {
  const providers = uniqueProviders(request.providers);
  if (providers.length === 0) {
    throw new Error('At least one council provider is required.');
  }

  DBService.createRun(runId, request.question.substring(0, 100));
  DBService.updateRunStatusIfNotTerminal(runId, 'IN_PROGRESS');
  const prompt = buildCouncilAnalysisPrompt({
    question: request.question,
    context: request.context,
    constraints: request.constraints
  });

  const pool = new ProviderSessionPool();
  const perProviderTimeoutMs = providerTimeoutMs(request, providers.length);
  const concurrencyLimit = maxConcurrency(request);
  const retryLimit = maxRetries(request);
  const runnerFactory = request.runnerFactory ?? defaultRunnerFactory;
  const warnings = [...request.context.warnings];

  try {
    const analysisResults = await mapWithConcurrency(providers, concurrencyLimit, async (provider, index): Promise<CouncilAnalysis> => {
      return await runProviderWithRetry({
        provider,
        index,
        runId,
        prompt,
        pool,
        timeoutMs: perProviderTimeoutMs,
        timeouts: request.timeouts,
        maxRetries: retryLimit,
        runnerFactory,
        warnings
      });
    });

    const analyses: CouncilAnalysis[] = [];
    const failedProviders: string[] = [];
    for (const result of analysisResults) {
      if (result.status === 'fulfilled') {
        analyses.push(result.value);
      } else {
        const provider = providers[failedProviders.length + analyses.length] ?? 'unknown';
        failedProviders.push(conciseFailureDetail(provider, result.reason));
        const reason = result.reason?.message || String(result.reason);
        warnings.push(`A council member failed, timed out, or was cancelled and was omitted from consolidation: ${reason}`);
      }
    }

    if (analyses.length === 0) {
      DBService.updateRunStatusIfNotTerminal(runId, 'FAILED');
      const suffix = failedProviders.length > 0 ? ` Failures: ${failedProviders.join('; ')}.` : '';
      throw new Error(`All council members failed for run ${runId}.${suffix}`);
    }

    const report = buildDirectReport(analyses);
    const status = analyses.length === providers.length ? 'COMPLETED' : 'PARTIAL_SUCCESS';
    DBService.updateRunStatusIfNotTerminal(runId, status);

    return {
      run_id: runId,
      status,
      report,
      warnings: Array.from(new Set(warnings)),
      analyses
    };
  } finally {
    console.log('\n[INFO] API council consultation finished.\n');
  }
}

export async function runCouncilConsultation(request: CouncilConsultationRequest): Promise<CouncilConsultationResult> {
  const runId = `council_run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  try {
    validateCouncilRequestText(request.question, request.constraints);
    uniqueProviders(request.providers);
    return await runCouncilConsultationInner(request, runId);
  } catch (err: any) {
    if (err?.code === 'INTERVENTION_REQUIRED') {
      err.run_id = runId;
      DBService.updateRunStatusIfNotTerminal(runId, 'INTERVENTION_REQUIRED');
    } else if (isAbortError(err)) {
      err.run_id = runId;
      DBService.updateRunStatusIfNotTerminal(runId, 'CANCELLED');
    } else {
      DBService.updateRunStatusIfNotTerminal(runId, 'FAILED');
    }
    throw err;
  }
}
