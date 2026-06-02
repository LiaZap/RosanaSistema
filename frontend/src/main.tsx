import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './lib/theme';
import { RealtimeProvider } from './lib/realtime';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <RealtimeProvider>
        <App />
      </RealtimeProvider>
    </ThemeProvider>
  </StrictMode>,
);
