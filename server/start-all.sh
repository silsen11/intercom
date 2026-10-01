#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# RiderCom Mesh Pro - Iniciar Servidor + Túnel Cloudflare Todo en Uno
# ==============================================================================

# 1. Prevenir suspensión en Android con pantalla apagada
if command -v termux-wake-lock &> /dev/null; then
    termux-wake-lock 2>/dev/null
fi

# 2. Verificar dependencias
if ! command -v node &> /dev/null; then
    echo "[-] Error: 'node' no está instalado. Ejecuta: pkg install nodejs -y"
    exit 1
fi

if ! command -v cloudflared &> /dev/null; then
    echo "[-] Error: 'cloudflared' no está instalado. Ejecuta: pkg install cloudflared -y"
    exit 1
fi

# 3. Limpiar procesos anteriores
pkill -f "node server/signal-server.js" 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

# 4. Iniciar Servidor de Señalización en segundo plano
echo "🚀 Iniciando Servidor de Señalización RiderCom..."
node server/signal-server.js > /dev/null 2>&1 &
NODE_PID=$!
sleep 1

# 5. Iniciar Túnel Cloudflare
echo "🌐 Conectando túnel Cloudflare para datos móviles (4G/5G)..."
rm -f cloudflared.log
cloudflared tunnel --url http://localhost:8765 > cloudflared.log 2>&1 &
CF_PID=$!

# Función para cerrar todo con CTRL + C
cleanup() {
    echo ""
    echo "🛑 Apagando RiderCom (Servidor y Túnel)..."
    kill $NODE_PID 2>/dev/null
    kill $CF_PID 2>/dev/null
    pkill -f "node server/signal-server.js" 2>/dev/null
    pkill -f "cloudflared tunnel" 2>/dev/null
    rm -f cloudflared.log
    if command -v termux-wake-unlock &> /dev/null; then
        termux-wake-unlock 2>/dev/null
    fi
    echo "✅ Todo apagado correctamente."
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# 6. Esperar la URL pública de Cloudflare
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

if [ -n "$URL" ]; then
    WSS_URL="wss://${URL#https://}"

    if command -v termux-clipboard-set &> /dev/null; then
        termux-clipboard-set "$URL"
        COPIED_MSG=" (¡Copiado al portapapeles!)"
    else
        COPIED_MSG=""
    fi

    echo "============================================================"
    echo " 🏍️  RIDERCOM MESH PRO - ¡ACTIVO Y EN LÍNEA!"
    echo "============================================================"
    echo ""
    echo " 🔗 ENLACE DE LA APP PARA TUS COMPAÑEROS${COPIED_MSG}:"
    echo "    $URL"
    echo ""
    echo " 📡 DIRECCIÓN DEL SERVIDOR (WSS):"
    echo "    $WSS_URL"
    echo ""
    echo "============================================================"
    echo " 💡 CÓMO USARLO:"
    echo " 1. Pega el enlace en el navegador o envíaselo a tus compañeros."
    echo " 2. En la app (⚙️ Ajustes), el Servidor se guardará automáticamente."
    echo " 3. Presiona CTRL + C en Termux cuando termines la ruta."
    echo "============================================================"
else
    echo "[-] No se pudo capturar la URL automáticamente. Revisa cloudflared.log"
    cat cloudflared.log
fi

# Mantener activo esperando Ctrl + C
wait
