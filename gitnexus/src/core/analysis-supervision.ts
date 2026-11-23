/** Raised before native graph work when a CLI needs its phase supervisor. */
export class AnalysisSupervisorRequired extends Error {
  constructor() {
    super('Graph work requires an analysis supervisor');
    this.name = 'AnalysisSupervisorRequired';
  }
}
