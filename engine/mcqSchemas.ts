import { z } from 'zod';

// ── Option & Criterion Schemas ──

export const McqOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional()
});

export const McqCriterionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  weight: z.number().positive().optional()
});

export type McqOption = z.infer<typeof McqOptionSchema>;
export type McqCriterion = z.infer<typeof McqCriterionSchema>;

// ── Simple Decision Schema (no criteria) ──

export const McqSimpleDecisionSchema = z.object({
  selected_option_id: z.string().min(1),
  decision_justification: z.string().min(1).max(2000),
  assumptions: z.array(z.string().min(1).max(300)).max(10).optional().default([]),
  confidence: z.number().min(0).max(1)
});

export type McqSimpleDecision = z.infer<typeof McqSimpleDecisionSchema>;

// ── Criteria Decision Schema (with per-option, per-criterion evaluations) ──

export const CriterionEvaluationSchema = z.object({
  criterion_id: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  justification: z.string().min(1).max(500)
});

export const OptionEvaluationSchema = z.object({
  option_id: z.string().min(1),
  criterion_evaluations: z.array(CriterionEvaluationSchema).min(1),
  summary: z.string().min(1).max(750)
});

export const McqCriteriaDecisionSchema = z.object({
  selected_option_id: z.string().min(1),
  option_evaluations: z.array(OptionEvaluationSchema).min(1),
  decision_justification: z.string().min(1).max(2000),
  assumptions: z.array(z.string().min(1).max(300)).max(10).optional().default([]),
  confidence: z.number().min(0).max(1)
});

export type McqCriteriaDecision = z.infer<typeof McqCriteriaDecisionSchema>;

// ── Unified Decision Type ──

export type McqDecision = McqSimpleDecision | McqCriteriaDecision;

/**
 * Returns true if the decision is a criteria-mode decision
 * (i.e., contains option_evaluations).
 */
export function isCriteriaDecision(decision: McqDecision): decision is McqCriteriaDecision {
  return 'option_evaluations' in decision && Array.isArray((decision as any).option_evaluations);
}

// ── Cross-field Validation ──

/**
 * Validates a parsed simple decision against the declared options.
 * Returns an array of error messages (empty = valid).
 */
export function validateSimpleDecisionCrossFields(
  decision: McqSimpleDecision,
  optionIds: Set<string>
): string[] {
  const errors: string[] = [];

  if (!optionIds.has(decision.selected_option_id)) {
    errors.push(`selected_option_id "${decision.selected_option_id}" is not one of the declared options: ${Array.from(optionIds).join(', ')}`);
  }

  return errors;
}

/**
 * Validates a parsed criteria decision against declared options and criteria.
 * Returns an array of error messages (empty = valid).
 */
export function validateCriteriaDecisionCrossFields(
  decision: McqCriteriaDecision,
  optionIds: Set<string>,
  criterionIds: Set<string>
): string[] {
  const errors: string[] = [];

  // selected_option_id must reference a declared option
  if (!optionIds.has(decision.selected_option_id)) {
    errors.push(`selected_option_id "${decision.selected_option_id}" is not one of the declared options: ${Array.from(optionIds).join(', ')}`);
  }

  // Every declared option must appear exactly once in option_evaluations
  const evaluatedOptionIds = new Set(decision.option_evaluations.map(e => e.option_id));
  for (const optionId of optionIds) {
    if (!evaluatedOptionIds.has(optionId)) {
      errors.push(`Missing evaluation for declared option "${optionId}".`);
    }
  }
  for (const evaluatedId of evaluatedOptionIds) {
    if (!optionIds.has(evaluatedId)) {
      errors.push(`Evaluation references unknown option "${evaluatedId}".`);
    }
  }

  // Check for duplicate option evaluations
  const optionIdCounts = new Map<string, number>();
  for (const evaluation of decision.option_evaluations) {
    optionIdCounts.set(evaluation.option_id, (optionIdCounts.get(evaluation.option_id) || 0) + 1);
  }
  for (const [optionId, count] of optionIdCounts) {
    if (count > 1) {
      errors.push(`Duplicate evaluation for option "${optionId}" (appears ${count} times).`);
    }
  }

  // Every declared criterion must appear exactly once for every option
  for (const evaluation of decision.option_evaluations) {
    const evaluatedCriterionIds = new Set(evaluation.criterion_evaluations.map(c => c.criterion_id));

    for (const criterionId of criterionIds) {
      if (!evaluatedCriterionIds.has(criterionId)) {
        errors.push(`Missing criterion "${criterionId}" evaluation for option "${evaluation.option_id}".`);
      }
    }
    for (const evaluatedCritId of evaluatedCriterionIds) {
      if (!criterionIds.has(evaluatedCritId)) {
        errors.push(`Unknown criterion "${evaluatedCritId}" in evaluation for option "${evaluation.option_id}".`);
      }
    }

    // Check for duplicate criterion evaluations within an option
    const critIdCounts = new Map<string, number>();
    for (const critEval of evaluation.criterion_evaluations) {
      critIdCounts.set(critEval.criterion_id, (critIdCounts.get(critEval.criterion_id) || 0) + 1);
    }
    for (const [critId, count] of critIdCounts) {
      if (count > 1) {
        errors.push(`Duplicate criterion "${critId}" evaluation for option "${evaluation.option_id}" (appears ${count} times).`);
      }
    }
  }

  return errors;
}

// ── JSON Schema Representations (for prompt injection) ──

export const SIMPLE_DECISION_JSON_SCHEMA = `{
  "selected_option_id": "<string: one of the option IDs listed above>",
  "decision_justification": "<string: concise justification for your choice, max 2000 chars>",
  "assumptions": ["<string: any assumptions you made, max 10 items>"],
  "confidence": <number: 0.0 to 1.0>
}`;

export const CRITERIA_DECISION_JSON_SCHEMA = `{
  "selected_option_id": "<string: one of the option IDs listed above>",
  "option_evaluations": [
    {
      "option_id": "<string: one of the option IDs>",
      "criterion_evaluations": [
        {
          "criterion_id": "<string: one of the criterion IDs>",
          "rating": <integer: 1 to 5>,
          "justification": "<string: brief justification, max 500 chars>"
        }
      ],
      "summary": "<string: overall assessment of this option, max 750 chars>"
    }
  ],
  "decision_justification": "<string: concise justification for your final choice, max 2000 chars>",
  "assumptions": ["<string: any assumptions you made, max 10 items>"],
  "confidence": <number: 0.0 to 1.0>
}`;
