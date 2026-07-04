import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ChatProvider } from './context/ChatContext';
import './styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <ChatProvider>
        <App />
      </ChatProvider>
    </HashRouter>
  </React.StrictMode>
);
