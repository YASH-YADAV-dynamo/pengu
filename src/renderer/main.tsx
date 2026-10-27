import { createRoot } from 'react-dom/client'
import '@fontsource/inter-tight/400.css'
import '@fontsource/inter-tight/500.css'
import '@fontsource/inter-tight/600.css'
import './styles.css'
import App from './App'
import Widget from './Widget'
import type { PenguApi } from '../preload'

declare global {
  interface Window {
    pengu: PenguApi
  }
}

// One bundle serves the main window and the widget. The hash decides which one to render,
// so there is a single build, CSP and theme instead of a separate HTML entry for the widget.
const widget = location.hash.startsWith('#/widget')
document.documentElement.dataset.platform = window.pengu.platform
if (widget) document.documentElement.classList.add('is-widget') // transparent page so the OS glass shows through
createRoot(document.getElementById('root')!).render(widget ? <Widget /> : <App />)
