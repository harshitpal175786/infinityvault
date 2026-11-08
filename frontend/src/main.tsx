import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ToastProvider } from './components/Toast'
import './styles/tokens.css'
import './index.css'
import './styles/primitives.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
)
