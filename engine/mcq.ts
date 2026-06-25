import crypto from 'crypto';
import { DBService } from '../db/database.ts';
import { type ValidatedCouncilContext } from '../mcp/contextValidation.ts';
import {
  uniqueProviders,
  mapWithConcurrency,
  providerTimeoutMs,
  maxConcurrency,
  maxRetries,
  buildDirectReport,
  type CouncilConsultationRequest,
  type CouncilAnalysis,
  type CouncilRunnerFactory,
} from './council.ts';
import { ProviderSessionPool } from './providerSessionPool.ts';
import { OrchestrationRunner, type RunnerTimeoutBudgets } from './runner.ts';
import { createCancelledError } from './statuses.ts';
import { classifyFailure, type FailureClassification } from './failures.ts';
import {
  McqSimpleDecisionSchema,
  McqCriteriaDecisionSchema,
  validateSimpleDecisionCrossFields,
  validateCriteriaDecisionCrossFields,
  isCriteriaDecision,
  SIMPLE_DECISION_JSON_SCHEMA,
  CRITERIA_DECISION_JSON_SCHEMA,
  type McqOption,
  type McqCriterion,
  type McqSimpleDecision,
  type McqCriteriaDecision,
  type McqDecision,
} from './mcqSchemas.ts';

// ── Types ──

export type McqRequest = {
  question: string;
  options: McqOption[];
  criteria?: McqCriterion[];
  context?: {
    files?: Array<{
      path: string;
      content: string;
      sha256?: string;
      modified_at?: string;
      relevance?: string;
    }>;
    notes?: string;
  };
  providers?: string[];
  maxWaitMs?: number;
  providerTimeoutMs?: number;
  timeouts?: Partial<RunnerTimeoutBudgets>;
  maxConcurrency?: number;
  maxRetries?: number;
  runnerFactory?: CouncilRunnerFactory;
};

export type McqMemberVote = {
  provider: string;
  taskId: string;
  decision: McqDecision;
  rawResponse: string;
};

export type McqFailedVote = {
  provider: string;
  reason: string;
};

export type McqVoteDistribution = {
  eligible_members: number;
  valid_votes: number;
  failed_votes: number;
  abstained: string[];
  distribution: Array<{
    option_id: string;
    option_label: string;
    vote_count: number;
    vote_fraction: number;
    voters: string[];
  }>;
};

export type McqResult = {
  run_id: string;
  status: 'COMPLETED' | 'PARTIAL_SUCCESS' | 'ALL_FAILED';
  question: string;
  options: McqOption[];
  criteria?: McqCriterion[];
  votes: McqMemberVote[];
  failed: McqFailedVote[];
  distribution: McqVoteDistribution;
  warnings: string[];
};

// ── Prompt Construction ──

function formatOptions(options: McqOption[]): string {
  return options.map(opt => {
    const desc = opt.description ? ` — ${opt.description}` : '';
    return `  - [${opt.id}] ${opt.label}${desc}`;
  }).join('\n');
}

function formatCriteria(criteria: McqCriterion[]): string {
  return criteria.map(crit => {
    const desc = crit.description ? ` — ${crit.description}` : '';
    const weight = crit.weight != null ? ` (weight: ${crit.weight})` : '';
    return `  - [${crit.id}] ${crit.label}${desc}${weight}`;
  }).join('\n');
}

function formatContextNotes(context?: McqRequest['context']): string {
  if (!context) return '';
  const parts: string[] = [];

  if (context.notes) {
    parts.push(`ADDITIONAL CONTEXT:\n${context.notes}`);
  }

  if (context.files && context.files.length > 0) {
    const filesBlock = context.files.map((file, index) => {
      return [
        `--- File ${index + 1}: ${file.path} ---`,
        file.content,
        `--- End File ${index + 1} ---`
      ].join('\n');
    }).join('\n\n');
    parts.push(`REFERENCE FILES:\n${filesBlock}`);
  }

  return parts.join('\n\n');
}

