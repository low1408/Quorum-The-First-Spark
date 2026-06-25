import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config/index.ts';

export type CouncilContextFile = {
  path: string;
  content: string;
  sha256?: string;
  modified_at?: string;
  relevance?: string;
  start_line?: number;
  end_line?: number;
  total_lines?: number;
  is_excerpt?: boolean;
};

export type CouncilContext = {
  schema_version?: string;
  files: CouncilContextFile[];
  notes?: string;
  evidence_manifest?: CouncilEvidenceManifestItem[];
  structured_review?: CouncilStructuredReviewContext;
};

export type ValidatedCouncilContext = {
  schema_version?: string;
  files: Array<CouncilContextFile & {
    normalizedPath: string;
    computedSha256: string;
    evidenceId: string;
    role: CouncilEvidenceRole;
    provenance: CouncilEvidenceProvenance;
    order?: number;
    startLine: number;
    endLine: number;
    totalLines: number;
    isExcerpt: boolean;
  }>;
  notes?: string;
  evidence_manifest?: CouncilEvidenceManifestItem[];
  structured_review?: CouncilStructuredReviewContext;
  warnings: string[];
  context_digest: string;
};

export type CouncilEvidenceRole = 'core' | 'contract' | 'config' | 'test' | 'runtime' | 'supporting';
export type CouncilEvidenceProvenance = 'repository' | 'generated' | 'test-runtime' | 'caller-supplied';

export type CouncilEvidenceManifestItem = {
  id: string;
  path: string;
  sha256?: string;
  role: CouncilEvidenceRole;
  provenance: CouncilEvidenceProvenance;
  relevance: string;
  order?: number;
  start_line?: number;
  end_line?: number;
  total_lines?: number;
  is_excerpt?: boolean;
};

export type CouncilStructuredReviewContext = {
  review_objective: string;
  architecture: string;
  execution_flow: string;
  assumptions_and_invariants: string;
  core_evidence: string;
  supporting_contracts: string;
  privacy_and_persistence: string;
  tests_and_runtime_evidence: string;
  omitted_material: string;
};

export type CouncilContextValidationOptions = {
  workspaceRoot?: string;
};

const MAX_FILE_CHARS = 250_000;
const MAX_TOTAL_CHARS = 750_000;
const STRUCTURED_REVIEW_FIELDS: Array<keyof CouncilStructuredReviewContext> = [
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
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\b(?:sk|pk|rk|xox[baprs])-[-A-Za-z0-9_]{20,}\b/,
  /\b(?:api[_-]?key|secret|token|password|passwd|credential)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
  /\bAWS_SECRET_ACCESS_KEY\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{30,}/i
];
const CONTEXT_KEYS = new Set(['schema_version', 'files', 'notes', 'evidence_manifest', 'structured_review']);
const CONTEXT_FILE_KEYS = new Set([
  'path',
  'content',
  'sha256',
  'modified_at',
  'relevance',
  'start_line',
  'end_line',
  'total_lines',
  'is_excerpt'
]);
const EVIDENCE_MANIFEST_KEYS = new Set([
  'id',
  'path',
  'sha256',
  'role',
  'provenance',
  'relevance',
  'order',
  'start_line',
  'end_line',
  'total_lines',
  'is_excerpt'
]);
const EVIDENCE_ROLES = new Set<CouncilEvidenceRole>(['core', 'contract', 'config', 'test', 'runtime', 'supporting']);
const EVIDENCE_PROVENANCE = new Set<CouncilEvidenceProvenance>(['repository', 'generated', 'test-runtime', 'caller-supplied']);
const TEXT_FIELD_MAX_CHARS = 50_000;

function validationWorkspaceRoot(options?: CouncilContextValidationOptions): string {
  return path.resolve(options?.workspaceRoot || config.rootDir);
}

