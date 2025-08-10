# 🚀 Knowledge Graph Generation Architecture Upgrade

## Overview

The knowledge graph generation pipeline has been completely restructured to address two critical weaknesses:

1. **Inaccurate Call Resolution** - Previous monolithic approach lacked project-wide visibility
2. **Inefficient Definition Lookups** - Simple map-based storage limited advanced resolution heuristics

## 🏗️ New Architecture: 4-Pass Decoupled Pipeline

### **Pass 1: Structure Analysis** 📁
- **Processor**: `StructureProcessor`
- **Purpose**: Build project hierarchy (folders, files)
- **Output**: Basic graph structure with CONTAINS relationships

### **Pass 2: Code Parsing & Definition Extraction** 🔍
- **Processor**: `ParsingProcessor` (Enhanced)
- **Purpose**: Parse source code and extract definitions
- **Key Enhancement**: Populates `FunctionRegistryTrie` for efficient lookups
- **Output**: Function/class/method nodes + optimized search structure

### **Pass 3: Import Resolution** 🔗
- **Processor**: `ImportProcessor` (NEW)
- **Purpose**: Build comprehensive project-wide import map
- **Key Features**:
  - Resolves all aliases and relative paths
  - Handles Python, JavaScript, TypeScript imports
  - Creates accurate IMPORTS relationships
- **Output**: Complete dependency graph + import map

### **Pass 4: Call Resolution** 📞
- **Processor**: `CallProcessor` (Completely Rewritten)
- **Purpose**: Resolve function calls using 3-stage strategy
- **Input**: Import map + Function registry trie
- **Output**: Accurate CALLS relationships

## 🧠 Key Innovations

### 1. FunctionRegistryTrie (`src/core/graph/trie.ts`)

**Purpose**: Optimized data structure for function definition lookups

**Key Features**:
- **Suffix-based search**: `findEndingWith(name)` for heuristic matching
- **Qualified names**: Stores full paths like `myProject.services.api.fetchUser`
- **Import distance calculation**: Smart scoring for best match selection

**Example Usage**:
```typescript
// Find all functions ending with "fetchUser" across the project
const candidates = trie.findEndingWith("fetchUser");
// Returns: [
//   { qualifiedName: "services.api.fetchUser", filePath: "services/api.py" },
//   { qualifiedName: "utils.cache.fetchUser", filePath: "utils/cache.js" }
// ]
```

### 2. ImportProcessor (`src/core/ingestion/import-processor.ts`)

**Purpose**: Dedicated import resolution with project-wide visibility

**Key Features**:
- **Language Support**: Python (`import`, `from...import`) and JS/TS (`import`, `require`)
- **Path Resolution**: Handles relative imports (`.`, `..`) and absolute imports
- **Alias Tracking**: Maps local names to actual exported functions
- **Validation**: Checks against actual project files

**Example Output**:
```typescript
importMap = {
  "src/api.js": {
    "fetchUser": {
      targetFile: "src/services/user.js",
      exportedName: "fetchUser",
      importType: "named"
    }
  }
}
```

### 3. Advanced Call Resolution Strategy

**3-Stage Resolution Process**:

#### Stage 1: Exact Match (High Confidence)
- Uses import map for direct resolution
- Example: `import { fetchUser } from './services'` → Direct link to `services/fetchUser`

#### Stage 2: Same-Module Match (High Confidence)  
- Checks for function definitions within the same file
- Example: Local function calls within a module

#### Stage 3: Heuristic Fallback (Intelligent Guessing)
- Uses `FunctionRegistryTrie.findEndingWith()` to find candidates
- Applies **import distance** algorithm for best match
- **Distance Formula**: `max(caller_parts, candidate_parts) - common_prefix_length`
- **Sibling Bonus**: -1 for functions in same parent directory

**Example Heuristic Resolution**:
```
Call: fetchUser() in "src/components/UserList.js"
Candidates found:
- src/services/user.js:fetchUser (distance: 2)
- src/utils/api.js:fetchUser (distance: 2) 
- src/components/utils.js:fetchUser (distance: 1) ← SELECTED (sibling bonus)
```

## 📊 Performance & Accuracy Improvements

### Resolution Statistics
The new CallProcessor provides detailed statistics:
- **Exact matches** (Stage 1): Highest confidence
- **Same-file matches** (Stage 2): High confidence  
- **Heuristic matches** (Stage 3): Medium confidence with distance scoring
- **Failed resolutions**: Tracked for debugging

### Expected Improvements
- **🎯 Higher Accuracy**: Project-wide visibility eliminates cross-file resolution failures
- **⚡ Better Performance**: Trie-based lookups vs linear searches
- **🔍 Smarter Heuristics**: Distance-based scoring for ambiguous cases
- **📈 Detailed Metrics**: Comprehensive resolution statistics

## 🔧 Technical Implementation Details

### File Structure
```
src/core/
├── graph/
│   └── trie.ts              # FunctionRegistryTrie implementation
├── ingestion/
│   ├── pipeline.ts          # Updated 4-pass orchestration
│   ├── structure-processor.ts
│   ├── parsing-processor.ts # Enhanced with trie population
│   ├── import-processor.ts  # NEW: Dedicated import resolution
│   └── call-processor.ts    # Completely rewritten
```

### Integration Points
1. **ParsingProcessor** populates the trie during definition extraction
2. **ImportProcessor** builds the complete import map
3. **CallProcessor** uses both trie and import map for resolution
4. **Pipeline** orchestrates the sequence with proper data flow

### Browser Compatibility
- Custom path utilities replace Node.js `path` module
- All processors work in browser environment
- Maintains existing WASM tree-sitter integration

## 🚀 Usage

The new architecture is fully integrated into the existing pipeline. No changes required for:
- UI components
- Worker integration  
- Export functionality
- Statistics display

The system automatically uses the new 4-pass architecture for all repository processing.

## 🎯 Results

This architecture upgrade transforms the knowledge graph generation from a basic parser into an intelligent code analysis system capable of:

- **Accurate cross-file call resolution**
- **Smart import dependency tracking** 
- **Heuristic-based intelligent guessing**
- **Comprehensive project-wide visibility**
- **Detailed resolution analytics**

The result is a significantly more accurate and comprehensive knowledge graph that truly represents the structure and relationships within a codebase. 