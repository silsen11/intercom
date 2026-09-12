#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# RiderCom Mesh Pro - Servidor de Señalización en Termux
# ==============================================================================

# 1. Prevenir suspensión del sistema con pantalla apagada en Android
if command -v termux-wake-lock &> /dev/null; then
    termux-wake-lock
fi

# 2. Cerrar procesos previos para evitar conflicto de puerto 8765
pkill -f "node server/signal-server.js" 2>/dev/null
sleep 1

# 3. Detectar IP local para conexiones Hotspot / Wi-Fi
LOCAL_IP=$(ip -4 addr show wlan0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n 1)
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP=$(ip -4 addr show ap0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n 1)
fi
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP="127.0.0.1"
fi

# Función para limpiar procesos al salir (Ctrl + C)
cleanup() {
    echo ""
    echo "🛑 Deteniendo RiderCom Mesh..."
    if command -v termux-wake-unlock &> /dev/null; then
        termux-wake-unlock 2>/dev/null
    fi
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

echo "============================================================"
echo " 🏍️  RIDERCOM MESH PRO - SERVIDOR EN TERMUX"
echo "============================================================"
echo " ► Puerto Local: 8765"
echo " ► Conexión Wi-Fi / Hotspot: http://${LOCAL_IP}:8765"
echo " ► WebSocket Local: ws://${LOCAL_IP}:8765"
echo "============================================================"
echo " 💡 NOTA PARA DATOS MÓVILES (4G/5G):"
echo "    Para conectar con compañeros en carretera fuera de tu Wi-Fi,"
echo "    inicia Cloudflare en otra sesión de Termux con:"
echo "    cloudflared tunnel --url http://localhost:8765"
echo "    (o ejecuta: bash server/start-cloudflare.sh)"
echo "============================================================"
echo " 🛑 Presiona CTRL + C en cualquier momento para apagar."
echo "============================================================"
echo ""

# 4. Iniciar servidor Node.js en primer plano mostrando logs en tiempo real
node server/signal-server.js
