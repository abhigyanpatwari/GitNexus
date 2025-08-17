import React from 'react';

export type ExportFormat = 'csv' | 'json';

interface ExportFormatModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectFormat: (format: ExportFormat) => void;
  projectName?: string;
}

const ExportFormatModal: React.FC<ExportFormatModalProps> = ({
  isOpen,
  onClose,
  onSelectFormat,
  projectName
}) => {
  if (!isOpen) return null;

  const handleFormatSelect = (format: ExportFormat) => {
    onSelectFormat(format);
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">
            Export Knowledge Graph
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Close modal"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-gray-600 mb-6">
          Choose the export format for your knowledge graph:
          {projectName && (
            <span className="block text-sm text-gray-500 mt-1">
              Project: {projectName}
            </span>
          )}
        </p>

        <div className="space-y-3">
          {/* CSV Option */}
          <button
            onClick={() => handleFormatSelect('csv')}
            className="w-full p-4 border border-gray-200 rounded-lg hover:border-blue-300 hover:bg-blue-50 transition-all duration-200 text-left group"
          >
            <div className="flex items-start space-x-3">
              <div className="flex-shrink-0 w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center group-hover:bg-green-200 transition-colors">
                <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="font-medium text-gray-900 group-hover:text-blue-900 transition-colors">
                  CSV Format
                </h3>
                <p className="text-sm text-gray-600 mt-1">
                  Best for importing into Neo4j, Amazon Neptune, and other graph databases. 
                  Exports as separate nodes and relationships files.
                </p>
                <div className="text-xs text-gray-500 mt-2">
                  <span className="inline-block bg-green-100 text-green-800 px-2 py-1 rounded mr-2">
                    Fast Import
                  </span>
                  <span className="inline-block bg-blue-100 text-blue-800 px-2 py-1 rounded">
                    Universal Support
                  </span>
                </div>
              </div>
            </div>
          </button>

          {/* JSON Option */}
          <button
            onClick={() => handleFormatSelect('json')}
            className="w-full p-4 border border-gray-200 rounded-lg hover:border-purple-300 hover:bg-purple-50 transition-all duration-200 text-left group"
          >
            <div className="flex items-start space-x-3">
              <div className="flex-shrink-0 w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center group-hover:bg-purple-200 transition-colors">
                <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="font-medium text-gray-900 group-hover:text-purple-900 transition-colors">
                  JSON Format
                </h3>
                <p className="text-sm text-gray-600 mt-1">
                  Complete export with metadata, source code, and processing information. 
                  Perfect for backup and analysis.
                </p>
                <div className="text-xs text-gray-500 mt-2">
                  <span className="inline-block bg-purple-100 text-purple-800 px-2 py-1 rounded mr-2">
                    Complete Data
                  </span>
                  <span className="inline-block bg-orange-100 text-orange-800 px-2 py-1 rounded">
                    Human Readable
                  </span>
                </div>
              </div>
            </div>
          </button>
        </div>

        <div className="mt-6 pt-4 border-t border-gray-200">
          <div className="text-xs text-gray-500 space-y-1">
            <p><strong>CSV:</strong> Two files (nodes.csv, relationships.csv) - optimized for database import</p>
            <p><strong>JSON:</strong> Single file with complete graph data and metadata</p>
          </div>
        </div>

        <div className="mt-6 flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExportFormatModal;
