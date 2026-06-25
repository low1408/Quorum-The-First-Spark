import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CouncilConsultationResult } from '../engine/council.ts';

export type CouncilReportArtifact = {
  absolutePath: string;
  relativePath: string;
  memberPaths: { provider: string; absolutePath: string; relativePath: string }[];
};

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function safeProvider(provider: string): string {
  return provider.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

function safeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildMemberMarkdown(provider: string, response: string, runId: string): string {
  return [
    `# Council Member Report — ${provider}`,
    '',
    `Run ID: ${runId}`,
    '',
    response.trim(),
    ''
  ].join('\n');
}

function buildCouncilReportMarkdown(result: CouncilConsultationResult): string {
  const warnings = result.warnings.length > 0
    ? result.warnings.map(warning => `- ${warning}`).join('\n')
    : '- None';

  return [
    `# Council Report`,
    '',
    `Run ID: ${result.run_id}`,
    `Status: ${result.status}`,
    '',
    '## Report',
    '',
    result.report.trim(),
    '',
    '## Warnings',
    '',
    warnings,
    ''
  ].join('\n');
}

export async function saveCouncilReportArtifact(result: CouncilConsultationResult): Promise<CouncilReportArtifact> {
  const outputFolder = 'quorum';
  const absoluteOutputFolder = path.resolve(repositoryRoot, outputFolder);

  await fs.mkdir(absoluteOutputFolder, { recursive: true });

  // Save the combined council report
  const reportRelativePath = path.join(outputFolder, 'council_report.md');
  const reportAbsolutePath = path.resolve(repositoryRoot, reportRelativePath);
  await fs.writeFile(reportAbsolutePath, buildCouncilReportMarkdown(result), 'utf8');

  // Save individual member responses, one file per provider
  const memberPaths: CouncilReportArtifact['memberPaths'] = [];
  for (const analysis of result.analyses ?? []) {
    const memberFileName = `${safeProvider(analysis.provider)}_${safeRunId(result.run_id)}.md`;
    const memberRelativePath = path.join(outputFolder, memberFileName);
    const memberAbsolutePath = path.resolve(repositoryRoot, memberRelativePath);
    await fs.writeFile(
      memberAbsolutePath,
      buildMemberMarkdown(analysis.provider, analysis.response, result.run_id),
      'utf8'
    );
    memberPaths.push({
      provider: analysis.provider,
      absolutePath: memberAbsolutePath,
      relativePath: memberRelativePath
    });
  }

  return {
    absolutePath: reportAbsolutePath,
    relativePath: reportRelativePath,
    memberPaths
  };
}
