import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileCode,
  Search,
  Filter,
  PanelLeftClose,
  PanelLeft,
  Box,
  Braces,
  Variable,
  Hash,
  Target,
  List,
  AtSign,
  Type,
} from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import { FILTERABLE_LABELS, NODE_COLORS, ALL_EDGE_TYPES, EDGE_INFO, type EdgeType } from '../lib/constants';
import { GraphNode, NodeLabel } from '../core/graph/types';

// Tree node structure
interface TreeNode {
  id: string;
  name: string;
  type: 'folder' | 'file';
  path: string;
  children: TreeNode[];
  graphNode?: GraphNode;
}

// Build tree from graph nodes
const buildFileTree = (nodes: GraphNode[]): TreeNode[] => {
  const root: TreeNode[] = [];
  const pathMap = new Map<string, TreeNode>();

  // Filter to only folders and files
  const fileNodes = nodes.filter(n => n.label === 'Folder' || n.label === 'File');

  // Sort by path to ensure parents come before children
  fileNodes.sort((a, b) => a.properties.filePath.localeCompare(b.properties.filePath));

  fileNodes.forEach(node => {
    const parts = node.properties.filePath.split('/').filter(Boolean);
    let currentPath = '';
    let currentLevel = root;

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let existing = pathMap.get(currentPath);

      if (!existing) {
        const isLastPart = index === parts.length - 1;
        const isFile = isLastPart && node.label === 'File';

        existing = {
          id: isLastPart ? node.id : currentPath,
          name: part,
          type: isFile ? 'file' : 'folder',
          path: currentPath,
          children: [],
          graphNode: isLastPart ? node : undefined,
        };

        pathMap.set(currentPath, existing);
        currentLevel.push(existing);
      }

      currentLevel = existing.children;
    });
  });

  return root;
};

// Tree item component
interface TreeItemProps {
  node: TreeNode;
  depth: number;
  searchQuery: string;
  onNodeClick: (node: TreeNode) => void;
  expandedPaths: Set<string>;
  toggleExpanded: (path: string) => void;
  selectedPath: string | null;
}

