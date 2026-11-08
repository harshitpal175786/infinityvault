import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind both stacks. Vite's default is localhost, which on macOS resolves to
    // ::1 only, so http://127.0.0.1:5173 refuses the connection and the app
    // looks stopped when it is running.
    host: '127.0.0.1',
  },
})
