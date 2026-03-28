/**
 * JCL Processor — Converts JCL parse results into graph nodes and edges.
 *
 * Maps JCL entities to existing graph types (no new tables):
 * - Job    -> CodeElement (description: "jcl-job class:A msgclass:X")
 * - Step   -> CodeElement (description: "jcl-step pgm:PROGRAMNAME")
 * - Dataset -> CodeElement (description: "jcl-dataset disp:SHR")
 * - PROC   -> Module
 *
 * Edges:
 * - Job CONTAINS Step
 * - Step CALLS Module (when PGM= matches an indexed program)
 * - Step references Dataset (CALLS edge with reason "jcl-dd")
 * - Job/Step IMPORTS PROC
 *
 * Pattern follows detectCrossProgamContracts() in pipeline.ts.
 */

import { parseJcl, type JclParseResults } from './jcl-parser.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import { generateId } from '../../../lib/utils.js';

export interface JclProcessResult {
  jobCount: number;
  stepCount: number;
  datasetCount: number;
  programLinks: number;
}

/**
 * Process JCL files and integrate into the knowledge graph.
 *
 * @param graph - The in-memory knowledge graph
 * @param jclPaths - File paths of JCL files
 * @param jclContents - Map of path -> file content
 * @returns Summary of what was added
 */
export function processJclFiles(
  graph: KnowledgeGraph,
  jclPaths: string[],
  jclContents: Map<string, string>,
): JclProcessResult {
  let jobCount = 0;
  let stepCount = 0;
  let datasetCount = 0;
  let programLinks = 0;

  // Collect all Module names for step -> program linking
  const moduleNames = new Map<string, string>(); // uppercase name -> node id
  graph.forEachNode((node) => {
    if (node.label === 'Module') {
      const nodeName = node.properties.name;
      if (typeof nodeName === 'string') {
        moduleNames.set(nodeName.toUpperCase(), node.id);
      }
    }
  });

  for (const filePath of jclPaths) {
    const content = jclContents.get(filePath);
    if (!content) continue;

    const parsed = parseJcl(content, filePath);
    const result = integrateJclResults(graph, parsed, filePath, moduleNames);

    jobCount += result.jobCount;
    stepCount += result.stepCount;
    datasetCount += result.datasetCount;
    programLinks += result.programLinks;
  }

  return { jobCount, stepCount, datasetCount, programLinks };
}

