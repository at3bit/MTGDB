import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import './ui/styles.css';

// No StrictMode: its double-run of effects would open the camera / video twice on the same <video> element.
createRoot(document.getElementById('root')!).render(<App />);