export function buildMcqPrompt(request: McqRequest): string {
  const hasCriteria = request.criteria && request.criteria.length > 0;
  const optionsBlock = formatOptions(request.options);
  const contextBlock = formatContextNotes(request.context);

  if (hasCriteria) {
    const criteriaBlock = formatCriteria(request.criteria!);
    return [
      'You are one independent voter in an anonymous council.',
      'You will be presented with a question, a set of options, and evaluation criteria.',
      'Score every option against every criterion (1-5), then select exactly one option.',
      '',
      `QUESTION:\n${request.question}`,
      '',
      `OPTIONS:\n${optionsBlock}`,
      '',
      `EVALUATION CRITERIA:\n${criteriaBlock}`,
      '',
      contextBlock,
      '',
      `Return ONLY a valid JSON object matching this exact schema (no markdown fences, no extra text):`,
      CRITERIA_DECISION_JSON_SCHEMA
    ].filter(Boolean).join('\n');
  }

  return [
    'You are one independent voter in an anonymous council.',
    'You will be presented with a question and a set of options.',
    'Select exactly one option and justify your choice.',
    '',
    `QUESTION:\n${request.question}`,
    '',
    `OPTIONS:\n${optionsBlock}`,
    '',
    contextBlock,
    '',
    `Return ONLY a valid JSON object matching this exact schema (no markdown fences, no extra text):`,
    SIMPLE_DECISION_JSON_SCHEMA
  ].filter(Boolean).join('\n');
}

// ── JSON Extraction ──

/**
 * Attempts to extract a JSON object from a raw LLM response.
 * Handles clean JSON, markdown-fenced JSON, and prose-wrapped JSON.
 */
export function extractJsonFromResponse(raw: string): object {
  const trimmed = raw.trim();

  // Try direct parse first
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch { /* fall through */ }

  // Try extracting from markdown fences: ```json ... ``` or ``` ... ```
  const fencedMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fencedMatch) {
    try {
      const parsed = JSON.parse(fencedMatch[1].trim());
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch { /* fall through */ }
  }

  // Try extracting the first {...} block
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(braceStart, braceEnd + 1));
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch { /* fall through */ }
  }

  throw new Error('Could not extract valid JSON from response.');
}

// ── Validation ──

export type ValidationResult =
  | { valid: true; decision: McqDecision }
  | { valid: false; errors: string[] };

/**
 * Parses and validates a raw JSON object against the appropriate schema,
 * then runs cross-field validation against declared options/criteria.
 */
export function validateDecision(
  parsed: object,
  request: McqRequest
): ValidationResult {
  const hasCriteria = request.criteria && request.criteria.length > 0;
  const optionIds = new Set(request.options.map(o => o.id));

  if (hasCriteria) {
    const criterionIds = new Set(request.criteria!.map(c => c.id));
    const zodResult = McqCriteriaDecisionSchema.safeParse(parsed);
    if (!zodResult.success) {
      return {
        valid: false,
        errors: zodResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
      };
    }
    const crossFieldErrors = validateCriteriaDecisionCrossFields(zodResult.data, optionIds, criterionIds);
    if (crossFieldErrors.length > 0) {
      return { valid: false, errors: crossFieldErrors };
    }
    return { valid: true, decision: zodResult.data };
  }

  const zodResult = McqSimpleDecisionSchema.safeParse(parsed);
  if (!zodResult.success) {
    return {
      valid: false,
      errors: zodResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
    };
  }
  const crossFieldErrors = validateSimpleDecisionCrossFields(zodResult.data, optionIds);
  if (crossFieldErrors.length > 0) {
    return { valid: false, errors: crossFieldErrors };
  }
  return { valid: true, decision: zodResult.data };
}

// ── Repair Prompt ──

export function buildRepairPrompt(rawResponse: string, errors: string[]): string {
  return [
    'Your previous response was invalid. The following validation errors were found:',
    '',
    errors.map(e => `  - ${e}`).join('\n'),
    '',
    'Your original response was:',
    '```',
    rawResponse.length > 2000 ? rawResponse.slice(0, 2000) + '...' : rawResponse,
    '```',
    '',
    'Please return ONLY a corrected valid JSON object. Do not change your decision rationale,',
    'just fix the structural/format issues identified above.',
    'No markdown fences, no extra text — just the raw JSON object.'
  ].join('\n');
}

// ── Vote Aggregation ──

