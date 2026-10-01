@echo off
title RiderCom Mesh Pro - Tunel Cloudflare Windows
chcp 65001 >nul

echo ============================================================
echo   🏍️  RIDERCOM MESH PRO - TÚNEL CLOUDFLARE PARA DATOS MÓVILES
echo ============================================================
echo   Iniciando túnel público para puerto 8765...
echo ============================================================

set CLOUDFLARED="C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist %CLOUDFLARED% (
    set CLOUDFLARED="C:\Program Files\cloudflared\cloudflared.exe"
)

%CLOUDFLARED% tunnel --url http://localhost:8765 --no-autoupdate
pause