export function normalizeContextPath(rawPath: string, workspaceRoot = config.rootDir): string {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('Context file path must be a non-empty string.');
  }
  if (rawPath.includes('\0')) {
    throw new Error(`Context file path contains a NUL byte: ${rawPath}`);
  }

  if (path.isAbsolute(rawPath)) {
    const absolutePath = path.resolve(rawPath);
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    if (!absolutePath.startsWith(resolvedWorkspaceRoot + path.sep) && absolutePath !== resolvedWorkspaceRoot) {
      throw new Error(`Context file path escapes the workspace: ${rawPath}`);
    }
    return path.relative(resolvedWorkspaceRoot, absolutePath).replace(/\\/g, '/');
  }

  const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error(`Context file path escapes the workspace: ${rawPath}`);
  }
  return normalized;
}

function looksBinary(content: string): boolean {
  if (content.includes('\0')) return true;
  if (content.length === 0) return false;

  const sample = content.slice(0, 4096);
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    const allowedControl = code === 9 || code === 10 || code === 13;
    if (code < 32 && !allowedControl) suspicious++;
  }
  return suspicious / sample.length > 0.02;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function hasSecretMaterial(content: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(content));
}

function assertNoUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}.`);
  }
}

function validateTextField(value: unknown, label: string, options: {
  required?: boolean;
  maxChars?: number;
} = {}): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`${label} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  if (options.required && value.trim() === '') {
    throw new Error(`${label} must be non-empty.`);
  }
  const maxChars = options.maxChars ?? TEXT_FIELD_MAX_CHARS;
  if (value.length > maxChars) {
    throw new Error(`${label} exceeds ${maxChars} characters.`);
  }
  if (looksBinary(value)) {
    throw new Error(`${label} appears to be binary.`);
  }
  if (hasSecretMaterial(value)) {
    throw new Error(`${label} appears to contain secret material.`);
  }
  return value;
}

function validateOptionalInteger(value: unknown, label: string, options: {
  min?: number;
} = {}): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  const numberValue = value as number;
  if (options.min !== undefined && numberValue < options.min) {
    throw new Error(`${label} must be at least ${options.min}.`);
  }
  return numberValue;
}

function validateOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

export function assertSafeContextPath(normalizedPath: string): void {
  const lower = normalizedPath.toLowerCase();
  const basename = path.posix.basename(lower);
  const safeEnvExamples = new Set(['.env.example', 'env.example']);
  const isEnvFile = basename === '.env' || basename.startsWith('.env.');
  const sensitive =
    (isEnvFile && !safeEnvExamples.has(basename)) ||
    lower === '.git' ||
    lower.startsWith('.git/') ||
    lower.startsWith('sessions/') ||
    lower.startsWith('quorum/') ||
    lower.endsWith('.log') ||
    lower.endsWith('.db') ||
    lower.endsWith('.sqlite') ||
    lower.endsWith('.sqlite3') ||
    lower.includes('private_key') ||
    lower.endsWith('.pem') ||
    lower.endsWith('.key');

  if (sensitive) {
    throw new Error(`Context file path is sensitive and cannot be sent to the council: ${normalizedPath}`);
  }
}

function validateStructuredReviewContext(context: CouncilContext, warnings: string[]): CouncilStructuredReviewContext | undefined {
  const structured = context.structured_review;
  if (!structured) {
    if (config.requireStructuredReviewContext) {
      throw new Error('Structured review context is required when REQUIRE_STRUCTURED_REVIEW_CONTEXT=true.');
    }
    return undefined;
  }

  assertNoUnknownKeys(structured as unknown as Record<string, unknown>, new Set(STRUCTURED_REVIEW_FIELDS), 'Structured review context');

  const missingFields = STRUCTURED_REVIEW_FIELDS.filter(field => {
    const value = structured[field];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missingFields.length > 0) {
    throw new Error(`Structured review context is missing required field(s): ${missingFields.join(', ')}.`);
  }

  for (const field of STRUCTURED_REVIEW_FIELDS) {
    validateTextField(structured[field], `Structured review context field ${field}`, {
      required: true,
      maxChars: MAX_FILE_CHARS
    });
  }

  if (!config.requireStructuredReviewContext) {
    warnings.push('Structured review context was provided but is not currently required by server configuration.');
  }

  return structured;
}

export function referencedRepositoryPaths(text: string): string[] {
  return text.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml)/g) || [];
}

