import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.ts';
import type { ScoutDiscoverContextResult } from '../tools/scout.ts';

export type ScoutContextArtifact = {
  contextRef: string;
  contextDigest: string;
  absolutePath: string;
  relativePath: string;
};

const OUTPUT_DIR = path.resolve(config.rootDir, 'quorum', 'scout-context');
const REF_PREFIX = 'scout:';

function safeDigest(value: string): string {
  const digest = value.startsWith(REF_PREFIX) ? value.slice(REF_PREFIX.length) : value;
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`Invalid Scout context reference: ${value}`);
  }
  return digest;
}

function artifactPathForDigest(digest: string): string {
  const absolutePath = path.resolve(OUTPUT_DIR, `${digest}.json`);
  if (!absolutePath.startsWith(OUTPUT_DIR + path.sep)) {
    throw new Error(`Invalid Scout context reference path: ${digest}`);
  }
  return absolutePath;
}

function relativeArtifactPath(absolutePath: string): string {
  return path.relative(config.rootDir, absolutePath).replace(/\\/g, '/');
}

function resultDigest(result: ScoutDiscoverContextResult): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    context_digest: result.context_digest,
    recommended_files: result.recommended_files.map(file => file.path),
    stats: result.stats
  })).digest('hex');
}

export async function saveScoutContextArtifact(result: ScoutDiscoverContextResult): Promise<ScoutContextArtifact> {
  const digest = safeDigest(result.context_digest);
  const absolutePath = artifactPathForDigest(digest);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(absolutePath, JSON.stringify({
    artifact_schema_version: '2026-06-25',
    artifact_digest: resultDigest(result),
    result
  }, null, 2), 'utf8');

  return {
    contextRef: `${REF_PREFIX}${digest}`,
    contextDigest: digest,
    absolutePath,
    relativePath: relativeArtifactPath(absolutePath)
  };
}

export async function loadScoutContextArtifact(contextRef: string): Promise<ScoutDiscoverContextResult> {
  const digest = safeDigest(contextRef);
  const absolutePath = artifactPathForDigest(digest);
  const raw = await fs.readFile(absolutePath, 'utf8').catch((err: any) => {
    if (err?.code === 'ENOENT') {
      throw new Error(`Scout context reference was not found or has not been created: ${contextRef}`);
    }
    throw err;
  });
  const parsed = JSON.parse(raw);
  const result = parsed?.result;

  if (!result || typeof result !== 'object' || result.context_digest !== digest) {
    throw new Error(`Scout context artifact is invalid or does not match reference: ${contextRef}`);
  }

  return result as ScoutDiscoverContextResult;
}
