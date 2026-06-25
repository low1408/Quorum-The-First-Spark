import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.ts';
import { OrchestrationRunner, type RunnerTimeoutBudgets } from '../engine/runner.ts';
import { createCancelledError } from '../engine/statuses.ts';
import {
  assertSafeContextPath,
  candidateImportPaths,
  normalizeContextPath,
  referencedRepositoryPaths,
  resolveLikelyImportPath,
  validateCouncilContext,
  validateCouncilRequestText,
  type CouncilContext,
  type CouncilEvidenceRole
} from '../mcp/contextValidation.ts';

type ScoutRole = Extract<CouncilEvidenceRole, 'core' | 'contract' | 'config' | 'test' | 'supporting'>;
type LlmPhase = 'ranking' | 'briefing';

export type ScoutStrategy =
  | 'deterministic-v1'
  | 'chatgpt-full-briefing-v1'
  | 'chatgpt-partial-v1'
  | 'chatgpt-fallback-v1';

export type ScoutDiscoverContextArgs = {
  query: string;
  repo_root?: string;
  entrypoints?: string[];
  changed_files?: string[];
  token_budget_chars?: number;
  max_dependency_depth?: number;
  include_tests?: boolean;
  include_reverse_importers?: boolean;
  enhance_with_llm?: boolean;
  llm_timeout_ms?: number;
};

export type ScoutRecommendedFile = {
  path: string;
  role: ScoutRole;
  relevance_score: number;
  relevance_reason: string;
  is_core: boolean;
  source: string;
  size_chars: number;
};

export type ScoutOmittedFile = {
  path: string;
  reason: string;
  size_chars?: number;
};

export type ScoutDiscoverContextResult = {
  context: CouncilContext;
  context_digest: string;
  workspace_root: string;
  recommended_files: ScoutRecommendedFile[];
  omitted_files: ScoutOmittedFile[];
  warnings: string[];
  stats: {
    strategy: ScoutStrategy;
    candidate_count: number;
    selected_count: number;
    total_chars: number;
    token_budget_chars: number;
    llm?: ScoutLlmStats;
  };
};

export type ScoutLlmStats = {
  provider: 'chatgpt';
  attempted: boolean;
  ranking_applied: boolean;
  briefing_applied: boolean;
  run_id?: string;
  task_ids?: string[];
  duration_ms: number;
  fallback_reason?: string;
};

export type ScoutLlmRunnerParams = {
  phase: LlmPhase;
  prompt: string;
  runId: string;
  taskId: string;
  signal: AbortSignal;
  timeoutMs: number;
};

export type ScoutLlmRunner = (params: ScoutLlmRunnerParams) => Promise<string>;

export type ScoutLlmDeps = {
  runLlm?: ScoutLlmRunner;
  now?: () => number;
};

type RepoFile = {
  path: string;
  content: string;
  sizeChars: number;
};

type Candidate = {
  path: string;
  role: ScoutRole;
  score: number;
  isCore: boolean;
  source: string;
  reasons: string[];
};

const DEFAULT_TOKEN_BUDGET_CHARS = 300_000;
const MAX_TOKEN_BUDGET_CHARS = 700_000;
const MAX_CONTEXT_FILE_CHARS = 250_000;
const DEFAULT_DEPENDENCY_DEPTH = 2;
const MAX_DEPENDENCY_DEPTH = 5;
const LEXICAL_CANDIDATE_LIMIT = 8;
const DEFAULT_LLM_TIMEOUT_MS = 90_000;
const MIN_LLM_TIMEOUT_MS = 15_000;
const MAX_LLM_TIMEOUT_MS = 180_000;
const LLM_BRIEFING_MAX_FILE_EXCERPT_CHARS = 4_000;
const LLM_BRIEFING_MAX_TOTAL_EXCERPT_CHARS = 40_000;
const LLM_OMITTED_FILE_LIMIT = 30;
const SCHEMA_VERSION = '2026-06-14';

const STRUCTURED_REVIEW_FIELDS: Array<keyof NonNullable<CouncilContext['structured_review']>> = [
  'review_objective',
  'architecture',
  'execution_flow',
  'assumptions_and_invariants',
  'core_evidence',
  'supporting_contracts',
  'privacy_and_persistence',
  'tests_and_runtime_evidence',
  'omitted_material'
];

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'also',
  'and',
  'are',
  'before',
  'build',
  'can',
  'code',
  'could',
  'debug',
  'file',
  'files',
  'fix',
  'for',
  'from',
  'how',
  'implement',
  'implementation',
  'into',
  'please',
  'repo',
  'repository',
  'should',
  'that',
  'the',
  'this',
  'tool',
  'tools',
  'typescript',
  'use',
  'used',
  'using',
  'what',
  'when',
  'where',
  'with',
  'would'
]);

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/u).length;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) {
    throw new Error('Scout numeric options must be integers.');
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function resolveScoutWorkspaceRoot(repoRoot?: string): string {
  const workspaceRoot = path.resolve(repoRoot || config.rootDir);
  if (!fs.existsSync(workspaceRoot)) {
    throw new Error(`Scout repo_root does not exist: ${workspaceRoot}`);
  }
  if (!fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error(`Scout repo_root must be a directory: ${workspaceRoot}`);
  }
  return workspaceRoot;
}

function isExcludedPath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  const parts = lower.split('/');
  const basename = path.posix.basename(lower);
  const safeEnvExamples = new Set(['.env.example', 'env.example']);
  const excludedDirectories = new Set([
    '.cache',
    '.agents',
    '.codex',
    '.git',
    '.vscode',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'quorum',
    'review-context',
    'sessions'
  ]);

  if (parts.some(part => excludedDirectories.has(part))) return true;
  if (lower.startsWith('extra/ai-chat-logs/')) return true;
  if (basename === 'package-lock.json') return true;
  if ((basename === '.env' || basename.startsWith('.env.')) && !safeEnvExamples.has(basename)) return true;
  if (
    lower.endsWith('.log') ||
    lower.endsWith('.db') ||
    lower.endsWith('.sqlite') ||
    lower.endsWith('.sqlite3') ||
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower.includes('private_key')
  ) {
    return true;
  }

  return false;
}

function isLikelyTextPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath.toLowerCase());
  if (basename === '.env.example' || basename === 'env.example') return true;
  return /\.(?:cjs|cts|d\.ts|js|json|jsx|md|mjs|mts|ts|tsx|txt|yaml|yml|py)$/.test(relativePath);
}

function scanRepository(rootDir: string): Map<string, RepoFile> {
  const files = new Map<string, RepoFile>();

  const visit = (absoluteDir: string, relativeDir: string): void => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (isExcludedPath(relativePath)) continue;

      const absolutePath = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile() || !isLikelyTextPath(relativePath)) continue;

      const normalizedPath = relativePath.replace(/\\/g, '/');
      try {
        assertSafeContextPath(normalizedPath);
        const content = fs.readFileSync(absolutePath, 'utf8');
        if (content.trim() === '') continue;
        files.set(normalizedPath, {
          path: normalizedPath,
          content,
          sizeChars: content.length
        });
      } catch {
        continue;
      }
    }
  };

  visit(rootDir, '');
  return files;
}

function normalizeQueryTerms(query: string): string[] {
  const expanded = query.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const terms = expanded
    .split(/[^a-z0-9]+/u)
    .map(term => term.trim())
    .filter(term => term.length >= 3 && !STOP_WORDS.has(term));
  return Array.from(new Set(terms)).slice(0, 40);
}

function classifyRole(relativePath: string, fallback: ScoutRole = 'supporting'): ScoutRole {
  const basename = path.posix.basename(relativePath);
  if (relativePath === 'package.json' || relativePath === 'tsconfig.json' || /\.ya?ml$/.test(relativePath)) return 'config';
  if (relativePath.startsWith('tests/') || /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/.test(basename)) return 'test';
  return fallback;
}

function rolePriority(role: ScoutRole): number {
  switch (role) {
    case 'core':
      return 0;
    case 'contract':
      return 1;
    case 'config':
      return 2;
    case 'test':
      return 3;
    case 'supporting':
      return 4;
  }
}

function outputSort(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const roleDelta = rolePriority(a.role) - rolePriority(b.role);
  if (roleDelta !== 0) return roleDelta;
  return a.path.localeCompare(b.path);
}

function budgetSort(a: Candidate, b: Candidate): number {
  if (a.isCore !== b.isCore) return a.isCore ? -1 : 1;
  return outputSort(a, b);
}

function dedupeWarnings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function addOmission(omissions: Map<string, ScoutOmittedFile>, omitted: ScoutOmittedFile): void {
  if (!omissions.has(omitted.path)) {
    omissions.set(omitted.path, omitted);
  }
}

function resolveInputPathCandidates(rawPath: string, repoFiles: Map<string, RepoFile>): string[] {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeContextPath(rawPath);
    assertSafeContextPath(normalizedPath);
  } catch {
    return [];
  }

  if (repoFiles.has(normalizedPath)) return [normalizedPath];

  const lower = normalizedPath.toLowerCase();
  const basename = path.posix.basename(lower);
  const matches = Array.from(repoFiles.keys()).filter(candidatePath => {
    const candidateLower = candidatePath.toLowerCase();
    return (
      candidateLower === lower ||
      candidateLower.endsWith(`/${lower}`) ||
      path.posix.basename(candidateLower) === basename
    );
  });

  return Array.from(new Set(matches)).sort();
}

function addCandidate(params: {
  candidates: Map<string, Candidate>;
  repoFiles: Map<string, RepoFile>;
  omissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
  rawPath: string;
  score: number;
  role: ScoutRole;
  source: string;
  reason: string;
  isCore: boolean;
}): void {
  let normalizedForOmission = params.rawPath;
  try {
    normalizedForOmission = normalizeContextPath(params.rawPath);
    assertSafeContextPath(normalizedForOmission);
  } catch (err) {
    params.warnings.push(`Scout skipped unsafe path ${params.rawPath}: ${err instanceof Error ? err.message : String(err)}`);
    addOmission(params.omissions, { path: params.rawPath, reason: 'unsafe path' });
    return;
  }

  const paths = resolveInputPathCandidates(params.rawPath, params.repoFiles);
  if (paths.length === 0) {
    params.warnings.push(`Scout could not find referenced file: ${params.rawPath}`);
    addOmission(params.omissions, { path: normalizedForOmission, reason: 'not found or excluded' });
    return;
  }

  for (const candidatePath of paths) {
    const previous = params.candidates.get(candidatePath);
    const role = classifyRole(candidatePath, params.role);
    if (!previous) {
      params.candidates.set(candidatePath, {
        path: candidatePath,
        role,
        score: params.score,
        isCore: params.isCore,
        source: params.source,
        reasons: [params.reason]
      });
      continue;
    }

    if (!previous.reasons.includes(params.reason)) {
      previous.reasons.push(params.reason);
    }
    previous.isCore = previous.isCore || params.isCore;
    if (params.score > previous.score) {
      previous.score = params.score;
      previous.role = role;
      previous.source = params.source;
    }
  }
}

function resolveLocalImports(relativePath: string, repoFiles: Map<string, RepoFile>): string[] {
  const file = repoFiles.get(relativePath);
  if (!file) return [];

  const imports = new Set<string>();
  for (const importPath of candidateImportPaths(file.content)) {
    for (const candidate of resolveLikelyImportPath(relativePath, importPath)) {
      if (repoFiles.has(candidate)) {
        imports.add(candidate);
        break;
      }
    }
  }

  return Array.from(imports).sort();
}

