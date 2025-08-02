# 🔍 CodeNexus - Edge Knowledge Graph Creator with Graph RAG

**Transform any codebase into an interactive knowledge graph in your browser. No servers, no setup - just instant Graph RAG-powered code intelligence.**

CodeNexus is a client-side knowledge graph creator that runs entirely in your browser. Drop in a GitHub repo or ZIP file, and get an interactive knowledge graph with AI-powered chat interface. Perfect for code exploration, documentation, and understanding complex codebases through Graph RAG (Retrieval-Augmented Generation).

## ✨ Features

### 📊 **Code Analysis & Visualization**
- **GitHub Integration**: Analyze any public GitHub repository directly from URL
- **ZIP File Support**: Upload and analyze local code archives
- **Interactive Knowledge Graph**: Visualize code structure with Cytoscape.js
- **Multi-language Support**: Currently optimized for Python with extensible architecture
- **Smart Filtering**: Directory and file pattern filters to focus analysis scope
- **Performance Optimization**: Configurable file limits with confirmation dialogs for large repositories

### 🤖 **AI-Powered Chat Interface**
- **Multiple LLM Providers**: OpenAI, Anthropic (Claude), Google Gemini
- **ReAct Agent Pattern**: Uses proper LangChain ReAct implementation for reasoning
- **Tool-Augmented Responses**: Graph queries, code retrieval, file search
- **Context-Aware**: Maintains conversation history with configurable memory

### 🔧 **Advanced Processing Pipeline**
- **3-Pass Ingestion Strategy**:
  1. **Structure Analysis**: Project hierarchy and file organization
  2. **Code Parsing**: AST-based extraction using Tree-sitter
  3. **Call Resolution**: Function/method call relationship mapping
- **Web Worker Processing**: Non-blocking UI with progress tracking
- **Intelligent Caching**: AST and processing result optimization
- **Error Resilience**: Comprehensive error boundaries and recovery mechanisms

### 🎨 **Modern UI/UX**
- **Responsive Design**: Adaptive layout for different screen sizes
- **Real-time Progress**: Live updates during repository processing
- **Interactive Graph**: Node selection, zooming, panning
- **Split-Panel Layout**: Graph visualization + AI chat interface
- **Settings Management**: Persistent configuration for API keys and preferences
- **Export Functionality**: Download knowledge graphs as JSON with metadata
- **Performance Controls**: File limits, filtering, and optimization settings

### 🛡️ **Reliability & Performance**
- **Error Boundaries**: Graceful error handling with user-friendly recovery options
- **Performance Monitoring**: Real-time processing statistics and export size calculation
- **Memory Management**: Efficient handling of large repositories with configurable limits
- **Progress Tracking**: Detailed progress indicators with phase-specific messaging
- **Confirmation Dialogs**: Smart warnings for potentially expensive operations

## 🏗️ Architecture

### **Frontend Stack**
- **React 18** with TypeScript
- **Vite** for fast development and building
- **Cytoscape.js** for graph visualization
- **Custom CSS** with modern design patterns
- **Error Boundaries** for robust error handling

### **Processing Engine**
- **Deno Runtime** for TypeScript execution
- **Tree-sitter WASM** for syntax parsing
- **Web Workers** for background processing
- **Comlink** for worker communication

### **AI Integration**
- **LangChain.js** with proper ReAct agent implementation
- **Multiple LLM Support**: OpenAI, Anthropic, Gemini
- **Tool-based Architecture**: Graph queries, code retrieval, file search
- **Cypher Query Generation**: Natural language to graph queries

### **Services Layer**
```
src/
├── services/           # External API integrations
│   ├── github.ts      # GitHub REST API client
│   └── zip.ts         # ZIP file processing
├── core/              # Core processing logic
│   ├── graph/         # Knowledge graph types
│   ├── ingestion/     # 3-pass processing pipeline
│   └── tree-sitter/   # Syntax parsing infrastructure
├── ai/                # AI and RAG components
│   ├── llm-service.ts # Multi-provider LLM client
│   ├── cypher-generator.ts # NL to Cypher translation
│   ├── orchestrator.ts     # Custom ReAct implementation
│   └── langchain-orchestrator.ts # Standard LangChain ReAct
├── workers/           # Web Worker implementations
├── ui/                # React components and pages
│   ├── components/    # Reusable UI components
│   │   ├── ErrorBoundary.tsx # Error handling component
│   │   ├── graph/     # Graph visualization components
│   │   └── chat/      # Chat interface components
│   └── pages/         # Application pages
├── lib/               # Shared utilities
│   └── export.ts      # Graph export functionality
└── App.tsx            # Main application entry point
```

