#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# RiderCom Mesh Pro - Túnel Cloudflare para Datos Móviles (Sesión Secundaria)
# ==============================================================================

if ! command -v cloudflared &> /dev/null; then
    echo "[-] Error: 'cloudflared' no está instalado en Termux."
    echo "    Instálalo con: pkg install cloudflared"
    exit 1
fi

echo "============================================================"
echo " 🏍️  RIDERCOM MESH PRO - INICIANDO TÚNEL CLOUDFLARE"
echo "============================================================"
echo " ⏳ Conectando túnel público para puerto 8765..."
echo "============================================================"
echo ""

# Ejecutar cloudflared apuntando al servidor local
cloudflared tunnel --url http://localhost:8765