function validateEvidenceManifest(context: CouncilContext, workspaceRoot: string): Map<string, CouncilEvidenceManifestItem> {
  const manifest = context.evidence_manifest;
  if (manifest === undefined) return new Map();
  if (!Array.isArray(manifest)) {
    throw new Error('Evidence manifest must be an array.');
  }

  const byPath = new Map<string, CouncilEvidenceManifestItem>();
  const seenIds = new Set<string>();
  for (const item of manifest) {
    if (!item || typeof item !== 'object') {
      throw new Error('Evidence manifest item must be an object.');
    }
    assertNoUnknownKeys(item as unknown as Record<string, unknown>, EVIDENCE_MANIFEST_KEYS, 'Evidence manifest item');
    const id = validateTextField(item.id, 'Evidence manifest item id', { required: true, maxChars: 120 })!;
    if (!/^[A-Za-z0-9_.:-]+$/.test(id)) {
      throw new Error(`Evidence manifest item id contains unsupported characters: ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate evidence manifest id: ${id}`);
    }
    seenIds.add(id);

    const normalizedPath = normalizeContextPath(validateTextField(item.path, `Evidence manifest item ${id} path`, { required: true, maxChars: 2_000 })!, workspaceRoot);
    assertSafeContextPath(normalizedPath);
    if (!EVIDENCE_ROLES.has(item.role)) {
      throw new Error(`Evidence manifest item ${id} has invalid role: ${String(item.role)}`);
    }
    if (!EVIDENCE_PROVENANCE.has(item.provenance)) {
      throw new Error(`Evidence manifest item ${id} has invalid provenance: ${String(item.provenance)}`);
    }
    validateTextField(item.relevance, `Evidence manifest item ${id} relevance`, { required: true, maxChars: 2_000 });
    validateTextField(item.sha256, `Evidence manifest item ${id} sha256`, { maxChars: 128 });
    validateOptionalInteger(item.order, `Evidence manifest item ${id} order`);
    validateOptionalInteger(item.start_line, `Evidence manifest item ${id} start_line`, { min: 1 });
    validateOptionalInteger(item.end_line, `Evidence manifest item ${id} end_line`, { min: 1 });
    validateOptionalInteger(item.total_lines, `Evidence manifest item ${id} total_lines`, { min: 1 });
    validateOptionalBoolean(item.is_excerpt, `Evidence manifest item ${id} is_excerpt`);
    if (item.start_line !== undefined && item.end_line !== undefined && item.end_line < item.start_line) {
      throw new Error(`Evidence manifest item ${id} has end_line before start_line.`);
    }
    if (byPath.has(normalizedPath)) {
      throw new Error(`Duplicate evidence manifest path: ${normalizedPath}`);
    }
    byPath.set(normalizedPath, { ...item, path: normalizedPath });
  }

  return byPath;
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/u).length;
}

function contextDigest(params: {
  question: string;
  schemaVersion?: string;
  files: ValidatedCouncilContext['files'];
  structuredReview?: CouncilStructuredReviewContext;
  notes?: string;
}): string {
  const payload = {
    question: params.question,
    schema_version: params.schemaVersion || null,
    notes: params.notes || null,
    structured_review: params.structuredReview || null,
    files: params.files.map(file => ({
      id: file.evidenceId,
      path: file.normalizedPath,
      sha256: file.computedSha256,
      role: file.role,
      provenance: file.provenance,
      relevance: file.relevance || null,
      order: file.order ?? null,
      start_line: file.startLine,
      end_line: file.endLine,
      total_lines: file.totalLines,
      is_excerpt: file.isExcerpt
    }))
  };
  return sha256(JSON.stringify(payload));
}

