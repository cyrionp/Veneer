import { createRoot } from 'react-dom/client';
import { AdminPage } from './admin/AdminPage.tsx';
import { App } from './ui/App.tsx';
import './ui/styles.css';

const admin = /^\/admin\/?$/.test(location.pathname);
createRoot(document.getElementById('root')!).render(admin ? <AdminPage /> : <App />);