function buildReverseImportIndex(repoFiles: Map<string, RepoFile>): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const relativePath of repoFiles.keys()) {
    for (const importedPath of resolveLocalImports(relativePath, repoFiles)) {
      const importers = reverse.get(importedPath) || [];
      importers.push(relativePath);
      reverse.set(importedPath, importers);
    }
  }
  for (const importers of reverse.values()) {
    importers.sort();
  }
  return reverse;
}

function addLexicalCandidates(params: {
  query: string;
  repoFiles: Map<string, RepoFile>;
  candidates: Map<string, Candidate>;
  omissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
}): void {
  const terms = normalizeQueryTerms(params.query);
  if (terms.length === 0) return;

  const hits: Array<{ path: string; strength: number; matchedTerms: string[] }> = [];
  for (const file of params.repoFiles.values()) {
    const pathLower = file.path.toLowerCase();
    const contentLower = file.content.toLowerCase();
    const pathTerms = terms.filter(term => pathLower.includes(term));
    const contentTerms = terms.filter(term => contentLower.includes(term));
    if (pathTerms.length === 0 && contentTerms.length < 2) continue;

    hits.push({
      path: file.path,
      strength: pathTerms.length * 4 + contentTerms.length,
      matchedTerms: Array.from(new Set([...pathTerms, ...contentTerms])).slice(0, 6)
    });
  }

  hits
    .sort((a, b) => b.strength - a.strength || a.path.localeCompare(b.path))
    .slice(0, LEXICAL_CANDIDATE_LIMIT)
    .forEach(hit => {
      const pathLower = hit.path.toLowerCase();
      const hasSpecificPathHit = hit.matchedTerms.some(term => term.length >= 5 && pathLower.includes(term));
      const isSourcePath = hit.path.startsWith('from_orchestrator/') || hit.path.startsWith('scripts/');
      const role = hasSpecificPathHit && isSourcePath ? 'core' : classifyRole(hit.path, 'supporting');
      addCandidate({
        candidates: params.candidates,
        repoFiles: params.repoFiles,
        omissions: params.omissions,
        warnings: params.warnings,
        rawPath: hit.path,
        score: 0.8,
        role,
        source: 'lexical_match',
        reason: `Lexical match for query terms: ${hit.matchedTerms.join(', ')}`,
        isCore: role === 'core'
      });
    });
}

function addForwardImports(params: {
  candidates: Map<string, Candidate>;
  repoFiles: Map<string, RepoFile>;
  omissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
  maxDepth: number;
}): void {
  if (params.maxDepth <= 0) return;

  const queue: Array<{ path: string; depth: number }> = Array.from(params.candidates.values())
    .filter(candidate => candidate.isCore)
    .map(candidate => ({ path: candidate.path, depth: 0 }));
  const visited = new Map(queue.map(item => [item.path, item.depth]));

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= params.maxDepth) continue;

    for (const importedPath of resolveLocalImports(current.path, params.repoFiles)) {
      addCandidate({
        candidates: params.candidates,
        repoFiles: params.repoFiles,
        omissions: params.omissions,
        warnings: params.warnings,
        rawPath: importedPath,
        score: 0.65,
        role: 'contract',
        source: 'forward_import',
        reason: `Imported by ${current.path}`,
        isCore: false
      });

      if (!visited.has(importedPath) || visited.get(importedPath)! > current.depth + 1) {
        visited.set(importedPath, current.depth + 1);
        queue.push({ path: importedPath, depth: current.depth + 1 });
      }
    }
  }
}

function addReverseImporters(params: {
  candidates: Map<string, Candidate>;
  repoFiles: Map<string, RepoFile>;
  omissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
}): void {
  const reverseIndex = buildReverseImportIndex(params.repoFiles);
  const targetPaths = Array.from(params.candidates.keys());

  for (const targetPath of targetPaths) {
    for (const importerPath of reverseIndex.get(targetPath) || []) {
      addCandidate({
        candidates: params.candidates,
        repoFiles: params.repoFiles,
        omissions: params.omissions,
        warnings: params.warnings,
        rawPath: importerPath,
        score: 0.5,
        role: 'supporting',
        source: 'reverse_importer',
        reason: `Imports selected file ${targetPath}`,
        isCore: false
      });
    }
  }
}

function addNearbyTests(params: {
  candidates: Map<string, Candidate>;
  repoFiles: Map<string, RepoFile>;
  omissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
}): void {
  const coreCandidates = Array.from(params.candidates.values()).filter(candidate => candidate.isCore);
  const testFiles = Array.from(params.repoFiles.values()).filter(file => classifyRole(file.path) === 'test');

  for (const candidate of coreCandidates) {
    const stem = path.posix.basename(candidate.path).replace(/\.(?:d\.)?(?:ts|tsx|js|jsx|json|md)$/u, '').toLowerCase();
    if (stem.length < 4) continue;

    for (const testFile of testFiles) {
      const testPath = testFile.path.toLowerCase();
      const testContent = testFile.content.toLowerCase();
      if (!testPath.includes(stem) && !testContent.includes(stem)) continue;
      addCandidate({
        candidates: params.candidates,
        repoFiles: params.repoFiles,
        omissions: params.omissions,
        warnings: params.warnings,
        rawPath: testFile.path,
        score: 0.5,
        role: 'test',
        source: 'nearby_test',
        reason: `Nearby test coverage for ${candidate.path}`,
        isCore: false
      });
    }
  }
}

