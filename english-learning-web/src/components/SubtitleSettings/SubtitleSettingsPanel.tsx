// components/SubtitleSettings/SubtitleSettingsPanel.tsx
import { X, RotateCcw } from 'lucide-react';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useStudyStore } from '../../stores/studyStore';

interface SubtitleSettingsPanelProps {
  onClose: () => void;
}

export function SubtitleSettingsPanel({ onClose }: SubtitleSettingsPanelProps) {
  const { settings, updateSettings, resetSettings } = useSubtitleStore();
  const {
    scrollMode, setScrollMode,
    shadowingPauseMs, setShadowingPauseMs,
    shadowingLoopCount, setShadowingLoopCount,
  } = useStudyStore();

  const fontOptions = [
    '"Inter", "Noto Sans SC", sans-serif',
    '"Noto Sans SC", "Microsoft YaHei", sans-serif',
    '"Roboto", sans-serif',
    '"Open Sans", sans-serif',
    'system-ui, sans-serif',
  ];

  const translateLangOptions = [
    { id: 'Chinese', label: '简体中文' },
    { id: 'Chinese-Traditional', label: '繁體中文' },
    { id: 'Japanese', label: '日本語' },
    { id: 'Korean', label: '한국어' },
    { id: 'French', label: 'Français' },
    { id: 'German', label: 'Deutsch' },
    { id: 'Spanish', label: 'Español' },
    { id: 'Portuguese', label: 'Português' },
    { id: 'Russian', label: 'Русский' },
    { id: 'Italian', label: 'Italiano' },
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
          
          {/* 字幕时间偏移 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">字幕偏移: {settings.subtitleOffset > 0 ? '+' : ''}{settings.subtitleOffset}ms</label>
            <input
              type="range"
              min="-2000"
              max="2000"
              step="100"
              value={settings.subtitleOffset}
              onChange={(e) => updateSettings({ subtitleOffset: parseInt(e.target.value) })}
              className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-subtitle-highlight"
            />
            <p className="text-xs text-gray-500 mt-1">调整字幕出现的时间，正值延后、负值提前</p>
          </div>

          {/* 自动滚动模式 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">字幕滚动模式</label>
            <div className="flex gap-2">
              {(['auto', 'highlight', 'off'] as const).map((mode) => (
                <button
                  key={mode}
                  className={`flex-1 py-2 px-3 rounded-lg text-sm transition-colors ${
                    scrollMode === mode
                      ? 'bg-subtitle-highlight text-black font-medium'
                      : 'bg-white/5 text-gray-300 hover:bg-white/10'
                  }`}
                  onClick={() => setScrollMode(mode)}
                >
                  {mode === 'auto' ? '自动滚动' : mode === 'highlight' ? '仅高亮' : '关闭'}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {scrollMode === 'auto'
                ? '播放时自动滚动到当前句，手动滚动后暂停 3 秒'
                : scrollMode === 'highlight'
                  ? '仅高亮当前句，不自动滚动'
                  : '不自动滚动也不高亮当前句'}
            </p>
          </div>

          {/* 翻译目标语言 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">翻译目标语言</label>
            <select
              value={settings.translateTargetLang}
              onChange={(e) => updateSettings({ translateTargetLang: e.target.value })}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-subtitle-highlight"
            >
              {translateLangOptions.map((lang) => (
                <option key={lang.id} value={lang.id}>{lang.label}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">点击工具栏“翻译”按钮时使用该语言</p>
          </div>

          {/* 逐句复读设置 */}
          <div className="border-t border-white/10 pt-5">
            <h3 className="text-sm font-medium text-white mb-4">逐句复读设置</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-2">每句暂停时长: {shadowingPauseMs / 1000}s</label>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.5"
                  value={shadowingPauseMs / 1000}
                  onChange={(e) => setShadowingPauseMs(Number(e.target.value) * 1000)}
                  className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-subtitle-highlight"
                />
                <p className="text-xs text-gray-500 mt-1">每句话结束后暂停多久，给用户跟读</p>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">每句复读: {shadowingLoopCount} 遍</label>
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="1"
                  value={shadowingLoopCount}
                  onChange={(e) => setShadowingLoopCount(Number(e.target.value))}
                  className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-subtitle-highlight"
                />
                <p className="text-xs text-gray-500 mt-1">每句话总共播放几遍后进入下一句</p>
              </div>
            </div>
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
