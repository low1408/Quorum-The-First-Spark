import crypto from 'crypto';
import path from 'node:path';
import { z } from 'zod';
import { DBService } from '../db/database.ts';
import { type ValidatedCouncilContext } from '../mcp/contextValidation.ts';
import { OrchestrationRunner, type RunnerTimeoutBudgets } from './runner.ts';
import {
  uniqueProviders,
  providerTimeoutMs,
  timeoutSignal,
  renderRepositoryEvidence,
  renderContextWarnings,
  type CouncilRunnerFactory
} from './council.ts';
import { isAbortError } from './statuses.ts';

export type ValidationTestFramework = 'auto' | 'node:test' | 'vitest' | 'jest' | 'pytest';

export type ValidationTestFinding = {
  id?: string;
  classification?: string;
  severity?: string;
  description: string;
  evidence?: string;
  validation_test: string;
};

export type MaterializeValidationTestsRequest = {
  objective: string;
  findings: ValidationTestFinding[];
  context: ValidatedCouncilContext;
  test_framework?: ValidationTestFramework;
  target_test_dir?: string;
  style_constraints?: string;
  provider?: string;
  max_wait_ms?: number;
  provider_timeout_ms?: number;
  timeouts?: Partial<RunnerTimeoutBudgets>;
  runnerFactory?: CouncilRunnerFactory;
};

export type MaterializedValidationTest = {
  path: string;
  target_finding_id?: string;
  assertion_summary: string;
};

export type UncoveredValidationFinding = {
  finding_id?: string;
  reason: string;
};

export type MaterializeValidationTestsResult = {
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  test_patch: string;
  tests: MaterializedValidationTest[];
  uncovered_findings: UncoveredValidationFinding[];
  warnings: string[];
  provider: string;
  raw_response?: string;
};

type NormalizedFinding = ValidationTestFinding & {
  normalizedId: string;
};

const modelTestSchema = z.object({
  path: z.string().min(1),
  target_finding_id: z.string().min(1).optional(),
  assertion_summary: z.string().min(1)
}).strict();

const modelUncoveredFindingSchema = z.object({
  finding_id: z.string().min(1).optional(),
  reason: z.string().min(1)
}).strict();

const modelResponseSchema = z.object({
  test_patch: z.string(),
  tests: z.array(modelTestSchema),
  uncovered_findings: z.array(modelUncoveredFindingSchema).default([]),
  warnings: z.array(z.string()).default([])
}).strict();

export function selectValidationTestProvider(provider?: string): string {
  return uniqueProviders(provider ? [provider] : undefined)[0];
}

function defaultRunnerFactory(params: { runId: string; taskId: string; provider: string }) {
  return new OrchestrationRunner(params.runId, params.taskId, params.provider, { manageRunStatus: false });
}

function normalizeFindingId(finding: ValidationTestFinding, index: number): string {
  const provided = finding.id?.trim();
  return provided || `finding_${index + 1}`;
}

export function normalizeValidationFindings(findings: ValidationTestFinding[]): NormalizedFinding[] {
  if (!Array.isArray(findings) || findings.length === 0) {
    throw new Error('At least one validation-test finding is required.');
  }

  const seenIds = new Set<string>();
  return findings.map((finding, index) => {
    if (!finding || typeof finding !== 'object') {
      throw new Error(`Finding ${index + 1} must be an object.`);
    }
    if (typeof finding.description !== 'string' || finding.description.trim() === '') {
      throw new Error(`Finding ${index + 1} must include a non-empty description.`);
    }
    if (typeof finding.validation_test !== 'string' || finding.validation_test.trim() === '') {
      throw new Error(`Finding ${index + 1} must include non-empty validation_test prose.`);
    }

    const normalizedId = normalizeFindingId(finding, index);
    if (seenIds.has(normalizedId)) {
      throw new Error(`Duplicate finding id: ${normalizedId}`);
    }
    seenIds.add(normalizedId);

    return { ...finding, normalizedId };
  });
}

function resolveTestFramework(framework: ValidationTestFramework | undefined, context: ValidatedCouncilContext): Exclude<ValidationTestFramework, 'auto'> {
  if (framework && framework !== 'auto') return framework;

  const packageJson = context.files.find(file => file.normalizedPath === 'package.json')?.content ?? '';
  if (/\bvitest\b/i.test(packageJson)) return 'vitest';
  if (/\bjest\b/i.test(packageJson)) return 'jest';
  if (/\bpytest\b/i.test(packageJson)) return 'pytest';
  return 'node:test';
}

