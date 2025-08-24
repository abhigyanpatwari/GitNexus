import React, { useState, useCallback } from 'react';

interface RepositoryInputProps {
  onGitHubSubmit: (url: string) => void;
  onZipFileSubmit: (file: File) => void;
  disabled?: boolean;
  githubUrl: string;
  onGitHubUrlChange: (url: string) => void;
}

const RepositoryInput: React.FC<RepositoryInputProps> = ({
  onGitHubSubmit,
  onZipFileSubmit,
  disabled = false,
  githubUrl,
  onGitHubUrlChange
}) => {
  const [activeTab, setActiveTab] = useState<'github' | 'zip'>('github');
  const [dragOver, setDragOver] = useState(false);
  
  const handleGitHubSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (githubUrl.trim()) {
      onGitHubSubmit(githubUrl.trim());
    }
  }, [githubUrl, onGitHubSubmit]);
  
  const handleFileSelect = useCallback((file: File) => {
    if (file && file.name.endsWith('.zip')) {
      onZipFileSubmit(file);
    } else {
      alert('Please select a valid ZIP file');
    }
  }, [onZipFileSubmit]);
  
  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  }, [handleFileSelect]);
  
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    
    const file = e.dataTransfer.files[0];
    if (file) {
      handleFileSelect(file);
    }
  }, [handleFileSelect]);
  
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);
  
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);
  
  return (
    <div className="repository-input">
      <div className="tabs">
        <button
          className={`tab ${activeTab === 'github' ? 'active' : ''}`}
          onClick={() => setActiveTab('github')}
          disabled={disabled}
        >
          🐙 GitHub Repository
        </button>
        <button
          className={`tab ${activeTab === 'zip' ? 'active' : ''}`}
          onClick={() => setActiveTab('zip')}
          disabled={disabled}
        >
          📦 ZIP File
        </button>
      </div>
      
      {activeTab === 'github' && (
        <div className="tab-content">
          <form onSubmit={handleGitHubSubmit} className="github-form">
            <div className="input-group">
              <input
                type="url"
                placeholder="https://github.com/owner/repository"
                value={githubUrl}
                onChange={(e) => onGitHubUrlChange(e.target.value)}
                disabled={disabled}
                className="github-input"
                required
              />
              <button
                type="submit"
                disabled={disabled || !githubUrl.trim()}
                className="submit-button"
              >
                🚀 Process Repository
              </button>
            </div>
            <div className="github-help">
              💡 Enter a public GitHub repository URL to analyze its codebase
            </div>
          </form>
        </div>
      )}
      
      {activeTab === 'zip' && (
        <div className="tab-content">
          <div
            className={`zip-drop-zone ${dragOver ? 'drag-over' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <div className="drop-zone-content">
              <div className="drop-zone-icon">📁</div>
              <div className="drop-zone-text">
                <div className="drop-zone-primary">
                  Drop a ZIP file here or click to browse
                </div>
                <div className="drop-zone-secondary">
                  Upload a ZIP file containing your project source code
                </div>
              </div>
              <input
                type="file"
                accept=".zip"
                onChange={handleFileInput}
                disabled={disabled}
                className="file-input"
                id="zip-file-input"
              />
              <label htmlFor="zip-file-input" className="file-input-label">
                Browse Files
              </label>
            </div>
          </div>
        </div>
      )}
      
      <style>{`
        .repository-input {
          margin-bottom: 2rem;
          border: 1px solid #e0e0e0;
          border-radius: 8px;
          overflow: hidden;
          background-color: white;
        }
        
        .tabs {
          display: flex;
          background-color: #f5f5f5;
          border-bottom: 1px solid #e0e0e0;
        }
        
        .tab {
          flex: 1;
          padding: 1rem;
          border: none;
          background: none;
          cursor: pointer;
          font-size: 1rem;
          font-weight: 500;
          color: #666;
          transition: all 0.2s ease;
        }
        
        .tab:hover:not(:disabled) {
          background-color: #eeeeee;
          color: #333;
        }
        
        .tab.active {
          background-color: white;
          color: #007bff;
          border-bottom: 2px solid #007bff;
        }
        
        .tab:disabled {
          cursor: not-allowed;
          opacity: 0.6;
        }
        
        .tab-content {
          padding: 1.5rem;
        }
        
        .github-form {
          width: 100%;
        }
        
        .input-group {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }
        
        .github-input {
          flex: 1;
          padding: 0.75rem;
          border: 1px solid #ccc;
          border-radius: 4px;
          font-size: 1rem;
        }
        
        .github-input:focus {
          outline: none;
          border-color: #007bff;
          box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.1);
        }
        
        .submit-button {
          padding: 0.75rem 1.5rem;
          background-color: #007bff;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 0.2s ease;
        }
        
        .submit-button:hover:not(:disabled) {
          background-color: #0056b3;
        }
        
        .submit-button:disabled {
          background-color: #ccc;
          cursor: not-allowed;
        }
        
        .github-help {
          font-size: 0.9rem;
          color: #666;
          margin-top: 0.5rem;
        }
        
        .zip-drop-zone {
          border: 2px dashed #ccc;
          border-radius: 8px;
          padding: 2rem;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s ease;
          position: relative;
        }
        
        .zip-drop-zone:hover,
        .zip-drop-zone.drag-over {
          border-color: #007bff;
          background-color: #f8f9fa;
        }
        
        .drop-zone-content {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1rem;
        }
        
        .drop-zone-icon {
          font-size: 3rem;
          opacity: 0.6;
        }
        
        .drop-zone-text {
          text-align: center;
        }
        
        .drop-zone-primary {
          font-size: 1.1rem;
          font-weight: 500;
          color: #333;
          margin-bottom: 0.5rem;
        }
        
        .drop-zone-secondary {
          font-size: 0.9rem;
          color: #666;
        }
        
        .file-input {
          display: none;
        }
        
        .file-input-label {
          padding: 0.5rem 1rem;
          background-color: #007bff;
          color: white;
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.9rem;
          transition: background-color 0.2s ease;
        }
        
        .file-input-label:hover {
          background-color: #0056b3;
        }
      `}</style>
    </div>
  );
};

export default RepositoryInput;