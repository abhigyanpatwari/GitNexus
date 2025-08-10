# 🔍 Debug Mode Features

The GitNexus chat interface now includes a comprehensive debug mode that shows the internal workings of the Graph RAG agent.

## 📝 Markdown Formatting

**NEW**: The chat interface now supports full markdown formatting for better readability!

### Supported Markdown Features:
- **Headers** (# ## ###) for organizing information
- **Bold** and *italic* text for emphasis  
- `Inline code` for function names and file paths
- Code blocks with syntax highlighting for multiple languages
- Bullet points and numbered lists
- Tables for structured data
- Blockquotes for important notes
- Links (automatically open in new tabs)

### Enhanced Debug Display:
- **Reasoning observations** are now rendered with markdown
- **Query explanations** support formatted text
- **Tool outputs** preserve formatting and structure
- **Code snippets** get proper syntax highlighting

## How to Use Debug Mode

1. **Toggle Debug Mode**: Click the `🔍 Debug` button in the chat interface header
2. **Ask Questions**: When debug mode is enabled, all assistant responses will include detailed debug information
3. **Explore Tabs**: The debug panel includes multiple tabs showing different aspects of the processing

## Debug Panel Tabs

### 🧠 Reasoning Steps
Shows the complete ReAct (Reasoning + Acting) process:
- **Step-by-step thinking**: See how the agent reasons about your question
- **Actions taken**: View which tools the agent decides to use
- **Tool inputs**: See the exact parameters passed to each tool
- **Observations**: View the results returned by each tool
- **Success/failure status**: Monitor tool execution success

### 🔍 Cypher Queries
Displays generated graph queries:
- **Generated Cypher**: See the exact database queries created
- **Query explanations**: Understand why each query was generated
- **Confidence scores**: View how confident the system is in each query
- **Syntax highlighting**: Cypher queries displayed with proper formatting

### ⚙️ Configuration
Shows system configuration:
- **LLM Settings**: Provider, model, temperature, max tokens
- **RAG Options**: Reasoning steps, strict mode, temperature
- **Performance Metrics**: Execution time, confidence scores

### 📊 Context Info
Displays knowledge graph statistics:
- **Graph Nodes**: Total number of code entities in the graph
- **Files Indexed**: Number of source files processed
- **Sources Used**: Files referenced in the current response
- **Referenced Sources**: List of specific files used for the answer

## What You Can Learn

### Understanding Agent Behavior
- See how the agent breaks down complex questions
- Understand the reasoning process step-by-step
- Monitor which tools are used and why

### Query Optimization
- View generated Cypher queries to understand graph traversal
- See query confidence scores to assess reliability
- Learn about query patterns for different question types

### Performance Analysis
- Monitor execution times for different operations
- Understand the relationship between question complexity and processing time
- Identify bottlenecks in the reasoning process

### Context Awareness
- See how much of your codebase is being used
- Understand which files are most relevant to your questions
- Monitor the scope of graph traversal

## Debug Mode Benefits

1. **Transparency**: Complete visibility into AI decision-making
2. **Learning**: Understand how Graph RAG works internally
3. **Debugging**: Identify issues with queries or reasoning
4. **Optimization**: Fine-tune your questions for better results
5. **Trust**: Build confidence through explainable AI

## Example Debug Output

When you ask "How many functions are in this project?", debug mode shows:

**Reasoning Steps:**
1. **Thought**: "I need to count all functions in the project using a graph query"
2. **Action**: query_graph
3. **Input**: "Count all functions in the project"
4. **Observation**: Generated Cypher query and results

**Generated Query:**
```cypher
MATCH (f:Function) RETURN COUNT(f)
```

**Configuration:**
- Model: gpt-4o-mini
- Temperature: 0.1
- Execution Time: 1,234ms

This level of detail helps you understand exactly how your question was processed and answered. 