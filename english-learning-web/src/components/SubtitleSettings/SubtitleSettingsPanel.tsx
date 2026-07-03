// components/SubtitleSettings/SubtitleSettingsPanel.tsx
import { X, RotateCcw } from 'lucide-react';
import { useSubtitleStore } from '../../stores/subtitleStore';

interface SubtitleSettingsPanelProps {
  onClose: () => void;
}

export function SubtitleSettingsPanel({ onClose }: SubtitleSettingsPanelProps) {
  const { settings, updateSettings, resetSettings } = useSubtitleStore();
  
  const fontOptions = [
    '"Inter", "Noto Sans SC", sans-serif',
    '"Noto Sans SC", "Microsoft YaHei", sans-serif',
    '"Roboto", sans-serif',
    '"Open Sans", sans-serif',
    'system-ui, sans-serif',
  ];
  
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-gray-900 rounded-xl p-6 w-[480px] max-h-[80vh] overflow-y-auto border border-white/10 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-white">字幕设置</h2>
          <div className="flex items-center gap-2">
            <button 
              className="p-2 text-gray-400 hover:text-white transition-colors"
              onClick={resetSettings}
              title="恢复默认"
            >
              <RotateCcw size={16} />
            </button>
            <button 
              className="p-2 text-gray-400 hover:text-white transition-colors"
              onClick={onClose}
            >
              <X size={20} />
            </button>
          </div>
        </div>
        
        <div className="space-y-5">
          {/* 显示模式 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">显示模式</label>
            <div className="flex gap-2">
              {(['bilingual', 'primary', 'secondary', 'none'] as const).map((mode) => (
                <button
                  key={mode}
                  className={`flex-1 py-2 px-3 rounded-lg text-sm transition-colors ${
                    settings.displayMode === mode
                      ? 'bg-subtitle-highlight text-black font-medium'
                      : 'bg-white/5 text-gray-300 hover:bg-white/10'
                  }`}
                  onClick={() => updateSettings({ displayMode: mode })}
                >
                  {mode === 'bilingual' ? '双语' : 
                   mode === 'primary' ? '仅英文' : 
                   mode === 'secondary' ? '仅中文' : '隐藏'}
                </button>
              ))}
            </div>
          </div>
          
          {/* 字体 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">字体</label>
            <select
              value={settings.fontFamily}
              onChange={(e) => updateSettings({ fontFamily: e.target.value })}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-subtitle-highlight"
            >
              {fontOptions.map((font) => (
                <option key={font} value={font}>{font.split(',')[0].replace(/"/g, '')}</option>
              ))}
            </select>
          </div>
          
          {/* 字号 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">字号: {settings.fontSize}px</label>
            <input
              type="range"
              min="12"
              max="32"
              value={settings.fontSize}
              onChange={(e) => updateSettings({ fontSize: parseInt(e.target.value) })}
              className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-subtitle-highlight"
            />
          </div>
          
          {/* 颜色 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-2">字体颜色</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={settings.fontColor}
                  onChange={(e) => updateSettings({ fontColor: e.target.value })}
                  className="w-10 h-10 rounded cursor-pointer"
                />
                <span className="text-sm text-gray-400">{settings.fontColor}</span>
              </div>
            </div>
            
            <div>
              <label className="block text-sm text-gray-400 mb-2">高亮颜色</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={settings.highlightColor}
                  onChange={(e) => updateSettings({ highlightColor: e.target.value })}
                  className="w-10 h-10 rounded cursor-pointer"
                />
                <span className="text-sm text-gray-400">{settings.highlightColor}</span>
              </div>
            </div>
          </div>
          
          {/* 背景透明度 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">背景透明度: {Math.round(settings.backgroundOpacity * 100)}%</label>
            <input
              type="range"
              min="0"
              max="100"
              value={settings.backgroundOpacity * 100}
              onChange={(e) => updateSettings({ backgroundOpacity: parseInt(e.target.value) / 100 })}
              className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-subtitle-highlight"
            />
          </div>
          
          {/* 位置 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">字幕位置</label>
            <div className="flex gap-2">
              {(['top', 'middle', 'bottom'] as const).map((pos) => (
                <button
                  key={pos}
                  className={`flex-1 py-2 px-3 rounded-lg text-sm transition-colors ${
                    settings.position === pos
                      ? 'bg-subtitle-highlight text-black font-medium'
                      : 'bg-white/5 text-gray-300 hover:bg-white/10'
                  }`}
                  onClick={() => updateSettings({ position: pos })}
                >
                  {pos === 'top' ? '顶部' : pos === 'middle' ? '中间' : '底部'}
                </button>
              ))}
            </div>
          </div>
          
          {/* 行高 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">行高: {settings.lineHeight}</label>
            <input
              type="range"
              min="1"
              max="2.5"
              step="0.1"
              value={settings.lineHeight}
              onChange={(e) => updateSettings({ lineHeight: parseFloat(e.target.value) })}
              className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-subtitle-highlight"
            />
          </div>
          
          {/* 自动滚动 */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-gray-400">自动滚动</label>
            <button
              className={`w-12 h-6 rounded-full transition-colors relative ${
                settings.autoScroll ? 'bg-subtitle-highlight' : 'bg-white/20'
              }`}
              onClick={() => updateSettings({ autoScroll: !settings.autoScroll })}
            >
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                settings.autoScroll ? 'translate-x-6' : 'translate-x-0.5'
              }`} />
            </button>
          </div>
        </div>
        
        {/* 预览 */}
        <div className="mt-6 p-4 bg-black/30 rounded-lg">
          <p className="text-xs text-gray-500 mb-2">预览</p>
          <div 
            className="inline-block px-4 py-2 rounded"
            style={{
              backgroundColor: `${settings.backgroundColor}${Math.round(settings.backgroundOpacity * 255).toString(16).padStart(2, '0')}`,
              fontFamily: settings.fontFamily,
            }}
          >
            <p style={{ 
              color: settings.fontColor,
              fontSize: `${settings.fontSize}px`,
              lineHeight: settings.lineHeight,
            }}>
              This is a preview text
            </p>
            <p style={{ 
              color: settings.fontColor,
              fontSize: `${settings.fontSize * 0.85}px`,
              lineHeight: settings.lineHeight,
              opacity: 0.9,
            }}>
              这是预览文本
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
