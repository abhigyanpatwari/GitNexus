/**
 * Mermaid Diagram Generator for Processes
 *
 * Generates Mermaid flowchart syntax from Process step data.
 * Designed to show branching/merging when CALLS edges exist between steps.
 */

export interface ProcessStep {
  id: string;
  name: string;
  filePath?: string;
  stepNumber: number;
  cluster?: string;
}

export interface ProcessEdge {
  from: string;
  to: string;
  type: string;
}

export interface ProcessData {
  id: string;
  label: string;
  processType: 'intra_community' | 'cross_community';
  steps: ProcessStep[];
  edges?: ProcessEdge[]; // CALLS edges between steps for branching
  clusters?: string[];
  rawMermaid?: string; // AI-generated mermaid code (sanitized before rendering)
}

/**
 * Generate Mermaid flowchart from process data
 */
export function generateProcessMermaid(process: ProcessData): string {
  const { steps, edges, clusters } = process;

  if (!steps || steps.length === 0) {
    return 'graph TD\n  A[No steps found]';
  }

  const lines: string[] = ['graph TD'];

  // Add class definitions for styling (rounded corners + colors)
  lines.push('  %% Styles');
  lines.push(
    '  classDef default fill:#1e293b,stroke:#94a3b8,stroke-width:3px,color:#f8fafc,rx:10,ry:10,font-size:24px;',
  );
  lines.push(
    '  classDef entry fill:#1e293b,stroke:#34d399,stroke-width:5px,color:#f8fafc,rx:10,ry:10,font-size:24px;',
  );
  lines.push(
    '  classDef step fill:#1e293b,stroke:#22d3ee,stroke-width:3px,color:#f8fafc,rx:10,ry:10,font-size:24px;',
  );
  lines.push(
    '  classDef terminal fill:#1e293b,stroke:#f472b6,stroke-width:5px,color:#f8fafc,rx:10,ry:10,font-size:24px;',
  );
  lines.push(
    '  classDef cluster fill:#0f172a,stroke:#334155,stroke-width:3px,color:#94a3b8,rx:4,ry:4,font-size:20px;',
  );

  // Track clusters for subgraph grouping
  const clusterGroups = new Map<string, ProcessStep[]>();
  const noCluster: ProcessStep[] = [];

  for (const step of steps) {
    if (step.cluster) {
      const group = clusterGroups.get(step.cluster) || [];
      group.push(step);
      clusterGroups.set(step.cluster, group);
    } else {
      noCluster.push(step);
    }
  }

  // Generate node IDs (sanitized) - use actual ID to avoid collisions when combining processes
  const nodeId = (step: ProcessStep) => {
    // Sanitize the actual ID to be Mermaid-safe
    return step.id.replace(/[^a-zA-Z0-9_]/g, '_');
  };
  const sanitizeLabel = (text: string) => text.replace(/["\[\]<>{}()]/g, '').substring(0, 30);
  const getFileName = (path?: string) => path?.split('/').pop() || '';

  // Determine node class (entry, terminal, or normal step)
  const sortedStepsRef = [...steps].sort((a, b) => a.stepNumber - b.stepNumber);
  const entryId = sortedStepsRef[0]?.id;
  const terminalId = sortedStepsRef[sortedStepsRef.length - 1]?.id;

  const getNodeClass = (step: ProcessStep) => {
    if (step.id === entryId) return 'entry';
    if (step.id === terminalId) return 'terminal';
    return 'step';
  };

  // If we have cluster groupings and cross-community, use subgraphs
  const useClusters = process.processType === 'cross_community' && clusterGroups.size > 1;

  if (useClusters) {
    // Generate subgraphs for each cluster
    let clusterIndex = 0;

    for (const [clusterName, clusterSteps] of clusterGroups) {
      lines.push(
        `  subgraph ${sanitizeLabel(clusterName)}["${sanitizeLabel(clusterName)}"]:::cluster`,
      );

      for (const step of clusterSteps) {
        const id = nodeId(step);
        const label = `${step.stepNumber}. ${sanitizeLabel(step.name)}`;
        const file = getFileName(step.filePath);
        const className = getNodeClass(step);
        lines.push(`    ${id}["${label}<br/><small>${file}</small>"]:::${className}`);
      }
      lines.push('  end');
      clusterIndex++;
    }

    // Add unclustered steps
    for (const step of noCluster) {
      const id = nodeId(step);
      const label = `${step.stepNumber}. ${sanitizeLabel(step.name)}`;
      const file = getFileName(step.filePath);
      const className = getNodeClass(step);
      lines.push(`  ${id}["${label}<br/><small>${file}</small>"]:::${className}`);
    }
  } else {
    // Simple flat layout
    for (const step of steps) {
      const id = nodeId(step);
      const label = `${step.stepNumber}. ${sanitizeLabel(step.name)}`;
      const file = getFileName(step.filePath);
      const className = getNodeClass(step);
      lines.push(`  ${id}["${label}<br/><small>${file}</small>"]:::${className}`);
    }
  }

  // Generate edges
  if (edges && edges.length > 0) {
    // Use actual CALLS edges for branching
    const stepById = new Map(steps.map((s) => [s.id, s]));
    for (const edge of edges) {
      const fromStep = stepById.get(edge.from);
      const toStep = stepById.get(edge.to);
      if (fromStep && toStep) {
        lines.push(`  ${nodeId(fromStep)} --> ${nodeId(toStep)}`);
      }
    }
    // Ensure all nodes are connected (fallback for disconnected components)
    // For now assume graph is connected enough or user accepts fragments.
  } else {
    // Fallback: linear chain based on step order
    const sortedSteps = [...steps].sort((a, b) => a.stepNumber - b.stepNumber);
    for (let i = 0; i < sortedSteps.length - 1; i++) {
      lines.push(`  ${nodeId(sortedSteps[i])} --> ${nodeId(sortedSteps[i + 1])}`);
    }
  }

  return lines.join('\n');
}

/**
 * Simple linear mermaid for quick preview
 */
export function generateSimpleMermaid(processLabel: string, stepCount: number): string {
  const [entry, terminal] = processLabel.split(' → ').map((s) => s.trim());

  return `graph LR
  classDef entry fill:#059669,stroke:#34d399,stroke-width:2px,color:#ffffff,rx:10,ry:10;
  classDef terminal fill:#be185d,stroke:#f472b6,stroke-width:2px,color:#ffffff,rx:10,ry:10;
  A["🟢 ${entry || 'Start'}"]:::entry --> B["... ${stepCount - 2} steps ..."] --> C["🔴 ${terminal || 'End'}"]:::terminal`;
}
