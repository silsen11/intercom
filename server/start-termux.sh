#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# RiderCom Mesh Pro - Script Todo-en-Uno con Enlace Destacado al Final
# ==============================================================================

# 1. Prevenir suspensión del sistema con pantalla apagada
if command -v termux-wake-lock &> /dev/null; then
    termux-wake-lock
fi

# 2. Cerrar procesos previos para evitar conflicto de puertos
pkill -f "node server/signal-server.js" 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

# 3. Iniciar el servidor Node en segundo plano
node server/signal-server.js > /dev/null 2>&1 &
SERVER_PID=$!

# 4. Iniciar Cloudflare en segundo plano para capturar el enlace limpio
rm -f cloudflared.log
cloudflared tunnel --url http://localhost:8765 > cloudflared.log 2>&1 &
CF_PID=$!

# Función para limpiar procesos al salir (Ctrl + C)
cleanup() {
    echo ""
    echo "🛑 Deteniendo RiderCom Mesh..."
    kill $SERVER_PID 2>/dev/null
    kill $CF_PID 2>/dev/null
    pkill -f "cloudflared tunnel" 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

echo "============================================================"
echo " 🏍️  Iniciando RiderCom Mesh Pro en Termux..."
echo " ⏳  Conectando túnel Cloudflare para datos móviles 4G/5G..."
echo "============================================================"

# 5. Esperar a que aparezca la URL en el log (máximo 25 segundos)
URL=""
for i in $(seq 1 25); do
    sleep 1
    URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' cloudflared.log 2>/dev/null | head -n 1)
    if [ -n "$URL" ]; then
        break
    fi
    echo -n "•"
done
echo ""

# 6. Mostrar el enlace limpio y destacado al final de todo
if [ -n "$URL" ]; then
    WSS_URL="wss://${URL#https://}"

    # Copiar automáticamente al portapapeles si termux-api está instalado
    if command -v termux-clipboard-set &> /dev/null; then
        termux-clipboard-set "$URL"
        COPIED_MSG=" (¡Copiado automáticamente al portapapeles!)"
    else
        COPIED_MSG=""
    fi

    echo ""
    echo "============================================================"
    echo " 🏍️  RIDERCOM MESH PRO - ¡CONECTADO Y LISTO!"
    echo "============================================================"
    echo ""
    echo " 🔗 ENLACE PARA TI Y TUS COMPAÑEROS${COPIED_MSG}:"
    echo "    $URL"
    echo ""
    echo " 📡 DIRECCIÓN WEBSOCKET (WSS):"
    echo "    $WSS_URL"
    echo ""
    echo "============================================================"
    echo " 👉 Toca el enlace de arriba para abrir la app o compartirla."
    echo " 🛑 Presiona CTRL + C en cualquier momento para apagar."
    echo "============================================================"
else
    echo "[-] No se pudo capturar el enlace automáticamente. Registro:"
    cat cloudflared.log
fi

# Mantener la terminal abierta mostrando el enlace
wait $CF_PID
