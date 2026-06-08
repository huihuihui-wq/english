@echo off
chcp 65001 >nul
cd /d "%~dp0backend"

if not exist ".venv" (
  echo [setup] creating virtual env...
  python -m venv .venv
)

call .venv\Scripts\activate.bat

echo [setup] installing deps...
pip install -q -r requirements.txt

if not exist ".env" (
  echo [setup] copying .env.example to .env
  copy .env.example .env >nul
)

echo.
echo ===================================================
echo  Shadow Reader starting at http://localhost:8000
echo ===================================================
echo.

python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
