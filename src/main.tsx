import { createRoot } from 'react-dom/client';
import App from './App';
// Self-hosted (OFL) so the Explorer still loads no external fonts.
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './style.css';
import './playlist.css';
import './interaction.css';
import './guided.css';

createRoot(document.getElementById('root')!).render(<App/>);
