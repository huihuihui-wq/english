// components/LoadingSpinner/LoadingSpinner.tsx - 加载动画组件

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  text?: string;
  className?: string;
}

export function LoadingSpinner({ size = 'md', text, className = '' }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'w-4 h-4 border-2',
    md: 'w-6 h-6 border-2',
    lg: 'w-8 h-8 border-3',
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div
        className={`${sizeClasses[size]} border-subtitle-highlight border-t-transparent rounded-full animate-spin`}
      />
      {text && (
        <span className="text-sm text-gray-400 animate-pulse">{text}</span>
      )}
    </div>
  );
}

// AI 思考中的动画
export function AIThinking({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-3 p-3 bg-white/5 rounded-lg ${className}`}>
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="w-2 h-2 bg-subtitle-highlight rounded-full animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
      <span className="text-sm text-gray-400">AI 正在思考...</span>
    </div>
  );
}

// 骨架屏加载
export function SkeletonLoader({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-4 bg-white/10 rounded animate-pulse"
          style={{
            width: `${Math.random() * 40 + 60}%`,
            animationDelay: `${i * 0.1}s`,
          }}
        />
      ))}
    </div>
  );
}
