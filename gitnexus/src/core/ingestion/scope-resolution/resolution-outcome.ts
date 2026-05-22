import type { Range } from 'gitnexus-shared';

export type ResolutionSuppressionReason =
  | 'adl-non-callable-block'
  | 'constraint-unknown'
  | 'conversion-rank-tied'
  | 'dependent-base-skipped'
  | 'inline-ns-ambiguous'
  | 'overload-ambiguous-normalization';

export type ResolutionOutcome =
  | {
      readonly kind: 'resolved';
      readonly targetId: string;
      readonly phase: string;
      readonly filePath: string;
      readonly name: string;
      readonly range: Range;
    }
  | {
      readonly kind: 'suppressed';
      readonly reason: ResolutionSuppressionReason;
      readonly candidateIds: readonly string[];
      readonly phase: string;
      readonly filePath: string;
      readonly name: string;
      readonly range: Range;
    };

export type ResolutionOutcomeRecorder = (outcome: ResolutionOutcome) => void;
