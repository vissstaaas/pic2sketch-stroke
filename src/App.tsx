import React from 'react';
import { GlobalErrorBoundary } from './components/ErrorBoundary';
import { SketchMvpPage } from './pages/SketchMvpPage';

export const App: React.FC = () => {
  return (
    <GlobalErrorBoundary>
      <SketchMvpPage />
    </GlobalErrorBoundary>
  );
};

export default App;
