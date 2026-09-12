#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# RiderCom Mesh Pro - Script Todo-en-Uno para Termux (Server + Cloudflare)
# ==============================================================================

echo "=================================================="
echo " 🏍️  RiderCom Mesh Pro - Iniciando Sistema"
echo "=================================================="

# 1. Prevenir suspensión del sistema con pantalla apagada
if command -v termux-wake-lock &> /dev/null; then
    termux-wake-lock
    echo "✓ WakeLock activado"
fi

# 2. Cerrar procesos previos para evitar conflicto de puertos (EADDRINUSE 8765)
pkill -f "node server/signal-server.js" 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

# 3. Iniciar el servidor Node en segundo plano
echo "✓ Iniciando servidor WebRTC en segundo plano..."
node server/signal-server.js > /dev/null 2>&1 &
SERVER_PID=$!

# Función para limpiar procesos al salir (Ctrl + C)
cleanup() {
    echo ""
    echo "🛑 Deteniendo RiderCom Mesh..."
    kill $SERVER_PID 2>/dev/null
    pkill -f "cloudflared tunnel" 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

sleep 1

# 4. Verificar si cloudflared está instalado
if ! command -v cloudflared &> /dev/null; then
    echo "[-] Instalando cloudflared..."
    pkg install -y cloudflared
fi

echo "✓ Conectando túnel Cloudflare para datos móviles 4G/5G..."
echo "--------------------------------------------------"
echo "💡 Tu enlace público seguro aparecerá abajo en unos segundos:"
echo "--------------------------------------------------"

# 5. Iniciar Cloudflare Tunnel en primer plano (para ver la URL en la misma pantalla)
cloudflared tunnel --url http://localhost:8765