export function candidateImportPaths(content: string): string[] {
  const candidates = new Set<string>();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1];
      if (importPath.startsWith('./') || importPath.startsWith('../')) {
        candidates.add(importPath);
      }
    }
  }

  return Array.from(candidates);
}

export function resolveLikelyImportPath(fromFile: string, importPath: string): string[] {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), importPath));
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
  return extensions.flatMap(ext => [
    `${base}${ext}`,
    `${base}/index${ext || '.ts'}`
  ]);
}

function addCompletenessWarnings(files: Array<CouncilContextFile & { normalizedPath: string }>, question: string, warnings: string[], workspaceRoot: string): void {
  const included = new Set(files.map(file => file.normalizedPath));
  const localImports = new Set<string>();

  for (const file of files) {
    for (const importPath of candidateImportPaths(file.content)) {
      for (const candidate of resolveLikelyImportPath(file.normalizedPath, importPath)) {
        const absolute = path.resolve(workspaceRoot, candidate);
        if (!included.has(candidate) && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
          localImports.add(candidate);
          break;
        }
      }
    }
  }

  if (localImports.size > 0) {
    warnings.push(`Context may be incomplete: omitted local imports ${Array.from(localImports).slice(0, 8).join(', ')}.`);
  }

  const questionAndNotes = question.toLowerCase();
  const codeChangeIntent = /\b(implement|fix|debug|refactor|test|typecheck|compile|build|mcp|server)\b/.test(questionAndNotes);
  const hasTsOrJs = files.some(file => /\.(?:ts|tsx|js|jsx)$/.test(file.normalizedPath));
  if (codeChangeIntent && hasTsOrJs) {
    for (const configFile of ['package.json', 'tsconfig.json']) {
      if (!included.has(configFile) && fs.existsSync(path.resolve(workspaceRoot, configFile))) {
        warnings.push(`Context may be incomplete: ${configFile} exists but was not included.`);
      }
    }
  }

  const referencedPaths = referencedRepositoryPaths(question);
  for (const referencedPath of referencedPaths) {
    const normalized = normalizeContextPath(referencedPath, workspaceRoot);
    if (!included.has(normalized) && fs.existsSync(path.resolve(workspaceRoot, normalized))) {
      warnings.push(`Question references ${normalized}, but that file was not included in context.`);
    }
  }
}

function addStructuredContextWarnings(context: CouncilStructuredReviewContext | undefined, files: Array<CouncilContextFile & { normalizedPath: string }>, warnings: string[], workspaceRoot: string): void {
  if (!context) return;

  const included = new Set(files.map(file => file.normalizedPath));
  for (const field of ['core_evidence', 'supporting_contracts'] as const) {
    for (const referencedPath of referencedRepositoryPaths(context[field])) {
      const normalized = normalizeContextPath(referencedPath, workspaceRoot);
      if (!included.has(normalized) && fs.existsSync(path.resolve(workspaceRoot, normalized))) {
        warnings.push(`Structured review field ${field} references ${normalized}, but that file was not included in context.`);
      }
    }
  }

  for (const referencedPath of referencedRepositoryPaths(context.omitted_material)) {
    const normalized = normalizeContextPath(referencedPath, workspaceRoot);
    if (included.has(normalized)) {
      warnings.push(`Structured review omitted_material says ${normalized} is omitted, but it was included in context.`);
    }
  }
}

export function validateCouncilRequestText(question: string, constraints?: string): void {
  validateTextField(question, 'Question', { required: true });
  validateTextField(constraints, 'Constraints');
}

