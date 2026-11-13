import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import App from './App.jsx';
import './styles.css';
import './layout.css';
import './forms.css';
import './theme.css';   // the design system: loaded last so it is the single source of truth for shared components
createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);