export function aggregateVotes(
  votes: McqMemberVote[],
  request: McqRequest,
  failedProviders: string[]
): McqVoteDistribution {
  const totalEligible = votes.length + failedProviders.length;
  const voteCounts = new Map<string, string[]>();

  // Initialize all options with empty voter lists
  for (const option of request.options) {
    voteCounts.set(option.id, []);
  }

  // Count votes
  for (const vote of votes) {
    const voters = voteCounts.get(vote.decision.selected_option_id);
    if (voters) {
      voters.push(vote.provider);
    }
  }

  const validVotes = votes.length;
  const distribution = request.options.map(option => {
    const voters = voteCounts.get(option.id) || [];
    return {
      option_id: option.id,
      option_label: option.label,
      vote_count: voters.length,
      vote_fraction: validVotes > 0 ? voters.length / validVotes : 0,
      voters
    };
  });

  // Sort by vote count descending, then by original option order for stability
  distribution.sort((a, b) => b.vote_count - a.vote_count);

  return {
    eligible_members: totalEligible,
    valid_votes: validVotes,
    failed_votes: failedProviders.length,
    abstained: failedProviders,
    distribution
  };
}

// ── Provider Execution (reuses council patterns) ──

function defaultRunnerFactory(params: { runId: string; taskId: string; provider: string }) {
  return new OrchestrationRunner(params.runId, params.taskId, params.provider, { manageRunStatus: false });
}