function addConfigFiles(params: {
  query: string;
  candidates: Map<string, Candidate>;
  repoFiles: Map<string, RepoFile>;
  omissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
}): void {
  const codeChangeIntent = /\b(implement|fix|debug|refactor|test|typecheck|compile|build|mcp|server)\b/i.test(params.query);
  const hasTsOrJs = Array.from(params.candidates.keys()).some(candidatePath => /\.(?:ts|tsx|js|jsx)$/.test(candidatePath));
  if (!codeChangeIntent || !hasTsOrJs) return;

  for (const configPath of ['package.json', 'tsconfig.json']) {
    addCandidate({
      candidates: params.candidates,
      repoFiles: params.repoFiles,
      omissions: params.omissions,
      warnings: params.warnings,
      rawPath: configPath,
      score: 0.5,
      role: 'config',
      source: 'config_heuristic',
      reason: 'Configuration context for TypeScript/code-change query',
      isCore: false
    });
  }
}

function selectWithinBudget(params: {
  candidates: Map<string, Candidate>;
  repoFiles: Map<string, RepoFile>;
  tokenBudgetChars: number;
  baseOmissions: Map<string, ScoutOmittedFile>;
}): {
  selected: Candidate[];
  omitted: Map<string, ScoutOmittedFile>;
  totalChars: number;
} {
  const omitted = new Map(params.baseOmissions);
  const selected: Candidate[] = [];
  let totalChars = 0;

  for (const candidate of Array.from(params.candidates.values()).sort(budgetSort)) {
    const file = params.repoFiles.get(candidate.path);
    if (!file) continue;
    if (file.sizeChars > MAX_CONTEXT_FILE_CHARS) {
      addOmission(omitted, {
        path: candidate.path,
        reason: `exceeds per-file limit of ${MAX_CONTEXT_FILE_CHARS} characters`,
        size_chars: file.sizeChars
      });
      continue;
    }
    if (totalChars + file.sizeChars > params.tokenBudgetChars) {
      addOmission(omitted, {
        path: candidate.path,
        reason: `exceeds token_budget_chars ${params.tokenBudgetChars}`,
        size_chars: file.sizeChars
      });
      continue;
    }

    selected.push(candidate);
    totalChars += file.sizeChars;
  }

  if (selected.length === 0) {
    throw new Error('Scout could not select any files within the requested token budget.');
  }

  return { selected, omitted, totalChars };
}

function selectedForOutput(selected: Candidate[], repoFiles: Map<string, RepoFile>): ScoutRecommendedFile[] {
  return selected.sort(outputSort).map(candidate => ({
    path: candidate.path,
    role: candidate.role,
    relevance_score: candidate.score,
    relevance_reason: candidate.reasons.join('; '),
    is_core: candidate.isCore,
    source: candidate.source,
    size_chars: repoFiles.get(candidate.path)?.sizeChars ?? 0
  }));
}

function formatPathList(paths: string[], emptyMessage: string): string {
  if (paths.length === 0) return emptyMessage;
  const listed = paths.slice(0, 30).join(', ');
  return paths.length > 30 ? `${listed}, and ${paths.length - 30} more.` : listed;
}

function buildStructuredReview(params: {
  query: string;
  recommended: ScoutRecommendedFile[];
  omitted: ScoutOmittedFile[];
  totalChars: number;
  tokenBudgetChars: number;
}): CouncilContext['structured_review'] {
  const corePaths = params.recommended.filter(file => file.role === 'core' || file.is_core).map(file => file.path);
  const supportPaths = params.recommended
    .filter(file => file.role === 'contract' || file.role === 'config' || file.role === 'supporting')
    .map(file => file.path);
  const testPaths = params.recommended.filter(file => file.role === 'test').map(file => file.path);
  const omitted = params.omitted
    .slice(0, 40)
    .map(file => `${file.path} (${file.reason})`);

  return {
    review_objective: `Review repository context relevant to: ${params.query}`,
    architecture: 'Scout selected files deterministically from explicit references, lexical matches, local imports, reverse importers, nearby tests, and configuration heuristics.',
    execution_flow: 'scout_discover_context scans local text files, ranks candidates, expands dependencies, prunes to budget, constructs a CouncilContext, and validates it with validateCouncilContext.',
    assumptions_and_invariants: 'V1 is deterministic and local-only; it does not use embeddings, persistent indexes, API calls, or LLM reranking. Source files and evidence_manifest entries are authoritative.',
    core_evidence: formatPathList(corePaths, 'No core files selected.'),
    supporting_contracts: formatPathList(supportPaths, 'No supporting contracts selected.'),
    privacy_and_persistence: 'Scout excludes sensitive and generated paths including real env files, session storage, logs, databases, saved council reports, node_modules, and .git internals.',
    tests_and_runtime_evidence: formatPathList(testPaths, 'No nearby tests or runtime evidence selected.'),
    omitted_material: omitted.length > 0
      ? `${omitted.join(', ')}${params.omitted.length > omitted.length ? `, and ${params.omitted.length - omitted.length} more omitted files.` : ''}`
      : `No candidate files omitted. Selected ${params.totalChars} characters within budget ${params.tokenBudgetChars}.`
  };
}

function buildCouncilContext(params: {
  query: string;
  selected: Candidate[];
  omitted: ScoutOmittedFile[];
  repoFiles: Map<string, RepoFile>;
  totalChars: number;
  tokenBudgetChars: number;
}): CouncilContext {
  const recommended = selectedForOutput([...params.selected], params.repoFiles);
  const files = recommended.map(file => {
    const repoFile = params.repoFiles.get(file.path)!;
    const lines = lineCount(repoFile.content);
    return {
      path: file.path,
      content: repoFile.content,
      sha256: sha256(repoFile.content),
      relevance: file.relevance_reason,
      start_line: 1,
      end_line: lines,
      total_lines: lines,
      is_excerpt: false
    };
  });

  return {
    schema_version: SCHEMA_VERSION,
    notes: 'Generated by scout_discover_context deterministic-v1. The context was assembled locally and validated before return.',
    files,
    evidence_manifest: recommended.map((file, index) => ({
      id: `EV${String(index + 1).padStart(3, '0')}`,
      path: file.path,
      sha256: files[index].sha256,
      role: file.role,
      provenance: 'repository',
      relevance: file.relevance_reason,
      order: index + 1,
      start_line: files[index].start_line,
      end_line: files[index].end_line,
      total_lines: files[index].total_lines,
      is_excerpt: files[index].is_excerpt
    })),
    structured_review: buildStructuredReview({
      query: params.query,
      recommended,
      omitted: params.omitted,
      totalChars: params.totalChars,
      tokenBudgetChars: params.tokenBudgetChars
    })
  };
}