function formatFindings(findings: NormalizedFinding[]): string {
  return findings.map((finding, index) => {
    return [
      `FINDING ${index + 1}`,
      `id=${finding.normalizedId}`,
      finding.classification ? `classification=${finding.classification}` : '',
      finding.severity ? `severity=${finding.severity}` : '',
      `description=${finding.description}`,
      finding.evidence ? `evidence=${finding.evidence}` : '',
      `validation_test=${finding.validation_test}`
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

export function buildMaterializeValidationTestsPrompt(request: MaterializeValidationTestsRequest): string {
  const findings = normalizeValidationFindings(request.findings);
  const testFramework = resolveTestFramework(request.test_framework, request.context);
  const targetDir = normalizeTargetTestDir(request.target_test_dir);

  return [
    'You are generating executable validation tests for a coding agent.',
    'Return ONLY a valid JSON object. Do not use markdown fences unless the entire response is a single JSON fence.',
    'Do not write production code. Do not modify implementation files. Return a unified diff that creates or edits test files only.',
    'If supplied context is insufficient for a finding, put that finding in uncovered_findings instead of inventing a test.',
    '',
    'REQUIRED JSON SHAPE:',
    JSON.stringify({
      test_patch: 'unified diff string touching test files only',
      tests: [
        {
          path: 'tests/example.test.ts',
          target_finding_id: findings[0]?.normalizedId ?? 'finding_1',
          assertion_summary: 'what behavior this test asserts'
        }
      ],
      uncovered_findings: [
        {
          finding_id: 'finding id that could not be covered',
          reason: 'why no executable test can be generated from supplied context'
        }
      ],
      warnings: ['optional caveats']
    }, null, 2),
    '',
    `OBJECTIVE:\n${request.objective}`,
    `TEST FRAMEWORK:\n${testFramework}`,
    targetDir ? `TARGET TEST DIRECTORY:\n${targetDir}` : '',
    request.style_constraints ? `STYLE CONSTRAINTS:\n${request.style_constraints}` : '',
    '',
    `FINDINGS:\n${formatFindings(findings)}`,
    '',
    `CONTEXT DIGEST:\n${request.context.context_digest}`,
    renderContextWarnings(request.context.warnings),
    `REPOSITORY EVIDENCE:\n${renderRepositoryEvidence(request.context)}`
  ].filter(Boolean).join('\n\n');
}

export function extractStrictJsonObject(raw: string): object {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Provider returned an empty response.');
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to fenced JSON handling.
  }

  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch {
      throw new Error('Provider returned malformed fenced JSON.');
    }
  }

  throw new Error('Provider response must be a strict JSON object.');
}

function normalizePatchPath(rawPath: string): string | null {
  const withoutPrefix = rawPath.trim().replace(/^["']|["']$/g, '').replace(/^(?:a|b)\//, '');
  if (!withoutPrefix || withoutPrefix === '/dev/null') return null;

  const normalized = path.posix.normalize(withoutPrefix.replace(/\\/g, '/'));
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Patch path escapes the workspace: ${rawPath}`);
  }
  return normalized;
}

export function modifiedPathsFromUnifiedDiff(patch: string): string[] {
  const paths = new Set<string>();

  for (const line of patch.split(/\r?\n/u)) {
    const diffMatch = line.match(/^diff --git\s+(.+?)\s+(.+)$/);
    if (diffMatch) {
      for (const candidate of [diffMatch[1], diffMatch[2]]) {
        const normalized = normalizePatchPath(candidate);
        if (normalized) paths.add(normalized);
      }
      continue;
    }

    const fileMatch = line.match(/^(?:---|\+\+\+)\s+(.+)$/);
    if (fileMatch) {
      const normalized = normalizePatchPath(fileMatch[1]);
      if (normalized) paths.add(normalized);
    }
  }

  return Array.from(paths).sort();
}

function normalizeTargetTestDir(targetTestDir?: string): string | null {
  if (!targetTestDir?.trim()) return null;
  const normalized = path.posix.normalize(targetTestDir.trim().replace(/\\/g, '/')).replace(/\/$/u, '');
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`target_test_dir escapes the workspace: ${targetTestDir}`);
  }
  return normalized;
}

function isUnderDirectory(filePath: string, directory: string): boolean {
  return filePath === directory || filePath.startsWith(`${directory}/`);
}

function isTestLikePath(filePath: string): boolean {
  return (
    /(^|\/)(tests?|__tests__)\//u.test(filePath) ||
    /\.(?:test|spec)\.(?:[cm]?[jt]sx?|py)$/u.test(filePath)
  );
}

function validatePatchPaths(testPatch: string, targetTestDir?: string): string[] {
  const paths = modifiedPathsFromUnifiedDiff(testPatch);
  if (paths.length === 0) {
    throw new Error('test_patch must include at least one modified path.');
  }

  const normalizedTargetDir = normalizeTargetTestDir(targetTestDir);
  const invalidPaths = paths.filter(filePath => {
    return !isTestLikePath(filePath) && !(normalizedTargetDir && isUnderDirectory(filePath, normalizedTargetDir));
  });

  if (invalidPaths.length > 0) {
    throw new Error(`test_patch modifies non-test path(s): ${invalidPaths.join(', ')}`);
  }

  return paths;
}

export function validateMaterializedValidationTestsResponse(params: {
  parsed: object;
  findings: ValidationTestFinding[];
  target_test_dir?: string;
  provider: string;
  raw_response?: string;
}): MaterializeValidationTestsResult {
  const findings = normalizeValidationFindings(params.findings);
  const findingIds = new Set(findings.map(finding => finding.normalizedId));
  const validation = modelResponseSchema.safeParse(params.parsed);
  if (!validation.success) {
    throw new Error(`Provider response does not match materialized validation test schema: ${validation.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }

  const response = validation.data;
  if (response.test_patch.trim() === '') {
    throw new Error('Provider response test_patch must be non-empty.');
  }
  validatePatchPaths(response.test_patch, params.target_test_dir);

  if (response.tests.length === 0) {
    throw new Error('Provider response must include at least one generated test mapping.');
  }

  for (const generatedTest of response.tests) {
    if (!generatedTest.target_finding_id) {
      throw new Error(`Generated test ${generatedTest.path} is missing target_finding_id.`);
    }
    if (!findingIds.has(generatedTest.target_finding_id)) {
      throw new Error(`Generated test ${generatedTest.path} references unknown finding id: ${generatedTest.target_finding_id}`);
    }
  }

  const coveredFindingIds = new Set(response.tests.map(generatedTest => generatedTest.target_finding_id!));
  const uncoveredFindingIds = new Set<string>();
  for (const uncovered of response.uncovered_findings) {
    if (!uncovered.finding_id) {
      throw new Error('Uncovered finding is missing finding_id.');
    }
    if (!findingIds.has(uncovered.finding_id)) {
      throw new Error(`Uncovered finding references unknown finding id: ${uncovered.finding_id}`);
    }
    uncoveredFindingIds.add(uncovered.finding_id);
  }

  for (const finding of findings) {
    if (!coveredFindingIds.has(finding.normalizedId) && !uncoveredFindingIds.has(finding.normalizedId)) {
      throw new Error(`Finding ${finding.normalizedId} is neither covered by a generated test nor listed as uncovered.`);
    }
  }

  return {
    status: response.uncovered_findings.length > 0 ? 'PARTIAL' : 'COMPLETED',
    test_patch: response.test_patch,
    tests: response.tests,
    uncovered_findings: response.uncovered_findings,
    warnings: response.warnings,
    provider: params.provider,
    raw_response: params.raw_response
  };
}

export async function runMaterializeValidationTests(request: MaterializeValidationTestsRequest): Promise<MaterializeValidationTestsResult> {
  const provider = selectValidationTestProvider(request.provider);
  const prompt = buildMaterializeValidationTestsPrompt({ ...request, provider });
  const runId = `validation_tests_run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const taskId = `validation_tests_${runId}_${provider}`;
  const runnerFactory = request.runnerFactory ?? defaultRunnerFactory;
  const timeoutMs = providerTimeoutMs({
    maxWaitMs: request.max_wait_ms,
    providerTimeoutMs: request.provider_timeout_ms
  }, 1);
  const controller = timeoutSignal(timeoutMs, `${provider} timed out after ${timeoutMs}ms.`);
  const runner = runnerFactory({ runId, taskId, provider });

  try {
    const rawResponse = await runner.executeTask(prompt, undefined, {
      signal: controller.signal,
      timeouts: { providerExecutionMs: timeoutMs, ...request.timeouts },
      attemptNo: 1
    });
    const parsed = extractStrictJsonObject(rawResponse);
    const result = validateMaterializedValidationTestsResponse({
      parsed,
      findings: request.findings,
      target_test_dir: request.target_test_dir,
      provider
    });
    DBService.updateRunStatusIfNotTerminal(runId, result.status === 'COMPLETED' ? 'COMPLETED' : 'PARTIAL_SUCCESS');
    return result;
  } catch (err) {
    DBService.updateRunStatusIfNotTerminal(runId, isAbortError(err) ? 'CANCELLED' : 'FAILED');
    throw err;
  } finally {
    controller.abort();
    await runner.close().catch(() => { });
  }
}
