import React from 'react';
import { AlertOctagon, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class GlobalErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[GlobalErrorBoundary] Uncaught studio error:', error, errorInfo);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="global-error-screen" role="alert">
          <div className="global-error-card">
            <div className="global-error-icon">
              <AlertOctagon size={28} />
            </div>
            <h2>画室运行出现异常</h2>
            <p className="global-error-detail">
              {this.state.error?.message || '渲染或脚本执行期间捕获到未预期错误。'}
            </p>
            <div className="global-error-actions">
              <button type="button" className="ctrl-btn btn-play" onClick={this.handleReset}>
                <RotateCcw size={16} />
                <span>恢复工作台</span>
              </button>
              <button
                type="button"
                className="ctrl-btn btn-replay"
                onClick={() => window.location.reload()}
              >
                <span>刷新页面</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