## 🚀 Getting Started

### Prerequisites
- **Node.js 18+** and **npm/yarn**
- **Deno 1.40+** for development
- **API Keys** for AI features (OpenAI, Anthropic, or Gemini)

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd gitnexus
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

4. **Open in browser**
   ```
   http://localhost:5173
   ```

### Configuration

1. **GitHub Token (Optional)**
   - Increases rate limit from 60 to 5,000 requests/hour
   - Generate at: https://github.com/settings/tokens
   - Requires no special permissions for public repos

2. **AI API Keys**
   - **OpenAI**: Get from https://platform.openai.com/api-keys
   - **Anthropic**: Get from https://console.anthropic.com/
   - **Gemini**: Get from https://makersuite.google.com/app/apikey

3. **Performance Settings**
   - **File Limit**: Configure maximum files to process (default: 500)
   - **Directory Filters**: Focus on specific directories (e.g., "src", "lib")
   - **File Patterns**: Filter by file types (e.g., "*.py", "*.js", "*.ts")

## 💡 Usage

### Analyzing a Repository

1. **GitHub Repository**
   ```
   1. Enter GitHub URL: https://github.com/owner/repo
   2. Optional: Set directory/file filters to focus analysis
   3. Click "Analyze"
   4. For large repos: Confirm processing or adjust filters
   5. Wait for processing (structure → parsing → call resolution)
   6. Explore the interactive graph
   ```

2. **ZIP File Upload**
   ```
   1. Click "Choose File" and select a .zip file
   2. Optional: Configure filters before processing
   3. Click "Analyze"
   4. Processing will extract and analyze text files
   5. Explore results in the graph visualization
   ```

### Performance Optimization

1. **Directory Filtering**
   ```
   - Enter directory names: "src", "lib", "components"
   - Focuses analysis on specific parts of the codebase
   - Reduces processing time and memory usage
   ```

2. **File Pattern Filtering**
   ```
   - Use patterns: "*.py", "*.js", "*.ts"
   - Supports wildcards: "test*.py", "*util*"
   - Comma-separated: "*.py,*.js,*.ts"
   ```

3. **File Limits**
   ```
   - Default limit: 500 files
   - Configurable in settings (50-2000 files)
   - Large repositories show confirmation dialog
   - Automatic truncation to limit if confirmed
   ```

### Using the AI Chat

1. **Configure API Key**
   ```
   1. Click the ⚙️ settings button
   2. Choose your preferred LLM provider
   3. Enter your API key
   4. Select model (e.g., gpt-4o-mini, claude-3-haiku)
   ```

2. **Ask Questions**
   ```
   - "What functions are in the main.py file?"
   - "Show me all classes that inherit from BaseClass"
   - "How does the authentication system work?"
   - "Find all functions that call the database"
   ```

### Exporting Data

1. **Export Knowledge Graph**
   ```
   1. Click the 📥 Export button after processing
   2. Downloads JSON file with graph data and metadata
   3. Includes processing statistics and timestamps
   4. File size shown in UI before export
   ```

2. **Export Format**
   ```json
   {
     "metadata": {
       "exportedAt": "2024-01-01T12:00:00.000Z",
       "version": "1.0.0",
       "nodeCount": 150,
       "relationshipCount": 200,
       "fileCount": 25,
       "processingDuration": 5000
     },
     "graph": {
       "nodes": [...],
       "relationships": [...]
     },
     "fileContents": {...}
   }
   ```

### Graph Interaction

- **Node Selection**: Click any node to highlight and view details
- **Zoom & Pan**: Mouse wheel to zoom, drag to pan
- **Node Types**: Different colors/shapes for files, functions, classes, etc.
- **Relationships**: Arrows show CONTAINS, CALLS, INHERITS relationships

## 🔧 Development

