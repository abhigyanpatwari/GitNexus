import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('reindex API wiring', () => {
  const readSource = () =>
    fs.readFile(path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'), 'utf-8');

  it('uses the constrained reindex control helpers', async () => {
    const source = await readSource();

    expect(source).toMatch(/parseReindexRequestBody/);
    expect(source).toMatch(/resolveRegisteredReindexTarget/);
    expect(source).toMatch(/buildReindexWorkerOptions/);
    expect(source).toMatch(/ReindexQueue/);
    expect(source).toMatch(/ReindexOperationRegistry/);
  });

  it('registers POST /api/reindex and resolves only registered repos', async () => {
    const source = await readSource();

    const route = source.match(/app\.post\('\/api\/reindex'[\s\S]{0,5000}res\.status\(202\)/);
    expect(route?.[0]).toMatch(/listRegisteredRepos\(\)/);
    expect(route?.[0]).toMatch(/parseReindexRequestBody/);
    expect(route?.[0]).toMatch(/resolveRegisteredReindexTarget/);
    expect(route?.[0]).not.toMatch(/path\.isAbsolute\(repoLocalPath\)/);
  });

  it('maps rejected reindex inputs to explicit bad requests', async () => {
    const source = await readSource();
    const route = source.match(/app\.post\('\/api\/reindex'[\s\S]{0,5200}\}\);/);

    expect(route?.[0]).toMatch(/err instanceof BadRequestError \? err\.status : 500/);
  });

  it('returns explicit active/dedup status for reindex queue decisions', async () => {
    const source = await readSource();
    const route = source.match(/app\.post\('\/api\/reindex'[\s\S]{0,5000}const requestedOptions/);

    expect(route?.[0]).toMatch(/queueAction\.action === 'reject-active-other-repo'/);
    expect(route?.[0]).toMatch(/res\.status\(409\)\.json/);
    expect(route?.[0]).toMatch(/activeRepoKey/);
    expect(route?.[0]).toMatch(/queueAction\.action !== 'start'/);
    expect(route?.[0]).toMatch(/jobId: activeJob\?\.id/);
    expect(route?.[0]).toMatch(/queue: reindexQueue\.status\(repoKey\)/);
    expect(route?.[0]).toMatch(/recordCoalescedRequest/);
  });

  it('registers GET /api/reindex as a reindex-only operation list endpoint', async () => {
    const source = await readSource();

    const route = source.match(/app\.get\('\/api\/reindex'[\s\S]{0,2200}\}\);/);
    expect(route?.[0]).toMatch(/reindexOperations\.list/);
    expect(route?.[0]).toMatch(/limit:\s*parseReindexListLimit/);
    expect(route?.[0]).toMatch(/repo:\s*parseOptionalQueryString\(req\.query\.repo\)/);
    expect(route?.[0]).toMatch(/status:\s*parseReindexStatusFilter\(req\.query\.status\)/);
    expect(route?.[0]).toMatch(/trigger:\s*parseReindexTriggerFilter\(req\.query\.trigger\)/);
    expect(route?.[0]).not.toMatch(/jobManager\.listJobs\(\)/);
  });

  it('locks GET /api/reindex list filter defaults and validation helpers', async () => {
    const source = await readSource();

    expect(source).toMatch(/const DEFAULT_REINDEX_LIST_LIMIT = 20/);
    expect(source).toMatch(/const MAX_REINDEX_LIST_LIMIT = 100/);
    expect(source).toMatch(/parseReindexListLimit/);
    expect(source).toMatch(/parseReindexStatusFilter/);
    expect(source).toMatch(/parseReindexTriggerFilter/);
  });

  it('strips the server-only indexOnly marker before worker IPC', async () => {
    const source = await readSource();

    const helper = source.match(/const startReindexJob = [\s\S]{0,16000}child\.send\(\{[\s\S]{0,500}\}\);/);
    expect(helper?.[0]).toMatch(/buildReindexWorkerOptions/);
    expect(helper?.[0]).toMatch(/indexOnly:\s*_indexOnly/);
    expect(helper?.[0]).toMatch(/options:\s*workerOptions/);
    expect(helper?.[0]).not.toMatch(/options:\s*\{[\s\S]{0,200}indexOnly/);
  });

  it('preserves embedding flags through reindex request options and worker IPC', async () => {
    const source = await readSource();
    const route = source.match(/app\.post\('\/api\/reindex'[\s\S]{0,4200}startReindexJob\(target, repoKey, requestedOptions\)/);
    const helper = source.match(/const startReindexJob = [\s\S]{0,16000}child\.send\(\{[\s\S]{0,500}\}\);/);

    expect(route?.[0]).toMatch(/force, embeddings, dropEmbeddings/);
    expect(route?.[0]).toMatch(/const requestedOptions = \{ force, embeddings, dropEmbeddings \}/);
    expect(helper?.[0]).toMatch(/buildReindexWorkerOptions\(requestedOptions\)/);
    expect(helper?.[0]).toMatch(/options:\s*workerOptions/);
  });

  it('keeps worker and embedding errors failure-shaped instead of marking complete', async () => {
    const source = await readSource();
    const helper = source.match(/const startReindexJob = [\s\S]{0,16000}return job;\s*};/);

    expect(helper?.[0]).toMatch(/const failWorker = \(message: string\) =>[\s\S]{0,900}jobManager\.updateJob\(job\.id, \{ status: 'failed'/);
    expect(helper?.[0]).toMatch(/msg\.type === 'error'[\s\S]{0,160}failWorker\(msg\.message\)/);
    expect(helper?.[0]).toMatch(/child\.on\('error'[\s\S]{0,220}failWorker\(message\)/);
    expect(helper?.[0]).toMatch(/child\.on\('exit'/);
    expect(helper?.[0]).toMatch(/Worker exited before completing reindex/);
    expect(helper?.[0]).toMatch(/jobManager\.updateJob\(job\.id, \{ status: 'failed', error: message \}\)/);
  });

  it('exposes GET /api/reindex/:jobId status with queue status fields', async () => {
    const source = await readSource();

    const route = source.match(/app\.get\('\/api\/reindex\/:jobId'[\s\S]{0,2200}\}\);/);
    expect(route?.[0]).toMatch(/reindexQueue\.status/);
    expect(route?.[0]).toMatch(/reindexOperations\.get/);
    expect(route?.[0]).toMatch(/pendingRerun/);
    expect(route?.[0]).toMatch(/lastError/);
    expect(route?.[0]).toMatch(/trigger/);
    expect(route?.[0]).toMatch(/parentJobId/);
    expect(route?.[0]).toMatch(/followUpJobId/);
    expect(route?.[0]).toMatch(/coalescedRequestCount/);
  });

  it('starts a pending same-repo rerun only after current job completion', async () => {
    const source = await readSource();

    expect(source).toMatch(/const startReindexJob = /);
    const completePath = source.match(
      /const finalizeCompletedWorker = async[\s\S]{0,6200}const followUp = startPendingRerun\(/,
    );
    expect(completePath?.[0]).toMatch(/refreshRepoIndex\(target\.name\)/);
    expect(completePath?.[0]).toMatch(/jobManager\.updateJob\(job\.id,[\s\S]{0,200}status: 'complete'/);
    expect(completePath?.[0]).toMatch(/reindexOperations\.markComplete\(job\.id\)/);
    expect(completePath?.[0]).toMatch(/reindexQueue\.complete\(repoKey\)/);
    expect(completePath?.[0]).toMatch(/completionAction\.action === 'start-pending-rerun'/);
    expect(completePath?.[0]).toMatch(/const followUp = startPendingRerun\(/);
    expect(source).toMatch(
      /startReindexJob\(target, repoKey, requestedOptions, \{[\s\S]{0,120}trigger: 'pending-rerun'[\s\S]{0,120}parentJobId: job\.id/,
    );
  });

  it('does not let normal worker exit race a terminal worker message', async () => {
    const source = await readSource();
    const helper = source.match(/const startReindexJob = [\s\S]{0,16000}return job;\s*};/);

    expect(helper?.[0]).toMatch(/let terminalWorkerMessageReceived = false/);
    expect(helper?.[0]).toMatch(/let completedWorkerResult: any \| null = null/);
    expect(helper?.[0]).toMatch(/msg\.type === 'complete'[\s\S]{0,120}terminalWorkerMessageReceived = true/);
    expect(helper?.[0]).toMatch(/msg\.type === 'complete'[\s\S]{0,160}completedWorkerResult = msg\.result \?\? \{\}/);
    expect(helper?.[0]).toMatch(/msg\.type === 'error'[\s\S]{0,120}terminalWorkerMessageReceived = true/);
    expect(helper?.[0]).toMatch(/child\.on\('error'[\s\S]{0,120}if \(terminalWorkerMessageReceived\) return/);
    expect(helper?.[0]).toMatch(/child\.on\('exit'[\s\S]{0,160}if \(completedWorkerResult\)/);
    expect(helper?.[0]).toMatch(/code === 0[\s\S]{0,120}finalizeCompletedWorker\(completedWorkerResult\)/);
    expect(helper?.[0]).toMatch(/Worker exited after completing reindex/);
  });

  it('records queue failure on worker creation, worker error, and premature exit', async () => {
    const source = await readSource();
    const helper = source.match(/const startReindexJob = [\s\S]{0,16000}return job;\s*};/);

    expect(helper?.[0]).toMatch(/catch \(err: any\)[\s\S]{0,180}reindexQueue\.fail\(repoKey, message\)/);
    expect(helper?.[0]).toMatch(/const failWorker = \(message: string\) =>[\s\S]{0,260}reindexOperations\.markFailed\(job\.id, message\)/);
    expect(helper?.[0]).toMatch(/msg\.type === 'error'[\s\S]{0,160}failWorker\(msg\.message\)/);
    expect(helper?.[0]).toMatch(/child\.on\('exit'[\s\S]{0,900}failWorker\(message\)/);
  });

  it('records pending-rerun startup failure on the completed parent without fabricating a child job', async () => {
    const source = await readSource();
    const completePath = source.match(
      /completionAction\.action === 'start-pending-rerun'[\s\S]{0,3200}logger\.error\(\{ err: followUp\.cause \}, 'pending reindex rerun failed to start:'\);/,
    );

    expect(completePath?.[0]).toMatch(/const followUp = startPendingRerun\(/);
    expect(completePath?.[0]).toMatch(
      /recordFollowUpStartFailure: \(parentJobId, message\) =>[\s\S]{0,120}reindexOperations\.recordFollowUpStartFailure\(parentJobId, message\)/,
    );
    expect(completePath?.[0]).toMatch(
      /queueFail: \(failedRepoKey, message\) => reindexQueue\.fail\(failedRepoKey, message\)/,
    );
    expect(completePath?.[0]).not.toMatch(/linkFollowUp\(job\.id,[\s\S]{0,600}catch \(err: any\)[\s\S]{0,200}linkFollowUp/);
  });

  it('gates /api/search only for the overlap/pending-rerun read hazard', async () => {
    const source = await readSource();
    const route = source.match(/app\.post\('\/api\/search'[\s\S]{0,2200}const lbugPath = path\.join/);

    expect(source).toMatch(/isGraphReadBlockedDuringReindex/);
    expect(source).toMatch(/const getActiveReindexGuardState = \(repoKey: string\)/);
    expect(route?.[0]).toMatch(/const repoKey = entry\.name/);
    expect(route?.[0]).toMatch(/const guardState = getActiveReindexGuardState\(repoKey\)/);
    expect(route?.[0]).toMatch(/if \(guardState\.blocked\)/);
    expect(route?.[0]).toMatch(/res\.status\(503\)\.json/);
    expect(route?.[0]).toMatch(/retryable:\s*true/);
    expect(route?.[0]).toMatch(/Repository reindex is still settling\. Retry shortly\./);
  });

  it('emits the locked structured reindex lifecycle log events', async () => {
    const source = await readSource();

    for (const event of [
      'reindex.request.accepted',
      'reindex.request.coalesced',
      'reindex.started',
      'reindex.pending_rerun.started',
      'reindex.completed',
      'reindex.failed',
    ]) {
      expect(source).toContain(event);
    }

    const postRoute = source.match(/app\.post\('\/api\/reindex'[\s\S]{0,9000}app\.get\('\/api\/reindex'/)?.[0] ?? '';
    const acceptedLogIndex = postRoute.indexOf("event: 'reindex.request.accepted'");
    const immediateStatusResponseIndex = postRoute.indexOf("if (job.status !== 'queued')");

    expect(acceptedLogIndex).toBeGreaterThan(-1);
    expect(immediateStatusResponseIndex).toBeGreaterThan(-1);
    expect(acceptedLogIndex).toBeLessThan(immediateStatusResponseIndex);
  });
});
