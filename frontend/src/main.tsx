import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './store/store';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

// Handy for inspecting state from the console during development.
if (import.meta.env.DEV) (window as unknown as { estate: typeof useStore }).estate = useStore;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
