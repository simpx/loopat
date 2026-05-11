import React from "react"

interface State {
  error: Error | null
}

/**
 * Top-level error boundary. White-screens come from uncaught render errors
 * in the React tree (a renderer hitting `null.foo`, a malformed assistant
 * message, etc). This catches them and shows a recoverable fallback so the
 * whole UI doesn't disappear.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    const e = this.state.error
    return (
      <div className="m-4 flex flex-col gap-3 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900">
        <div className="font-medium">UI crashed — caught by error boundary</div>
        <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-white/70 p-2 text-xs leading-relaxed">
          {e.name}: {e.message}
          {e.stack ? `\n\n${e.stack}` : ""}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
            onClick={this.reset}
          >
            Try again
          </button>
          <button
            type="button"
            className="rounded border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      </div>
    )
  }
}