function repairPathsFromWarnings(warnings: string[], selectedPaths: Set<string>, repoFiles: Map<string, RepoFile>): string[] {
  const repairPaths = new Set<string>();
  for (const warning of warnings) {
    if (!/omitted local imports|package\.json|tsconfig\.json|Question references/u.test(warning)) continue;
    for (const referencedPath of referencedRepositoryPaths(warning)) {
      const resolved = resolveInputPathCandidates(referencedPath, repoFiles);
      for (const pathCandidate of resolved) {
        if (!selectedPaths.has(pathCandidate)) {
          repairPaths.add(pathCandidate);
        }
      }
    }
  }
  return Array.from(repairPaths).sort();
}

type ScoutWorkingState = {
  query: string;
  workspaceRoot: string;
  tokenBudgetChars: number;
  repoFiles: Map<string, RepoFile>;
  candidates: Map<string, Candidate>;
  baseOmissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
};

type ScoutFinalizedContext = {
  selection: ReturnType<typeof selectWithinBudget>;
  context: CouncilContext;
  validated: ReturnType<typeof validateCouncilContext>;
};

function collectScoutContextState(args: ScoutDiscoverContextArgs): ScoutWorkingState {
  const query = args.query;
  validateCouncilRequestText(query);
  const workspaceRoot = resolveScoutWorkspaceRoot(args.repo_root);

  const tokenBudgetChars = clampInteger(
    args.token_budget_chars,
    DEFAULT_TOKEN_BUDGET_CHARS,
    1,
    MAX_TOKEN_BUDGET_CHARS
  );
  const maxDepth = clampInteger(
    args.max_dependency_depth,
    DEFAULT_DEPENDENCY_DEPTH,
    0,
    MAX_DEPENDENCY_DEPTH
  );
  const includeTests = args.include_tests !== false;
  const includeReverseImporters = args.include_reverse_importers !== false;

  const repoFiles = scanRepository(workspaceRoot);
  const candidates = new Map<string, Candidate>();
  const baseOmissions = new Map<string, ScoutOmittedFile>();
  const warnings: string[] = [];

  for (const referencedPath of referencedRepositoryPaths(query)) {
    addCandidate({
      candidates,
      repoFiles,
      omissions: baseOmissions,
      warnings,
      rawPath: referencedPath,
      score: 1,
      role: 'core',
      source: 'query_path',
      reason: `Explicitly referenced by query: ${referencedPath}`,
      isCore: true
    });
  }

  for (const entrypoint of args.entrypoints || []) {
    addCandidate({
      candidates,
      repoFiles,
      omissions: baseOmissions,
      warnings,
      rawPath: entrypoint,
      score: 1,
      role: 'core',
      source: 'entrypoint',
      reason: `Provided entrypoint: ${entrypoint}`,
      isCore: true
    });
  }

  for (const changedFile of args.changed_files || []) {
    addCandidate({
      candidates,
      repoFiles,
      omissions: baseOmissions,
      warnings,
      rawPath: changedFile,
      score: 0.95,
      role: 'core',
      source: 'changed_file',
      reason: `Provided changed file: ${changedFile}`,
      isCore: true
    });
  }

  addLexicalCandidates({ query, repoFiles, candidates, omissions: baseOmissions, warnings });

  if (candidates.size === 0) {
    throw new Error('Scout could not identify any candidate files for the query.');
  }

  addForwardImports({ candidates, repoFiles, omissions: baseOmissions, warnings, maxDepth });
  if (includeReverseImporters) {
    addReverseImporters({ candidates, repoFiles, omissions: baseOmissions, warnings });
  }
  if (includeTests) {
    addNearbyTests({ candidates, repoFiles, omissions: baseOmissions, warnings });
  }
  addConfigFiles({ query, candidates, repoFiles, omissions: baseOmissions, warnings });

  return {
    query,
    workspaceRoot,
    tokenBudgetChars,
    repoFiles,
    candidates,
    baseOmissions,
    warnings
  };
}

function applyContextOverrides(context: CouncilContext, overrides?: {
  notes?: string;
  structuredReview?: CouncilContext['structured_review'];
}): CouncilContext {
  if (!overrides) return context;
  return {
    ...context,
    notes: overrides.notes ?? context.notes,
    structured_review: overrides.structuredReview ?? context.structured_review
  };
}

function buildContextForSelection(state: ScoutWorkingState, selection: ReturnType<typeof selectWithinBudget>, overrides?: {
  notes?: string;
  structuredReview?: CouncilContext['structured_review'];
}): CouncilContext {
  const context = buildCouncilContext({
    query: state.query,
    selected: selection.selected,
    omitted: Array.from(selection.omitted.values()),
    repoFiles: state.repoFiles,
    totalChars: selection.totalChars,
    tokenBudgetChars: state.tokenBudgetChars
  });
  return applyContextOverrides(context, overrides);
}

