import './patch-console.ts';

import crypto from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DBService, initSchema } from '../db/database.ts';
import { runCouncilConsultation, uniqueProviders } from '../engine/council.ts';
import { runMcqConsultation } from '../engine/mcq.ts';
import { runMaterializeValidationTests, selectValidationTestProvider } from '../engine/validationTests.ts';
import { discoverScoutContextWithLlm, type ScoutDiscoverContextResult } from '../tools/scout.ts';
import { validateCouncilContext, type CouncilContext } from './contextValidation.ts';
import { saveCouncilReportArtifact } from './reportArtifact.ts';
import { saveMcqReportArtifact } from './mcqReportArtifact.ts';
import { loadScoutContextArtifact, saveScoutContextArtifact, type ScoutContextArtifact } from './scoutContextArtifact.ts';

const contextFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  sha256: z.string().optional(),
  modified_at: z.string().optional(),
  relevance: z.string().optional(),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  total_lines: z.number().int().positive().optional(),
  is_excerpt: z.boolean().optional()
});

const structuredReviewSchema = z.object({
  review_objective: z.string(),
  architecture: z.string(),
  execution_flow: z.string(),
  assumptions_and_invariants: z.string(),
  core_evidence: z.string(),
  supporting_contracts: z.string(),
  privacy_and_persistence: z.string(),
  tests_and_runtime_evidence: z.string(),
  omitted_material: z.string()
});

const evidenceManifestItemSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().optional(),
  role: z.enum(['core', 'contract', 'config', 'test', 'runtime', 'supporting']),
  provenance: z.enum(['repository', 'generated', 'test-runtime', 'caller-supplied']),
  relevance: z.string().min(1),
  order: z.number().int().optional(),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  total_lines: z.number().int().positive().optional(),
  is_excerpt: z.boolean().optional()
});

const councilContextSchema = z.object({
  schema_version: z.string().optional(),
  files: z.array(contextFileSchema).min(1),
  notes: z.string().optional(),
  evidence_manifest: z.array(evidenceManifestItemSchema).optional(),
  structured_review: structuredReviewSchema.optional()
});

const consultCouncilSchema = {
  question: z.string().min(1),
  context: councilContextSchema.optional(),
  scout_context_ref: z.string().min(1).optional(),
  workspace_root: z.string().optional(),
  constraints: z.string().optional(),
  providers: z.array(z.string().min(1)).optional(),
  max_wait_ms: z.number().int().positive().optional(),
  provider_timeout_ms: z.number().int().positive().optional(),
  max_concurrency: z.number().int().positive().optional(),
  max_retries: z.number().int().min(0).optional()
};

const scoutDiscoverContextSchema = {
  query: z.string().min(1),
  repo_root: z.string().optional(),
  entrypoints: z.array(z.string().min(1)).optional(),
  changed_files: z.array(z.string().min(1)).optional(),
  token_budget_chars: z.number().int().positive().optional(),
  max_dependency_depth: z.number().int().min(0).max(5).optional(),
  include_tests: z.boolean().optional(),
  include_reverse_importers: z.boolean().optional(),
  enhance_with_llm: z.boolean().optional(),
  llm_timeout_ms: z.number().int().positive().optional(),
  response_mode: z.enum(['full', 'compact', 'headroom']).optional(),
  compress_output: z.boolean().optional()
};

export const server = new McpServer({
  name: 'quorum-llm-council',
  version: '0.1.0'
});

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: any;
};

type ScoutResponseMode = 'full' | 'compact' | 'headroom';

type ScoutHeadroomCompression = {
  compressed?: string;
  hash?: string;
  original_tokens?: number;
  compressed_tokens?: number;
  savings_percent?: number;
  transforms?: string[];
};

type ScoutHeadroomCompressor = (content: string) => Promise<ScoutHeadroomCompression>;

