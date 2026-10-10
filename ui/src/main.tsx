import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import './styles.css';
