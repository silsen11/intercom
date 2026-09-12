#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# RiderCom Mesh Pro - Túnel Cloudflare para Datos Móviles (Sesión Secundaria)
# ==============================================================================

if ! command -v cloudflared &> /dev/null; then
    echo "[-] Error: 'cloudflared' no está instalado en Termux."
    echo "    Instálalo con: pkg install cloudflared"
    exit 1
fi

# 1. Prevenir suspensión en Android si está en segundo plano
if command -v termux-wake-lock &> /dev/null; then
    termux-wake-lock 2>/dev/null
fi

# 2. Cerrar túneles previos para evitar conflictos
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

# 3. Iniciar Cloudflare en segundo plano capturando logs para extraer el enlace
rm -f cloudflared.log
cloudflared tunnel --url http://localhost:8765 > cloudflared.log 2>&1 &
CF_PID=$!

# Función para limpiar procesos al salir (Ctrl + C)
cleanup() {
    echo ""
    echo "🛑 Deteniendo túnel Cloudflare..."
    kill $CF_PID 2>/dev/null
    pkill -f "cloudflared tunnel" 2>/dev/null
    rm -f cloudflared.log
    if command -v termux-wake-unlock &> /dev/null; then
        termux-wake-unlock 2>/dev/null
    fi
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

echo "============================================================"
echo " 🏍️  RIDERCOM MESH PRO - TÚNEL CLOUDFLARE"
echo "============================================================"
echo " ⏳ Conectando túnel público para puerto 8765..."
echo "============================================================"

# 4. Esperar a que aparezca la URL en el log (máximo 25 segundos)
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

# 5. Mostrar el enlace limpio y destacado en pantalla
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
    echo " 🏍️  RIDERCOM MESH PRO - ¡TÚNEL CONECTADO CON ÉXITO!"
    echo "============================================================"
    echo ""
    echo " 🔗 ENLACE PARA TI Y TUS COMPAÑEROS${COPIED_MSG}:"
    echo "    $URL"
    echo ""
    echo " 📡 DIRECCIÓN WEBSOCKET (WSS):"
    echo "    $WSS_URL"
    echo ""
    echo "============================================================"
    echo " 👉 Toca o copia el enlace de arriba y compártelo."
    echo " 🛑 Presiona CTRL + C en cualquier momento para apagar."
    echo "============================================================"
else
    echo "[-] No se pudo capturar el enlace automáticamente. Registro:"
    cat cloudflared.log
fi

# Mantener activo esperando Ctrl + C
wait $CF_PID
