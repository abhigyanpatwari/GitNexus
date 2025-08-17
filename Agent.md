# GitNexus - Complete Agent Documentation

## 🎯 Project Overview

**GitNexus** is a client-side, edge-based code knowledge graph generator that transforms any codebase into an interactive knowledge graph with AI-powered Graph RAG capabilities. It runs entirely in the browser with zero server dependencies.

### Core Mission

- **Zero-Setup Code Intelligence**: Analyze codebases without servers or configuration
- **Graph RAG-Powered**: Use knowledge graphs for AI-powered code understanding
- **Multi-Language Support**: Currently Python-focused with extensible architecture
- **Browser-Native**: All processing happens client-side using WebAssembly and Web Workers

### Key Capabilities

- **GitHub Integration**: Direct repository analysis via GitHub API
- **ZIP Processing**: Local archive analysis with intelligent filtering
- **Interactive Visualization**: Cytoscape.js-powered knowledge graphs
- **AI Chat Interface**: Multi-LLM support (OpenAI, Anthropic, Gemini)
- **Advanced Parsing**: Tree-sitter WASM for accurate AST analysis

## 🏗️ Architecture Deep Dive

### System Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    User Interface Layer                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   HomePage  │  │  Chat UI    │  │  Graph Explorer     │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                    Service Layer                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ GitHub API  │  │ ZIP Service │  │ Ingestion Service   │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                  Processing Pipeline                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  Structure  │  │   Parsing   │  │   Call Resolution   │ │
│  │  Processor  │  │  Processor  │  │   3-Stage Strategy  │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                  Core Engine                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  Graph      │  │  Function   │  │  Import             │ │
│  │  Types      │  │  Registry   │  │  Resolution         │ │
│  └─────────────┘  │  (Trie)     │  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Technology Stack

**Frontend Framework**: React 18 + TypeScript + Vite
**Graph Visualization**: Cytoscape.js + d3.js
**Code Parsing**: Tree-sitter WebAssembly
**AI Integration**: LangChain.js with ReAct pattern
**State Management**: React Context + custom hooks
**Build System**: Vite with WASM support

## 📊 4-Pass Processing Pipeline

### Pass 1: Structure Analysis (`StructureProcessor`)

**Purpose**: Discover complete repository structure without filtering

**Key Innovations**:

- **Complete Discovery**: Finds ALL directories and files (including ignored ones)
- **No Early Filtering**: Preserves complete structure for accurate representation
- **Smart Categorization**: Distinguishes files from directories algorithmically
- **Intermediate Paths**: Automatically discovers missing directory levels

**Implementation Details**:

```typescript
// Direct path processing instead of inference
const { directories, files } = this.categorizePaths(allPaths);
```

### Pass 2: Code Parsing & Definition Extraction (`ParsingProcessor`)

**Purpose**: Parse source code and extract definitions while applying intelligent filtering

**Key Components**:

- **Tree-sitter Integration**: WASM-based parsing for multiple languages
- **Function Registry Trie**: Optimized data structure for definition lookups
- **Two-Stage Filtering**:
  - Stage 1: Prune ignored directories (node_modules, .git, etc.)
  - Stage 2: Apply user filters (directory patterns, file extensions)

**Ignore Patterns**:

```typescript
IGNORE_PATTERNS = [
  '.git', 'node_modules', '__pycache__', '.venv', 'build', 'dist',
  '.vscode', '.idea', 'tmp', 'logs', 'coverage'
]
```

### Pass 3: Import Resolution (`ImportProcessor`)

**Purpose**: Build comprehensive project-wide import map

**Features**:

- **Multi-language Support**: Python, JavaScript, TypeScript imports
- **Path Resolution**: Handles relative and absolute imports
- **Alias Tracking**: Maps local names to actual exported functions
- **Validation**: Checks against actual project files

**Resolution Patterns**:

- Python: `import`, `from...import`
- JS/TS: `import`, `require()`, `export`
- Path normalization for complex project structures

### Pass 4: Call Resolution (`CallProcessor`)

