# GitNexus: Edge-Based Code Knowledge Graph Generator for Deno - Step-by-Step Implementation Guide

This guide will walk you through building a fully edge-based code knowledge graph generator from scratch using Deno. I'll explain each concept before showing the implementation, so you understand **why** we're doing something, not just **how** to do it.

## Phase 1: Project Setup & Core Infrastructure

### Step 1: Project Structure and Tooling Setup

**Why this matters:** Before writing any code, we need to set up our development environment properly. A well-structured project makes it easier to add features later and keeps everything organized.

**Key concepts:**

- We're using Vite (a modern build tool) with React and TypeScript
- We need special configuration for WebAssembly (WASM) files
- A clear directory structure helps us scale to multiple languages later

**Implementation Steps:**

1. **Create the base project:**

```bash
# Create project root
mkdir GitNexus
cd GitNexus

# Initialize Vite project with React and TypeScript
npm create vite@latest . -- --template react-ts

# Initialize Deno project
deno init
```

2. **Create the application directory structure:**

```bash
# Create directories for our core components
mkdir -p src/{core,core/tree-sitter,core/graph,core/ingestion,services,ai,ai/agents,ai/prompts,ui,ui/components,ui/components/graph,ui/components/chat,ui/hooks,workers,lib,config,store}
```

**Why this structure?**

- `core/`: Contains the engine that builds the knowledge graph
- `services/`: Handles external interactions (GitHub API, ZIP processing)
- `ai/`: Contains the RAG and chat functionality
- `ui/`: All user interface components
- `workers/`: Web Workers for heavy processing (keeps UI responsive)
- `lib/`: Utility functions used throughout the app

### Step 2: Configure Build Tools for WASM

**Why this matters:** WebAssembly (WASM) is how we'll run the Tree-sitter parsers in the browser. We need special configuration to handle these binary files correctly.

**Key concepts:**

- WASM files are binary files that run at near-native speed in browsers
- Vite needs special configuration to handle them properly
- We want to avoid inlining large WASM files in our JavaScript bundles

**Implementation:**

1. **Update `vite.config.ts`:**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es'
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    target: 'esnext',
    assetsInlineLimit: 0 // Don't inline WASM files
  }
})
```

**What this does:**

- `assetsInclude: ['**/*.wasm']` tells Vite to treat WASM files as assets
- `assetsInlineLimit: 0` ensures WASM files aren't inlined into JavaScript (they're too large)
- `worker: { format: 'es' }` configures Web Workers to use ES modules

2. **Configure TypeScript** with a `tsconfig.json` that has strict settings for better code quality.

**Why strict settings?** They help catch errors early and make the code more maintainable as the project grows.

### Step 3: Set Up WASM Parser Infrastructure

**Why this matters:** Tree-sitter is the engine that parses code into ASTs (Abstract Syntax Trees). We need to get these parsers working in the browser via WASM.

**Key concepts:**

- Tree-sitter parsers for different languages are written in C
- We compile them to WASM so they can run in browsers
- We need to load these parsers on demand

**Implementation:**

1. **Create a public directory for WASM files:**

```bash
mkdir -p public/wasm/python
```

2. **Download the Tree-sitter Python parser:**
   - Get `tree-sitter-python.wasm` from [tree-sitter-python releases](https://github.com/tree-sitter/tree-sitter-python/releases)
   - Place it in `public/wasm/python/`

**Why host WASM files separately?** Browsers can't access the user's file system directly for security reasons. We need to serve the WASM files from a URL.

I'm building a Deno 2.4.1-based edge code knowledge graph generator called GitNexus. I've completed Phase 1 (project setup and core infrastructure) and now need to implement Phase 2 (Code Acquisition Module) with Deno 2.4.1 compatibility.

Please generate the following two services with these specific requirements:

## 1. GitHub Service (Deno 2.4.1 Implementation)

Create a GitHubService class in `src/services/github.ts` that:

- Uses Deno 2.4.1's native fetch API (no Node.js dependencies)
- Handles GitHub API authentication via personal access tokens
- Implements rate limit handling (GitHub allows 5,000 requests/hour with token)
- Includes methods to:
  * getRepoContents(owner: string, repo: string, path = '') - fetches directory structure
  * getFileContent(owner: string, repo: string, filePath: string) - fetches individual file content
- Properly handles GitHub API rate limits and errors
- Uses Deno 2.4.1-specific error handling patterns
- Includes TypeScript interfaces for return types
- Has comprehensive comments explaining key implementation choices

Important Deno 2.4.1 considerations:

- Use ES modules (no CommonJS)
- No Node.js-specific modules (use Deno's built-in APIs where possible)
- Handle fetch responses with proper Deno error patterns
- Include proper types for all functions
- Follow Deno 2.4.1's security model (permissions)

## 2. ZIP Processing Service (Deno 2.4.1 Implementation)

Create a ZipService class in `src/services/zip.ts` that:

- Uses Deno-compatible ZIP processing (use `https://deno.land/x/zip@v1.2.3/mod.ts` instead of JSZip)
- Processes uploaded ZIP files containing code repositories
- Extracts file paths and contents into a Map<string, string>
- Handles binary data properly in Deno 2.4.1 environment
- Includes error handling for corrupted ZIP files
- Has TypeScript interfaces for all types
- Includes comprehensive comments

Important Deno 2.4.1 considerations:

- Use Deno's file system APIs where appropriate
- Handle file reading with Deno.readFile()
- Process ZIP entries without blocking the event loop
- Use Deno's native text decoding for file contents
- Implement streaming where possible for large ZIP files
- Note that this is for a browser-based application, so the ZIP service should work with File objects from HTML inputs

## Additional Requirements

