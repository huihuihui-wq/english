@echo off
chcp 65001 >nul
title 英语学习素材下载器

echo ============================================
echo  英语学习公有领域素材批量下载工具
echo ============================================
echo.
echo 版权状态说明：
echo - VOA Learning English: 美国联邦政府公有领域
echo - MLK 演讲: 公有领域（历史演讲录音）
echo - Charlie Chaplin 短片: 公有领域（1929年前作品）
echo - Private Snafu 卡通: 美国联邦政府公有领域
echo - JFK 就职演讲: 公有领域（总统就职演讲）
echo.
echo ============================================
echo.

REM 设置下载目录
set "DOWNLOAD_DIR=%~dp0"
echo 下载目录: %DOWNLOAD_DIR%
echo.

REM 检查 yt-dlp
yt-dlp --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 yt-dlp，请先安装：
    echo   1. 访问 https://github.com/yt-dlp/yt-dlp/releases
    echo   2. 下载 yt-dlp.exe 放到此目录或添加到 PATH
    echo.
    pause
    exit /b 1
)

echo [1/4] 下载 Martin Luther King "I Have a Dream" 演讲...
yt-dlp -f "best[ext=mp4]/best" ^
    -o "MLK_I_Have_a_Dream_1963.%%(ext)s" ^
    --merge-output-format mp4 ^
    "https://www.youtube.com/watch?v=vP4iY1TtS3s" ^
    --no-playlist ^
    --restrict-filenames
if errorlevel 1 (
    echo   [失败] 尝试备用链接...
    yt-dlp -f "best[ext=mp4]/best" ^
        -o "MLK_I_Have_a_Dream_1963.%%(ext)s" ^
        --merge-output-format mp4 ^
        "https://archive.org/download/MLKDream/MLKDream.mp4" ^
        --no-playlist
)
echo.

echo [2/4] 下载 Charlie Chaplin "The Adventurer" (1917)...
yt-dlp -f "best[ext=mp4]/best" ^
    -o "Chaplin_The_Adventurer_1917.%%(ext)s" ^
    --merge-output-format mp4 ^
    "https://www.youtube.com/watch?v=T8pVDQ2c6w8" ^
    --no-playlist ^
    --restrict-filenames
if errorlevel 1 (
    echo   [失败] 尝试备用链接...
    yt-dlp -f "best[ext=mp4]/best" ^
        -o "Chaplin_The_Adventurer_1917.%%(ext)s" ^
        --merge-output-format mp4 ^
        "https://archive.org/download/CC_1917_The_Adventurer/CC_1917_The_Adventurer.mp4" ^
        --no-playlist
)
echo.

echo [3/4] 下载 Private Snafu 卡通短片...
yt-dlp -f "best[ext=mp4]/best" ^
    -o "Private_Snafu_Cartoon.%%(ext)s" ^
    --merge-output-format mp4 ^
    "https://www.youtube.com/watch?v=3jZy-BZUIcw" ^
    --no-playlist ^
    --restrict-filenames
if errorlevel 1 (
    echo   [失败] 尝试备用链接...
    yt-dlp -f "best[ext=mp4]/best" ^
        -o "Private_Snafu_Cartoon.%%(ext)s" ^
        --merge-output-format mp4 ^
        "https://archive.org/download/private_snafu/private_snafu.mp4" ^
        --no-playlist
)
echo.

echo [4/4] 下载 JFK 就职演讲 "Ask Not" (1961)...
yt-dlp -f "best[ext=mp4]/best" ^
    -o "JFK_Inaugural_Address_1961.%%(ext)s" ^
    --merge-output-format mp4 ^
    "https://www.youtube.com/watch?v=NwM6s55no6U" ^
    --no-playlist ^
    --restrict-filenames
if errorlevel 1 (
    echo   [失败] 尝试备用链接...
    yt-dlp -f "best[ext=mp4]/best" ^
        -o "JFK_Inaugural_Address_1961.%%(ext)s" ^
        --merge-output-format mp4 ^
        "https://archive.org/download/JFKInaugural/JFKInaugural.mp4" ^
        --no-playlist
)
echo.

echo ============================================
echo 下载完成！
echo ============================================
echo.
echo 已下载文件列表：
dir /b "*.mp4" 2>nul
echo.
echo 如果某些文件下载失败，可能是网络问题。
echo 请检查网络连接后重新运行此脚本。
echo.
pause
