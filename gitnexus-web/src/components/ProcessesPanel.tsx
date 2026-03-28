/**
 * Processes Panel
 *
 * Lists all detected processes grouped by type (cross-community / intra-community).
 * Clicking a process opens the ProcessFlowModal with a flowchart.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  GitBranch,
  Search,
  Eye,
  Zap,
  Home,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Lightbulb,
  Layers,
} from 'lucide-react';
import { useAppState } from '../hooks/useAppState';
import { ProcessFlowModal } from './ProcessFlowModal';
import type { ProcessData, ProcessStep } from '../lib/mermaid-generator';

/** Validate that an ID contains only expected node identifier characters (no Cypher metacharacters or spaces) */
const isSafeId = (id: string): boolean => /^[a-zA-Z0-9_:.\-/@]+$/.test(id);

export const ProcessesPanel = () => {
  const { graph, runQuery, setHighlightedNodeIds, highlightedNodeIds } = useAppState();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProcess, setSelectedProcess] = useState<ProcessData | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['cross', 'intra']),
  );
  const [loadingProcess, setLoadingProcess] = useState<string | null>(null);
  const [focusedProcessId, setFocusedProcessId] = useState<string | null>(null);

  // Extract processes from graph
  const processes = useMemo(() => {
    if (!graph) return { cross: [], intra: [] };

    const processNodes = graph.nodes.filter((n) => n.label === 'Process');

    const cross: Array<{ id: string; label: string; stepCount: number; clusters: string[] }> = [];
    const intra: Array<{ id: string; label: string; stepCount: number; clusters: string[] }> = [];

    for (const node of processNodes) {
      const item = {
        id: node.id,
        label: node.properties.heuristicLabel || node.properties.name || node.id,
        stepCount: node.properties.stepCount || 0,
        clusters: node.properties.communities || [],
      };

      if (node.properties.processType === 'cross_community') {
        cross.push(item);
      } else {
        intra.push(item);
      }
    }

    // Sort by step count (most complex first)
    cross.sort((a, b) => b.stepCount - a.stepCount);
    intra.sort((a, b) => b.stepCount - a.stepCount);

    return { cross, intra };
  }, [graph]);

  // Filter by search
  const filteredProcesses = useMemo(() => {
    if (!searchQuery.trim()) return processes;

    const query = searchQuery.toLowerCase();
    return {
      cross: processes.cross.filter((p) => p.label.toLowerCase().includes(query)),
      intra: processes.intra.filter((p) => p.label.toLowerCase().includes(query)),
    };
  }, [processes, searchQuery]);

  // Toggle section expansion
  const toggleSection = useCallback((section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  // Load ALL processes and combine into one mega-diagram
  const handleViewAllProcesses = useCallback(async () => {
    setLoadingProcess('all');

    try {
      const allProcessIds = [...processes.cross, ...processes.intra]
        .map((p) => p.id)
        .filter(isSafeId);

      if (allProcessIds.length === 0) return;

      // Collect all steps from all processes
      const allStepsMap = new Map<string, ProcessStep>();
      const allEdges: Array<{ from: string; to: string; type: string }> = [];

      // Fetch steps for all processes concurrently in batches if needed, but for now sequentially to be safe
      // Optimization: Fetch all steps in one query if possible
      const allStepsQuery = `
                MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
                WHERE p.id IN [${allProcessIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')}]
                RETURN s.id AS id, s.name AS name, s.filePath AS filePath, r.step AS stepNumber
            `;

      const stepsResult = await runQuery(allStepsQuery);

      for (const row of stepsResult) {
        const stepId = row.id || row[0];
        if (!allStepsMap.has(stepId)) {
          allStepsMap.set(stepId, {
            id: stepId,
            name: row.name || row[1] || 'Unknown',
            filePath: row.filePath || row[2],
            stepNumber: row.stepNumber || row.step || row[3] || 0,
          });
        }
      }

      const allSteps = Array.from(allStepsMap.values());
      const stepIds = allSteps.map((s) => s.id).filter(isSafeId);

      // Query for all CALLS edges between the combined steps
      if (stepIds.length > 0) {
        // Batch query if too many steps
        const edgesQuery = `
                    MATCH (from)-[r:CodeRelation {type: 'CALLS'}]->(to)
                    WHERE from.id IN [${stepIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')}]
                      AND to.id IN [${stepIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')}]
                    RETURN from.id AS fromId, to.id AS toId, r.type AS type
                `;

        try {
          const edgesResult = await runQuery(edgesQuery);
          allEdges.push(
            ...edgesResult
              .map((row: any) => ({
                from: row.fromId || row[0],
                to: row.toId || row[1],
                type: row.type || row[2] || 'CALLS',
              }))
              .filter((edge) => edge.from !== edge.to),
          );
        } catch (err) {
          console.warn('Could not fetch combined edges:', err);
        }
      }

      const combinedProcessData: ProcessData = {
        id: 'combined-all',
        label: `All Processes (${allProcessIds.length} combined)`,
        processType: 'cross_community', // Treat as cross-community for styling
        steps: allSteps,
        edges: allEdges,
        clusters: [],
      };

      setSelectedProcess(combinedProcessData);
    } catch (error) {
      console.error('Failed to load combined processes:', error);
    } finally {
      setLoadingProcess(null);
    }
  }, [processes, runQuery]);

  // Load process steps and open modal
  const handleViewProcess = useCallback(
    async (processId: string, label: string, processType: string) => {
      if (!isSafeId(processId)) return;
      setLoadingProcess(processId);

      try {
        // Query for process steps
        const stepsQuery = `
        MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${processId.replace(/'/g, "''")}'})
        RETURN s.id AS id, s.name AS name, s.filePath AS filePath, r.step AS stepNumber
        ORDER BY r.step
      `;

        const stepsResult = await runQuery(stepsQuery);

        const steps: ProcessStep[] = stepsResult.map((row: any) => ({
          id: row.id || row[0],
          name: row.name || row[1] || 'Unknown',
          filePath: row.filePath || row[2],
          stepNumber: row.stepNumber || row.step || row[3] || 0,
        }));

        // Get step IDs for edge query
        const stepIds = steps.map((s) => s.id).filter(isSafeId);

        // Query for CALLS edges between the steps in this process
        let edges: Array<{ from: string; to: string; type: string }> = [];
        if (stepIds.length > 0) {
          const edgesQuery = `
          MATCH (from)-[r:CodeRelation {type: 'CALLS'}]->(to)
          WHERE from.id IN [${stepIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')}]
            AND to.id IN [${stepIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')}]
          RETURN from.id AS fromId, to.id AS toId, r.type AS type
        `;

          try {
            const edgesResult = await runQuery(edgesQuery);
            edges = edgesResult
              .map((row: any) => ({
                from: row.fromId || row[0],
                to: row.toId || row[1],
                type: row.type || row[2] || 'CALLS',
              }))
              .filter((edge) => edge.from !== edge.to); // Remove self-loops
          } catch (err) {
            console.warn('Could not fetch edges:', err);
            // Continue with empty edges - will fallback to linear
          }
        }

        // Get clusters for this process
        const processNode = graph?.nodes.find((n) => n.id === processId);
        const clusters = processNode?.properties.communities || [];

        const processData: ProcessData = {
          id: processId,
          label,
          processType: processType as 'cross_community' | 'intra_community',
          steps,
          edges,
          clusters,
        };

        setSelectedProcess(processData);
      } catch (error) {
        console.error('Failed to load process steps:', error);
      } finally {
        setLoadingProcess(null);
      }
    },
    [runQuery, graph],
  );

  // Cache for process steps (so we don't re-query when toggling focus)
  const [processStepsCache, setProcessStepsCache] = useState<Map<string, string[]>>(new Map());

  // Toggle focus for any process - loads steps on demand
  const handleToggleFocusForProcess = useCallback(
    async (processId: string) => {
      if (!isSafeId(processId)) return;
      // If already focused on this process, turn off
      if (focusedProcessId === processId) {
        setHighlightedNodeIds(new Set());
        setFocusedProcessId(null);
        return;
      }

      // Check if we have cached steps
      if (processStepsCache.has(processId)) {
        const stepIds = processStepsCache.get(processId)!;
        setHighlightedNodeIds(new Set(stepIds));
        setFocusedProcessId(processId);
        return;
      }

      // Load steps for this process
      setLoadingProcess(processId);
      try {
        const stepsQuery = `
                MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${processId.replace(/'/g, "''")}'})
                RETURN s.id AS id
            `;
        const stepsResult = await runQuery(stepsQuery);
        const stepIds = stepsResult.map((row: any) => row.id || row[0]);

        // Cache the result
        setProcessStepsCache((prev) => new Map(prev).set(processId, stepIds));

        // Set focus
        setHighlightedNodeIds(new Set(stepIds));
        setFocusedProcessId(processId);
      } catch (error) {
        console.error('Failed to load process steps for focus:', error);
      } finally {
        setLoadingProcess(null);
      }
    },
    [focusedProcessId, processStepsCache, runQuery, setHighlightedNodeIds],
  );

  // Focus in graph callback - toggles highlight (used by modal)
  const handleFocusInGraph = useCallback(
    (nodeIds: string[], processId: string) => {
      // Check if this process is already focused
      if (focusedProcessId === processId) {
        // Clear focus
        setHighlightedNodeIds(new Set());
        setFocusedProcessId(null);
      } else {
        // Set focus and cache
        setHighlightedNodeIds(new Set(nodeIds));
        setFocusedProcessId(processId);
        setProcessStepsCache((prev) => new Map(prev).set(processId, nodeIds));
      }
    },
    [focusedProcessId, setHighlightedNodeIds],
  );

  // Clear focused process when highlights are cleared externally
  useEffect(() => {
    if (highlightedNodeIds.size === 0 && focusedProcessId !== null) {
      setFocusedProcessId(null);
    }
  }, [highlightedNodeIds, focusedProcessId]);

  const totalCount = processes.cross.length + processes.intra.length;

  if (totalCount === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-surface">
          <GitBranch className="h-7 w-7 text-text-muted" />
        </div>
        <h3 className="mb-2 text-base font-medium text-text-primary">No Processes Detected</h3>
        <p className="max-w-xs text-sm text-text-secondary">
          Processes are execution flows traced from entry points. Load a codebase to see detected
          processes.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header with search */}
      <div className="border-b border-border-subtle p-3">
        <div className="mb-2 flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-border-subtle bg-elevated px-3 py-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
            <Search className="h-4 w-4 text-text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter processes..."
              className="flex-1 border-none bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
            />
          </div>
        </div>
        <div
          className="flex items-center gap-2 text-xs text-text-muted"
          data-testid="process-list-loaded"
        >
          <span>{totalCount} processes detected</span>
        </div>
      </div>

      {/* Process list */}
      <div className="scrollbar-thin flex-1 overflow-y-auto">
        {/* View All Processes Card */}
        <div className="px-4 py-3">
          <button
            onClick={handleViewAllProcesses}
            disabled={loadingProcess !== null}
            className="group flex w-full items-center gap-3 rounded-xl border border-border-subtle bg-elevated/40 p-3 text-left shadow-sm transition-all hover:border-cyan-500/30 hover:bg-elevated/80 hover:shadow-cyan-900/10"
          >
            <div className="rounded-lg bg-cyan-500/10 p-2 transition-colors group-hover:bg-cyan-500/20">
              <Layers className="h-5 w-5 text-cyan-400" />
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-medium text-text-primary group-hover:text-cyan-200">
                Full Process Map
              </h4>
              <p className="text-xs text-text-muted">View combined map of {totalCount} processes</p>
            </div>
            {loadingProcess === 'all' ? (
              <span className="mr-1 animate-spin">
                <Sparkles className="h-4 w-4 text-cyan-400" />
              </span>
            ) : (
              <Eye className="h-4 w-4 text-text-muted group-hover:text-cyan-400" />
            )}
          </button>
        </div>

        {/* Cross-Community Section */}
        {filteredProcesses.cross.length > 0 && (
          <div className="border-b border-border-subtle">
            <button
              onClick={() => toggleSection('cross')}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-hover"
            >
              {expandedSections.has('cross') ? (
                <ChevronDown className="h-4 w-4 text-text-muted" />
              ) : (
                <ChevronRight className="h-4 w-4 text-text-muted" />
              )}
              <Zap className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-medium text-text-primary">Cross-Community</span>
              <span className="ml-auto rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                {filteredProcesses.cross.length}
              </span>
            </button>

            {expandedSections.has('cross') && (
              <div className="pb-2">
                {filteredProcesses.cross.map((process) => (
                  <ProcessItem
                    key={process.id}
                    process={process}
                    isLoading={loadingProcess === process.id}
                    isSelected={selectedProcess?.id === process.id}
                    isFocused={focusedProcessId === process.id}
                    onView={() => handleViewProcess(process.id, process.label, 'cross_community')}
                    onToggleFocus={() => handleToggleFocusForProcess(process.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Intra-Community Section */}
        {filteredProcesses.intra.length > 0 && (
          <div>
            <button
              onClick={() => toggleSection('intra')}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-hover"
            >
              {expandedSections.has('intra') ? (
                <ChevronDown className="h-4 w-4 text-text-muted" />
              ) : (
                <ChevronRight className="h-4 w-4 text-text-muted" />
              )}
              <Home className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-medium text-text-primary">Intra-Community</span>
              <span className="ml-auto rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                {filteredProcesses.intra.length}
              </span>
            </button>

            {expandedSections.has('intra') && (
              <div className="pb-2">
                {filteredProcesses.intra.map((process) => (
                  <ProcessItem
                    key={process.id}
                    process={process}
                    isLoading={loadingProcess === process.id}
                    isSelected={selectedProcess?.id === process.id}
                    isFocused={focusedProcessId === process.id}
                    onView={() => handleViewProcess(process.id, process.label, 'intra_community')}
                    onToggleFocus={() => handleToggleFocusForProcess(process.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal */}
      <ProcessFlowModal
        process={selectedProcess}
        onClose={() => setSelectedProcess(null)}
        onFocusInGraph={handleFocusInGraph}
        isFullScreen={selectedProcess?.id === 'combined-all'}
      />
    </div>
  );
};

// Individual process item
interface ProcessItemProps {
  process: { id: string; label: string; stepCount: number; clusters: string[] };
  isLoading: boolean;
  isSelected: boolean;
  isFocused: boolean;
  onView: () => void;
  onToggleFocus: () => void;
}

const ProcessItem = ({
  process,
  isLoading,
  isSelected,
  isFocused,
  onView,
  onToggleFocus,
}: ProcessItemProps) => {
  // Determine row styling - focused gets special highlight
  const rowClass = isFocused
    ? 'bg-amber-950/40 border border-amber-500/50 ring-1 ring-amber-400/30'
    : isSelected
      ? 'bg-cyan-950/40 border border-cyan-500/50 ring-1 ring-cyan-400/30'
      : '';

  return (
    <div
      data-testid="process-row"
      className={`group mx-2 flex items-center gap-2 rounded-lg px-4 py-2 transition-all hover:bg-hover ${rowClass}`}
    >
      <GitBranch className="h-4 w-4 flex-shrink-0 text-text-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-text-primary">{process.label}</div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span>{process.stepCount} steps</span>
          {process.clusters.length > 0 && (
            <>
              <span>•</span>
              <span>{process.clusters.length} clusters</span>
            </>
          )}
        </div>
      </div>
      {/* Lightbulb icon - appears on hover, always visible when focused */}
      <button
        onClick={onToggleFocus}
        className={`rounded-md p-1.5 transition-all ${
          isFocused
            ? 'animate-pulse border border-amber-400/40 bg-amber-500/20 text-amber-400 opacity-100 hover:bg-amber-500/30 hover:text-amber-300'
            : 'border border-white/10 bg-white/5 text-text-muted opacity-0 group-hover:opacity-100 hover:border-cyan-400/40 hover:bg-cyan-500/20 hover:text-cyan-400'
        }`}
        title={isFocused ? 'Click to remove highlight from graph' : 'Click to highlight in graph'}
        data-testid="process-highlight-button"
      >
        <Lightbulb className="h-4 w-4" />
      </button>
      <button
        onClick={onView}
        disabled={isLoading}
        data-testid="process-view-button"
        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium shadow-sm transition-all disabled:opacity-50 ${
          isSelected
            ? 'border border-cyan-400/60 bg-cyan-900/60 text-cyan-300 opacity-100'
            : 'border border-cyan-500/30 bg-cyan-950/30 text-cyan-400 opacity-0 shadow-cyan-900/20 group-hover:opacity-100 hover:border-cyan-400/50 hover:bg-cyan-900/50 hover:text-cyan-300'
        }`}
      >
        {isLoading ? (
          <span className="animate-pulse">Loading...</span>
        ) : isSelected ? (
          <>
            <Eye className="h-3.5 w-3.5" />
            Viewing
          </>
        ) : (
          <>
            <Eye className="h-3.5 w-3.5" />
            View
          </>
        )}
      </button>
    </div>
  );
};
