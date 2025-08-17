# GitNexus Project Guide

This document provides a comprehensive technical overview of the GitNexus application, intended to give an LLM full context of the project's purpose, architecture, and implementation details.

## 1. Project Overview

GitNexus is a **client-side source code analysis tool** that runs entirely in the browser. It transforms a given codebase (from a public GitHub repository or an uploaded ZIP file) into an interactive **knowledge graph**.

The primary goal is to allow users to visually explore and understand complex codebases through two main interfaces:
1.  **A Graph Visualizer**: Displays the code structure as a network of nodes (files, classes, functions) and relationships (imports, calls, inheritance).
2.  **An AI Chat Interface**: A Retrieval-Augmented Generation (RAG) system that allows users to ask natural language questions about the code, which are answered by querying the knowledge graph.

Because it's fully client-side, no code is ever sent to a server, ensuring privacy and security.

## 2. Technology Stack

The project is built with a modern web technology stack:

- **Frontend Framework**: **React 18** with **TypeScript**.
- **Build Tool**: **Vite** for fast development and optimized builds.
- **Code Parsing**: **Tree-sitter** compiled to **WebAssembly (WASM)**. This allows for fast and accurate Abstract Syntax Tree (AST) parsing directly in the browser.
- **AI & RAG**: **LangChain.js** is used to orchestrate the AI agent, supporting multiple LLM providers (OpenAI, Anthropic, Google Gemini).
- **Concurrency**: **Web Workers** are used to run the entire code ingestion process in a background thread, preventing the UI from freezing. **Comlink** is used for simplifying communication with the worker.
- **Graph Visualization**: The UI likely uses a library like Cytoscape.js or D3.js to render the interactive graph (inferred from dependencies and functionality).
- **Styling**: A custom CSS-in-JS solution implemented directly within the `HomePage.tsx` component.

## 3. Architecture

The project follows a clean, modular architecture that separates concerns into distinct layers.

### `src/ui` - The Frontend Layer
- **Purpose**: Contains all React components, hooks, and pages.
- **Key Files**:
    - `pages/HomePage.tsx`: The main component that manages the application's state and orchestrates all user interactions. It handles user input, triggers the ingestion process, and displays the results.
    - `components/graph/GraphExplorer.tsx`: The React component responsible for rendering the interactive knowledge graph.
    - `components/chat/ChatInterface.tsx`: The component for the AI-powered chat.
    - `components/ErrorBoundary.tsx`: A crucial component for catching and gracefully handling runtime errors in the UI.

### `src/core` - The Core Logic Layer
- **Purpose**: This is the engine of the application where the knowledge graph is built.
- **Key Files**:
    - `ingestion/pipeline.ts`: Defines the `GraphPipeline`, which executes the multi-pass ingestion process.
    - `ingestion/structure-processor.ts`: **Pass 1**: Analyzes the file and directory structure.
    - `ingestion/parsing-processor.ts`: **Pass 2**: Uses Tree-sitter to parse source files into ASTs and extracts definitions (classes, functions, etc.).
    - `ingestion/import-processor.ts`: **Pass 3**: Resolves import statements between files.
    - `ingestion/call-processor.ts`: **Pass 4**: Resolves function and method calls between definitions.
    - `graph/graph.ts`: Defines the `SimpleKnowledgeGraph` class, the core data structure for the graph.
    - `tree-sitter/parser-loader.ts`: Manages the loading of the various language-specific Tree-sitter WASM parsers.

### `src/workers` - The Concurrency Layer
- **Purpose**: Offloads the intensive ingestion process from the main UI thread.
- **Key Files**:
    - `ingestion.worker.ts`: The entry point for the Web Worker. It receives file data from the UI, runs the `GraphPipeline`, and posts the resulting knowledge graph back to the main thread.

### `src/services` - The External Services Layer
- **Purpose**: Handles communication with external sources.
- **Key Files**:
    - `ingestion.service.ts`: Acts as a bridge between the UI (`HomePage.tsx`) and the `IngestionWorker`.
    - `github.ts`: Contains logic for fetching repository contents from the GitHub API.
    - `zip.ts`: Contains logic for reading and extracting files from an uploaded ZIP archive.

### `src/ai` - The Artificial Intelligence Layer
- **Purpose**: Manages the LLM interactions for the Graph RAG chat.
- **Key Files**:
    - `llm-service.ts`: A client that handles communication with the different supported LLM providers (OpenAI, etc.).
    - `langchain-orchestrator.ts`: Implements the ReAct agent logic using LangChain, defining the tools the agent can use (e.g., querying the graph).
    - `cypher-generator.ts`: Translates natural language questions into Cypher-like queries to be executed against the knowledge graph.