### Project Structure
```
GitNexus/
├── src/
│   ├── services/          # External integrations
│   ├── core/             # Processing pipeline
│   ├── ai/               # AI and RAG systems
│   ├── workers/          # Web Workers
│   ├── ui/               # React components
│   │   ├── components/   # Reusable components
│   │   │   ├── ErrorBoundary.tsx
│   │   │   ├── graph/    # Graph components
│   │   │   └── chat/     # Chat components
│   │   └── pages/        # Application pages
│   ├── lib/              # Utilities
│   │   └── export.ts     # Export functionality
│   └── App.tsx           # Main application
├── public/
│   └── wasm/             # Tree-sitter WASM files
├── package.json
├── vite.config.ts
└── tsconfig.json
```

### Key Components

#### **Error Handling**
```typescript
// ErrorBoundary component with recovery options
<ErrorBoundary
  onError={(error, errorInfo) => {
    console.error('Application error:', error);
  }}
>
  <App />
</ErrorBoundary>
```

#### **Performance Optimization**
```typescript
// File filtering and limits
const filterFiles = (files: any[]) => {
  return files
    .filter(file => matchesDirectoryFilter(file))
    .filter(file => matchesPatternFilter(file))
    .slice(0, maxFiles);
};
```

#### **Export Functionality**
```typescript
// Export with metadata
exportAndDownloadGraph(graph, {
  projectName: 'my-project',
  includeMetadata: true,
  prettyPrint: true
}, fileContents, { duration: 5000 });
```

#### **Processing Pipeline**
```typescript
// 3-pass ingestion strategy with progress tracking
const pipeline = new GraphPipeline();
const result = await pipeline.run({
  projectRoot: '/',
  projectName: 'MyProject',
  filePaths: ['src/main.py', 'src/utils.py'],
  fileContents: new Map([
    ['src/main.py', 'def main(): pass'],
    ['src/utils.py', 'def helper(): pass']
  ])
});
```

#### **AI Integration**
```typescript
// LangChain ReAct agent with error handling
const orchestrator = new LangChainRAGOrchestrator(llmService, cypherGenerator);
await orchestrator.setContext({ graph, fileContents }, llmConfig);
const response = await orchestrator.answerQuestion("How does auth work?");
```

#### **Graph Visualization**
```typescript
// Interactive graph component with error boundaries
<ErrorBoundary>
  <GraphExplorer
    graph={knowledgeGraph}
    onNodeSelect={(nodeId) => setSelectedNode(nodeId)}
  />
</ErrorBoundary>
```

### Adding New Features

1. **New Language Support**
   ```typescript
   // Add parser in core/tree-sitter/
   export const loadJavaScriptParser = async () => {
     // Load JS Tree-sitter grammar
   };
   ```

2. **Custom AI Tools**
   ```typescript
   // Add tools in ai/langchain-orchestrator.ts
   const customTool = tool(
     async (input: { query: string }) => {
       // Tool implementation
     },
     {
       name: "custom_tool",
       description: "Custom functionality",
       schema: z.object({ query: z.string() })
     }
   );
   ```

3. **Export Formats**
   ```typescript
   // Add new export formats in lib/export.ts
   export function exportToCSV(graph: KnowledgeGraph): string {
     // CSV export implementation
   }
   ```

## 🧪 Testing & Quality Assurance

### Error Handling
- **Error Boundaries**: Catch and display JavaScript errors gracefully
- **User Recovery**: Allow users to reset component state after errors
- **Detailed Logging**: Console logging for debugging and error reporting
- **Fallback UI**: User-friendly error messages with recovery options

### Performance Testing
1. **Large Repository Handling**
   - Test with repositories containing 1000+ files
   - Verify confirmation dialogs for file limits
   - Monitor memory usage during processing
   - Test filtering effectiveness

2. **UI Responsiveness**
   - Ensure non-blocking processing with Web Workers
   - Verify progress indicators update correctly
   - Test error recovery mechanisms
   - Validate export functionality with large graphs

3. **Error Scenarios**
   - Network failures during GitHub API calls
   - Corrupted ZIP files
   - Invalid API keys
   - Memory exhaustion scenarios

