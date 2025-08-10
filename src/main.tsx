import './lib/polyfills.ts';
import './lib/preload.ts';
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <App />
)
