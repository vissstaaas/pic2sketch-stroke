import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Studio Unhandled Rejection]', event.reason);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
