import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreContext, project } from './store.js';
import App from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <StoreContext.Provider value={project}>
      <App />
    </StoreContext.Provider>
  </StrictMode>
);
