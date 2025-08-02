import React from 'react';
import { HomePage, ErrorBoundary } from './ui/index.ts';

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <HomePage />
    </ErrorBoundary>
  );
};

export default App;