## 4. Core Concepts & Execution Flow

### The Knowledge Graph Data Model
The entire application revolves around the `KnowledgeGraph` object defined in `src/core/graph/graph.ts`. It's a simple structure containing two arrays:
- `nodes`: Represent code entities like `File`, `Folder`, `Class`, `Function`, etc.
- `relationships`: Represent the connections between nodes, such as `CONTAINS`, `IMPORTS`, `CALLS`.

### The Ingestion Pipeline
This is the central process for understanding code. When a user provides a repository, the following happens:
1.  **File Gathering**: The `IngestionService` fetches all file paths and their text content, either from GitHub or a ZIP file.
2.  **Worker Invocation**: The file data is passed to the `IngestionWorker`.
3.  **Pipeline Execution**: The worker runs the `GraphPipeline`, which executes its 4 passes sequentially on the `SimpleKnowledgeGraph` instance:
    - **Pass 1 (Structure)**: Creates `Project`, `Folder`, and `File` nodes, and links them with `CONTAINS` relationships.
    - **Pass 2 (Parsing)**: Parses the AST of each source file, creating `Function`, `Class`, and other code-level nodes. It links these nodes to their parent `File` node with `DEFINES` relationships.
    - **Pass 3 (Imports)**: Analyzes `import` statements and creates `IMPORTS` relationships between code entities.
    - **Pass 4 (Calls)**: Analyzes the code to find function and method calls, creating `CALLS` relationships between them.
4.  **Return to UI**: The completed graph is returned to the `HomePage.tsx` component, which updates its state and renders the visual graph.

This multi-pass approach ensures that the graph is built layer by layer, with each pass adding more detail and context.

## 5. Potential Issues & Areas for Improvement

This section details findings from a deep analysis of the codebase, highlighting areas for refactoring and potential bugs.

### 1. State Management in `HomePage.tsx`
- **Issue**: The component uses a single, large `useState` hook to manage the entire application state (`AppState`). Any small update, such as user input in a text field, triggers a re-render of the entire component and all its children.
- **Impact**: This can lead to a sluggish UI and poor performance, especially as the application grows in complexity.
- **Recommendation**: Refactor the state management. Use more granular `useState` hooks for simple, independent state. For state that needs to be shared across many components, consider using React's Context API or a lightweight state management library to prevent unnecessary re-renders.

### 2. Redundant `generateId` Function
- **Issue**: The file `src/core/ingestion/parsing-processor.ts` contains a local `generateId` function that uses a simple (and potentially collision-prone) hashing algorithm. A more robust, UUID-based `generateId` function already exists in `src/lib/utils.ts`.
- **Impact**: Code duplication and the risk of using an inferior ID generation method, which could lead to node ID collisions in the graph.
- **Recommendation**: Remove the local `generateId` function from `parsing-processor.ts` and update the file to import and use the centralized version from `src/lib/utils.ts`.

### 3. Inefficient Graph Integrity Checks
- **Issue**: The `validateGraphIntegrity` method in `src/core/ingestion/pipeline.ts` performs several distinct traversals (`filter`, `some`, `find`) over the entire graph to find issues like orphaned nodes or files without definitions. 
- **Impact**: On large codebases, this can significantly slow down the final phase of the ingestion process.
- **Recommendation**: Optimize these validation checks. Many of them can be combined into a single pass over the graph's nodes and relationships. Using a `Map` or `Set` for lookups within the pass would be much more performant than repeated array iterations.

### 4. Hardcoded Filtering Logic
- **Issue**: The `CallProcessor` in `src/core/ingestion/call-processor.ts` defines its own large, hardcoded `Set` of Python built-in functions to ignore during call resolution. This logic is disconnected from the centralized language configurations.
- **Impact**: This makes the list difficult to maintain and extend. It also violates the principle of single-source-of-truth, as language-specific knowledge should be centralized.
- **Recommendation**: Refactor the `CallProcessor` to use the `builtinFunctions` set from the `language-config.ts` file. This centralizes language-specific data and makes the processor more modular.

### 5. Mock/Incomplete Query Engine
- **Issue**: The `GraphQueryEngine` in `src/core/graph/query-engine.ts` is a mock implementation that uses regular expressions to parse Cypher-like queries. This approach is not robust and only supports a very limited subset of valid queries.
- **Impact**: This is a critical limitation for the AI chat feature. The `CypherGenerator` can produce complex queries that the engine cannot execute, leading to failed tool calls and inaccurate answers from the AI.
- **Recommendation**: This is a major area for future development. The regex-based parser should be replaced with a more robust solution. Options include:
    - Implementing a proper parser for a small, well-defined subset of Cypher.
    - Integrating a lightweight, in-browser graph database library that supports Cypher queries.
