import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './store/store';
import './store/region';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/motion.css';
import { installCardSpotlight } from './lib/motion';

// Handy for inspecting state from the console during development.
if (import.meta.env.DEV) (window as unknown as { estate: typeof useStore }).estate = useStore;

installCardSpotlight();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
