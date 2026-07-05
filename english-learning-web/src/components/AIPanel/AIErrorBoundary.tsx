// components/AIPanel/AIErrorBoundary.tsx
import { Component, type ReactNode } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class AIErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[AIErrorBoundary] caught error:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <AlertCircle size={36} className="text-red-400 mb-3" />
          <h3 className="text-base font-semibold text-white mb-1">AI 助手出错</h3>
          <p className="text-sm text-gray-400 mb-4 max-w-[280px]">
            {this.state.error?.message || '组件发生未知错误'}
          </p>
          <button
            onClick={this.handleRetry}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-subtitle-highlight/20 text-subtitle-highlight hover:bg-subtitle-highlight/30 transition-colors text-sm"
          >
            <RotateCcw size={14} />
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