function integrateJclResults(
  graph: KnowledgeGraph,
  parsed: JclParseResults,
  filePath: string,
  moduleNames: Map<string, string>,
): JclProcessResult {
  let jobCount = 0;
  let stepCount = 0;
  let datasetCount = 0;
  let programLinks = 0;

  // Track step node IDs for DD -> step linking
  const stepNodeIds = new Map<string, string>(); // stepName -> nodeId

  // 1. Create Job nodes
  for (const job of parsed.jobs) {
    const jobId = generateId('CodeElement', `${filePath}:job:${job.name}`);
    const classPart = job.class ? ` class:${job.class}` : '';
    const msgPart = job.msgclass ? ` msgclass:${job.msgclass}` : '';

    graph.addNode({
      id: jobId,
      label: 'CodeElement',
      properties: {
        name: job.name,
        filePath,
        startLine: job.line,
        endLine: job.line,
        description: `jcl-job${classPart}${msgPart}`,
      },
    });

    // Link File -> Job (CONTAINS)
    const fileId = generateId('File', filePath);
    graph.addRelationship({
      id: `${fileId}_contains_${jobId}`,
      type: 'CONTAINS',
      sourceId: fileId,
      targetId: jobId,
      confidence: 1.0,
      reason: 'jcl-job',
    });

    jobCount++;
  }

  // 1.5 Pre-register in-stream PROCs so steps can reference them
  // (fixes ordering bug: steps processed before PROCs were registered)
  for (const proc of parsed.procs) {
    const procId = generateId('Module', `${filePath}:proc:${proc.name}`);
    moduleNames.set(proc.name.toUpperCase(), procId);
  }

  // 2. Create Step nodes and link to programs
  for (const step of parsed.steps) {
    const stepId = generateId('CodeElement', `${filePath}:step:${step.jobName}:${step.name}`);
    const pgmPart = step.program ? ` pgm:${step.program}` : '';
    const procPart = step.proc ? ` proc:${step.proc}` : '';

    graph.addNode({
      id: stepId,
      label: 'CodeElement',
      properties: {
        name: step.name,
        filePath,
        startLine: step.line,
        endLine: step.line,
        description: `jcl-step${pgmPart}${procPart}`,
      },
    });

    stepNodeIds.set(step.name, stepId);

    // Link Job -> Step (CONTAINS)
    if (step.jobName) {
      const jobId = generateId('CodeElement', `${filePath}:job:${step.jobName}`);
      graph.addRelationship({
        id: `${jobId}_contains_${stepId}`,
        type: 'CONTAINS',
        sourceId: jobId,
        targetId: stepId,
        confidence: 1.0,
        reason: 'jcl-step',
      });
    }

    // Link Step -> Module (CALLS) when PGM= matches an indexed program
    if (step.program) {
      const moduleId = moduleNames.get(step.program.toUpperCase());
      if (moduleId) {
        graph.addRelationship({
          id: `${stepId}_calls_${moduleId}`,
          type: 'CALLS',
          sourceId: stepId,
          targetId: moduleId,
          confidence: 0.95,
          reason: 'jcl-exec-pgm',
        });
        programLinks++;
      }
    }

    // Link Step -> PROC (CALLS) — PROC as Module
    if (step.proc) {
      const procModuleId = moduleNames.get(step.proc.toUpperCase());
      if (procModuleId) {
        graph.addRelationship({
          id: `${stepId}_calls_proc_${procModuleId}`,
          type: 'CALLS',
          sourceId: stepId,
          targetId: procModuleId,
          confidence: 0.9,
          reason: 'jcl-exec-proc',
        });
      }
    }

    stepCount++;
  }

  // 3. Create Dataset nodes from DD statements
  const seenDatasets = new Set<string>();
  for (const dd of parsed.ddStatements) {
    if (!dd.dataset) continue;

    // Create dataset node (deduplicated per file)
    const datasetKey = `${filePath}:dataset:${dd.dataset}`;
    const datasetId = generateId('CodeElement', datasetKey);

    if (!seenDatasets.has(dd.dataset)) {
      const dispPart = dd.disp ? ` disp:${dd.disp}` : '';
      graph.addNode({
        id: datasetId,
        label: 'CodeElement',
        properties: {
          name: dd.dataset,
          filePath,
          startLine: dd.line,
          endLine: dd.line,

          description: `jcl-dataset${dispPart}`,
        },
      });
      seenDatasets.add(dd.dataset);
      datasetCount++;
    }

    // Link Step -> Dataset (CALLS with reason jcl-dd)
    const stepId = stepNodeIds.get(dd.stepName);
    if (stepId) {
      graph.addRelationship({
        id: `${stepId}_dd_${dd.ddName}_${datasetId}`,
        type: 'CALLS',
        sourceId: stepId,
        targetId: datasetId,
        confidence: 0.85,
        reason: `jcl-dd:${dd.ddName}`,
      });
    }
  }

  // 4. Create PROC nodes (in-stream procs as Module)
  for (const proc of parsed.procs) {
    if (!proc.isInStream) continue;

    const procId = generateId('Module', `${filePath}:proc:${proc.name}`);
    graph.addNode({
      id: procId,
      label: 'Module',
      properties: {
        name: proc.name,
        filePath,
        startLine: proc.line,
        endLine: proc.line,
        description: 'jcl-proc-instream',
      },
    });

    // Register for step linking
    moduleNames.set(proc.name.toUpperCase(), procId);
  }

  // 5. INCLUDE directives -> IMPORTS edges
  for (const inc of parsed.includes) {
    const moduleId = moduleNames.get(inc.member.toUpperCase());
    if (moduleId) {
      const fileId = generateId('File', filePath);
      graph.addRelationship({
        id: `${fileId}_includes_${moduleId}`,
        type: 'IMPORTS',
        sourceId: fileId,
        targetId: moduleId,
        confidence: 0.9,
        reason: 'jcl-include',
      });
    }
  }

  return { jobCount, stepCount, datasetCount, programLinks };
}
