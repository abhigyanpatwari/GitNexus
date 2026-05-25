import type { EvaluationReport, GateDecision, VariantSpec } from './types.js';

const decidedAt = '2026-05-25T00:00:00.000Z';

export function decidePromotion(variant: VariantSpec, report: EvaluationReport): GateDecision {
  const gateId = `gate-${variant.id}-${report.id}`;

  if (report.safetyFindings.length > 0) {
    return reject(gateId, variant, report, ['evaluation report contains safety findings']);
  }

  if (variant.provenance.length === 0) {
    return reject(gateId, variant, report, ['variant provenance is required']);
  }

  if (variant.rollbackPlan.operations.length === 0 && variant.mutationType === 'parameter') {
    return reject(gateId, variant, report, ['rollback operations are required for automatic promotion']);
  }

  if (report.verdict === 'reject') {
    return reject(gateId, variant, report, ['evaluation report rejected variant']);
  }

  if (variant.mutationType === 'algorithm') {
    return needsReview(gateId, variant, report, ['algorithm variants require review before promotion']);
  }

  if (variant.mutationType === 'structure') {
    return needsReview(gateId, variant, report, ['structure variants require review before promotion']);
  }

  if (variant.riskLevel !== 'low') {
    return needsReview(gateId, variant, report, ['non-low-risk variants require review before promotion']);
  }

  if (report.verdict !== 'promote') {
    return needsReview(gateId, variant, report, ['evaluation report does not recommend promotion']);
  }

  return {
    id: gateId,
    variantId: variant.id,
    reportId: report.id,
    decision: 'allow',
    reasons: ['parameter variant passed promotion gate'],
    decidedAt,
  };
}

function reject(
  id: string,
  variant: VariantSpec,
  report: EvaluationReport,
  reasons: string[],
): GateDecision {
  return {
    id,
    variantId: variant.id,
    reportId: report.id,
    decision: 'reject',
    reasons,
    decidedAt,
  };
}

function needsReview(
  id: string,
  variant: VariantSpec,
  report: EvaluationReport,
  reasons: string[],
): GateDecision {
  return {
    id,
    variantId: variant.id,
    reportId: report.id,
    decision: 'needs-review',
    reasons,
    decidedAt,
  };
}