### Manual Testing Checklist
- [ ] GitHub repository analysis with various sizes
- [ ] ZIP file upload and extraction
- [ ] Directory and file pattern filtering
- [ ] Large repository confirmation dialog
- [ ] Export functionality with different options
- [ ] Error boundary activation and recovery
- [ ] API key validation for all providers
- [ ] Settings persistence across sessions
- [ ] Graph visualization interactions
- [ ] Chat interface with different LLM providers

## 🚀 Deployment

### Production Build
```bash
npm run build
npm run preview
```

### Environment Variables
```env
# Optional: Pre-configure API keys
VITE_OPENAI_API_KEY=sk-...
VITE_ANTHROPIC_API_KEY=sk-ant-...
VITE_GEMINI_API_KEY=...

# Performance settings
VITE_DEFAULT_MAX_FILES=500
VITE_ENABLE_DEBUG_LOGGING=false
```

### Docker Deployment
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0"]
```

### Performance Monitoring
```javascript
// Add performance monitoring
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.entryType === 'measure') {
      console.log(`${entry.name}: ${entry.duration}ms`);
    }
  }
});
observer.observe({ entryTypes: ['measure'] });
```

## 🔒 Security & Privacy

- **Client-Side Processing**: All analysis happens in your browser
- **API Keys**: Stored locally, never transmitted to our servers
- **GitHub Access**: Uses public API, respects repository permissions
- **Data Privacy**: No code or analysis results are stored remotely
- **Error Logging**: Sensitive data excluded from error reports
- **Export Security**: User-controlled data export with no server interaction

## 🤝 Contributing

### Development Setup
1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Make changes and test thoroughly
4. Run the testing checklist above
5. Commit: `git commit -m 'Add amazing feature'`
6. Push: `git push origin feature/amazing-feature`
7. Open a Pull Request

### Code Style
- **TypeScript**: Strict mode enabled
- **ESLint**: Follow configured rules
- **Prettier**: Auto-formatting
- **Comments**: Minimal, only when necessary
- **Error Handling**: Comprehensive error boundaries and recovery
- **Performance**: Consider memory usage and processing time

### Testing Guidelines
- Test error scenarios and edge cases
- Verify performance with large datasets
- Ensure graceful degradation
- Test all export functionality
- Validate error boundary behavior

## 📚 Technical Details

### Knowledge Graph Schema
```typescript
interface KnowledgeGraph {
  nodes: GraphNode[];        // Code entities
  relationships: GraphRelationship[]; // Connections
}

// Node types: Project, Folder, File, Module, Class, Function, Method, Variable
// Relationship types: CONTAINS, CALLS, INHERITS, OVERRIDES, IMPORTS
```

### Export Format
```typescript
interface ExportedGraph {
  metadata: {
    exportedAt: string;
    version: string;
    nodeCount: number;
    relationshipCount: number;
    fileCount?: number;
    processingDuration?: number;
  };
  graph: KnowledgeGraph;
  fileContents?: Record<string, string>;
}
```

### Error Boundary Implementation
- **Component-Level**: Individual components wrapped for isolation
- **Application-Level**: Top-level boundary for catastrophic failures
- **Recovery Options**: Reset state, reload page, or continue with fallback
- **Error Reporting**: Detailed technical information for developers

### Performance Optimizations
- **Web Workers**: Non-blocking processing
- **AST Caching**: Reuse parsed syntax trees
- **Progressive Loading**: Stream results as available
- **Memory Management**: Efficient data structures
- **File Filtering**: Reduce processing scope
- **Confirmation Dialogs**: Prevent accidental expensive operations

### ReAct Agent Implementation
- **Standard LangChain**: Uses `createReactAgent` from `@langchain/langgraph/prebuilt`
- **Custom Implementation**: Manual ReAct loop for educational purposes
- **Tools**: Graph queries, code retrieval, file search
- **Memory**: Conversation persistence with thread management
- **Error Recovery**: Graceful handling of API failures

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Tree-sitter**: Syntax parsing infrastructure
- **LangChain.js**: AI agent framework
- **Cytoscape.js**: Graph visualization
- **React**: UI framework with error boundaries
- **Vite**: Build tool and dev server

---

**CodeNexus** - Edge Knowledge Graph Creator with instant Graph RAG. Zero setup, maximum insight. 🚀

*Browser-native code intelligence that runs anywhere, anytime - no servers required.* 