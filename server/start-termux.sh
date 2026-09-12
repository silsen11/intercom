#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# RiderCom Mesh Pro - Script de Inicio Rápido para Termux (Android)
# ==============================================================================

echo "=================================================="
echo " 🏍️  Iniciando Servidor RiderCom Mesh en Termux"
echo "=================================================="

# 1. Prevenir suspensión del sistema (pantalla apagada o en el bolsillo)
if command -v termux-wake-lock &> /dev/null; then
    termux-wake-lock
    echo "✓ WakeLock activado (Android no suspenderá el servidor)"
fi

# 2. Verificar e instalar Node.js si es necesario
if ! command -v node &> /dev/null; then
    echo "[-] Node.js no encontrado. Instalando..."
    pkg update -y && pkg install -y nodejs git
fi

# 3. Obtener IP Local (para cuando uses Punto de Acceso / Zona Wi-Fi)
LOCAL_IP=$(ip -4 addr show wlan0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n 1)
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP="192.168.43.1 (o IP de tu Hotspot)"
fi

echo ""
echo "📡 CONECTIVIDAD:"
echo "--------------------------------------------------"
echo " 1) MODO HOTSPOT / ZONA WI-FI:"
echo "    Dirección en la app: ws://${LOCAL_IP}:8765"
echo "--------------------------------------------------"
echo " 2) MODO DATOS MÓVILES (4G/5G con Cloudflare Tunnel):"
echo "    Para generar un enlace público seguro gratuito:"
echo "    pkg install cloudflared"
echo "    cloudflared tunnel --url http://localhost:8765"
echo "--------------------------------------------------"
echo ""

# 4. Iniciar el servidor
node server/signal-server.js