function finalizeScoutContext(state: ScoutWorkingState, overrides?: {
  notes?: string;
  structuredReview?: CouncilContext['structured_review'];
}): ScoutFinalizedContext {
  let selection = selectWithinBudget({
    candidates: state.candidates,
    repoFiles: state.repoFiles,
    tokenBudgetChars: state.tokenBudgetChars,
    baseOmissions: state.baseOmissions
  });
  let context = buildContextForSelection(state, selection, overrides);
  let validated = validateCouncilContext(context, state.query, { workspaceRoot: state.workspaceRoot });

  const repairPaths = repairPathsFromWarnings(
    validated.warnings,
    new Set(selection.selected.map(candidate => candidate.path)),
    state.repoFiles
  );

  if (repairPaths.length > 0) {
    for (const repairPath of repairPaths) {
      addCandidate({
        candidates: state.candidates,
        repoFiles: state.repoFiles,
        omissions: state.baseOmissions,
        warnings: state.warnings,
        rawPath: repairPath,
        score: 0.5,
        role: classifyRole(repairPath, 'contract'),
        source: 'validation_repair',
        reason: `Added from validateCouncilContext warning: ${repairPath}`,
        isCore: false
      });
    }

    selection = selectWithinBudget({
      candidates: state.candidates,
      repoFiles: state.repoFiles,
      tokenBudgetChars: state.tokenBudgetChars,
      baseOmissions: state.baseOmissions
    });
    context = buildContextForSelection(state, selection, overrides);
    validated = validateCouncilContext(context, state.query, { workspaceRoot: state.workspaceRoot });
  }

  return { selection, context, validated };
}

function buildScoutResult(params: {
  state: ScoutWorkingState;
  finalized: ScoutFinalizedContext;
  strategy: ScoutStrategy;
  llm?: ScoutLlmStats;
  warnings?: string[];
}): ScoutDiscoverContextResult {
  const { state, finalized } = params;
  return {
    context: finalized.context,
    context_digest: finalized.validated.context_digest,
    workspace_root: state.workspaceRoot,
    recommended_files: selectedForOutput([...finalized.selection.selected], state.repoFiles),
    omitted_files: Array.from(finalized.selection.omitted.values()).sort((a, b) => a.path.localeCompare(b.path)),
    warnings: dedupeWarnings([...state.warnings, ...finalized.validated.warnings, ...(params.warnings || [])]),
    stats: {
      strategy: params.strategy,
      candidate_count: state.candidates.size,
      selected_count: finalized.selection.selected.length,
      total_chars: finalized.selection.totalChars,
      token_budget_chars: state.tokenBudgetChars,
      ...(params.llm ? { llm: params.llm } : {})
    }
  };
}

function llmTimeoutMs(args: ScoutDiscoverContextArgs): number {
  return clampInteger(
    args.llm_timeout_ms,
    DEFAULT_LLM_TIMEOUT_MS,
    MIN_LLM_TIMEOUT_MS,
    MAX_LLM_TIMEOUT_MS
  );
}

function cloneWorkingState(state: ScoutWorkingState): ScoutWorkingState {
  const candidates = new Map<string, Candidate>();
  for (const [candidatePath, candidate] of state.candidates.entries()) {
    candidates.set(candidatePath, {
      ...candidate,
      reasons: [...candidate.reasons]
    });
  }

  return {
    query: state.query,
    workspaceRoot: state.workspaceRoot,
    tokenBudgetChars: state.tokenBudgetChars,
    repoFiles: state.repoFiles,
    candidates,
    baseOmissions: new Map(state.baseOmissions),
    warnings: [...state.warnings]
  };
}

function timeoutController(ms: number): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(createCancelledError(`ChatGPT Scout enhancement timed out after ${ms}ms.`));
  }, ms);
  timeout.unref?.();
  return {
    controller,
    clear: () => clearTimeout(timeout)
  };
}

function runnerTimeouts(timeoutMs: number): Partial<RunnerTimeoutBudgets> {
  return {
    navigationMs: Math.min(15_000, timeoutMs),
    inputReadyMs: Math.min(10_000, timeoutMs),
    submissionMs: Math.min(20_000, timeoutMs),
    firstTokenMs: Math.min(30_000, timeoutMs),
    outputStabilizationMs: Math.min(60_000, timeoutMs),
    providerExecutionMs: timeoutMs
  };
}

async function defaultScoutLlmRunner(params: ScoutLlmRunnerParams): Promise<string> {
  const runner = new OrchestrationRunner(params.runId, params.taskId, 'chatgpt', { manageRunStatus: false });
  try {
    return await runner.executeTask(params.prompt, undefined, {
      signal: params.signal,
      timeouts: runnerTimeouts(params.timeoutMs),
      attemptNo: 1
    });
  } finally {
    await runner.close().catch(() => {});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
}

function unknownErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseJsonObjectFromLlmResponse(response: string): Record<string, unknown> {
  const candidates: string[] = [];
  for (const match of response.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) {
    candidates.push(match[1].trim());
  }

  const firstBrace = response.indexOf('{');
  const lastBrace = response.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(response.slice(firstBrace, lastBrace + 1));
  }
  candidates.push(response.trim());

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next plausible JSON span.
    }
  }

  throw new Error('ChatGPT response did not contain a valid JSON object.');
}

type ParsedLlmRankedFile = {
  path: string;
  score?: number;
  reason?: string;
};

function parseLlmRanking(response: string): ParsedLlmRankedFile[] {
  const parsed = parseJsonObjectFromLlmResponse(response);
  const rankedFiles = parsed.ranked_files;
  if (!Array.isArray(rankedFiles) || rankedFiles.length === 0) {
    throw new Error('ChatGPT ranking JSON must include a non-empty ranked_files array.');
  }

  return rankedFiles.map((item, index) => {
    if (!isRecord(item) || typeof item.path !== 'string' || item.path.trim() === '') {
      throw new Error(`ChatGPT ranked_files[${index}] must include a non-empty path.`);
    }
    const rawScore = item.relevance_score ?? item.score;
    const score = typeof rawScore === 'number' ? rawScore : undefined;
    const rawReason = item.relevance_reason ?? item.reason;
    const reason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : undefined;
    return {
      path: item.path,
      score,
      reason
    };
  });
}