export function validateCouncilContext(context: CouncilContext, question = '', options?: CouncilContextValidationOptions): ValidatedCouncilContext {
  const workspaceRoot = validationWorkspaceRoot(options);
  if (!context || typeof context !== 'object' || !Array.isArray(context.files)) {
    throw new Error('Context must include a files array.');
  }
  assertNoUnknownKeys(context as unknown as Record<string, unknown>, CONTEXT_KEYS, 'Context');
  if (context.files.length === 0) {
    throw new Error('Context must include at least one file.');
  }
  validateTextField(context.schema_version, 'Context schema_version', { maxChars: 40 });
  validateTextField(context.notes, 'Context notes');

  const seen = new Set<string>();
  const contentHashes = new Map<string, string>();
  const warnings: string[] = [];
  const structuredReview = validateStructuredReviewContext(context, warnings);
  const manifestByPath = validateEvidenceManifest(context, workspaceRoot);
  const unresolvedManifestPaths = new Set(manifestByPath.keys());
  const files: ValidatedCouncilContext['files'] = [];
  let totalChars = structuredReview
    ? STRUCTURED_REVIEW_FIELDS.reduce((sum, field) => sum + structuredReview[field].length, 0)
    : 0;

  if (totalChars > MAX_TOTAL_CHARS) {
    throw new Error(`Context exceeds ${MAX_TOTAL_CHARS} total characters.`);
  }

  for (const file of context.files) {
    if (!file || typeof file !== 'object') {
      throw new Error('Context file must be an object.');
    }
    assertNoUnknownKeys(file as unknown as Record<string, unknown>, CONTEXT_FILE_KEYS, 'Context file');
    const normalizedPath = normalizeContextPath(file.path, workspaceRoot);
    assertSafeContextPath(normalizedPath);
    if (seen.has(normalizedPath)) {
      throw new Error(`Duplicate context file: ${normalizedPath}`);
    }
    seen.add(normalizedPath);
    validateTextField(file.relevance, `Context file relevance for ${normalizedPath}`, { maxChars: 2_000 });
    const manifestItem = manifestByPath.get(normalizedPath);
    unresolvedManifestPaths.delete(normalizedPath);
    const startLine = validateOptionalInteger(file.start_line, `Context file start_line for ${normalizedPath}`, { min: 1 }) ?? manifestItem?.start_line ?? 1;
    const declaredEndLine = validateOptionalInteger(file.end_line, `Context file end_line for ${normalizedPath}`, { min: 1 }) ?? manifestItem?.end_line;
    const declaredTotalLines = validateOptionalInteger(file.total_lines, `Context file total_lines for ${normalizedPath}`, { min: 1 }) ?? manifestItem?.total_lines;
    const declaredExcerpt = validateOptionalBoolean(file.is_excerpt, `Context file is_excerpt for ${normalizedPath}`);

    if (typeof file.content !== 'string' || file.content.trim() === '') {
      throw new Error(`Context file is empty: ${normalizedPath}`);
    }
    if (file.content.length > MAX_FILE_CHARS) {
      throw new Error(`Context file exceeds ${MAX_FILE_CHARS} characters: ${normalizedPath}`);
    }
    if (looksBinary(file.content)) {
      throw new Error(`Context file appears to be binary: ${normalizedPath}`);
    }
    if (hasSecretMaterial(file.content)) {
      throw new Error(`Context file appears to contain secret material: ${normalizedPath}`);
    }

    totalChars += file.content.length;
    if (totalChars > MAX_TOTAL_CHARS) {
      throw new Error(`Context exceeds ${MAX_TOTAL_CHARS} total characters.`);
    }

    const computedSha256 = sha256(file.content);
    const previousPathForHash = contentHashes.get(computedSha256);
    if (previousPathForHash) {
      warnings.push(`Context includes duplicate content hash for ${previousPathForHash} and ${normalizedPath}.`);
    } else {
      contentHashes.set(computedSha256, normalizedPath);
    }
    if (file.sha256 && file.sha256.toLowerCase() !== computedSha256) {
      throw new Error(`Context file hash is stale or incorrect: ${normalizedPath}`);
    }

    const absolutePath = path.resolve(workspaceRoot, normalizedPath);
    if (!absolutePath.startsWith(workspaceRoot + path.sep) && absolutePath !== workspaceRoot) {
      throw new Error(`Context file path escapes the workspace: ${normalizedPath}`);
    }
    if (fs.existsSync(absolutePath)) {
      const diskHash = sha256(fs.readFileSync(absolutePath, 'utf8'));
      if (file.sha256 && diskHash !== file.sha256.toLowerCase()) {
        throw new Error(`Context file is stale relative to disk: ${normalizedPath}`);
      }
      if (file.modified_at) {
        const providedMtime = Date.parse(file.modified_at);
        const diskMtime = fs.statSync(absolutePath).mtimeMs;
        if (Number.isFinite(providedMtime) && diskMtime > providedMtime + 1000) {
          warnings.push(`Context file may be stale relative to disk mtime: ${normalizedPath}.`);
        }
      }
    } else {
      warnings.push(`Context file does not exist on disk and could not be freshness-checked: ${normalizedPath}.`);
    }

    if (manifestItem?.sha256 && manifestItem.sha256.toLowerCase() !== computedSha256) {
      throw new Error(`Evidence manifest hash is stale or incorrect: ${manifestItem.id}`);
    }

    const contentLineCount = lineCount(file.content);
    const endLine = declaredEndLine ?? (startLine + contentLineCount - 1);
    const totalLines = declaredTotalLines ?? Math.max(endLine, contentLineCount);
    const isExcerpt = declaredExcerpt ?? manifestItem?.is_excerpt ?? (startLine !== 1 || endLine < totalLines);
    if (endLine < startLine) {
      throw new Error(`Context file end_line is before start_line: ${normalizedPath}`);
    }
    if (totalLines < endLine) {
      throw new Error(`Context file total_lines is before end_line: ${normalizedPath}`);
    }
    if (manifestItem?.start_line !== undefined && manifestItem.start_line !== startLine) {
      throw new Error(`Evidence manifest start_line does not match file metadata: ${manifestItem.id}`);
    }
    if (manifestItem?.end_line !== undefined && manifestItem.end_line !== endLine) {
      throw new Error(`Evidence manifest end_line does not match file metadata: ${manifestItem.id}`);
    }
    if (manifestItem?.total_lines !== undefined && manifestItem.total_lines !== totalLines) {
      throw new Error(`Evidence manifest total_lines does not match file metadata: ${manifestItem.id}`);
    }

    files.push({
      ...file,
      normalizedPath,
      computedSha256,
      evidenceId: manifestItem?.id || normalizedPath,
      role: manifestItem?.role || 'core',
      provenance: manifestItem?.provenance || 'repository',
      relevance: manifestItem?.relevance || file.relevance,
      order: manifestItem?.order,
      startLine,
      endLine,
      totalLines,
      isExcerpt
    });
  }

  if (unresolvedManifestPaths.size > 0) {
    throw new Error(`Evidence manifest references missing context file(s): ${Array.from(unresolvedManifestPaths).join(', ')}.`);
  }

  files.sort((a, b) => {
    const orderA = a.order ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.order ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    return a.normalizedPath.localeCompare(b.normalizedPath);
  });

  addCompletenessWarnings(files, `${question}\n${context.notes || ''}`, warnings, workspaceRoot);
  addStructuredContextWarnings(structuredReview, files, warnings, workspaceRoot);
  const dedupedWarnings = Array.from(new Set(warnings));

  return {
    schema_version: context.schema_version,
    files,
    notes: context.notes,
    evidence_manifest: context.evidence_manifest,
    structured_review: structuredReview,
    warnings: dedupedWarnings,
    context_digest: contextDigest({
      question,
      schemaVersion: context.schema_version,
      files,
      structuredReview,
      notes: context.notes
    })
  };
}
