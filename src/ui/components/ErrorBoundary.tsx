import React, { Component, ReactNode } from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // Update state so the next render will show the fallback UI
    return {
      hasError: true,
      error
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log the error to console for debugging
    console.error('ErrorBoundary caught an error:', error);
    console.error('Error info:', errorInfo);

    // Update state with error details
    this.setState({
      error,
      errorInfo
    });

    // Call optional error handler
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // In a production app, you might want to log this to an error reporting service
    // logErrorToService(error, errorInfo);
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null
    });
  };

  render() {
    if (this.state.hasError) {
      // Custom fallback UI
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI
      return (
        <div style={containerStyle}>
          <div style={errorBoxStyle}>
            <div style={iconStyle}>⚠️</div>
            
            <h2 style={titleStyle}>Something went wrong</h2>
            
            <p style={messageStyle}>
              We encountered an unexpected error. This might be due to a temporary issue 
              or an incompatibility with your browser.
            </p>

            <div style={buttonContainerStyle}>
              <button
                onClick={this.handleReset}
                style={primaryButtonStyle}
              >
                Try Again
              </button>
              
              <button
                onClick={() => window.location.reload()}
                style={secondaryButtonStyle}
              >
                Reload Page
              </button>
            </div>

            {/* Error details (collapsible) */}
            <details style={detailsStyle}>
              <summary style={summaryStyle}>
                Technical Details (for developers)
              </summary>
              
              <div style={errorDetailsStyle}>
                <div style={errorSectionStyle}>
                  <strong>Error:</strong>
                  <pre style={preStyle}>
                    {this.state.error?.toString()}
                  </pre>
                </div>
                
                {this.state.errorInfo && (
                  <div style={errorSectionStyle}>
                    <strong>Component Stack:</strong>
                    <pre style={preStyle}>
                      {this.state.errorInfo.componentStack}
                    </pre>
                  </div>
                )}
                
                {this.state.error?.stack && (
                  <div style={errorSectionStyle}>
                    <strong>Stack Trace:</strong>
                    <pre style={preStyle}>
                      {this.state.error.stack}
                    </pre>
                  </div>
                )}
              </div>
            </details>

            <div style={helpTextStyle}>
              <p>
                <strong>What you can do:</strong>
              </p>
              <ul style={helpListStyle}>
                <li>Try refreshing the page</li>
                <li>Clear your browser cache and reload</li>
                <li>Try a different browser</li>
                <li>Check the console for additional error details</li>
              </ul>
              
              <p style={reportStyle}>
                If this problem persists, please report it with the technical details above.
              </p>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Styles
const containerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '400px',
  padding: '20px',
  backgroundColor: '#f8f9fa',
  fontFamily: 'system-ui, -apple-system, sans-serif'
};

const errorBoxStyle: React.CSSProperties = {
  maxWidth: '600px',
  width: '100%',
  backgroundColor: '#fff',
  borderRadius: '8px',
  padding: '32px',
  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
  border: '1px solid #e9ecef',
  textAlign: 'center'
};

const iconStyle: React.CSSProperties = {
  fontSize: '48px',
  marginBottom: '16px'
};

const titleStyle: React.CSSProperties = {
  fontSize: '24px',
  fontWeight: '600',
  color: '#dc3545',
  margin: '0 0 16px 0'
};

const messageStyle: React.CSSProperties = {
  fontSize: '16px',
  color: '#666',
  lineHeight: '1.5',
  margin: '0 0 24px 0'
};

const buttonContainerStyle: React.CSSProperties = {
  display: 'flex',
  gap: '12px',
  justifyContent: 'center',
  marginBottom: '24px'
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '12px 24px',
  backgroundColor: '#007bff',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontSize: '14px',
  fontWeight: '500',
  cursor: 'pointer',
  transition: 'background-color 0.2s ease'
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '12px 24px',
  backgroundColor: '#6c757d',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontSize: '14px',
  fontWeight: '500',
  cursor: 'pointer',
  transition: 'background-color 0.2s ease'
};

const detailsStyle: React.CSSProperties = {
  textAlign: 'left',
  marginTop: '24px',
  border: '1px solid #dee2e6',
  borderRadius: '4px'
};

const summaryStyle: React.CSSProperties = {
  padding: '12px 16px',
  backgroundColor: '#f8f9fa',
  cursor: 'pointer',
  fontSize: '14px',
  fontWeight: '500',
  borderBottom: '1px solid #dee2e6'
};

const errorDetailsStyle: React.CSSProperties = {
  padding: '16px',
  fontSize: '12px'
};

const errorSectionStyle: React.CSSProperties = {
  marginBottom: '16px'
};

const preStyle: React.CSSProperties = {
  backgroundColor: '#f8f9fa',
  padding: '12px',
  borderRadius: '4px',
  overflow: 'auto',
  fontSize: '11px',
  fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, source-code-pro, monospace',
  color: '#e83e8c',
  border: '1px solid #dee2e6',
  marginTop: '8px'
};

const helpTextStyle: React.CSSProperties = {
  textAlign: 'left',
  marginTop: '24px',
  padding: '16px',
  backgroundColor: '#f8f9fa',
  borderRadius: '4px',
  fontSize: '14px'
};

const helpListStyle: React.CSSProperties = {
  margin: '8px 0',
  paddingLeft: '20px'
};

const reportStyle: React.CSSProperties = {
  fontSize: '12px',
  color: '#666',
  fontStyle: 'italic',
  marginTop: '12px'
};

export default ErrorBoundary; 