function clampedScore(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value as number));
}

function pinnedCandidateMinimum(candidate: Candidate): number | undefined {
  if (candidate.source === 'query_path' || candidate.source === 'entrypoint') return 1;
  if (candidate.source === 'changed_file') return 0.95;
  return undefined;
}

function applyLlmRanking(params: {
  state: ScoutWorkingState;
  ranking: ParsedLlmRankedFile[];
  warnings: string[];
}): number {
  const seen = new Set<string>();
  let applied = 0;

  params.ranking.forEach((rankedFile, index) => {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeContextPath(rankedFile.path);
      assertSafeContextPath(normalizedPath);
    } catch (err) {
      params.warnings.push(`ChatGPT ranked path ignored as unsafe: ${rankedFile.path} (${unknownErrorMessage(err)})`);
      return;
    }

    const candidate = params.state.candidates.get(normalizedPath);
    if (!candidate) {
      params.warnings.push(`ChatGPT ranked path ignored because it was not a deterministic candidate: ${normalizedPath}`);
      return;
    }
    if (seen.has(normalizedPath)) return;
    seen.add(normalizedPath);

    const fallbackScore = Math.max(0.1, 1 - index * 0.01);
    const minimum = pinnedCandidateMinimum(candidate) ?? 0;
    candidate.score = Math.max(clampedScore(rankedFile.score, fallbackScore), minimum);
    const reason = rankedFile.reason
      ? `ChatGPT rerank: ${truncateText(rankedFile.reason, 500)}`
      : `ChatGPT rerank position ${index + 1}`;
    if (!candidate.reasons.includes(reason)) {
      candidate.reasons.push(reason);
    }
    applied++;
  });

  if (applied === 0) {
    throw new Error('ChatGPT ranking did not contain any usable deterministic candidate paths.');
  }

  return applied;
}

function rankingPrompt(state: ScoutWorkingState): string {
  const candidates = Array.from(state.candidates.values()).sort(outputSort).map(candidate => ({
    path: candidate.path,
    role: candidate.role,
    relevance_score: candidate.score,
    is_core: candidate.isCore,
    source: candidate.source,
    size_chars: state.repoFiles.get(candidate.path)?.sizeChars ?? 0,
    reasons: candidate.reasons
  }));

  return [
    'You are improving repository context discovery for a code review tool.',
    'Rank only the provided deterministic candidate files for relevance to the query.',
    'Do not invent paths. Do not request file contents. Preserve explicitly provided query paths, entrypoints, and changed files as highly relevant.',
    'Return only JSON with this shape: {"ranked_files":[{"path":"relative/path.ts","relevance_score":0.0,"relevance_reason":"short reason"}]}.',
    JSON.stringify({ query: state.query, candidates }, null, 2)
  ].join('\n\n');
}

function briefingPrompt(state: ScoutWorkingState, finalized: ScoutFinalizedContext): string {
  const recommended = selectedForOutput([...finalized.selection.selected], state.repoFiles);
  let remainingExcerptChars = LLM_BRIEFING_MAX_TOTAL_EXCERPT_CHARS;
  const selectedFiles = recommended.map(file => {
    const repoFile = state.repoFiles.get(file.path)!;
    const excerptChars = Math.min(
      repoFile.content.length,
      LLM_BRIEFING_MAX_FILE_EXCERPT_CHARS,
      Math.max(0, remainingExcerptChars)
    );
    remainingExcerptChars -= excerptChars;
    return {
      path: file.path,
      role: file.role,
      relevance_reason: file.relevance_reason,
      size_chars: file.size_chars,
      content_excerpt: repoFile.content.slice(0, excerptChars),
      excerpt_truncated: excerptChars < repoFile.content.length
    };
  });

  const omittedFiles = Array.from(finalized.selection.omitted.values())
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, LLM_OMITTED_FILE_LIMIT);

  return [
    'You are drafting structured context notes for a council code review.',
    'Use only the selected_files and omitted_files listed below. Do not invent paths or facts.',
    'The selected files are authoritative repository evidence; excerpts are bounded and may be incomplete.',
    'Return only JSON with a top-level structured_review object containing exactly these string fields:',
    STRUCTURED_REVIEW_FIELDS.join(', '),
    JSON.stringify({
      query: state.query,
      selected_files: selectedFiles,
      omitted_files: omittedFiles
    }, null, 2)
  ].join('\n\n');
}

function parseLlmStructuredReview(response: string): NonNullable<CouncilContext['structured_review']> {
  const parsed = parseJsonObjectFromLlmResponse(response);
  const reviewCandidate = isRecord(parsed.structured_review) ? parsed.structured_review : parsed;
  const allowed = new Set<string>(STRUCTURED_REVIEW_FIELDS);
  const unknownFields = Object.keys(reviewCandidate).filter(field => !allowed.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`ChatGPT structured_review contained unknown field(s): ${unknownFields.join(', ')}.`);
  }

  const review: Partial<NonNullable<CouncilContext['structured_review']>> = {};
  for (const field of STRUCTURED_REVIEW_FIELDS) {
    const value = reviewCandidate[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`ChatGPT structured_review field ${field} must be a non-empty string.`);
    }
    if (value.length > MAX_CONTEXT_FILE_CHARS) {
      throw new Error(`ChatGPT structured_review field ${field} exceeds ${MAX_CONTEXT_FILE_CHARS} characters.`);
    }
    review[field] = value;
  }

  return review as NonNullable<CouncilContext['structured_review']>;
}