**Purpose**: Resolve function calls using 3-stage strategy

**3-Stage Resolution Strategy**:

1. **Exact Match** (High Confidence): Uses import map for direct resolution
2. **Same-Module Match** (High Confidence): Local function calls within files
3. **Heuristic Fallback** (Intelligent): Uses FunctionRegistryTrie with distance scoring

**Heuristic Algorithm**:

```typescript
// Distance-based scoring for ambiguous calls
const distance = max(caller_parts, candidate_parts) - common_prefix_length
const score = distance - sibling_bonus
```

## 🤖 AI Integration Architecture

### ReAct Agent Implementation

**Pattern**: Reasoning + Acting for complex code queries

**Agent Components**:

- **LLM Service**: Multi-provider support (OpenAI, Anthropic, Gemini)
- **Cypher Generator**: Natural language to graph query translation
- **Tool System**: Graph queries, code retrieval, file search
- **Memory Management**: Configurable conversation history

### Available Tools

1. **query_graph**: Execute Cypher queries on knowledge graph
2. **get_code**: Retrieve specific code snippets
3. **search_files**: Find files by name or content patterns
4. **get_file_content**: Get complete file contents

### Debug Mode Features

- **Reasoning Steps**: Complete ReAct process visualization
- **Cypher Queries**: Generated queries with explanations
- **Configuration**: LLM settings and performance metrics
- **Context Info**: Graph statistics and source attribution

## 🔧 Service Layer Details

### GitHub Service (`src/services/github.ts`)

**Purpose**: GitHub API integration with rate limiting and error handling

**Key Features**:

- **Rate Limit Handling**: 5,000 requests/hour with token, 60 without
- **Error Recovery**: Comprehensive error handling with user-friendly messages
- **Authentication**: Personal access token support
- **Content Retrieval**: Efficient file and directory fetching

**API Methods**:

```typescript
getRepositoryContents(owner, repo, path) // Directory structure
getFileContent(owner, repo, path)       // Individual file content
downloadFileRaw(owner, repo, path)      // Raw file download
```

### ZIP Service (`src/services/zip.ts`)

**Purpose**: Local archive processing with complete structure discovery

**Features**:

- **Complete Structure**: Extracts all paths regardless of filtering
- **Memory Efficient**: Streaming processing for large archives
- **Path Normalization**: Handles common top-level folder removal
- **Content Mapping**: Efficient Map<string, string> for file contents

### Ingestion Service (`src/services/ingestion.service.ts`)

**Purpose**: Orchestrate the complete ingestion pipeline

**Orchestration Methods**:

```typescript
processGitHubRepo(url, options)    // GitHub repository processing
processZipFile(file, options)      // ZIP archive processing
```

## 📈 Data Models & Types

### Core Graph Types

```typescript
interface KnowledgeGraph {
  nodes: GraphNode[]
  relationships: Relationship[]
}

interface GraphNode {
  id: string
  label: 'Project' | 'Folder' | 'File' | 'Function' | 'Class' | 'Method' | 'Variable'
  properties: Record<string, any>
}

interface Relationship {
  id: string
  type: 'CONTAINS' | 'CALLS' | 'IMPORTS' | 'DECORATES'
  source: string
  target: string
  properties: Record<string, any>
}
```

### Function Registry Trie

**Purpose**: Optimized function definition lookups

**Key Features**:

- **Suffix-based search**: `findEndingWith(name)` for heuristic matching
- **Qualified names**: Full paths like `myProject.services.api.fetchUser`
- **Import distance**: Smart scoring for best match selection

## 🎨 User Interface Architecture

### Component Structure

```
App.tsx
├── HomePage.tsx (Main application page)
├── GraphExplorer.tsx (Interactive graph visualization)
├── ChatInterface.tsx (AI chat with debug mode)
├── SourceViewer.tsx (Code display with syntax highlighting)
└── ErrorBoundary.tsx (Comprehensive error handling)
```

### Interactive Features

