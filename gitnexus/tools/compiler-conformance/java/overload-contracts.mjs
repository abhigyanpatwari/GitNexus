import { compareCodeUnits } from '../compare.mjs';
import {
  copyResolutionProject,
  FIXTURES,
  getRelationships,
  getResolutionOutcomes,
} from './graph-observations.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';
function targets(result, caller, method) {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === caller && edge.target === method)
    .map((edge) => edge.rel.targetId)
    .sort(compareCodeUnits);
}
async function verifyRecordsUnresolvedReceiversOnceAcrossReplayWithoutMerging() {
  // records unresolved receivers once across replay without merging distinct sites

  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-receiver-replay-'));
  try {
    copyResolutionProject(root, 'replayed-receiver-sites');
    const result = await runPipelineFromRepo(root, () => {});
    const drops = getResolutionOutcomes(result)
      .filter((outcome) => outcome.kind === 'suppressed')
      .filter((outcome) => outcome.reason === 'receiver-unresolved');
    assert.equal(drops.filter((outcome) => outcome.name === 'println').length, 2);
    assert.equal(
      drops.filter((outcome) => outcome.name === 'value' && outcome.siteKind === 'call').length,
      2,
    );
    const identities = drops.map((outcome) =>
      JSON.stringify([outcome.filePath, outcome.range, outcome.siteKind, outcome.name]),
    );
    assert.equal(new Set(identities).size, drops.length);
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}
async function verifyJavaImportedOverloadsAndDeclaredDispatchBounds() {
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-imported-overloads-'));
  try {
    copyResolutionProject(root, 'imported-overload-dispatch');
    const result = await runPipelineFromRepo(root, () => {});
    // retains the original child-interface bound during runtime dispatch
    {
      const ids = targets(result, 'childDispatch', 'task');
      assert.ok(ids.includes('Method:Dispatch.java:ChildImpl.task#0'));
      assert.ok(!ids.includes('Method:Dispatch.java:OtherImpl.task#0'));
    }
    // A replayed call sees implementations in the caller and its sibling files.
    const replayed = targets(result, 'returnedChild', 'task');
    assert.ok(replayed.includes('Method:ExternalChild.java:ExternalChild.task#0'));
    assert.ok(replayed.includes('Method:Dispatch.java:ChildImpl.task#0'));
    assert.ok(!replayed.includes('Method:Dispatch.java:OtherImpl.task#0'));
    // keeps a known anonymous receiver on its own implementation branch
    {
      const ids = targets(result, 'anonymousDispatch', 'task');
      assert.ok(ids.includes('Method:Dispatch.java:Dispatch$1.task#0'));
      assert.ok(!ids.includes('Method:Dispatch.java:ChildImpl.task#0'));
      assert.ok(!ids.includes('Method:Dispatch.java:OtherImpl.task#0'));
    }
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}
async function verifyJavaJLSOverloadResolutionIssue3789() {
  let original;
  original = await runPipelineFromRepo(path.join(FIXTURES, 'java-overload-types'), () => {});
  // retains the original six signatures and their exact direct caller counts
  {
    const expected = {
      'find#1~Collection<Long>': 3,
      'find#1~Long': 1,
      'resolve#1~String': 1,
      'resolve#1~Long': 1,
      'count#1': 2,
      'count#2': 1,
    };
    const calls = getRelationships(original, 'CALLS');
    for (const [signature, count] of Object.entries(expected)) {
      const id = `Method:src/main/java/demo/LookupService.java:LookupService.${signature}`;
      assert.notEqual(original.graph.getNode(id), undefined, signature);
      assert.equal(
        new Set(calls.filter((edge) => edge.rel.targetId === id).map((edge) => edge.rel.sourceId))
          .size,
        count,
        signature,
      );
    }
  }
}
async function verifyJavaCompileTimeOverloadFamilies() {
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-overload-jls-'));
  try {
    copyResolutionProject(root, 'compile-time-overloads');
    const result = await runPipelineFromRepo(root, () => {});
    // Each rejected call records its specific suppression reason.
    for (const [caller, method, status] of [
      ['nullAmbiguous', 'nullable', 'ambiguous'],
      ['crossedAmbiguous', 'crossed', 'ambiguous'],
      ['unknownArgument', 'opaque', 'inapplicable'],
      ['knownInapplicable', 'forbidden', 'inapplicable'],
      ['polyTie', 'polyAmbiguous', 'ambiguous'],
      ['staticUnqualified', 'staticChoice', 'inapplicable'],
      ['staticQualified', 'staticChoice', 'inapplicable'],
    ]) {
      assert.deepEqual(targets(result, caller, method), []);
      const reason = status === 'ambiguous' ? 'member-lookup-ambiguous' : `overload-${status}`;
      assert.ok(
        getResolutionOutcomes(result).some(
          (outcome) =>
            outcome.kind === 'suppressed' &&
            outcome.name === method &&
            outcome.reason === reason &&
            outcome.callerId?.includes(`.${caller}#`),
        ),
        `${caller} must record ${reason} for ${method}`,
      );
    }
    // The inherited field takes precedence over the enclosing field.
    for (const caller of ['inheritedByThis', 'inheritedImplicit']) {
      const calls = targets(result, caller, 'shadowPick');
      assert.equal(calls.length, 1);
      assert.deepEqual(result.graph.getNode(calls[0])?.properties.parameterTypes, ['String']);
    }
    // These calls have no published target. equivalentPreferred has a known String
    // argument, but its two inherited interfaces declare the same signature.
    for (const [caller, method] of [
      ['fakeFactory', 'select'],
      ['fieldFactory', 'select'],
      ['typeParameter', 'generic'],
      ['inheritedUnknown', 'select'],
      ['implicitObject', 'wait'],
      ['missingStaticType', 'select'],
      ['conflictingStaticTypes', 'select'],
      ['equivalentPreferred', 'preferred'],
    ]) {
      assert.deepEqual(targets(result, caller, method), []);
      assert.equal(
        getResolutionOutcomes(result).some(
          (outcome) =>
            outcome.kind === 'suppressed' &&
            outcome.name === method &&
            outcome.reason === 'overload-unknown' &&
            outcome.callerId?.includes(`.${caller}#`),
        ),
        true,
      );
    }
    // uses the selected interface declaration return despite a covariant implementation return

    assert.ok(targets(result, 'interfaceReturn', 'run').includes('Method:Cases.java:A.run#0'));
    assert.ok(!targets(result, 'interfaceReturn', 'run').includes('Method:Cases.java:B.run#0'));
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}
export async function checkOverloadContracts() {
  await verifyRecordsUnresolvedReceiversOnceAcrossReplayWithoutMerging();
  await verifyJavaImportedOverloadsAndDeclaredDispatchBounds();
  await verifyJavaJLSOverloadResolutionIssue3789();
  await verifyJavaCompileTimeOverloadFamilies();
}