function assertStructuredReviewPathConsistency(params: {
  review: NonNullable<CouncilContext['structured_review']>;
  selectedPaths: Set<string>;
  omittedPaths: Set<string>;
}): void {
  for (const field of STRUCTURED_REVIEW_FIELDS) {
    for (const referencedPath of referencedRepositoryPaths(params.review[field])) {
      const normalizedPath = normalizeContextPath(referencedPath);
      assertSafeContextPath(normalizedPath);
      if (field === 'omitted_material') {
        if (!params.omittedPaths.has(normalizedPath)) {
          throw new Error(`ChatGPT omitted_material referenced a file that is not omitted: ${normalizedPath}`);
        }
      } else if (!params.selectedPaths.has(normalizedPath)) {
        throw new Error(`ChatGPT structured_review field ${field} referenced a file that is not selected: ${normalizedPath}`);
      }
    }
  }
}

function buildLlmStats(params: {
  startedAt: number;
  now: () => number;
  runId: string;
  taskIds: string[];
  rankingApplied: boolean;
  briefingApplied: boolean;
  fallbackReason?: string;
}): ScoutLlmStats {
  return {
    provider: 'chatgpt',
    attempted: true,
    ranking_applied: params.rankingApplied,
    briefing_applied: params.briefingApplied,
    run_id: params.runId,
    task_ids: params.taskIds,
    duration_ms: Math.max(0, params.now() - params.startedAt),
    ...(params.fallbackReason ? { fallback_reason: truncateText(params.fallbackReason, 500) } : {})
  };
}

const LLM_RANKING_NOTES = 'Generated by scout_discover_context with ChatGPT candidate reranking and deterministic structured_review. Repository files were assembled locally and validated before return.';
const LLM_FULL_BRIEFING_NOTES = 'Generated by scout_discover_context with ChatGPT candidate reranking and ChatGPT-generated structured_review from bounded repository excerpts. Repository files were assembled locally and validated before return.';

export function discoverScoutContext(args: ScoutDiscoverContextArgs): ScoutDiscoverContextResult {
  const state = collectScoutContextState(args);
  const finalized = finalizeScoutContext(state);
  return buildScoutResult({
    state,
    finalized,
    strategy: 'deterministic-v1'
  });
}

export async function discoverScoutContextWithLlm(
  args: ScoutDiscoverContextArgs,
  deps: ScoutLlmDeps = {}
): Promise<ScoutDiscoverContextResult> {
  const baseState = collectScoutContextState(args);
  const baseFinalized = finalizeScoutContext(baseState);

  if (args.enhance_with_llm !== true) {
    return buildScoutResult({
      state: baseState,
      finalized: baseFinalized,
      strategy: 'deterministic-v1'
    });
  }

  const now = deps.now ?? Date.now;
  const startedAt = now();
  const timeoutMs = llmTimeoutMs(args);
  const runId = `scout_llm_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const rankingTaskId = `${runId}_ranking`;
  const briefingTaskId = `${runId}_briefing`;
  const taskIds = [rankingTaskId];
  const runLlm = deps.runLlm ?? defaultScoutLlmRunner;
  const timeout = timeoutController(timeoutMs);
  const llmWarnings: string[] = [];

  try {
    const llmState = cloneWorkingState(baseState);
    const rankingResponse = await runLlm({
      phase: 'ranking',
      prompt: rankingPrompt(llmState),
      runId,
      taskId: rankingTaskId,
      signal: timeout.controller.signal,
      timeoutMs
    });
    const ranking = parseLlmRanking(rankingResponse);
    applyLlmRanking({ state: llmState, ranking, warnings: llmWarnings });

    const rankedFinalized = finalizeScoutContext(llmState, { notes: LLM_RANKING_NOTES });

    taskIds.push(briefingTaskId);
    let briefingResponse: string;
    try {
      briefingResponse = await runLlm({
        phase: 'briefing',
        prompt: briefingPrompt(llmState, rankedFinalized),
        runId,
        taskId: briefingTaskId,
        signal: timeout.controller.signal,
        timeoutMs
      });
    } catch (err) {
      throw err;
    }

    try {
      const structuredReview = parseLlmStructuredReview(briefingResponse);
      assertStructuredReviewPathConsistency({
        review: structuredReview,
        selectedPaths: new Set(rankedFinalized.selection.selected.map(candidate => candidate.path)),
        omittedPaths: new Set(Array.from(rankedFinalized.selection.omitted.keys()))
      });

      const fullContext = applyContextOverrides(rankedFinalized.context, {
        notes: LLM_FULL_BRIEFING_NOTES,
        structuredReview
      });
      const fullValidated = validateCouncilContext(fullContext, llmState.query, { workspaceRoot: llmState.workspaceRoot });
      return buildScoutResult({
        state: llmState,
        finalized: {
          selection: rankedFinalized.selection,
          context: fullContext,
          validated: fullValidated
        },
        strategy: 'chatgpt-full-briefing-v1',
        llm: buildLlmStats({
          startedAt,
          now,
          runId,
          taskIds,
          rankingApplied: true,
          briefingApplied: true
        }),
        warnings: llmWarnings
      });
    } catch (err) {
      const reason = `ChatGPT briefing rejected: ${unknownErrorMessage(err)}`;
      return buildScoutResult({
        state: llmState,
        finalized: rankedFinalized,
        strategy: 'chatgpt-partial-v1',
        llm: buildLlmStats({
          startedAt,
          now,
          runId,
          taskIds,
          rankingApplied: true,
          briefingApplied: false,
          fallbackReason: reason
        }),
        warnings: [...llmWarnings, reason]
      });
    }
  } catch (err) {
    const reason = `ChatGPT Scout enhancement fell back to deterministic context: ${unknownErrorMessage(err)}`;
    return buildScoutResult({
      state: baseState,
      finalized: baseFinalized,
      strategy: 'chatgpt-fallback-v1',
      llm: buildLlmStats({
        startedAt,
        now,
        runId,
        taskIds,
        rankingApplied: false,
        briefingApplied: false,
        fallbackReason: reason
      }),
      warnings: [reason]
    });
  } finally {
    timeout.clear();
  }
}
