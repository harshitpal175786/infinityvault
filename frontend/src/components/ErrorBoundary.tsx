import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from './Button'

type Props = { children: ReactNode }
type State = { error: Error | null; resetKey: number }

/**
 * Catches render-time throws so a single bad component cannot leave the user
 * staring at a blank white page.
 *
 * This vault may hold someone's only copies of their photos, so failing with no
 * message and no way back is the worst possible outcome. The fallback states
 * plainly that nothing was deleted, and offers a retry that re-mounts the tree
 * without a full reload.
 *
 * React boundaries do not catch async errors or event-handler throws; those are
 * surfaced by the existing toast system instead.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console for debugging; nothing is sent anywhere.
    console.error('InfinityVault render error:', error, info.componentStack)
  }

  private handleReset = (): void => {
    this.setState((current) => ({ error: null, resetKey: current.resetKey + 1 }))
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) {
      // Remount the subtree on reset so stale broken state is discarded.
      return <div key={this.state.resetKey} style={{ display: 'contents' }}>{this.props.children}</div>
    }

    return (
      <div className="crash-screen" role="alert">
        <div className="crash-card">
          <div className="crash-icon"><AlertTriangle size={22} /></div>
          <h1>Something went wrong while drawing this page</h1>
          <p>
            Your photos are safe. Nothing was deleted or changed — the problem is
            only in how the page was being displayed.
          </p>
          <pre className="crash-detail">{error.message}</pre>
          <div className="crash-actions">
            <Button variant="primary" onClick={this.handleReset}>
              <RotateCcw size={15} /> Try again
            </Button>
            <Button variant="ghost" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
