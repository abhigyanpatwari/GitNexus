import React, { useState } from 'react';

interface DiagnosticInfo {
  processedFiles: number;
  skippedFiles: number;
  totalDefinitions: number;
  definitionsByType: Record<string, number>;
  definitionsByFile: Record<string, number>;
  processingErrors: string[];
}

interface FileAnalysis {
  language: string;
  isSourceFile: boolean;
  isConfigFile: boolean;
  isCompiled: boolean;
  contentLength: number;
  queryResults: Record<string, number>;
  extractionIssues: string[];
}

interface DiagnosticPanelProps {
  onGetDiagnostics?: () => DiagnosticInfo | null;
  onAnalyzeFile?: (filePath: string, content: string) => Promise<FileAnalysis>;
  fileContents?: Map<string, string>;
}

export default function DiagnosticPanel({ 
  onGetDiagnostics, 
  onAnalyzeFile, 
  fileContents 
}: DiagnosticPanelProps) {
  const [diagnostics, setDiagnostics] = useState<DiagnosticInfo | null>(null);
  const [fileAnalysis, setFileAnalysis] = useState<FileAnalysis | null>(null);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const handleGetDiagnostics = () => {
    if (onGetDiagnostics) {
      const result = onGetDiagnostics();
      setDiagnostics(result);
    }
  };

  const handleAnalyzeFile = async () => {
    if (!onAnalyzeFile || !selectedFile || !fileContents) return;
    
    const content = fileContents.get(selectedFile);
    if (!content) {
      alert('File content not found');
      return;
    }

    setIsAnalyzing(true);
    try {
      const result = await onAnalyzeFile(selectedFile, content);
      setFileAnalysis(result);
    } catch (error) {
      console.error('Error analyzing file:', error);
      alert('Error analyzing file: ' + error);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const fileList = fileContents ? Array.from(fileContents.keys()).sort() : [];

  const containerStyle: React.CSSProperties = {
    padding: '20px',
    backgroundColor: '#f8f9fa',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    margin: '10px',
    fontFamily: 'Arial, sans-serif'
  };

  const sectionStyle: React.CSSProperties = {
    marginBottom: '20px',
    padding: '15px',
    backgroundColor: 'white',
    borderRadius: '6px',
    border: '1px solid #ddd'
  };

  const buttonStyle: React.CSSProperties = {
    padding: '8px 16px',
    backgroundColor: '#007bff',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    marginRight: '10px'
  };

  const selectStyle: React.CSSProperties = {
    padding: '8px',
    marginRight: '10px',
    borderRadius: '4px',
    border: '1px solid #ccc',
    minWidth: '300px'
  };

  return (
    <div style={containerStyle}>
      <h2>🔍 Parsing Diagnostics</h2>
      
      {/* Overall Diagnostics Section */}
      <div style={sectionStyle}>
        <h3>Overall Parsing Statistics</h3>
        <button style={buttonStyle} onClick={handleGetDiagnostics}>
          Get Diagnostics
        </button>
        
        {diagnostics && (
          <div style={{ marginTop: '15px' }}>
            <h4>📊 Summary</h4>
            <ul>
              <li><strong>Processed Files:</strong> {diagnostics.processedFiles}</li>
              <li><strong>Total Definitions:</strong> {diagnostics.totalDefinitions}</li>
            </ul>
            
            <h4>📋 Definitions by Type</h4>
            <ul>
              {Object.entries(diagnostics.definitionsByType).map(([type, count]) => (
                <li key={type}><strong>{type}:</strong> {count}</li>
              ))}
            </ul>
            
            <h4>📁 Top Files by Definition Count</h4>
            <ul>
              {Object.entries(diagnostics.definitionsByFile)
                .sort(([,a], [,b]) => b - a)
                .slice(0, 10)
                .map(([file, count]) => (
                  <li key={file}><strong>{file.split('/').pop()}:</strong> {count} definitions</li>
                ))}
            </ul>
          </div>
        )}
      </div>

      {/* Individual File Analysis Section */}
      <div style={sectionStyle}>
        <h3>Individual File Analysis</h3>
        <div style={{ marginBottom: '15px' }}>
          <select 
            style={selectStyle}
            value={selectedFile} 
            onChange={(e) => setSelectedFile(e.target.value)}
          >
            <option value="">Select a file to analyze...</option>
            {fileList.map(file => (
              <option key={file} value={file}>
                {file}
              </option>
            ))}
          </select>
          <button 
            style={buttonStyle} 
            onClick={handleAnalyzeFile}
            disabled={!selectedFile || isAnalyzing}
          >
            {isAnalyzing ? 'Analyzing...' : 'Analyze File'}
          </button>
        </div>
        
        {fileAnalysis && (
          <div style={{ marginTop: '15px' }}>
            <h4>📄 Analysis Results for: {selectedFile.split('/').pop()}</h4>
            
            <div style={{ marginBottom: '10px' }}>
              <strong>Language:</strong> {fileAnalysis.language}<br/>
              <strong>Source File:</strong> {fileAnalysis.isSourceFile ? '✅ Yes' : '❌ No'}<br/>
              <strong>Config File:</strong> {fileAnalysis.isConfigFile ? '✅ Yes' : '❌ No'}<br/>
              <strong>Compiled/Minified:</strong> {fileAnalysis.isCompiled ? '⚠️ Yes' : '✅ No'}<br/>
              <strong>Content Length:</strong> {fileAnalysis.contentLength} characters
            </div>
            
            <h5>🔍 Query Results</h5>
            <ul>
              {Object.entries(fileAnalysis.queryResults).map(([query, count]) => (
                <li key={query}><strong>{query}:</strong> {count} matches</li>
              ))}
            </ul>
            
            {fileAnalysis.extractionIssues.length > 0 && (
              <>
                <h5>⚠️ Extraction Issues</h5>
                <ul>
                  {fileAnalysis.extractionIssues.map((issue, index) => (
                    <li key={index} style={{ color: '#d32f2f' }}>{issue}</li>
                  ))}
                </ul>
              </>
            )}
            
            {fileAnalysis.extractionIssues.length === 0 && 
             Object.values(fileAnalysis.queryResults).every(count => count === 0) && (
              <div style={{ color: '#f57c00', fontWeight: 'bold' }}>
                ℹ️ No extraction issues found, but no definitions were extracted. 
                This might be a file with no parseable definitions (like documentation, empty files, or pure data files).
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}