- **Graph Navigation**: Node selection, zooming, panning
- **Real-time Progress**: Live updates during processing
- **Split-Panel Layout**: Graph + chat interface
- **Settings Management**: Persistent configuration
- **Export Functionality**: JSON export with metadata

## 🔍 Performance Optimization

### Processing Optimizations

- **Web Workers**: Background processing to keep UI responsive
- **Intelligent Filtering**: Skip massive directories (node_modules, .git)
- **Batch Processing**: Chunked processing for large repositories
- **Memory Management**: Configurable file limits (default: 500 files)

### Graph Optimization

- **Node Limiting**: Smart truncation for large graphs
- **Relationship Pruning**: Focus on high-confidence connections
- **Caching**: AST and processing result caching
- **Lazy Loading**: On-demand content loading

## 🛡️ Error Handling & Reliability

### Error Boundaries

- **Component-level**: Graceful degradation for UI components
- **Worker-level**: Web Worker error recovery
- **Service-level**: API and processing error handling

### User Experience

- **Progress Indicators**: Detailed phase-specific messaging
- **Confirmation Dialogs**: Smart warnings for expensive operations
- **Recovery Options**: Clear guidance for error resolution
- **Debug Information**: Comprehensive logging for troubleshooting

## 📊 Development Setup

### Prerequisites

- **Node.js 18+** and **npm/yarn**
- **GitHub Token** (optional, increases rate limits)
- **AI API Keys**: OpenAI, Anthropic, or Gemini

### Installation

```bash
npm install
npm run dev    # Development server on http://localhost:5173
npm run build  # Production build
```

### Configuration

- **GitHub Token**: Settings → GitHub Token
- **AI Keys**: Settings → AI Provider Configuration
- **Performance**: Settings → File limits and filtering

## 🎯 Usage Patterns

### GitHub Repository Analysis

1. **URL Input**: Enter GitHub repository URL
2. **Filtering**: Optional directory and file extension filters
3. **Processing**: 4-pass pipeline with progress tracking
4. **Exploration**: Interactive graph with AI chat

### ZIP Archive Analysis

1. **File Upload**: Select local ZIP archive
2. **Configuration**: Set processing limits and filters
3. **Analysis**: Complete repository structure discovery
4. **Results**: Knowledge graph with code intelligence

### Best Practices

- **Start Small**: Begin with focused directories
- **Use Filters**: Exclude dependencies and build artifacts
- **Monitor Progress**: Watch console for processing insights
- **Leverage AI**: Use chat interface for code exploration

## 🔮 Future Enhancements

### Language Support

- **JavaScript/TypeScript**: Enhanced parsing and analysis
- **Java**: Class and method relationship mapping
- **C++**: Template and inheritance analysis
- **Go**: Package and interface resolution

### Advanced Features

- **Code Metrics**: Complexity and quality analysis
- **Security Scanning**: Vulnerability detection
- **Documentation Generation**: Auto-generated docs
- **Team Collaboration**: Shared graph exploration

### Performance Improvements

- **Incremental Processing**: Update existing graphs
- **Distributed Processing**: Multiple worker threads
- **Caching Layer**: Persistent processing cache
- **Streaming Analysis**: Real-time code changes

---

## 📝 Quick Reference

### Key Files

- **Main Entry**: `src/App.tsx`
- **Pipeline**: `src/core/ingestion/pipeline.ts`
- **Services**: `src/services/`
- **AI Logic**: `src/ai/`
- **UI Components**: `src/ui/components/`

### Debug Commands

- **Enable Debug**: Click "🔍 Debug" in chat interface
- **Check Console**: F12 → Console for processing logs
- **Diagnose Issues**: Use "🩺 Diagnose" button

### Common Issues

- **Rate Limits**: Add GitHub token for higher limits
- **Large Repos**: Adjust file limits in settings
- **Parsing Errors**: Check file syntax and extensions
- **Memory Issues**: Reduce processing scope with filters

This documentation provides complete context for any agent working on GitNexus, from architecture understanding to implementation details and troubleshooting guidance.