function timeoutSignal(ms: number, message: string): AbortController {
  const controller = new AbortController();
  setTimeout(() => controller.abort(createCancelledError(message)), ms).unref();
  return controller;
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

function retryBackoffMs(attemptNo: number): number {
  const base = Number.parseInt(process.env.COUNCIL_RETRY_BACKOFF_MS || '', 10);
  const backoff = Number.isFinite(base) && base >= 0 ? base : 750;
  return backoff * attemptNo;
}

async function runMcqProviderWithTimeout(params: {
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
  const taskId = `mcq_${runId}_${index + 1}_${provider}_attempt_${attemptNo}`;
  const runner = runnerFactory({ runId, taskId, provider });
  const controller = timeoutSignal(timeoutMs, `${provider} timed out after ${timeoutMs}ms.`);

  try {
    const session = pool.acquire(provider);
    const response = await runner.executeTask(prompt, session, {
      signal: controller.signal,
      timeouts: { providerExecutionMs: timeoutMs, ...timeouts },
      attemptNo
    });
    session.hasActiveThread = true;
    session.lastUsedAt = Date.now();
    return { provider, taskId, response };
  } catch (err) {
    controller.abort(createCancelledError(`${provider} failed.`));
    await runner.close().catch(() => { });
    await pool.invalidate(provider, err instanceof Error ? err.message : String(err)).catch(() => { });
    throw err;
  }
}

async function runMcqProviderWithRetry(params: {
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
  const { maxRetries: maxRetryCount, warnings, ...base } = params;
  let lastFailure: FailureClassification | null = null;

  for (let attemptNo = 1; attemptNo <= maxRetryCount + 1; attemptNo++) {
    try {
      return await runMcqProviderWithTimeout({ ...base, attemptNo });
    } catch (err) {
      const failure = classifyFailure(err);
      lastFailure = failure;
      warnings.push(`${base.provider} attempt ${attemptNo} failed with ${failure.code}: ${failure.publicMessage}`);

      if (!failure.retryable || attemptNo > maxRetryCount) {
        throw err;
      }

      await delay(retryBackoffMs(attemptNo));
    }
  }

  throw new Error(lastFailure?.message || `${base.provider} failed after retries.`);
}

// ── Repair Attempt via Provider ──

async function attemptRepair(params: {
  provider: string;
  index: number;
  runId: string;
  repairPrompt: string;
  pool: ProviderSessionPool;
  timeoutMs: number;
  timeouts?: Partial<RunnerTimeoutBudgets>;
  runnerFactory: CouncilRunnerFactory;
}): Promise<CouncilAnalysis> {
  return await runMcqProviderWithTimeout({
    ...params,
    prompt: params.repairPrompt,
    attemptNo: 1
  });
}

// ── Main Entry Point ──

export async function runMcqConsultation(request: McqRequest): Promise<McqResult> {
  const runId = `mcq_run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  // Input validation
  if (!request.question || request.question.trim().length === 0) {
    throw new Error('MCQ question is required.');
  }
  if (!request.options || request.options.length < 2) {
    throw new Error('At least 2 options are required for MCQ voting.');
  }

  const optionIds = new Set(request.options.map(o => o.id));
  if (optionIds.size !== request.options.length) {
    throw new Error('Duplicate option IDs are not allowed.');
  }

  if (request.criteria && request.criteria.length > 0) {
    const criterionIds = new Set(request.criteria.map(c => c.id));
    if (criterionIds.size !== request.criteria.length) {
      throw new Error('Duplicate criterion IDs are not allowed.');
    }
  }

  const providers = uniqueProviders(request.providers);
  if (providers.length === 0) {
    throw new Error('At least one council provider is required.');
  }

  DBService.createRun(runId, `MCQ: ${request.question.substring(0, 80)}`);
  DBService.updateRunStatusIfNotTerminal(runId, 'IN_PROGRESS');

  const prompt = buildMcqPrompt(request);
  const pool = new ProviderSessionPool();
  const perProviderTimeoutMs = providerTimeoutMs(request, providers.length);
  const concurrencyLimit = maxConcurrency(request);
  const retryLimit = maxRetries(request);
  const runnerFactory = request.runnerFactory ?? defaultRunnerFactory;
  const warnings: string[] = [];

  try {
    // Execute all providers in parallel
    const rawResults = await mapWithConcurrency(providers, concurrencyLimit, async (provider, index): Promise<CouncilAnalysis> => {
      return await runMcqProviderWithRetry({
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

    // Parse and validate each response
    const votes: McqMemberVote[] = [];
    const failed: McqFailedVote[] = [];

    for (const result of rawResults) {
      if (result.status === 'rejected') {
        const reason = result.reason?.message || String(result.reason);
        const providerName = providers[rawResults.indexOf(result)] || 'unknown';
        failed.push({ provider: providerName, reason });
        warnings.push(`Provider ${providerName} failed: ${reason}`);
        continue;
      }

      const analysis = result.value;
      let decision: McqDecision | null = null;

      try {
        const extracted = extractJsonFromResponse(analysis.response);
        const validationResult = validateDecision(extracted, request);

        if (validationResult.valid) {
          decision = validationResult.decision;
        } else {
          // Attempt bounded repair (max 1 retry)
          warnings.push(`${analysis.provider} returned invalid JSON, attempting repair: ${validationResult.errors.join('; ')}`);
          const repairPromptText = buildRepairPrompt(analysis.response, validationResult.errors);

          try {
            const repairResult = await attemptRepair({
              provider: analysis.provider,
              index: providers.indexOf(analysis.provider),
              runId,
              repairPrompt: repairPromptText,
              pool,
              timeoutMs: perProviderTimeoutMs,
              timeouts: request.timeouts,
              runnerFactory
            });

            const reExtracted = extractJsonFromResponse(repairResult.response);
            const reValidation = validateDecision(reExtracted, request);

            if (reValidation.valid) {
              decision = reValidation.decision;
              warnings.push(`${analysis.provider} repair succeeded.`);
            } else {
              warnings.push(`${analysis.provider} repair also failed: ${reValidation.errors.join('; ')}`);
            }
          } catch (repairErr: any) {
            warnings.push(`${analysis.provider} repair attempt failed: ${repairErr?.message || String(repairErr)}`);
          }
        }
      } catch (parseErr: any) {
        warnings.push(`${analysis.provider} JSON extraction failed: ${parseErr?.message || String(parseErr)}`);
      }

      if (decision) {
        votes.push({
          provider: analysis.provider,
          taskId: analysis.taskId,
          decision,
          rawResponse: analysis.response
        });
      } else {
        failed.push({ provider: analysis.provider, reason: 'Failed to produce valid structured response.' });
      }
    }

    // Aggregate votes
    const distribution = aggregateVotes(votes, request, failed.map(f => f.provider));

    // Determine overall status
    let status: McqResult['status'];
    if (votes.length === 0) {
      status = 'ALL_FAILED';
      DBService.updateRunStatusIfNotTerminal(runId, 'FAILED');
    } else if (votes.length === providers.length) {
      status = 'COMPLETED';
      DBService.updateRunStatusIfNotTerminal(runId, 'COMPLETED');
    } else {
      status = 'PARTIAL_SUCCESS';
      DBService.updateRunStatusIfNotTerminal(runId, 'PARTIAL_SUCCESS');
    }

    return {
      run_id: runId,
      status,
      question: request.question,
      options: request.options,
      criteria: request.criteria,
      votes,
      failed,
      distribution,
      warnings: Array.from(new Set(warnings))
    };
  } finally {
    // Keep browser sessions open (consistent with council.ts behavior)
    console.log('\n[INFO] MCQ: Keeping active browser sessions open for visual inspection.\n');
  }
}
