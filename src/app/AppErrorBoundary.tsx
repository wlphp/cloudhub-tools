import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[app] render failed:", error, info.componentStack);
  }

  private handleReload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-error-boundary" role="alert" aria-live="assertive">
        <div className="app-error-boundary-card">
          <div className="app-error-boundary-icon">
            <AlertTriangle size={20} aria-hidden="true" />
          </div>
          <div className="app-error-boundary-copy">
            <span className="eyebrow">启动错误</span>
            <h2>界面初始化失败</h2>
            <p>应用在挂载过程中遇到未处理的错误。请尝试重新加载；若问题持续，请查看终端日志。</p>
            <pre className="app-error-boundary-detail">{this.state.error.message}</pre>
          </div>
          <div className="app-error-boundary-actions">
            <button type="button" className="secondary" onClick={this.handleReset}>重试</button>
            <button type="button" className="primary" onClick={this.handleReload}>
              <RefreshCw size={14} aria-hidden="true" /> 重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