const TreeItem = ({
  node,
  depth,
  searchQuery,
  onNodeClick,
  expandedPaths,
  toggleExpanded,
  selectedPath,
}: TreeItemProps) => {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  const hasChildren = node.children.length > 0;

  // Filter children based on search (recursive)
  const filteredChildren = useMemo(() => {
    if (!searchQuery) return node.children;
    const searchLower = searchQuery.toLowerCase();
    const matchesSearch = (node: TreeNode, query: string): boolean => {
      if (node.name.toLowerCase().includes(query)) return true;
      return node.children?.some(child => matchesSearch(child, query)) ?? false;
    };
    return node.children.filter(child => matchesSearch(child, searchLower));
  }, [node.children, searchQuery]);

  // Check if this node matches search
  const matchesSearch = searchQuery && node.name.toLowerCase().includes(searchQuery.toLowerCase());

  const handleClick = () => {
    if (hasChildren) {
      toggleExpanded(node.path);
    }
    onNodeClick(node);
  };

  return (
    <div>
      <button
        onClick={handleClick}
        className={`
          w-full flex items-center gap-1.5 px-2 py-1 text-left text-sm
          hover:bg-hover transition-colors rounded relative
          ${isSelected ? 'bg-amber-500/15 text-amber-300 border-l-2 border-amber-400' : 'text-text-secondary hover:text-text-primary border-l-2 border-transparent'}
          ${matchesSearch ? 'bg-accent/10' : ''}
        `}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {/* Expand/collapse icon */}
        {hasChildren ? (
          isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0 text-text-muted" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-text-muted" />
          )
        ) : (
          <span className="w-3.5" />
        )}

        {/* Node icon */}
        {node.type === 'folder' ? (
          isExpanded ? (
            <FolderOpen className="w-4 h-4 shrink-0" style={{ color: NODE_COLORS.Folder }} />
          ) : (
            <Folder className="w-4 h-4 shrink-0" style={{ color: NODE_COLORS.Folder }} />
          )
        ) : (
          <FileCode className="w-4 h-4 shrink-0" style={{ color: NODE_COLORS.File }} />
        )}

        {/* Name */}
        <span className="truncate font-mono text-xs">{node.name}</span>
      </button>

      {/* Children */}
      {isExpanded && filteredChildren.length > 0 && (
        <div>
          {filteredChildren.map(child => (
            <TreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              searchQuery={searchQuery}
              onNodeClick={onNodeClick}
              expandedPaths={expandedPaths}
              toggleExpanded={toggleExpanded}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// Icon for node types
const getNodeTypeIcon = (label: NodeLabel) => {
  switch (label) {
    case 'Folder': return Folder;
    case 'File': return FileCode;
    case 'Class': return Box;
    case 'Function': return Braces;
    case 'Method': return Braces;
    case 'Interface': return Hash;
    case 'Enum': return List;
    case 'Type': return Type;
    case 'Decorator': return AtSign;
    case 'Import': return FileCode;
    case 'Variable': return Variable;
    default: return Variable;
  }
};

interface FileTreePanelProps {
  onFocusNode: (nodeId: string) => void;
}

export const FileTreePanel = ({ onFocusNode }: FileTreePanelProps) => {
  const { graph, visibleLabels, toggleLabelVisibility, visibleEdgeTypes, toggleEdgeVisibility, selectedNode, setSelectedNode, openCodePanel, depthFilter, setDepthFilter } = useAppState();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<'files' | 'filters'>('files');

  // Build file tree from graph
  const fileTree = useMemo(() => {
    if (!graph) return [];
    return buildFileTree(graph.nodes);
  }, [graph]);

  // Auto-expand first level on initial load
  useEffect(() => {
    if (fileTree.length > 0 && expandedPaths.size === 0) {
      const firstLevel = new Set(fileTree.map(n => n.path));
      setExpandedPaths(firstLevel);
    }
  }, [fileTree.length]); // Only run when tree first loads

  // Auto-expand to selected file when selectedNode changes (e.g., from graph click)
  useEffect(() => {
    const path = selectedNode?.properties?.filePath;
    if (!path) return;

    // Expand all parent folders leading to this file
    const parts = path.split('/').filter(Boolean);
    const pathsToExpand: string[] = [];
    let currentPath = '';

    // Build all parent paths (exclude the last part if it's a file)
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      pathsToExpand.push(currentPath);
    }

    if (pathsToExpand.length > 0) {
      setExpandedPaths(prev => {
        const next = new Set(prev);
        pathsToExpand.forEach(p => next.add(p));
        return next;
      });
    }
  }, [selectedNode?.id]); // Trigger when selected node changes

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleNodeClick = useCallback((treeNode: TreeNode) => {
    if (treeNode.graphNode) {
      // Only focus if selecting a different node
      const isSameNode = selectedNode?.id === treeNode.graphNode.id;
      setSelectedNode(treeNode.graphNode);
      openCodePanel();
      if (!isSameNode) {
        onFocusNode(treeNode.graphNode.id);
      }
    }
  }, [setSelectedNode, openCodePanel, onFocusNode, selectedNode]);

  const selectedPath = selectedNode?.properties.filePath || null;

  if (isCollapsed) {
    return (
      <div className="h-full w-12 bg-surface border-r border-border-subtle flex flex-col items-center py-3 gap-2">
        <button
          onClick={() => setIsCollapsed(false)}
          className="p-2 text-text-secondary hover:text-text-primary hover:bg-hover rounded transition-colors"
          title="Expand Panel"
        >
          <PanelLeft className="w-5 h-5" />
        </button>
        <div className="w-6 h-px bg-border-subtle my-1" />
        <button
          onClick={() => { setIsCollapsed(false); setActiveTab('files'); }}
          className={`p-2 rounded transition-colors ${activeTab === 'files' ? 'text-accent bg-accent/10' : 'text-text-secondary hover:text-text-primary hover:bg-hover'}`}
          title="File Explorer"
        >
          <Folder className="w-5 h-5" />
        </button>
        <button
          onClick={() => { setIsCollapsed(false); setActiveTab('filters'); }}
          className={`p-2 rounded transition-colors ${activeTab === 'filters' ? 'text-accent bg-accent/10' : 'text-text-secondary hover:text-text-primary hover:bg-hover'}`}
          title="Filters"
        >
          <Filter className="w-5 h-5" />
        </button>
      </div>
    );
  }

  return (
    <div className="h-full w-64 bg-surface border-r border-border-subtle flex flex-col animate-slide-in">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab('files')}
            className={`px-2 py-1 text-xs rounded transition-colors ${activeTab === 'files'
              ? 'bg-accent/20 text-accent'
              : 'text-text-secondary hover:text-text-primary hover:bg-hover'
              }`}
          >
            Explorer
          </button>
          <button
            onClick={() => setActiveTab('filters')}
            className={`px-2 py-1 text-xs rounded transition-colors ${activeTab === 'filters'
              ? 'bg-accent/20 text-accent'
              : 'text-text-secondary hover:text-text-primary hover:bg-hover'
              }`}
          >
            Filters
          </button>
        </div>
        <button
          onClick={() => setIsCollapsed(true)}
          className="p-1 text-text-muted hover:text-text-primary hover:bg-hover rounded transition-colors"
          title="Collapse Panel"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {activeTab === 'files' && (
        <>
          {/* Search */}
          <div className="px-3 py-2 border-b border-border-subtle">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
              <input
                type="text"
                placeholder="Search files..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 bg-elevated border border-border-subtle rounded text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          {/* File tree */}
          <div className="flex-1 overflow-y-auto scrollbar-thin py-2">
            {fileTree.length === 0 ? (
              <div className="px-3 py-4 text-center text-text-muted text-xs">
                No files loaded
              </div>
            ) : (
              fileTree.map(node => (
                <TreeItem
                  key={node.id}
                  node={node}
                  depth={0}
                  searchQuery={searchQuery}
                  onNodeClick={handleNodeClick}
                  expandedPaths={expandedPaths}
                  toggleExpanded={toggleExpanded}
                  selectedPath={selectedPath}
                />
              ))
            )}
          </div>
        </>
      )}

      {activeTab === 'filters' && (
        <div className="flex-1 overflow-y-auto scrollbar-thin p-3">
          <div className="mb-3">
            <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
              Node Types
            </h3>
            <p className="text-[11px] text-text-muted mb-3">
              Toggle visibility of node types in the graph
            </p>
          </div>

          <div className="flex flex-col gap-1">
            {FILTERABLE_LABELS.map((label) => {
              const Icon = getNodeTypeIcon(label);
              const isVisible = visibleLabels.includes(label);

              return (
                <button
                  key={label}
                  onClick={() => toggleLabelVisibility(label)}
                  className={`
                    flex items-center gap-2.5 px-2 py-1.5 rounded text-left transition-colors
                    ${isVisible
                      ? 'bg-elevated text-text-primary'
                      : 'text-text-muted hover:bg-hover hover:text-text-secondary'
                    }
                  `}
                >
                  <div
                    className={`w-5 h-5 rounded flex items-center justify-center ${isVisible ? '' : 'opacity-40'}`}
                    style={{ backgroundColor: `${NODE_COLORS[label]}20` }}
                  >
                    <Icon className="w-3 h-3" style={{ color: NODE_COLORS[label] }} />
                  </div>
                  <span className="text-xs flex-1">{label}</span>
                  <div
                    className={`w-2 h-2 rounded-full transition-colors ${isVisible ? 'bg-accent' : 'bg-border-subtle'}`}
                  />
                </button>
              );
            })}
          </div>

          {/* Edge Type Toggles */}
          <div className="mt-6 pt-4 border-t border-border-subtle">
            <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
              Edge Types
            </h3>
            <p className="text-[11px] text-text-muted mb-3">
              Toggle visibility of relationship types
            </p>

            <div className="flex flex-col gap-1">
              {ALL_EDGE_TYPES.map((edgeType) => {
                const info = EDGE_INFO[edgeType];
                const isVisible = visibleEdgeTypes.includes(edgeType);

                return (
                  <button
                    key={edgeType}
                    onClick={() => toggleEdgeVisibility(edgeType)}
                    className={`
                      flex items-center gap-2.5 px-2 py-1.5 rounded text-left transition-colors
                      ${isVisible
                        ? 'bg-elevated text-text-primary'
                        : 'text-text-muted hover:bg-hover hover:text-text-secondary'
                      }
                    `}
                  >
                    <div
                      className={`w-6 h-1.5 rounded-full ${isVisible ? '' : 'opacity-40'}`}
                      style={{ backgroundColor: info.color }}
                    />
                    <span className="text-xs flex-1">{info.label}</span>
                    <div
                      className={`w-2 h-2 rounded-full transition-colors ${isVisible ? 'bg-accent' : 'bg-border-subtle'}`}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Depth Filter */}
          <div className="mt-6 pt-4 border-t border-border-subtle">
            <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
              <Target className="w-3 h-3 inline mr-1.5" />
              Focus Depth
            </h3>
            <p className="text-[11px] text-text-muted mb-3">
              Show nodes within N hops of selection
            </p>

            <div className="flex flex-wrap gap-1.5">
              {[
                { value: null, label: 'All' },
                { value: 1, label: '1 hop' },
                { value: 2, label: '2 hops' },
                { value: 3, label: '3 hops' },
                { value: 5, label: '5 hops' },
              ].map(({ value, label }) => (
                <button
                  key={label}
                  onClick={() => setDepthFilter(value)}
                  className={`
                    px-2 py-1 text-xs rounded transition-colors
                    ${depthFilter === value
                      ? 'bg-accent text-white'
                      : 'bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
                    }
                  `}
                >
                  {label}
                </button>
              ))}
            </div>

            {depthFilter !== null && !selectedNode && (
              <p className="mt-2 text-[10px] text-amber-400">
                Select a node to apply depth filter
              </p>
            )}
          </div>

          {/* Legend */}
          <div className="mt-6 pt-4 border-t border-border-subtle">
            <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-3">
              Color Legend
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {(['Folder', 'File', 'Class', 'Interface', 'Enum', 'Type', 'Function', 'Method', 'Variable', 'Decorator'] as NodeLabel[]).map(label => (
                <div key={label} className="flex items-center gap-1.5">
                  <div
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: NODE_COLORS[label] }}
                  />
                  <span className="text-[10px] text-text-muted">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Stats footer */}
      {graph && (
        <div className="px-3 py-2 border-t border-border-subtle bg-elevated/50">
          <div className="flex items-center justify-between text-[10px] text-text-muted">
            <span>{graph.nodes.length} nodes</span>
            <span>{graph.relationships.length} edges</span>
          </div>
        </div>
      )}
    </div>
  );
};

