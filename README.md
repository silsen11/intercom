# 🏍️ RiderCom Mesh Pro

Intercomunicador Push-To-Talk (PTT) nativo para motociclistas con audio WebRTC P2P de ultra baja latencia sobre datos móviles 4G/5G y redes locales.

---

## 📋 Características Principales

* **Voz P2P de Alta Fidelidad**: Audio directo de teléfono a teléfono usando WebRTC sin pasar por un servidor central (menor retraso y sin saturación).
* **Diseñado para Ruta**:
  * Botón PTT táctil gigante de alto contraste para usar con guantes.
  * Respuesta háptica (vibración al pulsar).
  * Modo **Manos Libres** (bloqueo por doble toque) para caminos difíciles.
* **Anti-Cortes en 4G/5G**:
  * Heartbeat / Ping cada 5 segundos para evitar que las operadoras cierren la conexión.
  * Reconexión automática transparente con retroceso exponencial.
  * STUN de Google + servidores TURN de respaldo para atravesar firewalls móviles y NAT simétrico.
* **Servidor de Señalización en Termux**: Ejecuta el servidor directamente desde tu teléfono Android sin pagar hosting.
* **Compilación en la Nube con GitHub Actions**: Genera el `.apk` de Android automáticamente sin instalar Android Studio en tu PC.

---

## 🚀 Guía de Inicio Rápido con Termux (En tu Teléfono)

### 1. Instalar Termux
Descarga e instala Termux desde **F-Droid** (o GitHub Releases).

### 2. Clonar y Arrancar el Servidor
Abre Termux en tu celular y ejecuta:

```bash
# Actualizar repositorios e instalar Node.js y Git
pkg update -y && pkg install -y nodejs git

# Clonar el proyecto
git clone <URL_DE_TU_REPOSITORIO>
cd intercom

# Instalar dependencias del servidor
npm install --omit=dev

# Iniciar servidor con WakeLock (evita que Android lo suspenda)
bash server/start-termux.sh
```

El servidor arrancará en el puerto `8765`.

---

## 📡 Opciones de Conexión en Carretera

### Modo 1: Zona Wi-Fi / Hotspot Móvil (Sin gastar datos de señalización)
1. Activa la **Zona Wi-Fi (Punto de acceso)** en tu teléfono donde corre Termux.
2. Tus compañeros se conectan a tu Wi-Fi.
3. En la app de RiderCom, ingresan la IP local:
   ```text
   ws://192.168.43.1:8765
   ```
4. Ingresan el mismo código de sala (ej: `RUTA-77`). ¡Listo!

### Modo 2: Datos Móviles Separados (4G/5G con Cloudflare Tunnel Gratis)
Si cada piloto tiene su propia conexión de datos móviles:
1. En Termux instala `cloudflared`:
   ```bash
   pkg install cloudflared
   ```
2. Inicia el túnel público:
   ```bash
   cloudflared tunnel --url http://localhost:8765
   ```
3. Cloudflare te dará una URL segura tipo `https://xyz-random.trycloudflare.com`.
4. En la app RiderCom ingresan:
   ```text
   wss://xyz-random.trycloudflare.com
   ```

---

## 📱 Compilación del APK Nativo (GitHub Actions)

No necesitas instalar 20 GB de Android Studio en tu computadora:

1. Sube tu código a GitHub:
   ```bash
   git init
   git add .
   git commit -m "feat: ridercom mesh initial release"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/intercom.git
   git push -u origin main
   ```
2. Ve a la pestaña **Actions** en tu repositorio de GitHub.
3. El flujo `.github/workflows/build-apk.yml` compilará el código automáticamente y generará el artefacto de release.
4. Descarga el archivo `.apk` directamente a tu celular Android e instálalo.

---

## 🛠️ Comandos de Desarrollo

Siguiendo las directrices de `AGENTS.md`:

```bash
# Instalar dependencias
npm install

# Servidor en desarrollo
npm run dev

# Verificación de sintaxis
npm run lint

# Verificación de tipos TypeScript
npm run typecheck

# Pruebas unitarias del servidor y protocolo
npm test
```

**Orden de validación antes de publicar cambios**:
```bash
npm run lint -> npm run typecheck -> npm test
```

---

## 📄 Estructura del Proyecto

```
intercom/
├── App.tsx                    # Pantalla principal React Native
├── server/
│   ├── signal-server.js       # Servidor WebSocket + STUN/TURN
│   └── start-termux.sh        # Script con WakeLock para Termux
├── src/
│   ├── components/
│   │   ├── PTTButton.tsx      # Botón táctil con vibración
│   │   ├── PeerList.tsx       # Lista de pilotos en vivo
│   │   └── StatusBar.tsx      # Estado de red, sala y latencia
│   ├── hooks/
│   │   ├── useWebRTC.ts       # Audio P2P y mute por hardware
│   │   └── useSignaling.ts    # WebSocket con auto-reconexión
│   └── types/                 # Interfaces TypeScript del protocolo
├── android/                   # Manifiesto y permisos nativos
├── .github/workflows/         # Compilación en la nube (CI/CD)
└── tests/                     # Pruebas automatizadas de protocolo
```

---

## ⚖️ Licencia
MIT License - Hecho para motociclistas.