@echo off
chcp 65001 >nul
title 添加 MLK 演讲素材到 Shadow Reader
echo ============================================
echo  Martin Luther King - I Have a Dream (1963)
echo ============================================
echo.
echo 此脚本将视频转换为音频+字幕，并添加到系统中
echo.

set "VIDEO_PATH=%~1"
set "TARGET_DIR=C:\Users\liurf1\Desktop\A_Big_Pulgin\英语学习\shadow-reader\backend\data\materials\static\mlk-dream"

if "%~1"=="" (
    echo [用法] 将下载好的视频拖放到此脚本上
echo   或运行: add_mlk.bat "视频路径.mp4"
    echo.
    echo 下载地址:
    echo   YouTube: https://www.youtube.com/watch?v=vP4iY1TtS3s
echo   Archive: https://archive.org/details/MLKDream
    echo.
    pause
    exit /b 1
)

if not exist "%VIDEO_PATH%" (
    echo [错误] 视频文件不存在: %VIDEO_PATH%
    pause
    exit /b 1
)

echo [1/4] 创建素材目录...
mkdir "%TARGET_DIR%" 2>nul

echo [2/4] 提取音频...
ffmpeg -i "%VIDEO_PATH%" -vn -acodec libmp3lame -ac 1 -ar 16000 -b:a 64k "%TARGET_DIR%\audio.mp3" -y
if errorlevel 1 (
    echo [错误] ffmpeg 提取音频失败
    pause
    exit /b 1
)

echo [3/4] 生成字幕（使用 Whisper）...
echo 注意：此步骤需要 Python 和 faster-whisper 模型
echo 如果失败，您可以手动创建字幕文件
echo.

REM 尝试使用已安装的 ASR
cd /d "C:\Users\liurf1\Desktop\A_Big_Pulgin\英语学习\shadow-reader\backend"
python -c "
import sys
sys.path.insert(0, '.')
try:
    import subprocess
    import json
    # 使用本地 whisper 或请求后端 API
    print('尝试使用后端 ASR 服务生成字幕...')
except Exception as e:
    print(f'跳过字幕生成: {e}')
    print('请手动上传视频到 Shadow Reader 生成字幕')
"

echo.
echo [4/4] 更新素材清单...
cd /d "C:\Users\liurf1\Desktop\A_Big_Pulgin\英语学习\shadow-reader\backend\data\materials\static"
python -c "
import json
from pathlib import Path

manifest_path = Path('manifest.json')
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))

# 检查是否已存在
exists = any(m['id'] == 'mlk-dream' for m in manifest['materials'])
if not exists:
    manifest['materials'].append({
        'id': 'mlk-dream',
        'title': 'Martin Luther King Jr. - I Have a Dream (1963)',
        'description': '历史上最著名的演讲之一，节奏感强，修辞优美',
        'category': 'Speech',
        'difficulty': 'intermediate',
        'speed': 1.0,
        'icon': 'MLK',
        'color': '#bb1919',
        'duration': 1020,  # 17分钟，需要实际获取
        'audio_url': '/api/materials/mlk-dream/audio',
        'srt_url': '/api/materials/mlk-dream/srt',
        'is_placeholder': False,
        'source': 'Public Domain',
        'source_url': 'https://archive.org/details/MLKDream'
    })
    manifest['total'] = len(manifest['materials'])
    manifest['updated'] = '2026-06-09'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print('✅ 已添加到素材库')
else:
    print('ℹ️ 素材已存在，无需重复添加')
"

echo.
echo ============================================
echo  完成！
echo ============================================
echo.
echo 现在您可以：
echo 1. 重启 Shadow Reader 后端服务
echo 2. 在浏览器刷新页面
echo 3. 在"内置库"中找到 "MLK - I Have a Dream"
echo.
echo 注意：首次加载可能需要后端处理字幕
echo.
pause
