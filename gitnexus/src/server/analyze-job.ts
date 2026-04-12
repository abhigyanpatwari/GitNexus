/**
 * Backward-compatible server export for index job primitives.
 *
 * New code should import from ../core/index-jobs.
 */

export {
  JobManager,
  type AnalyzeJob,
  type AnalyzeJobProgress,
} from '../core/index-jobs/job-manager.js';
