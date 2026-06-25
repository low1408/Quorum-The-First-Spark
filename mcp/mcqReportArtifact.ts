import fs from 'fs';
import path from 'path';
import type { McqResult, McqMemberVote } from '../engine/mcq.ts';
import { isCriteriaDecision } from '../engine/mcqSchemas.ts';

export interface McqReportArtifact {
  relativePath: string;
  absolutePath: string;
  memberPaths: Array<{ provider: string; relativePath: string }>;
}

const MCQ_OUTPUT_DIR = path.resolve('quorum');

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function formatDistributionTable(result: McqResult): string {
  const rows = result.distribution.distribution.map(d => {
    const pct = (d.vote_fraction * 100).toFixed(0);
    const bar = '█'.repeat(Math.round(d.vote_fraction * 20));
    const voterList = d.voters.length > 0 ? d.voters.join(', ') : '—';
    return `| ${d.option_id} | ${d.option_label} | ${d.vote_count} | ${pct}% ${bar} | ${voterList} |`;
  });

  return [
    '| Option ID | Label | Votes | Distribution | Voters |',
    '|-----------|-------|-------|-------------|--------|',
    ...rows
  ].join('\n');
}

function formatMemberDecision(vote: McqMemberVote, index: number): string {
  const d = vote.decision;
  const sections: string[] = [
    `### Voter ${index + 1} (${vote.provider})`,
    '',
    `**Selected:** \`${d.selected_option_id}\``,
    `**Confidence:** ${d.confidence}`,
    '',
    `**Justification:** ${d.decision_justification}`,
  ];

  if (d.assumptions && d.assumptions.length > 0) {
    sections.push('', '**Assumptions:**');
    for (const assumption of d.assumptions) {
      sections.push(`- ${assumption}`);
    }
  }

  if (isCriteriaDecision(d)) {
    sections.push('', '**Option Evaluations:**');
    for (const optEval of d.option_evaluations) {
      sections.push(``, `#### Option: \`${optEval.option_id}\``);
      sections.push(`Summary: ${optEval.summary}`);
      sections.push('');
      sections.push('| Criterion | Rating | Justification |');
      sections.push('|-----------|--------|---------------|');
      for (const critEval of optEval.criterion_evaluations) {
        sections.push(`| ${critEval.criterion_id} | ${'★'.repeat(critEval.rating)}${'☆'.repeat(5 - critEval.rating)} (${critEval.rating}/5) | ${critEval.justification} |`);
      }
    }
  }

  return sections.join('\n');
}

function buildMcqReport(result: McqResult): string {
  const hasCriteria = result.criteria && result.criteria.length > 0;
  const mode = hasCriteria ? 'Criteria' : 'Simple';

  const sections: string[] = [
    `# MCQ Council Vote Report`,
    '',
    `**Run ID:** \`${result.run_id}\``,
    `**Status:** ${result.status}`,
    `**Mode:** ${mode}`,
    `**Eligible Members:** ${result.distribution.eligible_members}`,
    `**Valid Votes:** ${result.distribution.valid_votes}`,
    `**Failed Votes:** ${result.distribution.failed_votes}`,
    '',
    `## Question`,
    '',
    result.question,
    '',
    `## Options`,
    '',
    ...result.options.map(o => `- **[${o.id}]** ${o.label}${o.description ? ` — ${o.description}` : ''}`),
    '',
  ];

  if (hasCriteria) {
    sections.push(
      `## Criteria`,
      '',
      ...result.criteria!.map(c => `- **[${c.id}]** ${c.label}${c.description ? ` — ${c.description}` : ''}${c.weight != null ? ` (weight: ${c.weight})` : ''}`),
      ''
    );
  }

  sections.push(
    `## Vote Distribution`,
    '',
    formatDistributionTable(result),
    ''
  );

  if (result.failed.length > 0) {
    sections.push(
      `## Failed Votes`,
      '',
      ...result.failed.map(f => `- **${f.provider}**: ${f.reason}`),
      ''
    );
  }

  sections.push(
    `## Individual Decisions`,
    ''
  );

  for (let i = 0; i < result.votes.length; i++) {
    sections.push(formatMemberDecision(result.votes[i], i));
    if (i < result.votes.length - 1) {
      sections.push('', '---', '');
    }
  }

  if (result.warnings.length > 0) {
    sections.push(
      '',
      `## Warnings`,
      '',
      ...result.warnings.map(w => `- ${w}`)
    );
  }

  return sections.join('\n');
}

export async function saveMcqReportArtifact(result: McqResult): Promise<McqReportArtifact> {
  const runDir = path.join(MCQ_OUTPUT_DIR, 'MCQ-Votes');
  ensureDir(runDir);

  // Save main report
  const reportFilename = `${result.run_id}.md`;
  const reportPath = path.join(runDir, reportFilename);
  const reportContent = buildMcqReport(result);
  fs.writeFileSync(reportPath, reportContent, 'utf-8');

  // Save individual member raw responses
  const memberPaths: McqReportArtifact['memberPaths'] = [];
  for (const vote of result.votes) {
    const memberFilename = `${vote.provider}_${result.run_id}.md`;
    const memberPath = path.join(runDir, memberFilename);
    const memberContent = [
      `# ${vote.provider} — MCQ Vote`,
      '',
      `**Run ID:** \`${result.run_id}\``,
      `**Selected:** \`${vote.decision.selected_option_id}\``,
      `**Confidence:** ${vote.decision.confidence}`,
      '',
      `## Raw Response`,
      '',
      vote.rawResponse
    ].join('\n');
    fs.writeFileSync(memberPath, memberContent, 'utf-8');
    memberPaths.push({
      provider: vote.provider,
      relativePath: path.relative(process.cwd(), memberPath)
    });
  }

  return {
    relativePath: path.relative(process.cwd(), reportPath),
    absolutePath: reportPath,
    memberPaths
  };
}
