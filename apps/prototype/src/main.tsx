import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@/app/index.css';
import { PrototypeApp } from './prototype-app';

const root = document.getElementById('root');
if (!root) throw new Error('Prototype root container not found.');

document.documentElement.classList.add('dark');
document.documentElement.dataset.theme = 'dark';

createRoot(root).render(
  <StrictMode>
    <PrototypeApp />
  </StrictMode>
);