- All code must be Deno 2.4.1 compatible
- Use strict TypeScript with deno-lint directives where needed
- Include proper error messages that help with debugging
- Add unit test stubs for both services (using Deno's built-in test runner)
- Follow the same directory structure as Phase 1 (services directory already exists)
- Maintain the same coding style and patterns established in Phase 1
- Include necessary imports from Deno's standard library
- Document any Deno-specific permissions required

I'm building a Deno 2.4.1-based edge code knowledge graph generator called GitNexus. I've completed Phase 1 (project setup and core infrastructure) and now need to implement Phase 2 (Code Acquisition Module) with Deno 2.4.1 compatibility.

Please generate the following two services with these specific requirements:

## 1. GitHub Service (Deno 2.4.1 Implementation)

Create a GitHubService class in `src/services/github.ts` that:

- Uses Deno 2.4.1's native fetch API (no Node.js dependencies)
- Handles GitHub API authentication via personal access tokens
- Implements rate limit handling (GitHub allows 5,000 requests/hour with token)
- Includes methods to:
  * getRepoContents(owner: string, repo: string, path = '') - fetches directory structure
  * getFileContent(owner: string, repo: string, filePath: string) - fetches individual file content
- Properly handles GitHub API rate limits and errors
- Uses Deno 2.4.1-specific error handling patterns
- Includes TypeScript interfaces for return types
- Has comprehensive comments explaining key implementation choices

Important Deno 2.4.1 considerations:

- Use ES modules (no CommonJS)
- No Node.js-specific modules (use Deno's built-in APIs where possible)
- Handle fetch responses with proper Deno error patterns
- Include proper types for all functions
- Follow Deno 2.4.1's security model (permissions)

## 2. ZIP Processing Service (Deno 2.4.1 Implementation)

Create a ZipService class in `src/services/zip.ts` that:

- Uses Deno-compatible ZIP processing (use `https://deno.land/x/zip@v1.2.3/mod.ts` instead of JSZip)
- Processes uploaded ZIP files containing code repositories
- Extracts file paths and contents into a Map<string, string>
- Handles binary data properly in Deno 2.4.1 environment
- Includes error handling for corrupted ZIP files
- Has TypeScript interfaces for all types
- Includes comprehensive comments

Important Deno 2.4.1 considerations:

- Use Deno's file system APIs where appropriate
- Handle file reading with Deno.readFile()
- Process ZIP entries without blocking the event loop
- Use Deno's native text decoding for file contents
- Implement streaming where possible for large ZIP files
- Note that this is for a browser-based application, so the ZIP service should work with File objects from HTML inputs

## Additional Requirements

- All code must be Deno 2.4.1 compatible
- Use strict TypeScript with deno-lint directives where needed
- Include proper error messages that help with debugging
- Add unit test stubs for both services (using Deno's built-in test runner)
- Follow the same directory structure as Phase 1 (services directory already exists)
- Maintain the same coding style and patterns established in Phase 1
- Include necessary imports from Deno's standard library
- Document any Deno-specific permissions required

I'm building a Deno 2.4.1-based edge code knowledge graph generator called GitNexus. I've completed Phase 1 (project setup and core infrastructure) and now need to implement Phase 2 (Code Acquisition Module) with Deno 2.4.1 compatibility.

Please generate the following two services with these specific requirements:

## 1. GitHub Service (Deno 2.4.1 Implementation)

Create a GitHubService class in `src/services/github.ts` that:

- Uses Deno 2.4.1's native fetch API (no Node.js dependencies)
- Handles GitHub API authentication via personal access tokens
- Implements rate limit handling (GitHub allows 5,000 requests/hour with token)
- Includes methods to:
  * getRepoContents(owner: string, repo: string, path = '') - fetches directory structure
  * getFileContent(owner: string, repo: string, filePath: string) - fetches individual file content
- Properly handles GitHub API rate limits and errors
- Uses Deno 2.4.1-specific error handling patterns
- Includes TypeScript interfaces for return types
- Has comprehensive comments explaining key implementation choices

Important Deno 2.4.1 considerations:

- Use ES modules (no CommonJS)
- No Node.js-specific modules (use Deno's built-in APIs where possible)
- Handle fetch responses with proper Deno error patterns
- Include proper types for all functions
- Follow Deno 2.4.1's security model (permissions)

## 2. ZIP Processing Service (Deno 2.4.1 Implementation)

Create a ZipService class in `src/services/zip.ts` that:

- Uses Deno-compatible ZIP processing (use `https://deno.land/x/zip@v1.2.3/mod.ts` instead of JSZip)
- Processes uploaded ZIP files containing code repositories
- Extracts file paths and contents into a Map<string, string>
- Handles binary data properly in Deno 2.4.1 environment
- Includes error handling for corrupted ZIP files
- Has TypeScript interfaces for all types
- Includes comprehensive comments

Important Deno 2.4.1 considerations:

- Use Deno's file system APIs where appropriate
- Handle file reading with Deno.readFile()
- Process ZIP entries without blocking the event loop
- Use Deno's native text decoding for file contents
- Implement streaming where possible for large ZIP files
- Note that this is for a browser-based application, so the ZIP service should work with File objects from HTML inputs

## Additional Requirements

- All code must be Deno 2.4.1 compatible
- Use strict TypeScript with deno-lint directives where needed
- Include proper error messages that help with debugging
- Add unit test stubs for both services (using Deno's built-in test runner)
- Follow the same directory structure as Phase 1 (services directory already exists)
- Maintain the same coding style and patterns established in Phase 1
- Include necessary imports from Deno's standard library
- Document any Deno-specific permissions required

I'm building a Deno 2.4.1-based edge code knowledge graph generator called GitNexus. I've completed Phase 1 (project setup and core infrastructure) and now need to implement Phase 2 (Code Acquisition Module) with Deno 2.4.1 compatibility.

Please generate the following two services with these specific requirements:

## 1. GitHub Service (Deno 2.4.1 Implementation)

Create a GitHubService class in `src/services/github.ts` that:

- Uses Deno 2.4.1's native fetch API (no Node.js dependencies)
- Handles GitHub API authentication via personal access tokens
- Implements rate limit handling (GitHub allows 5,000 requests/hour with token)
- Includes methods to:
  * getRepoContents(owner: string, repo: string, path = '') - fetches directory structure
  * getFileContent(owner: string, repo: string, filePath: string) - fetches individual file content
- Properly handles GitHub API rate limits and errors
- Uses Deno 2.4.1-specific error handling patterns
- Includes TypeScript interfaces for return types
- Has comprehensive comments explaining key implementation choices

Important Deno 2.4.1 considerations:

- Use ES modules (no CommonJS)
- No Node.js-specific modules (use Deno's built-in APIs where possible)
- Handle fetch responses with proper Deno error patterns
- Include proper types for all functions
- Follow Deno 2.4.1's security model (permissions)

## 2. ZIP Processing Service (Deno 2.4.1 Implementation)

Create a ZipService class in `src/services/zip.ts` that:

- Uses Deno-compatible ZIP processing (use `https://deno.land/x/zip@v1.2.3/mod.ts` instead of JSZip)
- Processes uploaded ZIP files containing code repositories
- Extracts file paths and contents into a Map<string, string>
- Handles binary data properly in Deno 2.4.1 environment
- Includes error handling for corrupted ZIP files
- Has TypeScript interfaces for all types
- Includes comprehensive comments

Important Deno 2.4.1 considerations:

- Use Deno's file system APIs where appropriate
- Handle file reading with Deno.readFile()
- Process ZIP entries without blocking the event loop
- Use Deno's native text decoding for file contents
- Implement streaming where possible for large ZIP files
- Note that this is for a browser-based application, so the ZIP service should work with File objects from HTML inputs

## Additional Requirements

- All code must be Deno 2.4.1 compatible
- Use strict TypeScript with deno-lint directives where needed
- Include proper error messages that help with debugging
- Add unit test stubs for both services (using Deno's built-in test runner)
- Follow the same directory structure as Phase 1 (services directory already exists)
- Maintain the same coding style and patterns established in Phase 1
- Include necessary imports from Deno's standard library
- Document any Deno-specific permissions required

I'm building a Deno 2.4.1-based edge code knowledge graph generator called GitNexus. I've completed Phase 1 (project setup and core infrastructure) and now need to implement Phase 2 (Code Acquisition Module) with Deno 2.4.1 compatibility.

Please generate the following two services with these specific requirements:

## 1. GitHub Service (Deno 2.4.1 Implementation)

Create a GitHubService class in `src/services/github.ts` that:

- Uses Deno 2.4.1's native fetch API (no Node.js dependencies)
- Handles GitHub API authentication via personal access tokens
- Implements rate limit handling (GitHub allows 5,000 requests/hour with token)
- Includes methods to:
  * getRepoContents(owner: string, repo: string, path = '') - fetches directory structure
  * getFileContent(owner: string, repo: string, filePath: string) - fetches individual file content
- Properly handles GitHub API rate limits and errors
- Uses Deno 2.4.1-specific error handling patterns
- Includes TypeScript interfaces for return types
- Has comprehensive comments explaining key implementation choices

Important Deno 2.4.1 considerations:

- Use ES modules (no CommonJS)
- No Node.js-specific modules (use Deno's built-in APIs where possible)
- Handle fetch responses with proper Deno error patterns
- Include proper types for all functions
- Follow Deno 2.4.1's security model (permissions)

## 2. ZIP Processing Service (Deno 2.4.1 Implementation)

Create a ZipService class in `src/services/zip.ts` that:

- Uses Deno-compatible ZIP processing (use `https://deno.land/x/zip@v1.2.3/mod.ts` instead of JSZip)
- Processes uploaded ZIP files containing code repositories
- Extracts file paths and contents into a Map<string, string>
- Handles binary data properly in Deno 2.4.1 environment
- Includes error handling for corrupted ZIP files
- Has TypeScript interfaces for all types
- Includes comprehensive comments

Important Deno 2.4.1 considerations:

- Use Deno's file system APIs where appropriate
- Handle file reading with Deno.readFile()
- Process ZIP entries without blocking the event loop
- Use Deno's native text decoding for file contents
- Implement streaming where possible for large ZIP files
- Note that this is for a browser-based application, so the ZIP service should work with File objects from HTML inputs

## Additional Requirements

- All code must be Deno 2.4.1 compatible
- Use strict TypeScript with deno-lint directives where needed
- Include proper error messages that help with debugging
- Add unit test stubs for both services (using Deno's built-in test runner)
- Follow the same directory structure as Phase 1 (services directory already exists)
- Maintain the same coding style and patterns established in Phase - Include necessary imports from Deno's standard library
- Document any Deno-specific permissions required

I'm building a Deno 2.4.1-based edge code knowledge graph generator called GitNexus. I've completed Phase 1 (project setup and core infrastructure) and now need to implement Phase 2 (Code Acquisition Module) with Deno 2.4.1 compatibility.

Please generate the following two services with these specific requirements:

## 1. GitHub Service (Deno 2.4.1 Implementation)

Create a GitHubService class in `src/services/github.ts` that:

- Uses Deno 2.4.1's native fetch API (no Node.js dependencies)
- Handles GitHub API authentication via personal access tokens
- Implements rate limit handling (GitHub allows 5,000 requests/hour with token)
- Includes methods to:
  * getRepoContents(owner: string, repo: string, path = '') - fetches directory structure
  * getFileContent(owner: string, repo: string, filePath: string) - fetches individual file content
- Properly handles GitHub API rate limits and errors
- Uses Deno 2.4.1-specific error handling patterns
- Includes TypeScript interfaces for return types
- Has comprehensive comments explaining key implementation choices

Important Deno 2.4.1 considerations:

- Use ES modules (no CommonJS)
- No Node.js-specific modules (use Deno's built-in APIs where possible)
- Handle fetch responses with proper Deno error patterns
- Include proper types for all functions
- Follow Deno 2.4.1's security model (permissions)

## 2. ZIP Processing Service (Deno 2.4.1 Implementation)

Create a ZipService class in `src/services/zip.ts` that:

- Uses Deno-compatible ZIP processing (use `https://deno.land/x/zip@v1.2.3/mod.ts` instead of JSZip)
- Processes uploaded ZIP files containing code repositories
- Extracts file paths and contents into a Map<string, string>
- Handles binary data properly in Deno 2.4.1 environment
- Includes error handling for corrupted ZIP files
- Has TypeScript interfaces for all types
- Includes comprehensive comments

Important Deno 2.4.1 considerations:

- Use Deno's file system APIs where appropriate
- Handle file reading with Deno.readFile()
- Process ZIP entries without blocking the event loop
- Use Deno's native text decoding for file contents
- Implement streaming where possible for large ZIP files
- Note that this is for a browser-based application, so the ZIP service should work with File objects from HTML inputs

## Additional Requirements

- All code must be Deno 2.4.1 compatible
- Use strict TypeScript with deno-lint directives where needed
- Include proper error messages that help with debugging
- Add unit test stubs for both services (using Deno's built-in test runner)
- Follow the same directory structure as Phase 1 (services directory already exists)
- Maintain the same coding style and patterns established in Phase - Include necessary imports from Deno's standard library
- Document any Deno-specific permissions required

I'm building a Deno 2.4.1-based edge code knowledge graph generator called GitNexus. I've completed Phase 1 (project setup and core infrastructure) and now need to implement Phase 2 (Code Acquisition Module) with Deno 2.4.1 compatibility.

Please generate the following two services with these specific requirements:

## 1. GitHub Service (Deno 2.4.1 Implementation)

Create a GitHubService class in `src/services/github.ts` that:

- Uses Deno 2.4.1's native fetch API (no Node.js dependencies)
- Handles GitHub API authentication via personal access tokens
- Implements rate limit handling (GitHub allows 5,000 requests/hour with token)
- Includes methods to:
  * getRepoContents(owner: string, repo: string, path = '') - fetches directory structure
  * getFileContent(owner: string, repo: string, filePath: string) - fetches individual file content
- Properly handles GitHub API rate limits and errors
- Uses Deno 2.4.1-specific error handling patterns
- Includes TypeScript interfaces for return types
- Has comprehensive comments explaining key implementation choices

Important Deno 2.4.1 considerations:

- Use ES modules (no CommonJS)
- No Node.js-specific modules (use Deno's built-in APIs where possible)
- Handle fetch responses with proper Deno error patterns
- Include proper types for all functions
- Follow Deno 2.4.1's security model (permissions)

## 2. ZIP Processing Service (Deno 2.4.1 Implementation)

Create a ZipService class in `src/services/zip.ts` that:

- Uses Deno-compatible ZIP processing (use `https://deno.land/x/zip@v1.2.3/mod.ts` instead of JSZip)
- Processes uploaded ZIP files containing code repositories
- Extracts file paths and contents into a Map<string, string>
- Handles binary data properly in Deno 2.4.1 environment
- Includes error handling for corrupted ZIP files
- Has TypeScript interfaces for all types
- Includes comprehensive comments

Important Deno 2.4.1 considerations:

- Use Deno's file system APIs where appropriate
- Handle file reading with Deno.readFile()
- Process ZIP entries without blocking the event loop
- Use Deno's native text decoding for file contents
- Implement streaming where possible for large ZIP files
- Note that this is for a browser-based application, so the ZIP service should work with File objects from HTML inputs

## Additional Requirements

- All code must be Deno 2.4.1 compatible
- Use strict TypeScript with deno-lint directives where needed
- Include proper error messages that help with debugging
- Add unit test stubs for both services (using Deno's built-in test runner)
- Follow the same directory structure as Phase 1 (services directory already exists)
- Maintain the same coding style and patterns established in Phase - Include necessary imports from Deno's standard library
- Document any Deno-specific permissions required

3. **Create a loader for Tree-sitter parsers:**

```typescript
import WebTreeSitter from 'web-tree-sitter';
let parserInstance: WebTreeSitter | null = null;
const parserCache = new Map<string, WebTreeSitter.Language>();

export async function initTreeSitter() {
  if (parserInstance) return parserInstance;
  parserInstance = await WebTreeSitter.init();
  return parserInstance;
}

export async function loadPythonParser(): Promise<WebTreeSitter.Language> {
  if (parserCache.has('python')) {
    return parserCache.get('python')!;
  }
  const Parser = await initTreeSitter();
  const pythonLang = await Parser.Language.load(
    '/wasm/python/tree-sitter-python.wasm'
  );
  parserCache.set('python', pythonLang);
  return pythonLang;
}
```

**How this works:**

1. `initTreeSitter()` initializes the WebAssembly module once
2. `loadPythonParser()` loads the Python parser from the WASM file
3. We cache parsers to avoid reloading them multiple times

**Why cache parsers?** Loading WASM files is relatively slow, so we want to do it once and reuse the parsers.

## Phase 2: Code Acquisition Module

### Step 4: Implement GitHub API Integration

**Why this matters:** Users will want to analyze public GitHub repositories, so we need a way to fetch code from GitHub.

**Key concepts:**

- GitHub has a REST API for accessing repository contents
- We need to handle rate limits (GitHub limits how many requests you can make)
- We'll let users provide their own API tokens for higher limits

**Implementation:**

```typescript
export class GitHubService {
  private token: string | null = null;
  
  setToken(token: string) {
    this.token = token;
  }
  
  async getRepoContents(owner: string, repo: string, path = '') {
    const headers: HeadersInit = {
      'Accept': 'application/vnd.github.v3+json'
    };
    if (this.token) {
      headers['Authorization'] = `token ${this.token}`;
    }
  
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers }
    );
  
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }
  
    return response.json();
  }
}
```

**How this works:**

- `getRepoContents()` fetches the directory structure of a repository
- It uses the GitHub API with proper headers
- It handles authentication via a token

**Important note:** GitHub API has rate limits. For unauthenticated requests, it's about 60 requests/hour. With a token, it's 5,000/hour.

### Step 5: Implement ZIP Processing

**Why this matters:** Not all code is on GitHub. Users might want to analyze local code or private repositories by uploading a ZIP file.

**Key concepts:**

- JSZip is a library for handling ZIP files in JavaScript
- We need to extract files and their contents from the ZIP
- We'll use a Map to store file paths and contents

**Implementation:**

```typescript
import JSZip from 'jszip';

export class ZipService {
  async processZip(file: File): Promise<Map<string, string>> {
    const zip = await JSZip.loadAsync(file);
    const files = new Map<string, string>();
  
    for (const [filePath, zipEntry] of Object.entries(zip.files)) {
      if (!zipEntry.dir) {
        const content = await zipEntry.async('text');
        files.set(filePath, content);
      }
    }
  
    return files;
  }
}
```

**How this works:**

1. `JSZip.loadAsync(file)` loads the ZIP file
2. We iterate through all entries in the ZIP
3. For each file (not directory), we extract its content as text
4. We store the file path and content in a Map

**Why use a Map?** It provides O(1) lookups by file path, which is important when we need to find files during graph construction.

## Phase 3: Graph Construction Pipeline

### Step 6: Define Graph Data Structures

**Why this matters:** Before we can build a graph, we need to define what nodes and relationships look like.

**Key concepts:**

- A knowledge graph consists of nodes and relationships
- Nodes represent code elements (functions, classes, etc.)
- Relationships represent connections between elements (calls, contains, etc.)

**Implementation:**

```typescript
export type NodeLabel = 
  | 'Project' 
  | 'Package' 
  | 'Module' 
  | 'Folder' 
  | 'File' 
  | 'Class' 
  | 'Function' 
  | 'Method' 
  | 'Variable';

export interface GraphNode {
  id: string;
  label: NodeLabel;
  properties: Record<string, any>;
}

export type RelationshipType = 
  | 'CONTAINS'
  | 'CALLS'
  | 'INHERITS'
  | 'OVERRIDES'
  | 'IMPORTS';

export interface GraphRelationship {
  id: string;
  type: RelationshipType;
  source: string;
  target: string;
  properties?: Record<string, any>;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}
```

**Why these specific types?**

- `NodeLabel` defines all possible types of code elements we'll track
- `RelationshipType` defines how code elements connect to each other
- `KnowledgeGraph` is the complete structure we'll build

**Important relationships:**

- `CONTAINS`: A folder contains files, a file contains functions
- `CALLS`: A function calls another function
- `IMPORTS`: One module imports from another

### Step 7: Implement the 3-Pass Ingestion Pipeline

**Why this matters:** Building a complete knowledge graph requires multiple passes to handle cross-file references properly.

**Key concepts:**

- **Pass 1**: Identify the overall structure (folders, modules)
- **Pass 2**: Parse individual files and cache ASTs
- **Pass 3**: Process function calls across files (the hardest part)

This three-pass approach solves the "island problem" - where functions in different files appear disconnected.

#### Pass 1: Structure Identification

```typescript
export class StructureProcessor {
  private graph: KnowledgeGraph;
  private projectRoot: string;
  private projectName: string;
  
  constructor(graph: KnowledgeGraph, projectRoot: string, projectName: string) {
    this.graph = graph;
    this.projectRoot = projectRoot;
    this.projectName = projectName;
  }
  
  identifyStructure(filePaths: string[]): void {
    // Add Project node
    this.graph.nodes.push({
      id: `project:${this.projectName}`,
      label: 'Project',
      properties: { name: this.projectName }
    });
  
    // Track directory structure
    const directories = new Set<string>();
    for (const filePath of filePaths) {
      const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
      if (dirPath && !directories.has(dirPath)) {
        directories.add(dirPath);
        // Create Folder node
        this.graph.nodes.push({
          id: `folder:${dirPath}`,
          label: 'Folder',
          properties: { path: dirPath }
        });
      
        // Create CONTAINS relationship with parent
        if (dirPath.includes('/')) {
          const parentPath = dirPath.substring(0, dirPath.lastIndexOf('/'));
          this.graph.relationships.push({
            id: `rel:folder:${dirPath}:parent`,
            type: 'CONTAINS',
            source: `folder:${parentPath}`,
            target: `folder:${dirPath}`
          });
        } else {
          // Root folder connects to project
          this.graph.relationships.push({
            id: `rel:folder:${dirPath}:project`,
            type: 'CONTAINS',
            source: `project:${this.projectName}`,
            target: `folder:${dirPath}`
          });
        }
      }
    }
  }
}
```

**How this works:**

1. Creates a root Project node
2. Walks through all file paths to identify directories
3. Creates Folder nodes and CONTAINS relationships

**Why identify structure first?** We need to know the overall organization before parsing individual files.

#### Pass 2: File Parsing

```typescript
export class ParsingProcessor {
  private graph: KnowledgeGraph;
  private astCache = new Map<string, any>();
  
  constructor(graph: KnowledgeGraph) {
    this.graph = graph;
  }
  
  async parseFiles(filePaths: string[], fileContents: Map<string, string>): Promise<Map<string, any>> {
    for (const [filePath, content] of fileContents) {
      if (filePath.endsWith('.py')) {
        await this.parsePythonFile(filePath, content);
      }
    }
    return this.astCache;
  }
  
  private async parsePythonFile(filePath: string, content: string): Promise<void> {
    const parser = await loadPythonParser();
    const tree = parser.parse(content);
    // Cache the AST
    this.astCache.set(filePath, tree);
    // Extract definitions from the AST
    this.extractDefinitions(filePath, tree, content);
  }
  
  private extractDefinitions(filePath: string, tree: any, content: string): void {
    // Extract modules
    this.graph.nodes.push({
      id: `module:${filePath}`,
      label: 'Module',
      properties: { 
        path: filePath,
        name: filePath.split('/').pop()!.replace('.py', ''),
        extension: '.py'
      }
    });
  
    // Extract functions from the AST
    const rootNode = tree.rootNode;
    const functionDefs = rootNode.descendantsOfType('function_definition');
    for (const funcNode of functionDefs) {
      const nameNode = funcNode.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'unknown';
    
      // Calculate position
      const startLine = funcNode.startPosition.row + 1;
    
      // Create function node
      this.graph.nodes.push({
        id: `function:${filePath}:${name}`,
        label: 'Function',
        properties: {
          name,
          qualified_name: `${this.getModuleName(filePath)}.${name}`,
          path: filePath,
          start_line: startLine
        }
      });
    
      // Create CONTAINS relationship with module
      this.graph.relationships.push({
        id: `rel:function:${filePath}:${name}:module`,
        type: 'CONTAINS',
        source: `module:${filePath}`,
        target: `function:${filePath}:${name}`
      });
    }
  }
}
```

**How this works:**

1. Parses each file with the appropriate Tree-sitter parser
2. Caches the AST for later use
3. Extracts definitions (functions, classes) from the AST
4. Creates nodes and relationships in the graph

**Why cache ASTs?** We need them in Pass 3 to resolve cross-file function calls.

#### Pass 3: Call Resolution

```typescript
export class CallProcessor {
  private graph: KnowledgeGraph;
  private astCache: Map<string, any>;
  private projectRoot: string;
  private projectName: string;
  
  constructor(
    graph: KnowledgeGraph,
    astCache: Map<string, any>,
    projectRoot: string,
    projectName: string
  ) {
    this.graph = graph;
    this.astCache = astCache;
    this.projectRoot = projectRoot;
    this.projectName = projectName;
  }
  
  processCalls(): void {
    for (const [filePath, tree] of this.astCache) {
      if (filePath.endsWith('.py')) {
        this.processPythonCalls(filePath, tree);
      }
    }
  }
  
  private processPythonCalls(filePath: string, tree: any): void {
    const rootNode = tree.rootNode;
    // Find all call expressions
    const callExpressions = rootNode.descendantsOfType('call');
    for (const callNode of callExpressions) {
      const functionNameNode = callNode.childForFieldName('function');
      if (!functionNameNode) continue;
    
      // Handle different types of function references
      let targetFunctionName = '';
      if (functionNameNode.type === 'identifier') {
        targetFunctionName = functionNameNode.text;
      } else if (functionNameNode.type === 'attribute') {
        // Handle method calls like obj.method()
        const attrNode = functionNameNode;
        const objectNode = attrNode.childForFieldName('object');
        const attrNameNode = attrNode.childForFieldName('attribute');
        if (objectNode && attrNameNode) {
          const objectName = objectNode.text;
          const methodName = attrNameNode.text;
          targetFunctionName = `${objectName}.${methodName}`;
        }
      }
    
      if (!targetFunctionName) continue;
    
      // Try to resolve the target function
      const targetNode = this.resolveTargetFunction(targetFunctionName, filePath);
      if (targetNode) {
        // Create CALLS relationship
        const callerId = this.getCallerId(callNode, filePath);
        this.graph.relationships.push({
          id: `rel:call:${callerId}:${targetNode.id}`,
          type: 'CALLS',
          source: callerId,
          target: targetNode.id
        });
      }
    }
  }
  
  private resolveTargetFunction(targetName: string, currentFilePath: string): { id: string; type: string } | null {
    // 1. Check if it's a built-in function
    if (this.isBuiltInFunction(targetName)) {
      return {
        id: `builtin:${targetName}`,
        type: 'builtin'
      };
    }
  
    // 2. Check if it's an imported function
    const importInfo = this.findImportForFunction(targetName, currentFilePath);
    if (importInfo) {
      const targetId = `function:${importInfo.sourceFile}:${importInfo.targetName}`;
      return {
        id: targetId,
        type: 'imported'
      };
    }
  
    // 3. Check if it's defined in the current file
    for (const node of this.graph.nodes) {
      if (node.label === 'Function' && 
          node.properties.name === targetName &&
          node.properties.path === currentFilePath) {
        return {
          id: node.id,
          type: 'local'
        };
      }
    }
  
    return null;
  }
}
```

**How this works:**

1. Finds all function calls in the AST
2. Determines what function is being called
3. Resolves the target function across files using imports
4. Creates CALLS relationships in the graph

**Why is this the hardest part?** Resolving cross-file references requires understanding:

- How imports work in the language
- How to map a simple name to a fully qualified name
- Handling edge cases like aliases (`import helper as h`)

### Step 8: Implement Web Workers for Performance

**Why this matters:** Parsing code and building graphs can be CPU-intensive. Web Workers keep the UI responsive.

**Key concepts:**

- Web Workers run JavaScript in background threads
- They can't access the DOM directly
- We use Comlink to simplify communication

**Implementation:**

```typescript
// src/workers/ingestion.worker.ts
import { expose } from 'comlink';
import { GraphPipeline } from '../core/ingestion/pipeline';

class IngestionWorker {
  async processRepository(
    projectRoot: string,
    projectName: string,
    filePaths: string[],
    fileContents: Record<string, string>
  ) {
    const pipeline = new GraphPipeline(projectRoot, projectName);
    return pipeline.run(filePaths, new Map(Object.entries(fileContents)));
  }
}

expose(new IngestionWorker());
```

**How this works:**

1. The worker runs the heavy processing in a background thread
2. We expose methods via Comlink to call them from the main thread
3. The main thread can call these methods without blocking the UI

**Why use Web Workers?** Without them, large repositories would freeze the browser tab while processing.

## Phase 4: Graph Visualization

### Step 9: Implement Graph Visualization Components

**Why this matters:** A knowledge graph is useless if users can't see and interact with it.

**Key concepts:**

- Cytoscape.js is a powerful graph visualization library
- We need to convert our graph data to Cytoscape's format
- Users need controls to filter and navigate the graph

**Implementation:**

```tsx
import React, { useEffect, useRef } from 'react';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { KnowledgeGraph } from '@/core/graph/types';

cytoscape.use(dagre);

interface GraphVisualizationProps {
  graph: KnowledgeGraph;
  onNodeClick?: (nodeId: string) => void;
  filter?: (node: any) => boolean;
}

export const GraphVisualization: React.FC<GraphVisualizationProps> = ({ 
  graph, 
  onNodeClick,
  filter 
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  
  useEffect(() => {
    if (!containerRef.current) return;
  
    // Clean up previous instance
    if (cyRef.current) {
      cyRef.current.destroy();
    }
  
    // Convert our graph to Cytoscape format
    const cyElements = convertToCytoscapeElements(graph, filter);
  
    const cy = cytoscape({
      container: containerRef.current,
      elements: cyElements,
      style: [
        {
          selector: 'node',
          style: {
            'label': 'data(label)',
            'width': 'mapData(size, 0, 100, 20, 80)',
            'height': 'mapData(size, 0, 100, 20, 80)',
            'background-color': 'data(color)',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '8px'
          }
        },
        {
          selector: 'edge',
          style: {
            'width': 2,
            'line-color': '#ccc',
            'target-arrow-color': '#ccc',
            'target-arrow-shape': 'triangle'
          }
        }
      ],
      layout: {
        name: 'dagre',
        rankDir: 'TB',
        padding: 20
      }
    });
  
    // Add interactions
    cy.on('tap', 'node', (event) => {
      const node = event.target;
      const nodeId = node.data('id');
      if (onNodeClick) {
        onNodeClick(nodeId);
      }
    });
  
    cyRef.current = cy;
  
    return () => {
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
      }
    };
  }, [graph, filter]);
  
  return (
    <div 
      ref={containerRef} 
      className="w-full h-full bg-white rounded-lg border border-gray-200"
    />
  );
};

function convertToCytoscapeElements(
  graph: KnowledgeGraph, 
  filter?: (node: any) => boolean
) {
  const elements: any[] = [];
  
  // Add nodes
  for (const node of graph.nodes) {
    if (filter && !filter(node)) continue;
    elements.push({
      data: {
        id: node.id,
        label: getNodeLabel(node),
        type: node.label,
        color: getNodeColor(node.label),
        size: getNodeSize(node)
      }
    });
  }
  
  // Add edges
  for (const rel of graph.relationships) {
    elements.push({
      data: {
        id: rel.id,
        source: rel.source,
        target: rel.target,
        label: rel.type
      }
    });
  }
  
  return elements;
}
```

**How this works:**

1. Converts our graph data to Cytoscape's format
2. Sets up visual styles based on node type
3. Applies a hierarchical layout (dagre)
4. Adds interaction handlers for node clicks

**Why use Cytoscape.js?** It's specifically designed for graph visualization with:

- Multiple layout algorithms
- Good performance for medium-sized graphs
- Extensive customization options

### Step 10: Create Source Code Viewer

**Why this matters:** Seeing the graph isn't enough - users need to see the actual code behind the nodes.

**Implementation:**

```tsx
import React, { useState, useEffect } from 'react';
import { KnowledgeGraph } from '@/core/graph/types';

interface SourceViewerProps {
  graph: KnowledgeGraph;
  selectedNodeId: string | null;
}

export const SourceViewer: React.FC<SourceViewerProps> = ({ graph, selectedNodeId }) => {
  const [sourceCode, setSourceCode] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [lineNumber, setLineNumber] = useState<number | null>(null);
  
  useEffect(() => {
    if (!selectedNodeId) {
      setSourceCode('');
      setFileName('');
      setLineNumber(null);
      return;
    }
  
    // Find the node in the graph
    const node = graph.nodes.find(n => n.id === selectedNodeId);
    if (!node) return;
  
    // For functions, get the source code
    if (node.label === 'Function' || node.label === 'Method') {
      const filePath = node.properties.path;
      const startLine = node.properties.start_line;
    
      // In a real implementation, you'd have the source code available
      setFileName(filePath);
      setLineNumber(startLine);
      setSourceCode(`# Source code for ${node.properties.qualified_name}
# Line ${startLine} and following...`);
    }
  }, [graph, selectedNodeId]);
  
  if (!selectedNodeId || !sourceCode) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <p className="text-gray-500">Select a node to view source code</p>
      </div>
    );
  }
  
  return (
    <div className="flex flex-col h-full">
      <div className="p-2 bg-gray-100 border-b border-gray-200 flex justify-between items-center">
        <span className="text-sm font-medium text-gray-700 truncate">{fileName}</span>
        {lineNumber && (
          <span className="text-xs text-gray-500">Line {lineNumber}</span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-2 font-mono text-sm bg-black text-white">
        <pre>{sourceCode}</pre>
      </div>
    </div>
  );
};
```

**How this works:**

1. When a node is selected, it finds the corresponding code element
2. It displays the source code with line numbers
3. It highlights the relevant part of the code

**Why is this important?** It bridges the gap between the abstract graph and the concrete code, helping users understand what they're seeing.

## Phase 5: RAG Chat Interface

### Step 11: Implement LLM Service

**Why this matters:** The chat interface needs to connect to LLMs (Large Language Models) to translate natural language to graph queries.

**Key concepts:**

- We'll support multiple LLM providers (OpenAI, Anthropic, Gemini)
- Users provide their own API keys (privacy-focused)
- We need a consistent interface for different providers

**Implementation:**

```typescript
import { ChatOpenAI } from 'langchain/chat_models/openai';
import { ChatAnthropic } from 'langchain/chat_models/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

export type LLMProvider = 'openai' | 'anthropic' | 'gemini';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model?: string;
}

export class LLMService {
  private config: LLMConfig;
  
  constructor(config: LLMConfig) {
    this.config = config;
  }
  
  getChatModel() {
    switch (this.config.provider) {
      case 'openai':
        return new ChatOpenAI({
          apiKey: this.config.apiKey,
          modelName: this.config.model || 'gpt-4-turbo',
          temperature: 0
        });
      case 'anthropic':
        return new ChatAnthropic({
          apiKey: this.config.apiKey,
          modelName: this.config.model || 'claude-3-sonnet-20240229',
          temperature: 0
        });
      case 'gemini':
        return new ChatGoogleGenerativeAI({
          apiKey: this.config.apiKey,
          modelName: this.config.model || 'gemini-1.5-pro-latest',
          temperature: 0
        });
      default:
        throw new Error(`Unsupported LLM provider: ${this.config.provider}`);
    }
  }
}
```

**How this works:**

1. The service takes an LLM configuration (provider, API key, model)
2. It returns a consistent chat model interface regardless of provider
3. It handles provider-specific initialization

**Why support multiple providers?** Different users have different preferences and API key availability.

### Step 12: Implement Cypher Generator

**Why this matters:** The core of the RAG system - translating natural language questions to graph queries.

**Key concepts:**

- We use a system prompt to instruct the LLM
- The prompt includes our graph schema
- We clean the response to get a valid Cypher query

**Implementation:**

```typescript
import { BaseChatModel } from 'langchain/chat_models/base';
import { CYPHER_SYSTEM_PROMPT } from '../prompts/cypher';

export class CypherGenerator {
  private llm: BaseChatModel;
  
  constructor(llm: BaseChatModel) {
    this.llm = llm;
  }
  
  async generate(naturalLanguageQuery: string): Promise<string> {
    const response = await this.llm.call([
      { role: 'system', content: CYPHER_SYSTEM_PROMPT },
      { role: 'user', content: naturalLanguageQuery }
    ]);
  
    return this.cleanResponse(response.content);
  }
  
  private cleanResponse(response: string): string {
    // Remove markdown code blocks
    let cleaned = response.replace(/```cypher/g, '').replace(/```/g, '');
    // Ensure it ends with a semicolon
    if (!cleaned.trim().endsWith(';')) {
      cleaned = cleaned.trim() + ';';
    }
    return cleaned;
  }
}
```

**How this works:**

1. It sends the natural language query with a system prompt to the LLM
2. The system prompt teaches the LLM about our graph structure
3. It cleans the response to extract a valid Cypher query

**Why is the system prompt important?** It provides the LLM with the context it needs to generate correct queries. Without it, the LLM wouldn't know about our graph schema.

### Step 13: Implement RAG Orchestrator

**Why this matters:** This is the "brain" of the system that coordinates the query process.

**Key concepts:**

- It follows a ReAct (Reason + Act) pattern
- It plans steps, uses tools, observes results, and responds
- It prevents hallucination by sticking to tool results

**Implementation:**

```typescript
import { BaseChatModel } from 'langchain/chat_models/base';
import { RAG_ORCHESTRATOR_SYSTEM_PROMPT } from '../prompts/rag-orchestrator';

export class RAGOrchestrator {
  private llm: BaseChatModel;
  
  constructor(llm: BaseChatModel) {
    this.llm = llm;
  }
  
  async query(
    userQuery: string,
    queryGraph: (cypher: string) => Promise<any>,
    retrieveCode: (nodeId: string) => Promise<string>
  ) {
    // Start with the system prompt
    let conversation = [
      { role: 'system', content: RAG_ORCHESTRATOR_SYSTEM_PROMPT }
    ];
  
    // Add the user's question
    conversation.push({ role: 'user', content: userQuery });
  
    // Simple ReAct loop
    for (let i = 0; i < 5; i++) { // Max 5 steps
      const response = await this.llm.call(conversation);
      const responseContent = response.content;
    
      // Check if the response contains a tool call
      if (responseContent.includes('Action: query_graph')) {
        const match = responseContent.match(/Action Input: (.*)/);
        if (match) {
          const cypherQuery = match[1].trim();
        
          // Execute the query
          const queryResults = await queryGraph(cypherQuery);
        
          // Add the observation to the conversation
          conversation.push({
            role: 'assistant',
            content: responseContent
          });
        
          conversation.push({
            role: 'system',
            content: `Observation: ${JSON.stringify(queryResults)}`
          });
        
          // If we have results, we might be done
          if (queryResults.length > 0) {
            break;
          }
        }
      } 
      else if (responseContent.includes('Action: retrieve_code')) {
        // Similar handling for code retrieval
      }
      else {
        // This appears to be the final answer
        return responseContent;
      }
    }
  
    // If we got here without a final answer, generate one
    conversation.push({
      role: 'user',
      content: 'Please provide your final answer based on the information gathered.'
    });
  
    const finalResponse = await this.llm.call(conversation);
    return finalResponse.content;
  }
}
```

**How this works:**

1. It starts with a system prompt that defines the rules
2. It sends the user's query to the LLM
3. The LLM responds with either:
   - A tool call (query_graph or retrieve_code)
   - A final answer
4. If it's a tool call, it executes the tool and adds the result to the conversation
5. It repeats until it gets a final answer or hits the step limit

**Why the step limit?** To prevent infinite loops if the LLM gets stuck.

## Phase 6: Main Application Integration

### Step 14: Create Main Application Component

**Why this matters:** This brings all the pieces together into a cohesive UI.

**Implementation:**

```tsx
import React, { useState, useRef } from 'react';
import { GraphVisualization } from '@/ui/components/graph/Visualization';
import { GraphControls } from '@/ui/components/graph/Controls';
import { SourceViewer } from '@/ui/components/graph/SourceViewer';
import { ChatInterface } from '@/ui/components/chat/ChatInterface';
import { KnowledgeGraph } from '@/core/graph/types';
import { GitHubService } from '@/services/github';
import { ZipService } from '@/services/zip';
import { ingestionWorkerApi } from '@/lib/workerUtils';

export const HomePage = () => {
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const handleRepoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoUrl.trim() || isLoading) return;
  
    setIsLoading(true);
    setError(null);
  
    try {
      // Parse the GitHub URL
      const urlMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!urlMatch) {
        throw new Error('Invalid GitHub repository URL');
      }
    
      const owner = urlMatch[1];
      const repo = urlMatch[2].replace(/\.git$/, '');
    
      // Fetch repository contents
      const githubService = new GitHubService();
      const contents = await githubService.getRepoContents(owner, repo);
    
      // Filter for Python files
      const pythonFiles = contents
        .filter((item: any) => item.type === 'file' && item.name.endsWith('.py'))
        .map((item: any) => item.path);
    
      // Fetch file contents
      const fileContents: Record<string, string> = {};
      for (const filePath of pythonFiles) {
        fileContents[filePath] = await githubService.getFileContent(owner, repo, filePath);
      }
    
      // Process the repository
      const projectName = `${owner}/${repo}`;
      const processedGraph = await ingestionWorkerApi.processRepository(
        repoUrl,
        projectName,
        pythonFiles,
        fileContents
      );
    
      setGraph(processedGraph);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process repository');
      console.error('Processing error:', err);
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleQuery = async (query: string): Promise<string> => {
    if (!graph) {
      throw new Error('No graph available');
    }
  
    // In a real implementation, this would use the RAG orchestrator
    return `I found information related to "${query}" in the codebase.`;
  };
  
  return (
    <div className="h-screen flex flex-col">
      {/* Header with repository input */}
      <header className="p-4 bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center gap-4">
          <h1 className="text-2xl font-bold text-gray-900">GitNexus</h1>
        
          <div className="flex-1 flex gap-2">
            <form onSubmit={handleRepoSubmit} className="flex-1">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo.git"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
                <button
                  type="submit"
                  disabled={isLoading}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
                >
                  {isLoading ? 'Processing...' : 'Analyze'}
                </button>
              </div>
            </form>
          
            <div className="flex items-center">
              <span className="text-gray-500 mx-2">or</span>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleZipUpload}
                accept=".zip"
                className="hidden"
                id="zip-upload"
              />
              <label
                htmlFor="zip-upload"
                className="px-3 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 cursor-pointer"
              >
                Upload ZIP
              </label>
            </div>
          </div>
        </div>
      </header>
    
      <main className="flex-1 max-w-7xl mx-auto w-full flex gap-4 p-4">
        {/* Graph Visualization Pane */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden flex-1 flex flex-col">
            {graph ? (
              <>
                <GraphControls 
                  onFilterChange={() => {}} 
                  onLayoutChange={() => {}} 
                />
                <div className="flex-1 min-h-0">
                  <GraphVisualization 
                    graph={graph} 
                    onNodeClick={setSelectedNodeId}
                  />
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-500">
                {isLoading ? (
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-2"></div>
                    <p>Processing repository...</p>
                  </div>
                ) : (
                  <p>Enter a repository URL or upload a ZIP to get started</p>
                )}
              </div>
            )}
          </div>
        </div>
      
        {/* Right Panel */}
        <div className="w-80 flex flex-col gap-4">
          {/* Source Viewer */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden flex-1 flex flex-col h-[40%]">
            <div className="p-3 border-b border-gray-200 bg-gray-50">
              <h2 className="text-sm font-medium text-gray-700">Source Code</h2>
            </div>
            {graph ? (
              <SourceViewer graph={graph} selectedNodeId={selectedNodeId} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-500">
                <p>Select a node to view source</p>
              </div>
            )}
          </div>
        
          {/* Chat Interface */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden flex-1 flex flex-col h-[60%]">
            <div className="p-3 border-b border-gray-200 bg-gray-50">
              <h2 className="text-sm font-medium text-gray-700">Ask About Code</h2>
            </div>
            {graph ? (
              <ChatInterface graph={graph} onQuery={handleQuery} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-500 p-4">
                <p>Process a repository to ask questions about the code</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
```

**How this works:**

1. The header has inputs for GitHub URLs and ZIP uploads
2. The main area has two panes:
   - Left: Graph visualization
   - Right: Source viewer and chat interface
3. When a repository is processed, the graph is displayed
4. Users can click nodes to see source code and ask questions

**Why this layout?** It provides a cohesive experience where users can:

- See the big picture (graph)
- Drill down to specific code (source viewer)
- Ask questions about what they're seeing (chat)

## Final Steps: Testing and Optimization

### Step 15: Add Error Boundaries

**Why this matters:** Inevitably, something will go wrong. We want to handle errors gracefully.

**Implementation:**

```tsx
import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 bg-red-50 border border-red-200 rounded-md">
          <h2 className="text-lg font-medium text-red-800 mb-2">Something went wrong</h2>
          <p className="text-red-700 mb-2">{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-3 py-1 bg-red-100 text-red-700 rounded-md hover:bg-red-200"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

**How this works:**

- It catches JavaScript errors in child components
- It displays a friendly error message instead of a blank screen
- It allows users to try again without losing their work

**Why use error boundaries?** They prevent a single error from breaking the entire application.

### Step 16: Implement Performance Optimizations

**Why this matters:** Large repositories can be slow to process. We need to keep the UI responsive.

**Key optimizations:**

1. **Web Workers**: Already implemented for graph processing
2. **Progress Indicators**: Show users what's happening
3. **File Filtering**: Only process relevant files
4. **Lazy Loading**: Load components as needed

**Implementation:**

```tsx
// Add to your GitHub processing function
const MAX_FILES = 500; // Limit for free tier
if (pythonFiles.length > MAX_FILES) {
  // Offer to filter by directory or file pattern
  const shouldFilter = window.confirm(
    `Repository has ${pythonFiles.length} Python files (max ${MAX_FILES}). ` +
    `Would you like to filter by directory or file pattern?`
  );
  if (shouldFilter) {
    const filterPattern = prompt(
      "Enter a directory path or file pattern to filter (e.g., 'src/', '*.py')",
      "src/"
    );
    if (filterPattern) {
      const filteredFiles = pythonFiles.filter(file => 
        file.includes(filterPattern) || file.endsWith(filterPattern)
      );
      pythonFiles = filteredFiles;
    }
  }
}
```

**Why limit file processing?** Processing too many files can:

- Freeze the browser tab
- Exceed GitHub API rate limits
- Use excessive memory

### Step 17: Add Export Functionality

**Why this matters:** Users might want to save or share their generated graphs.

**Implementation:**

```tsx
export function exportGraphToJson(graph: KnowledgeGraph): string {
  return JSON.stringify(graph, null, 2);
}

export function downloadGraph(graph: KnowledgeGraph, filename: string = 'gitnexus-graph.json') {
  const json = exportGraphToJson(graph);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
```

**How this works:**

1. Converts the graph to JSON
2. Creates a downloadable file
3. Triggers a download

**Why include export?** It allows users to:

- Save their work for later
- Share graphs with teammates
- Use the data in other tools

## Conclusion

This implementation guide has walked you through building a complete edge-based code knowledge graph generator using Deno. By following these steps, you'll create a privacy-focused tool that runs entirely in the user's browser.

**Key advantages of this approach:**

- **Zero server costs**: All processing happens in the user's browser
- **Strong privacy**: Code never leaves the user's machine
- **Modular architecture**: Easy to add more languages later
- **Clear separation of concerns**: Makes the codebase maintainable
- **Deno compatibility**: Modern runtime with built-in TypeScript support

Remember to start small (Python support only) and iterate, adding more features and language support as you validate the core functionality. The most important part is getting the graph construction pipeline working correctly - everything else builds on that foundation.