function createToolCallId(toolName: string): string {
  return `${toolName}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function rawRequestedProviderCount(providers?: string[]): number {
  return providers?.length ?? 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
}

function failedMetricStatus(err: any): 'FAILED' | 'CANCELLED' | 'INTERVENTION_REQUIRED' {
  if (err?.code === 'CANCELLED' || err?.name === 'AbortError') return 'CANCELLED';
  if (err?.code === 'INTERVENTION_REQUIRED') return 'INTERVENTION_REQUIRED';
  return 'FAILED';
}

async function resolveCouncilContext(args: any): Promise<{ context: CouncilContext; workspaceRoot?: string }> {
  if (args.context && args.scout_context_ref) {
    throw new Error('Provide either context or scout_context_ref, not both.');
  }
  if (args.context) return { context: args.context, workspaceRoot: args.workspace_root };
  if (args.scout_context_ref) {
    const scoutResult = await loadScoutContextArtifact(args.scout_context_ref);
    return { context: scoutResult.context, workspaceRoot: scoutResult.workspace_root };
  }
  throw new Error('consult_council requires either context or scout_context_ref.');
}

function scoutResponseMode(args: any): ScoutResponseMode {
  const raw = args.response_mode ?? process.env.SCOUT_OUTPUT_MODE;
  if ((raw === undefined || raw === null || raw === '') && args.compress_output === true) {
    return 'headroom';
  }
  if (raw === undefined || raw === null || raw === '') return 'full';
  if (raw === 'full' || raw === 'compact' || raw === 'headroom') return raw;
  throw new Error(`Invalid Scout response_mode: ${String(raw)}`);
}

function scoutHeadroomMcpUrl(): string {
  const explicitUrl = process.env.HEADROOM_MCP_URL?.trim();
  if (explicitUrl) return explicitUrl;
  const proxyUrl = process.env.HEADROOM_PROXY_URL?.trim();
  if (proxyUrl) return new URL('/mcp', proxyUrl.endsWith('/') ? proxyUrl : `${proxyUrl}/`).toString();
  return 'http://127.0.0.1:8787/mcp';
}

function scoutHeadroomMaxInlineChars(): number {
  const raw = Number.parseInt(process.env.SCOUT_HEADROOM_MAX_INLINE_CHARS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 24_000;
}

function parseJsonOrText(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseJsonRpcPayload(text: string): any {
  const trimmed = text.trim();
  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
    return JSON.parse(trimmed);
  }

  for (const line of trimmed.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (!data || data === '[DONE]') continue;
    const parsed = JSON.parse(data);
    if (parsed?.result || parsed?.error) return parsed;
  }

  throw new Error('Headroom MCP returned an SSE response without a JSON-RPC payload.');
}

function normalizeHeadroomCompression(value: any): ScoutHeadroomCompression {
  if (!value || typeof value !== 'object') return {};
  const structured = value.structuredContent && typeof value.structuredContent === 'object'
    ? value.structuredContent
    : value;
  const textContent = Array.isArray(value.content)
    ? value.content.find((item: any) => item?.type === 'text' && typeof item.text === 'string')?.text
    : undefined;
  const parsedText = typeof textContent === 'string' ? parseJsonOrText(textContent) : undefined;
  const source = parsedText && typeof parsedText === 'object' ? parsedText : structured;

  return {
    compressed: typeof source.compressed === 'string' ? source.compressed : undefined,
    hash: typeof source.hash === 'string' ? source.hash : undefined,
    original_tokens: typeof source.original_tokens === 'number' ? source.original_tokens : undefined,
    compressed_tokens: typeof source.compressed_tokens === 'number' ? source.compressed_tokens : undefined,
    savings_percent: typeof source.savings_percent === 'number' ? source.savings_percent : undefined,
    transforms: Array.isArray(source.transforms) ? source.transforms.filter((item: unknown): item is string => typeof item === 'string') : undefined
  };
}

async function compressWithHeadroomMcp(content: string): Promise<ScoutHeadroomCompression> {
  const response = await fetch(scoutHeadroomMcpUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `quorum_scout_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      method: 'tools/call',
      params: {
        name: 'headroom_compress',
        arguments: { content }
      }
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Headroom MCP compression failed with HTTP ${response.status}: ${truncateText(text, 300)}`);
  }
  const payload = parseJsonRpcPayload(text);
  if (payload?.error) {
    throw new Error(`Headroom MCP compression failed: ${payload.error.message || JSON.stringify(payload.error)}`);
  }
  return normalizeHeadroomCompression(payload?.result);
}

function compactScoutResult(params: {
  result: ScoutDiscoverContextResult;
  artifact: ScoutContextArtifact;
  mode: Exclude<ScoutResponseMode, 'full'>;
  headroom?: Record<string, unknown>;
}): Record<string, unknown> {
  const { result, artifact } = params;
  return {
    tool: 'scout_discover_context',
    response_mode: params.mode,
    scout_context_ref: artifact.contextRef,
    context_digest: result.context_digest,
    workspace_root: result.workspace_root,
    artifact: {
      relative_path: artifact.relativePath
    },
    retrieval: {
      consult_council: {
        argument: 'scout_context_ref',
        value: artifact.contextRef
      },
      note: 'The full Scout context is stored server-side. Pass scout_context_ref to consult_council instead of pasting context.files content.'
    },
    context_manifest: result.context.files.map(file => ({
      path: file.path,
      sha256: file.sha256,
      relevance: file.relevance,
      start_line: file.start_line,
      end_line: file.end_line,
      total_lines: file.total_lines,
      is_excerpt: file.is_excerpt,
      size_chars: file.content.length
    })),
    structured_review: result.context.structured_review,
    notes: result.context.notes,
    recommended_files: result.recommended_files,
    omitted_files: result.omitted_files,
    warnings: result.warnings,
    stats: result.stats,
    ...(params.headroom ? { headroom: params.headroom } : {})
  };
}

async function buildScoutToolResponse(result: ScoutDiscoverContextResult, args: any): Promise<ToolResponse> {
  const mode = scoutResponseMode(args);
  if (mode === 'full') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result
    };
  }

  const artifact = await saveScoutContextArtifact(result);

  if (mode === 'compact') {
    const compact = compactScoutResult({ result, artifact, mode });
    return {
      content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }],
      structuredContent: compact
    };
  }

  const raw = JSON.stringify(result, null, 2);
  const compressor: ScoutHeadroomCompressor = typeof args.headroomCompress === 'function'
    ? args.headroomCompress
    : compressWithHeadroomMcp;

  try {
    const compressed = await compressor(raw);
    const compressedText = compressed.compressed || '';
    const maxInlineChars = scoutHeadroomMaxInlineChars();
    const effectiveInline = compressedText.length > 0 &&
      compressedText.length <= maxInlineChars &&
      compressedText.length < raw.length * 0.7;
    const compact = compactScoutResult({
      result,
      artifact,
      mode,
      headroom: {
        attempted: true,
        status: 'compressed',
        hash: compressed.hash,
        original_tokens: compressed.original_tokens,
        compressed_tokens: compressed.compressed_tokens,
        savings_percent: compressed.savings_percent,
        transforms: compressed.transforms,
        inline_compressed: effectiveInline,
        max_inline_chars: maxInlineChars,
        ...(effectiveInline ? { compressed: compressedText } : {
          omitted_compressed_reason: 'Headroom did not reduce the Scout payload enough to safely inline it without re-consuming context. Use the hash or scout_context_ref for retrieval.'
        })
      }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }],
      structuredContent: compact
    };
  } catch (err) {
    const compact = compactScoutResult({
      result,
      artifact,
      mode,
      headroom: {
        attempted: true,
        status: 'failed',
        error: truncateText(errorMessage(err), 500)
      }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }],
      structuredContent: compact
    };
  }
}

export async function handleConsultCouncil(args: any): Promise<ToolResponse> {
  initSchema();

  const startedAt = Date.now();
  const toolCallId = createToolCallId('consult_council');
  DBService.createMcpToolCallMetric({
    toolCallId,
    toolName: 'consult_council',
    requestedProviderCount: rawRequestedProviderCount(args.providers)
  });

  let requestedProviderCount = rawRequestedProviderCount(args.providers);
  let contextDigest: string | null = null;

  try {
    const selectedProviders = uniqueProviders(args.providers);
    requestedProviderCount = selectedProviders.length;
    const { context, workspaceRoot } = await resolveCouncilContext(args);
    const validatedContext = validateCouncilContext(context, args.question, { workspaceRoot });
    contextDigest = validatedContext.context_digest;

    const result = await runCouncilConsultation({
      question: args.question,
      context: validatedContext,
      constraints: args.constraints,
      providers: args.providers,
      maxWaitMs: args.max_wait_ms,
      providerTimeoutMs: args.provider_timeout_ms,
      maxConcurrency: args.max_concurrency,
      maxRetries: args.max_retries,
      runnerFactory: args.runnerFactory
    });

    DBService.completeMcpToolCallMetric({
      toolCallId,
      runId: result.run_id,
      status: result.status,
      requestedProviderCount,
      successfulProviderCount: result.analyses.length,
      failedProviderCount: Math.max(0, requestedProviderCount - result.analyses.length),
      durationMs: Date.now() - startedAt,
      contextDigest
    });

    const artifact = await saveCouncilReportArtifact(result).catch((err) => {
      console.error('[WARN] Failed to save council report artifact:', err?.message ?? err);
      return null;
    });

    if (artifact) {
      const memberList = artifact.memberPaths.map(m => `  - ${m.provider}: ${m.relativePath}`).join('\n');
      console.error(`[INFO] Council run saved to ${artifact.relativePath}\n${memberList}`);
    }

    const response = artifact ? { ...result, artifact } : result;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ],
      structuredContent: response
    };
  } catch (err: any) {
    DBService.failMcpToolCallMetric({
      toolCallId,
      runId: err?.run_id ?? null,
      status: contextDigest ? failedMetricStatus(err) : 'VALIDATION_FAILED',
      requestedProviderCount,
      durationMs: Date.now() - startedAt,
      contextDigest,
      errorMessage: errorMessage(err)
    });
    throw err;
  }
}

server.registerTool(
  'consult_council',
  {
    title: 'Consult Council',
    description: 'Send a coding question and selected repository context to an independent LLM council, then return one consolidated anonymous report.',
    inputSchema: consultCouncilSchema
  },
  handleConsultCouncil
);

export async function handleScoutDiscoverContext(args: any): Promise<ToolResponse> {
  initSchema();

  const startedAt = Date.now();
  const toolCallId = createToolCallId('scout_discover_context');
  DBService.createMcpToolCallMetric({
    toolCallId,
    toolName: 'scout_discover_context'
  });

  let contextDigest: string | null = null;

  try {
    const result = await discoverScoutContextWithLlm(args);
    contextDigest = result.context_digest;

    DBService.completeMcpToolCallMetric({
      toolCallId,
      runId: result.stats.llm?.run_id,
      status: 'COMPLETED',
      durationMs: Date.now() - startedAt,
      contextDigest
    });

    return buildScoutToolResponse(result, args);
  } catch (err: any) {
    DBService.failMcpToolCallMetric({
      toolCallId,
      status: 'VALIDATION_FAILED',
      durationMs: Date.now() - startedAt,
      contextDigest,
      errorMessage: errorMessage(err)
    });
    throw err;
  }
}

server.registerTool(
  'scout_discover_context',
  {
    title: 'Scout Discover Context',
    description: 'Deterministically discover, rank, budget, and validate repository files into a ready-to-send council context.',
    inputSchema: scoutDiscoverContextSchema
  },
  handleScoutDiscoverContext
);

// ── MCQ Voting Tool ──

const mcqOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional()
});

const mcqCriterionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  weight: z.number().positive().optional()
});

const consultCouncilMcqSchema = {
  question: z.string().min(1),
  options: z.array(mcqOptionSchema).min(2).max(10),
  criteria: z.array(mcqCriterionSchema).optional(),
  context: z.object({
    schema_version: z.string().optional(),
    files: z.array(contextFileSchema).optional(),
    notes: z.string().optional(),
    evidence_manifest: z.array(evidenceManifestItemSchema).optional(),
    structured_review: structuredReviewSchema.optional()
  }).optional(),
  providers: z.array(z.string().min(1)).optional(),
  max_wait_ms: z.number().int().positive().optional(),
  provider_timeout_ms: z.number().int().positive().optional(),
  max_concurrency: z.number().int().positive().optional(),
  max_retries: z.number().int().min(0).optional()
};

const validationTestFindingSchema = z.object({
  id: z.string().min(1).optional(),
  classification: z.string().min(1).optional(),
  severity: z.string().min(1).optional(),
  description: z.string().min(1),
  evidence: z.string().min(1).optional(),
  validation_test: z.string().min(1)
});

const materializeValidationTestsSchema = {
  objective: z.string().min(1),
  findings: z.array(validationTestFindingSchema).min(1),
  context: councilContextSchema,
  workspace_root: z.string().optional(),
  test_framework: z.enum(['auto', 'node:test', 'vitest', 'jest', 'pytest']).optional(),
  target_test_dir: z.string().min(1).optional(),
  style_constraints: z.string().optional(),
  provider: z.string().min(1).optional(),
  max_wait_ms: z.number().int().positive().optional(),
  provider_timeout_ms: z.number().int().positive().optional()
};

export async function handleConsultCouncilMcq(args: any): Promise<ToolResponse> {
  initSchema();

  const startedAt = Date.now();
  const toolCallId = createToolCallId('consult_council_mcq');
  DBService.createMcpToolCallMetric({
    toolCallId,
    toolName: 'consult_council_mcq',
    requestedProviderCount: rawRequestedProviderCount(args.providers)
  });

  let requestedProviderCount = rawRequestedProviderCount(args.providers);

  try {
    const selectedProviders = uniqueProviders(args.providers);
    requestedProviderCount = selectedProviders.length;

    const result = await runMcqConsultation({
      question: args.question,
      options: args.options,
      criteria: args.criteria,
      context: args.context,
      providers: args.providers,
      maxWaitMs: args.max_wait_ms,
      providerTimeoutMs: args.provider_timeout_ms,
      maxConcurrency: args.max_concurrency,
      maxRetries: args.max_retries,
      runnerFactory: args.runnerFactory
    });

    if (result.status === 'ALL_FAILED') {
      DBService.failMcpToolCallMetric({
        toolCallId,
        runId: result.run_id,
        status: 'FAILED',
        requestedProviderCount,
        successfulProviderCount: result.votes.length,
        failedProviderCount: result.failed.length,
        durationMs: Date.now() - startedAt,
        errorMessage: 'All MCQ providers failed to produce valid votes.'
      });
    } else {
      DBService.completeMcpToolCallMetric({
        toolCallId,
        runId: result.run_id,
        status: result.status,
        requestedProviderCount,
        successfulProviderCount: result.votes.length,
        failedProviderCount: result.failed.length,
        durationMs: Date.now() - startedAt
      });
    }

    const artifact = await saveMcqReportArtifact(result).catch((err) => {
      console.error('[WARN] Failed to save MCQ report artifact:', err?.message ?? err);
      return null;
    });

    if (artifact) {
      const memberList = artifact.memberPaths.map(m => `  - ${m.provider}: ${m.relativePath}`).join('\n');
      console.error(`[INFO] MCQ vote saved to ${artifact.relativePath}\n${memberList}`);
    }

    const response = artifact ? { ...result, artifact } : result;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ],
      structuredContent: response
    };
  } catch (err: any) {
    DBService.failMcpToolCallMetric({
      toolCallId,
      runId: err?.run_id ?? null,
      status: 'VALIDATION_FAILED',
      requestedProviderCount,
      durationMs: Date.now() - startedAt,
      errorMessage: errorMessage(err)
    });
    throw err;
  }
}

server.registerTool(
  'consult_council_mcq',
  {
    title: 'Council MCQ Vote',
    description: 'Ask the LLM council to vote on predefined options. Each council member independently selects one option and provides justification. Returns the full vote distribution for human review — no winner is declared. Optionally provide evaluation criteria for structured per-option scoring.',
    inputSchema: consultCouncilMcqSchema
  },
  handleConsultCouncilMcq
);

export async function handleMaterializeValidationTests(args: any): Promise<ToolResponse> {
  initSchema();

  const startedAt = Date.now();
  const toolCallId = createToolCallId('materialize_validation_tests');
  DBService.createMcpToolCallMetric({
    toolCallId,
    toolName: 'materialize_validation_tests',
    requestedProviderCount: args.provider ? 1 : 0
  });

  let requestedProviderCount = args.provider ? 1 : 0;
  let contextDigest: string | null = null;

  try {
    const provider = selectValidationTestProvider(args.provider);
    requestedProviderCount = 1;
    const validatedContext = validateCouncilContext(args.context, args.objective, { workspaceRoot: args.workspace_root });
    contextDigest = validatedContext.context_digest;

    const result = await runMaterializeValidationTests({
      objective: args.objective,
      findings: args.findings,
      context: validatedContext,
      test_framework: args.test_framework,
      target_test_dir: args.target_test_dir,
      style_constraints: args.style_constraints,
      provider,
      max_wait_ms: args.max_wait_ms,
      provider_timeout_ms: args.provider_timeout_ms,
      runnerFactory: args.runnerFactory
    });

    if (result.status === 'FAILED') {
      DBService.failMcpToolCallMetric({
        toolCallId,
        status: 'FAILED',
        requestedProviderCount,
        successfulProviderCount: 0,
        failedProviderCount: 1,
        durationMs: Date.now() - startedAt,
        contextDigest,
        errorMessage: 'Validation-test materialization failed.'
      });
    } else {
      DBService.completeMcpToolCallMetric({
        toolCallId,
        status: result.status === 'PARTIAL' ? 'PARTIAL_SUCCESS' : 'COMPLETED',
        requestedProviderCount,
        successfulProviderCount: 1,
        failedProviderCount: 0,
        durationMs: Date.now() - startedAt,
        contextDigest
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result
    };
  } catch (err: any) {
    DBService.failMcpToolCallMetric({
      toolCallId,
      status: contextDigest ? failedMetricStatus(err) : 'VALIDATION_FAILED',
      requestedProviderCount,
      successfulProviderCount: 0,
      failedProviderCount: requestedProviderCount,
      durationMs: Date.now() - startedAt,
      contextDigest,
      errorMessage: errorMessage(err)
    });
    throw err;
  }
}

server.registerTool(
  'materialize_validation_tests',
  {
    title: 'Materialize Validation Tests',
    description: 'Convert structured council findings and validation-test prose into a patch-only executable test diff. The tool returns generated tests as metadata and never writes files.',
    inputSchema: materializeValidationTestsSchema
  },
  handleMaterializeValidationTests
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  const shutdown = async (signal: string) => {
    console.error(`Received ${signal}; shutting down MCP transport.`);
    await transport.close().catch(() => { });
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
