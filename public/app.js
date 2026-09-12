/**
 * RiderCom Mesh Pro - Web/PWA Client
 * 100% WebRTC P2P Direct Mesh (Audio en Vivo de Baja Latencia)
 */

const state = {
  room: 'RUTA-77',
  nick: 'Piloto_' + Math.floor(1000 + Math.random() * 9000),
  serverUrl: '',
  isTransmitting: false,
  isHandsFree: false,        // Modo Manos Libres ("Fijar Manos Libres")
  isManualPtt: false,        // PTT manual presionado por el piloto
  isVoiceActive: false,      // Voz humana activa detectada por formantes
  isFilteringNoise: false,   // Ruido de viento o motor detectado y silenciado
  handsFreeMode: localStorage.getItem('ridercom_handsfree_mode') || 'open', // 'open' (Abierto Continuo como PTT) o 'vox' (VOX Auto)
  peers: new Map(), // peerId -> { id, nick, pc, isTalking, pendingCandidates }
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  localStream: null,         // MediaStream nativo directo hacia WebRTC (Bluetooth SCO)
  analyserTrack: null,       // Track clonado independiente para que el analizador nunca se silencie
  audioCtx: null,            // AudioContext en memoria exclusivamente para análisis acústico
  voxSourceNode: null,
  analyserNode: null,
  voxMode: localStorage.getItem('ridercom_vox_mode') || 'standard',
  selectedAudioInputId: localStorage.getItem('ridercom_input_device') || '',
  selectedAudioOutputId: localStorage.getItem('ridercom_output_device') || '',
  dataSaverMode: localStorage.getItem('ridercom_datasaver_profile') || 'balanced',
  lastTotalBytes: 0,
  lastStatsTimestamp: Date.now(),
  statsInterval: null,
  voxLoopTimer: null,
  voxConsecutiveVoice: 0,
  voxHoldTimer: 0,
  ws: null,
  myId: null,
  // Estado de Navegación GPS, Mapa y Rutas
  currentView: 'intercom', // 'intercom', 'map', 'split'
  leafletMap: null,
  myMarker: null,
  peerMarkers: new Map(), // peerId -> L.marker
  currentLocation: null,  // { lat, lng, speed, heading }
  mapUserInteracted: false,
  routePolyline: null,
  routeSteps: [],
  currentStepIndex: 0,
  voiceNavEnabled: true,
  searchTimeout: null,
  lastSpeechText: '',
  lastSpokenDistance: -1,
  lastLocationBroadcastTs: 0,
  // Amplificador de Volumen y Procesamiento de Audio
  intercomVolume: parseInt(localStorage.getItem('ridercom_intercom_volume'), 10) || 150,
  peerAudioPipelines: new Map() // peerId -> { sourceNode, gainNode, compressorNode, destNode, audioElement }
};

// Perfiles de Consumo de Datos Móviles (Optimización de Ancho de Banda y Cabeceras UDP)
const DATA_SAVER_PROFILES = {
  ultra: {
    label: 'Ultra Ahorro',
    bitrate: 12000, // 12 kbps (Reduce >60% de consumo, ideal para 3G/4G débil)
    ptime: 60,      // Agrupa 60ms por paquete (reduce cabeceras IP un 66%)
    maxptime: 60
  },
  balanced: {
    label: 'Equilibrado',
    bitrate: 16000, // 16 kbps (Nitidez total de voz, reduce 50% de consumo)
    ptime: 40,      // Agrupa 40ms por paquete (reduce cabeceras IP un 50%)
    maxptime: 60
  },
  hd: {
    label: 'Alta Fidelidad',
    bitrate: 28000, // 28 kbps (Calidad de estudio para WiFi)
    ptime: 20,      // Paquetes estándar cada 20ms
    maxptime: 40
  }
};

function applyDataSaverProfile(mode) {
  if (!DATA_SAVER_PROFILES[mode]) mode = 'balanced';
  state.dataSaverMode = mode;
  localStorage.setItem('ridercom_datasaver_profile', mode);

  const elSelect = document.getElementById('selectDataSaver');
  if (elSelect) {
    elSelect.value = mode;
  }
}

// Perfiles de discriminación acústica Voz Humana vs Viento/Motor (VOX Inteligente)
const VOX_PROFILES = {
  highway: {
    label: 'Moto / Autopista (Anti-Viento)',
    minDb: -44,           // Volumen mínimo audible para evaluar
    minVoiceRatio: 0.28,  // Proporción de formantes vocales vs ruido total
    minCrest: 1.70,       // Picos de resonancia vocal en 300-3200Hz
    maxRumbleRatio: 0.72, // Rechazo si los bajos <280Hz dominan (viento/escape)
    hangoverMs: 380       // Tiempo de resaca (ms) para no recortar finales de frases
  },
  standard: {
    label: 'Carretera / Equilibrado',
    minDb: -50,
    minVoiceRatio: 0.20,
    minCrest: 1.40,
    maxRumbleRatio: 0.82,
    hangoverMs: 440
  },
  sensitive: {
    label: 'Ciudad / Alta Sensibilidad',
    minDb: -56,
    minVoiceRatio: 0.14,
    minCrest: 1.25,
    maxRumbleRatio: 0.90,
    hangoverMs: 520
  }
};

function applyHandsFreeMode(mode) {
  if (mode !== 'open' && mode !== 'vox') mode = 'open';
  state.handsFreeMode = mode;
  localStorage.setItem('ridercom_handsfree_mode', mode);

  const elSelect = document.getElementById('selectHandsFreeMode');
  const elVoxGroup = document.getElementById('voxSettingsGroup');
  if (elSelect) elSelect.value = mode;
  if (elVoxGroup) elVoxGroup.style.display = mode === 'vox' ? 'block' : 'none';

  syncTransmissionState();
}

function applyVoxProfile(mode) {
  if (!VOX_PROFILES[mode]) mode = 'standard';
  state.voxMode = mode;
  localStorage.setItem('ridercom_vox_mode', mode);

  const elSelect = document.getElementById('selectVoxMode');
  if (elSelect) {
    elSelect.value = mode;
  }
}

function applyDspProfile(mode) {
  if (VOX_PROFILES[mode]) {
    applyVoxProfile(mode);
  }
}

// Optimización de SDP Opus: Bitrate Inteligente, Empaquetado ptime y DTX (Ahorro de Datos)
function optimizeOpusSdp(sdp) {
  try {
    const match = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
    if (!match) return sdp;
    const pt = match[1];

    const dataProfile = DATA_SAVER_PROFILES[state.dataSaverMode] || DATA_SAVER_PROFILES.balanced;
    const bitrate = dataProfile.bitrate;
    const ptime = dataProfile.ptime;
    const maxptime = dataProfile.maxptime || 60;

    // stereo=0 y sprop-stereo=0 fuerzan mono (imprescindible para AEC hardware)
    // usedtx=1 detiene la transmisión de paquetes en silencio (ahorro del 75% en ruta)
    // useinbandfec=1 protege contra paquetes perdidos en cobertura móvil
    const opusParams = `minptime=20;ptime=${ptime};maxptime=${maxptime};useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=${bitrate};cbr=0`;

    if (sdp.includes(`a=fmtp:${pt}`)) {
      sdp = sdp.replace(
        new RegExp(`a=fmtp:${pt}\\s+[^\\r\\n]+`, 'g'),
        `a=fmtp:${pt} ${opusParams}`
      );
    } else {
      sdp = sdp.replace(
        new RegExp(`a=rtpmap:${pt}\\s+opus\\/48000\\/2[\\r\\n]+`, 'g'),
        (m) => `${m}a=fmtp:${pt} ${opusParams}\r\n`
      );
    }

    // Inyectar o reemplazar ptime y maxptime a nivel de sesión
    if (sdp.includes('a=ptime:')) {
      sdp = sdp.replace(/a=ptime:\d+/g, `a=ptime:${ptime}`);
    } else {
      sdp = sdp.replace(/(m=audio[^\r\n]+[\r\n]+)/, `$1a=ptime:${ptime}\r\n`);
    }

    if (sdp.includes('a=maxptime:')) {
      sdp = sdp.replace(/a=maxptime:\d+/g, `a=maxptime:${maxptime}`);
    } else {
      sdp = sdp.replace(/(m=audio[^\r\n]+[\r\n]+)/, `$1a=maxptime:${maxptime}\r\n`);
    }

    return sdp;
  } catch (e) {
    console.warn('[WebRTC] Error optimizando SDP Opus:', e);
    return sdp;
  }
}

// Monitor de Consumo de Datos Móviles en Tiempo Real
function startDataUsageMonitor() {
  if (state.statsInterval) return;

  state.statsInterval = setInterval(async () => {
    const elDataUsage = document.getElementById('displayDataUsage');
    if (!elDataUsage) return;

    let totalBytes = 0;
    const promises = [];

    state.peers.forEach((peer) => {
      if (peer.pc && (peer.pc.connectionState === 'connected' || peer.pc.iceConnectionState === 'connected')) {
        promises.push(
          peer.pc.getStats().then((stats) => {
            stats.forEach((report) => {
              if (report.type === 'outbound-rtp' && report.kind === 'audio' && typeof report.bytesSent === 'number') {
                totalBytes += report.bytesSent;
              }
              if (report.type === 'inbound-rtp' && report.kind === 'audio' && typeof report.bytesReceived === 'number') {
                totalBytes += report.bytesReceived;
              }
            });
          }).catch(() => {})
        );
      }
    });

    await Promise.all(promises);

    const now = Date.now();
    const timeDeltaSec = Math.max((now - state.lastStatsTimestamp) / 1000, 0.5);

    if (state.lastTotalBytes > 0 && totalBytes >= state.lastTotalBytes) {
      const bytesDiff = totalBytes - state.lastTotalBytes;
      const speedKBps = (bytesDiff / timeDeltaSec) / 1024;
      const totalMb = totalBytes / (1024 * 1024);
      elDataUsage.textContent = `📊 ${totalMb.toFixed(1)} MB (${speedKBps.toFixed(1)} KB/s)`;
    } else if (totalBytes > 0) {
      const totalMb = totalBytes / (1024 * 1024);
      elDataUsage.textContent = `📊 ${totalMb.toFixed(1)} MB`;
    }

    state.lastTotalBytes = totalBytes;
    state.lastStatsTimestamp = now;
  }, 2000);
}

// Detección y Gestión de Dispositivos de Audio / Cascos Bluetooth
function isBluetoothDevice(label) {
  if (!label) return false;
  const l = label.toLowerCase();
  return (
    l.includes('bluetooth') ||
    l.includes('headset') ||
    l.includes('hands-free') ||
    l.includes('manos libres') ||
    l.includes('inalámbrico') ||
    l.includes('wireless') ||
    l.includes('cardo') ||
    l.includes('sena') ||
    l.includes('freedconn') ||
    l.includes('airpods') ||
    l.includes('tws') ||
    l.includes('auricular') ||
    l.includes('intercom')
  );
}

async function refreshAudioDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((d) => d.kind === 'audioinput');
    const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');

    const elSelectInput = document.getElementById('selectAudioInput');
    const elSelectOutput = document.getElementById('selectAudioOutput');

    if (elSelectInput) {
      elSelectInput.innerHTML = '';
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = 'Predeterminado del Sistema';
      elSelectInput.appendChild(defaultOpt);

      let detectedBtInput = null;

      audioInputs.forEach((dev, index) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        const label = dev.label || `Micrófono ${index + 1}`;
        const isBt = isBluetoothDevice(label);
        opt.textContent = isBt ? `🎧 ${label} (Bluetooth)` : `🎤 ${label}`;
        elSelectInput.appendChild(opt);

        if (isBt && !detectedBtInput) {
          detectedBtInput = dev.deviceId;
        }
      });

      // Auto-selección preferente de Bluetooth si está conectado y no se ha fijado otro
      if (!state.selectedAudioInputId && detectedBtInput) {
        state.selectedAudioInputId = detectedBtInput;
      }

      if (state.selectedAudioInputId) {
        elSelectInput.value = state.selectedAudioInputId;
      }
    }

    if (elSelectOutput) {
      elSelectOutput.innerHTML = '';
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = 'Predeterminado del Sistema';
      elSelectOutput.appendChild(defaultOpt);

      let detectedBtOutput = null;

      audioOutputs.forEach((dev, index) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        const label = dev.label || `Altavoz ${index + 1}`;
        const isBt = isBluetoothDevice(label);
        opt.textContent = isBt ? `🎧 ${label} (Bluetooth)` : `🔊 ${label}`;
        elSelectOutput.appendChild(opt);

        if (isBt && !detectedBtOutput) {
          detectedBtOutput = dev.deviceId;
        }
      });

      if (!state.selectedAudioOutputId && detectedBtOutput) {
        state.selectedAudioOutputId = detectedBtOutput;
      }

      if (state.selectedAudioOutputId) {
        elSelectOutput.value = state.selectedAudioOutputId;
      }
    }

    updateActiveDeviceBadge(audioInputs);
  } catch (err) {
    console.warn('[Audio] Error enumerando dispositivos:', err);
  }
}

function updateActiveDeviceBadge(audioInputs) {
  const elBadge = document.getElementById('audioDeviceLabel');
  const elIcon = document.getElementById('audioDeviceIcon');
  if (!elBadge || !elIcon) return;

  const currentDev = audioInputs?.find((d) => d.deviceId === state.selectedAudioInputId);
  const label = currentDev?.label || '';

  if (isBluetoothDevice(label)) {
    elIcon.textContent = '🎧';
    const cleanName = label.replace(/(\(.*\)|bluetooth)/gi, '').trim() || 'Conectado';
    elBadge.textContent = `Bluetooth: ${cleanName.length > 20 ? cleanName.substring(0, 18) + '..' : cleanName}`;
  } else if (label) {
    elIcon.textContent = '🎤';
    elBadge.textContent = label.length > 22 ? `${label.substring(0, 19)}...` : label;
  } else {
    const anyBt = audioInputs?.find((d) => isBluetoothDevice(d.label));
    if (anyBt) {
      elIcon.textContent = '🎧';
      elBadge.textContent = 'Bluetooth detectado';
    } else {
      elIcon.textContent = '📱';
      elBadge.textContent = 'Audio: Teléfono / Sistema';
    }
  }
}

async function switchAudioInput(deviceId) {
  state.selectedAudioInputId = deviceId;
  localStorage.setItem('ridercom_input_device', deviceId);
  console.log(`[Audio] Cambiando micrófono a deviceId: ${deviceId || 'default'}`);
  await getLocalStream(deviceId);
}

async function switchAudioOutput(deviceId) {
  state.selectedAudioOutputId = deviceId;
  localStorage.setItem('ridercom_output_device', deviceId);
  console.log(`[Audio] Cambiando salida a deviceId: ${deviceId || 'default'}`);

  document.querySelectorAll('audio').forEach((audio) => {
    if (typeof audio.setSinkId === 'function') {
      audio.setSinkId(deviceId).catch((err) => {
        console.warn('[Audio] Error aplicando setSinkId:', err);
      });
    }
  });
}

// Auto-detect server URL from current host
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
state.serverUrl = `${protocol}//${window.location.host}`;

// DOM Elements
const elRoom = document.getElementById('displayRoom');
const elNick = document.getElementById('displayNick');
const elStatusDot = document.getElementById('statusDot');
const elStatusText = document.getElementById('statusText');
const elLatency = document.getElementById('displayLatency');
const elCount = document.getElementById('displayCount');
const elPttTitle = document.getElementById('pttTitle');
const elPttSubtitle = document.getElementById('pttSubtitle');
const elPttBtn = document.getElementById('pttButton');
const elPttLabel = document.getElementById('pttLabel');
const elMicIcon = document.getElementById('micIcon');
const elLockBtn = document.getElementById('btnToggleLock');
const elPeersList = document.getElementById('peersList');
const elPeersTotal = document.getElementById('peersTotal');
const elModal = document.getElementById('settingsModal');
const elUnlockBanner = document.getElementById('audioUnlockBanner');
const elBtnUnlock = document.getElementById('btnUnlockAudio');
const elDeviceBadge = document.getElementById('btnDeviceBadge');

// Init fields
elRoom.textContent = state.room;
elNick.textContent = state.nick;
document.getElementById('inputRoom').value = state.room;
document.getElementById('inputNick').value = state.nick;
document.getElementById('inputServer').value = state.serverUrl;
applyHandsFreeMode(state.handsFreeMode);
applyVoxProfile(state.voxMode);
applyDataSaverProfile(state.dataSaverMode);
startDataUsageMonitor();
refreshAudioDevices();
initTabs();
initVolumeControls();

// Setup Mic Stream & Web Audio DSP Engine
// Setup Mic Stream (Direct Native WebRTC para máxima compatibilidad con Bluetooth SCO y Cascos)
async function getLocalStream(forceDeviceId) {
  const targetDeviceId = forceDeviceId !== undefined ? forceDeviceId : state.selectedAudioInputId;

  if (!forceDeviceId && state.localStream && state.localStream.active) {
    const tracks = state.localStream.getAudioTracks();
    if (tracks.length > 0 && tracks[0].readyState === 'live') {
      return state.localStream;
    }
  }

  // Detener micrófono anterior si se está cambiando de dispositivo
  if (state.localStream) {
    try {
      state.localStream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    state.localStream = null;
  }

  try {
    const audioConstraints = {
      channelCount: { ideal: 1 }, // Mono estricto para activar AEC y Bluetooth SCO en Android
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      googEchoCancellation: { ideal: true },
      googAutoGainControl: { ideal: true },
      googNoiseSuppression: { ideal: true },
      googHighpassFilter: { ideal: true }
    };

    if (targetDeviceId) {
      audioConstraints.deviceId = { ideal: targetDeviceId };
    }

    console.log('[Audio] Solicitando micrófono:', audioConstraints);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false
    });

    // PTT mute por defecto si no estamos transmitiendo en este momento
    stream.getAudioTracks().forEach((t) => {
      t.enabled = state.isTransmitting;
    });

    state.localStream = stream;

    // Inicializar analizador acústico VOX en paralelo sin alterar el stream WebRTC nativo
    setupVoxAnalyser(stream);

    // Vincular track directo a todos los pares ya conectados
    state.peers.forEach((peer) => {
      if (peer.pc && peer.pc.signalingState !== 'closed') {
        const senders = peer.pc.getSenders();
        stream.getAudioTracks().forEach((t) => {
          const alreadyAdded = senders.some((s) => s.track === t);
          if (!alreadyAdded) {
            try {
              peer.pc.addTrack(t, stream);
            } catch (e) {}
          }
        });
      }
    });

    if (elUnlockBanner) {
      elUnlockBanner.classList.add('hidden');
    }

    // Refrescar lista de dispositivos con los nombres ahora accesibles
    await refreshAudioDevices();

    return stream;
  } catch (err) {
    console.warn('[Audio] Error al obtener audio del micrófono:', err);
    return null;
  }
}

async function unlockAudio() {
  try {
    await getLocalStream();
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      await state.audioCtx.resume();
    }
    // Desbloquear elementos de audio existentes de pares
    document.querySelectorAll('audio').forEach((a) => {
      a.play().catch(() => {});
    });
    if (elUnlockBanner) {
      elUnlockBanner.classList.add('hidden');
    }
  } catch (e) {}
}

if (elUnlockBanner) {
  elUnlockBanner.addEventListener('click', unlockAudio);
}
if (elBtnUnlock) {
  elBtnUnlock.addEventListener('click', (e) => {
    e.stopPropagation();
    unlockAudio();
  });
}
window.addEventListener('pointerdown', () => {
  if (!state.localStream) unlockAudio();
}, { once: true });

// WebSocket Connection
function connect() {
  setStatus('connecting', 'CONECTANDO...');

  try {
    const ws = new WebSocket(state.serverUrl);
    state.ws = ws;

    ws.onopen = () => {
      setStatus('connected', 'EN LÍNEA');
      ws.send(JSON.stringify({
        type: 'JOIN',
        room: state.room,
        nick: state.nick
      }));
      startPing(ws);
    };

    ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        await handleSignaling(msg);
      } catch (err) {
        console.error('[Signaling] Error procesando mensaje WS:', err);
      }
    };

    ws.onclose = () => {
      setStatus('disconnected', 'RECONECTANDO...');
      cleanupPeers();
      setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      setStatus('disconnected', 'DESCONECTADO');
    };
  } catch (e) {
    setTimeout(connect, 3000);
  }
}

function startPing(ws) {
  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'PING', ts: Date.now() }));
    } else {
      clearInterval(timer);
    }
  }, 5000);
}

function setStatus(type, text) {
  elStatusDot.className = `status-dot dot-${type}`;
  elStatusText.textContent = text;
}

// Signaling & Message Handler
async function handleSignaling(msg) {
  switch (msg.type) {
    case 'CONFIG':
      state.myId = msg.clientId;
      if (msg.iceServers && msg.iceServers.length > 0) {
        state.iceServers = msg.iceServers;
      }
      break;

    case 'PEERS':
      for (const peer of msg.peers) {
        await createPeerConnection(peer.id, peer.nick, true);
      }
      break;

    case 'PEER_JOINED':
      await createPeerConnection(msg.id, msg.nick, false);
      break;

    case 'PEER_LEFT':
      removePeer(msg.id);
      break;

    case 'OFFER':
      await handleOffer(msg);
      break;

    case 'ANSWER':
      await handleAnswer(msg);
      break;

    case 'ICE_CANDIDATE':
      await handleCandidate(msg);
      break;

    case 'PEER_TALK_STATE':
      setPeerTalking(msg.peerId, msg.isTalking);
      break;

    case 'PEER_LOCATION':
      updatePeerLocationOnMap(msg);
      break;

    case 'PONG':
      elLatency.textContent = `${Math.max(1, Date.now() - msg.ts)} ms`;
      break;
  }
}

// WebRTC P2P Sanitizado para Malla Multi-Usuario
async function createPeerConnection(peerId, nick, isInitiator) {
  if (state.peers.has(peerId)) return state.peers.get(peerId).pc;

  const pc = new RTCPeerConnection({
    iceServers: state.iceServers,
    iceCandidatePoolSize: 10
  });

  const peerData = {
    id: peerId,
    nick,
    pc,
    isTalking: false,
    pendingCandidates: []
  };

  state.peers.set(peerId, peerData);
  renderPeers();

  // Vincular tracks locales de forma limpia (sin addTransceiver redundante)
  const stream = await getLocalStream();
  if (stream) {
    stream.getAudioTracks().forEach((t) => {
      try {
        pc.addTrack(t, stream);
      } catch (e) {}
    });
  }

  // Candidatos ICE
  pc.onicecandidate = (e) => {
    if (e.candidate && state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        type: 'ICE_CANDIDATE',
        targetId: peerId,
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex
      }));
    }
  };

  // Reproducción de audio entrante
  pc.ontrack = (e) => {
    console.log(`[WebRTC] Recibiendo audio del piloto: ${nick} (${peerId})`);
    let audio = document.getElementById(`audio_${peerId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio_${peerId}`;
      audio.autoplay = true;
      audio.playsInline = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
    }
    // Configurar pipeline con amplificación y compresor anti-distorsión
    setupPeerAudioPipeline(peerId, e.streams[0], audio);

    if (typeof audio.setSinkId === 'function' && state.selectedAudioOutputId) {
      audio.setSinkId(state.selectedAudioOutputId).catch(() => {});
    }
    audio.play().catch((err) => {
      console.warn(`[WebRTC] Autoplay pendiente para ${peerId}:`, err);
    });
  };

  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC] Conexión con ${nick} (${peerId}): ${pc.connectionState}`);
    if (pc.connectionState === 'closed') {
      removePeer(peerId);
    } else if (pc.connectionState === 'failed') {
      console.warn(`[WebRTC] Conexión fallida con ${peerId}, intentando ICE restart...`);
      if (isInitiator && typeof pc.restartIce === 'function') {
        try {
          pc.restartIce();
        } catch (e) {}
      }
    }
  };

  if (isInitiator) {
    try {
      const offer = await pc.createOffer();
      const sdpOpt = optimizeOpusSdp(offer.sdp);
      await pc.setLocalDescription(new RTCSessionDescription({ type: offer.type, sdp: sdpOpt }));
      state.ws.send(JSON.stringify({
        type: 'OFFER',
        targetId: peerId,
        sdp: sdpOpt
      }));
    } catch (err) {
      console.error(`[WebRTC] Error al crear oferta para ${peerId}:`, err);
    }
  }

  return pc;
}

async function handleOffer(msg) {
  try {
    const pc = await createPeerConnection(msg.fromId, msg.fromNick, false);
    const peer = state.peers.get(msg.fromId);

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));

    // Aplicar candidatos ICE acumulados en cola
    if (peer && peer.pendingCandidates.length > 0) {
      for (const cand of peer.pendingCandidates) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (err) {}
      }
      peer.pendingCandidates = [];
    }

    const answer = await pc.createAnswer();
    const sdpOpt = optimizeOpusSdp(answer.sdp);
    await pc.setLocalDescription(new RTCSessionDescription({ type: answer.type, sdp: sdpOpt }));

    state.ws.send(JSON.stringify({
      type: 'ANSWER',
      targetId: msg.fromId,
      sdp: sdpOpt
    }));
  } catch (err) {
    console.error(`[WebRTC] Error procesando OFFER de ${msg.fromId}:`, err);
  }
}

async function handleAnswer(msg) {
  try {
    const peer = state.peers.get(msg.fromId);
    if (peer && peer.pc) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
      if (peer.pendingCandidates.length > 0) {
        for (const cand of peer.pendingCandidates) {
          try {
            await peer.pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch (err) {}
        }
        peer.pendingCandidates = [];
      }
    }
  } catch (err) {
    console.error(`[WebRTC] Error procesando ANSWER de ${msg.fromId}:`, err);
  }
}

async function handleCandidate(msg) {
  const peer = state.peers.get(msg.fromId);
  if (!peer || !peer.pc) return;

  const candidateData = {
    candidate: msg.candidate,
    sdpMid: msg.sdpMid,
    sdpMLineIndex: msg.sdpMLineIndex
  };

  if (!peer.pc.remoteDescription || !peer.pc.remoteDescription.type) {
    peer.pendingCandidates.push(candidateData);
  } else {
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidateData));
    } catch (e) {
      console.warn('[WebRTC] Error al aplicar candidato ICE:', e);
    }
  }
}

// ==========================================
// AMPLIFICADOR DE VOLUMEN DIGITAL Y COMPRESOR PARA CASCOS (AUDIO BOOST)
// ==========================================
function setupPeerAudioPipeline(peerId, incomingStream, audioElement) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      audioElement.srcObject = incomingStream;
      return;
    }

    if (!state.audioCtx) {
      state.audioCtx = new AudioContextClass();
    }
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }

    // Desconectar pipeline previo si existía
    cleanupPeerAudioPipeline(peerId);

    const sourceNode = state.audioCtx.createMediaStreamSource(incomingStream);
    const gainNode = state.audioCtx.createGain();
    const multiplier = state.intercomVolume / 100;
    gainNode.gain.setValueAtTime(multiplier, state.audioCtx.currentTime);

    // Compresor dinámico anti-distorsión para motocicletas
    const compressorNode = state.audioCtx.createDynamicsCompressor();
    compressorNode.threshold.value = -24; // dB
    compressorNode.knee.value = 30; // dB
    compressorNode.ratio.value = 12; // limitador suave en picos altos
    compressorNode.attack.value = 0.003; // segundos
    compressorNode.release.value = 0.25; // segundos

    const destNode = state.audioCtx.createMediaStreamDestination();

    sourceNode.connect(gainNode);
    gainNode.connect(compressorNode);
    compressorNode.connect(destNode);

    state.peerAudioPipelines.set(peerId, {
      sourceNode,
      gainNode,
      compressorNode,
      destNode,
      audioElement
    });

    audioElement.srcObject = destNode.stream;
    console.log(`[AudioBoost] Pipeline activado para piloto ${peerId} (Volumen: ${state.intercomVolume}%)`);
  } catch (err) {
    console.warn('[AudioBoost] Fallback a audio nativo:', err);
    audioElement.srcObject = incomingStream;
  }
}

function cleanupPeerAudioPipeline(peerId) {
  if (state.peerAudioPipelines && state.peerAudioPipelines.has(peerId)) {
    const p = state.peerAudioPipelines.get(peerId);
    try { p.sourceNode?.disconnect(); } catch (e) {}
    try { p.gainNode?.disconnect(); } catch (e) {}
    try { p.compressorNode?.disconnect(); } catch (e) {}
    state.peerAudioPipelines.delete(peerId);
  }
}

function setIntercomVolume(volPercent, save = true) {
  state.intercomVolume = Math.max(20, Math.min(300, volPercent));
  if (save) {
    try {
      localStorage.setItem('ridercom_intercom_volume', state.intercomVolume.toString());
    } catch (e) {}
  }

  // Despertar AudioContext si estaba en pausa
  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    state.audioCtx.resume().catch(() => {});
  }

  const multiplier = state.intercomVolume / 100;

  // Actualizar todos los GainNodes activos en tiempo real
  if (state.audioCtx && state.peerAudioPipelines) {
    state.peerAudioPipelines.forEach((pipeline) => {
      try {
        pipeline.gainNode.gain.setValueAtTime(multiplier, state.audioCtx.currentTime);
      } catch (e) {}
    });
  }

  updateVolumeUI();
}

function updateVolumeUI() {
  const vol = state.intercomVolume;
  let modeLabel = '';
  if (vol <= 100) modeLabel = `${vol}% (Normal)`;
  else if (vol <= 160) modeLabel = `${vol}% (Boost Moto)`;
  else if (vol <= 220) modeLabel = `${vol}% (Casco)`;
  else modeLabel = `${vol}% (Turbo Boost 🚀)`;

  const elBadgeLabel = document.getElementById('volumeBadgeLabel');
  const elBadge = document.getElementById('btnVolumeBadge');
  if (elBadgeLabel) elBadgeLabel.textContent = `Vol: ${vol}%`;
  if (elBadge) {
    elBadge.classList.toggle('turbo', vol >= 220);
    elBadge.title = `Volumen de intercomunicador: ${modeLabel}. Toca para cambiar.`;
  }

  const elValLabel = document.getElementById('volumeValueLabel');
  if (elValLabel) {
    elValLabel.textContent = modeLabel;
    elValLabel.classList.toggle('turbo', vol >= 220);
  }

  const elSlider = document.getElementById('sliderVolume');
  if (elSlider && parseInt(elSlider.value, 10) !== vol) {
    elSlider.value = vol;
  }

  // Actualizar botones de presets
  document.querySelectorAll('.btn-vol-preset').forEach((btn) => {
    const presetVal = parseInt(btn.getAttribute('data-vol'), 10);
    btn.classList.toggle('active', presetVal === vol);
  });
}

function cycleIntercomVolume() {
  // Cicla: 100% -> 150% -> 200% -> 300% -> 100%
  const current = state.intercomVolume;
  let next = 150;
  if (current < 130) next = 150;
  else if (current < 180) next = 200;
  else if (current < 250) next = 300;
  else next = 100;

  setIntercomVolume(next);
}

function initVolumeControls() {
  const slider = document.getElementById('sliderVolume');
  const badge = document.getElementById('btnVolumeBadge');

  updateVolumeUI();

  slider?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val)) setIntercomVolume(val);
  });

  badge?.addEventListener('click', () => {
    cycleIntercomVolume();
  });

  document.querySelectorAll('.btn-vol-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = parseInt(btn.getAttribute('data-vol'), 10);
      if (!isNaN(val)) {
        setIntercomVolume(val);
      }
    });
  });
}

function removePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (peer) {
    try {
      peer.pc.close();
    } catch (e) {}
    state.peers.delete(peerId);
    renderPeers();
  }
  cleanupPeerAudioPipeline(peerId);
  const audio = document.getElementById(`audio_${peerId}`);
  if (audio) {
    audio.srcObject = null;
    audio.remove();
  }
}

function cleanupPeers() {
  state.peers.forEach((p, id) => {
    try {
      p.pc.close();
    } catch (e) {}
    cleanupPeerAudioPipeline(id);
    const audio = document.getElementById(`audio_${id}`);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
    }
  });
  state.peers.clear();
  renderPeers();
}

function setPeerTalking(peerId, isTalking) {
  const peer = state.peers.get(peerId);
  if (peer) {
    peer.isTalking = isTalking;
    renderPeers();
  }
}

function renderPeers() {
  elPeersTotal.textContent = `${state.peers.size + 1} en ruta`;
  elCount.textContent = `👥 ${state.peers.size + 1} en ruta`;

  let html = `
    <div class="peer-item">
      <div class="peer-left">
        <span style="font-size:20px">👑</span>
        <div>
          <div class="peer-name">${state.nick} (Tú)</div>
          <div class="peer-subtext">Transmisor local</div>
        </div>
      </div>
      <span class="peer-badge">● Activo</span>
    </div>
  `;

  state.peers.forEach((peer) => {
    html += `
      <div class="peer-item ${peer.isTalking ? 'talking' : ''}">
        <div class="peer-left">
          <span style="font-size:20px">${peer.isTalking ? '📢' : '👤'}</span>
          <div>
            <div class="peer-name">${peer.nick}</div>
            <div class="peer-subtext">${peer.isTalking ? 'Hablando ahora...' : 'En escucha'}</div>
          </div>
        </div>
        <span class="peer-badge ${peer.isTalking ? 'talking' : ''}">
          ${peer.isTalking ? '🔊 HABLANDO' : '● Conectado'}
        </span>
      </div>
    `;
  });

  elPeersList.innerHTML = html;
}

// ==========================================
// AUDIO ENGINE: VOX INTELIGENTE & WEBRTC P2P
// ==========================================

// Configuración del Analizador Acústico VOX (En memoria paralela con pista clonada)
function setupVoxAnalyser(stream) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    if (!state.audioCtx) {
      state.audioCtx = new AudioContextClass();
    }
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }

    if (state.voxSourceNode) {
      try { state.voxSourceNode.disconnect(); } catch (e) {}
    }

    const tracks = stream.getAudioTracks();
    if (!tracks || tracks.length === 0) return;

    // SOLUCIÓN CLAVE: Clonar la pista de audio exclusivamente para el analizador acústico.
    // Al clonarla, analyserTrack.enabled permanece SIEMPRE en true en el AudioContext.
    // Esto permite que el analizador siga escuchando el micrófono real para detectar cuándo hablas,
    // incluso cuando la pista WebRTC principal esté temporalmente silenciada (track.enabled = false).
    if (state.analyserTrack) {
      try { state.analyserTrack.stop(); } catch (e) {}
      state.analyserTrack = null;
    }
    state.analyserTrack = tracks[0].clone();
    state.analyserTrack.enabled = true;

    const analyserStream = new MediaStream([state.analyserTrack]);
    const source = state.audioCtx.createMediaStreamSource(analyserStream);
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);

    state.voxSourceNode = source;
    state.analyserNode = analyser;

    startVoxLoop();
  } catch (err) {
    console.warn('[VOX] Error iniciando analizador acústico:', err);
  }
}

// Bucle continuo de discriminación espectral: Voz vs Viento/Motor
function startVoxLoop() {
  if (state.voxLoopTimer) return;

  const freqData = new Uint8Array(256);
  const timeData = new Uint8Array(512);

  state.voxLoopTimer = setInterval(() => {
    if (!state.analyserNode) return;

    state.analyserNode.getByteFrequencyData(freqData);
    state.analyserNode.getByteTimeDomainData(timeData);

    // 1. RMS y volumen en dB
    let sumSquares = 0;
    for (let i = 0; i < timeData.length; i++) {
      const norm = (timeData[i] - 128) / 128;
      sumSquares += norm * norm;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);
    const db = 20 * Math.log10(Math.max(rms, 1e-5));

    // 2. Discriminación espectral en 3 bandas:
    // Bins 0..2: <280 Hz (Rumble grave: viento en casco, escape, motor)
    let eLow = 0;
    for (let i = 0; i <= 2; i++) {
      const v = freqData[i] / 255;
      eLow += v * v;
    }

    // Bins 3..34: ~280 Hz a ~3200 Hz (Formantes de voz humana F1, F2, F3)
    let eVoice = 0;
    let peakVoice = 0;
    for (let i = 3; i <= 34; i++) {
      const v = freqData[i] / 255;
      const p = v * v;
      eVoice += p;
      if (p > peakVoice) peakVoice = p;
    }
    const meanVoice = eVoice / 32;
    const crestFactor = peakVoice / (meanVoice + 1e-5);

    // Bins 35..80: ~3300 Hz a ~7500 Hz (Soplido agudo de viento)
    let eHigh = 0;
    for (let i = 35; i <= 80; i++) {
      const v = freqData[i] / 255;
      eHigh += v * v;
    }

    const eTotal = eLow + eVoice + eHigh;
    const voiceRatio = eVoice / (eTotal + 1e-5);
    const rumbleRatio = eLow / (eTotal + 1e-5);

    const prof = VOX_PROFILES[state.voxMode] || VOX_PROFILES.standard;

    // Regla de decisión acústica afinada para Bluetooth SCO y móviles
    const isAudible = db > prof.minDb;
    const isFormantStructure = voiceRatio >= prof.minVoiceRatio && crestFactor >= prof.minCrest;
    const isRumbleDominant = rumbleRatio > prof.maxRumbleRatio && voiceRatio < (prof.minVoiceRatio * 1.15);

    const isRawVoice = isAudible && isFormantStructure && !isRumbleDominant;
    const isRawNoise = isAudible && !isRawVoice;

    // Lógica temporal de activación (Ataque y Resaca / Hangover)
    if (isRawVoice) {
      state.voxConsecutiveVoice++;
      if (state.voxConsecutiveVoice >= 1) { // Activación inmediata en 30ms
        state.isVoiceActive = true;
        state.voxHoldTimer = prof.hangoverMs;
      }
    } else {
      state.voxConsecutiveVoice = 0;
      if (state.voxHoldTimer > 0) {
        state.voxHoldTimer -= 30;
        state.isVoiceActive = true;
      } else {
        state.isVoiceActive = false;
      }
    }

    state.isFilteringNoise = isRawNoise && !state.isVoiceActive;

    // Actualizar medidor visual en modal de configuración
    updateVoxMeterUI(db, isRawVoice, isRawNoise);

    // Sincronizar transmisión
    syncTransmissionState();
  }, 30);
}

// Medidor visual de calibración en Ajustes
function updateVoxMeterUI(db, isVoice, isNoise) {
  const elBar = document.getElementById('voxMeterBar');
  const elStatus = document.getElementById('voxMeterStatus');
  if (!elBar || !elStatus) return;

  const pct = Math.min(Math.max(((db + 60) / 45) * 100, 0), 100);
  elBar.style.width = `${pct}%`;

  if (isVoice) {
    elBar.className = 'vox-meter-bar voice';
    elStatus.className = 'vox-meter-status voice';
    elStatus.textContent = '🟢 VOZ HUMANA DETECTADA';
  } else if (isNoise) {
    elBar.className = 'vox-meter-bar noise';
    elStatus.className = 'vox-meter-status noise';
    elStatus.textContent = '🟡 RUIDO / VIENTO BLOQUEADO';
  } else {
    elBar.className = 'vox-meter-bar';
    elStatus.className = 'vox-meter-status';
    elStatus.textContent = '⚪ Silencio';
  }
}

// Sincronización precisa de pistas WebRTC nativas
function syncTransmissionState() {
  let shouldTransmit = false;

  if (state.isManualPtt) {
    shouldTransmit = true;
  } else if (state.isHandsFree) {
    if (state.handsFreeMode === 'open') {
      // MODO MICRÓFONO ABIERTO:
      // Exactamente idéntico a presionar PTT: transmisión 100% continua, nativa y cristalina
      shouldTransmit = true;
    } else {
      // MODO VOX AUTO:
      // Activación inteligente solo al hablar
      shouldTransmit = state.isVoiceActive;
    }
  } else {
    shouldTransmit = false;
  }

  // Activar o desactivar pistas de audio nativas WebRTC
  if (state.localStream) {
    state.localStream.getAudioTracks().forEach((track) => {
      if (track.enabled !== shouldTransmit) {
        track.enabled = shouldTransmit;
      }
    });
  }

  if (state.isTransmitting !== shouldTransmit) {
    state.isTransmitting = shouldTransmit;
    broadcastTalkState(shouldTransmit);
    if ('vibrate' in navigator && shouldTransmit) navigator.vibrate(30);
  }

  updatePttUI();
}

function broadcastTalkState(isTalking) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'TALK_STATE', isTalking }));
  }
}

function updatePttUI() {
  const elDspDot = document.getElementById('dspDot');
  const elDspLabel = document.getElementById('dspLabel');

  if (state.isManualPtt) {
    elPttBtn.className = 'ptt-button active';
    elPttTitle.textContent = '🎙️ TRANSMITIENDO VOZ (PTT)';
    elPttLabel.textContent = 'HABLANDO';
    elMicIcon.textContent = '📢';
    if (elDspDot) elDspDot.style.backgroundColor = '#dc2626';
    if (elDspLabel) elDspLabel.textContent = 'PTT: Manual';
  } else if (state.isHandsFree) {
    elLockBtn.className = 'lock-btn active';
    elLockBtn.textContent = '🔓 Liberar Micrófono';

    if (state.handsFreeMode === 'open') {
      // Modo Continuo (Igual a PTT Fijo)
      elPttBtn.className = 'ptt-button locked active';
      elPttTitle.textContent = '🎙️ MANOS LIBRES (ABIERTO)';
      elPttLabel.textContent = 'HABLANDO';
      elMicIcon.textContent = '📢';
      if (elDspDot) {
        elDspDot.style.backgroundColor = '#10b981';
        elDspDot.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.8)';
      }
      if (elDspLabel) elDspLabel.textContent = 'Manos Libres: Continuo';
    } else {
      // Modo VOX Inteligente
      if (state.isTransmitting) {
        elPttBtn.className = 'ptt-button active';
        elPttTitle.textContent = '🟢 VOZ EN VIVO (VOX)';
        elPttLabel.textContent = 'HABLANDO';
        elMicIcon.textContent = '📢';
        if (elDspDot) {
          elDspDot.style.backgroundColor = '#10b981';
          elDspDot.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.8)';
        }
        if (elDspLabel) elDspLabel.textContent = 'VOX: 🟢 Transmitiendo';
      } else if (state.isFilteringNoise) {
        elPttBtn.className = 'ptt-button locked';
        elPttTitle.textContent = '🟡 FILTRANDO VIENTO / MOTOR';
        elPttLabel.textContent = 'BLOQUEADO';
        elMicIcon.textContent = '🛡️';
        if (elDspDot) {
          elDspDot.style.backgroundColor = '#f59e0b';
          elDspDot.style.boxShadow = '0 0 8px rgba(245, 158, 11, 0.6)';
        }
        if (elDspLabel) elDspLabel.textContent = 'VOX: 🟡 Filtrando Viento';
      } else {
        elPttBtn.className = 'ptt-button locked';
        elPttTitle.textContent = '⚪ MANOS LIBRES (VOX ESPERA)';
        elPttLabel.textContent = 'VOX AUTO';
        elMicIcon.textContent = '🎙️';
        if (elDspDot) {
          elDspDot.style.backgroundColor = '#38bdf8';
          elDspDot.style.boxShadow = '0 0 6px rgba(56, 189, 248, 0.5)';
        }
        if (elDspLabel) elDspLabel.textContent = 'VOX: 🔵 En Espera';
      }
    }
  } else {
    elLockBtn.className = 'lock-btn';
    elLockBtn.textContent = '🔒 Fijar Manos Libres';
    elPttBtn.className = 'ptt-button';
    elPttTitle.textContent = '⚪ EN ESPERA';
    elPttLabel.textContent = 'PTT HABLAR';
    elMicIcon.textContent = '🎙️';
    if (elDspDot) {
      elDspDot.style.backgroundColor = '#64748b';
      elDspDot.style.boxShadow = 'none';
    }
    if (elDspLabel) {
      elDspLabel.textContent = state.handsFreeMode === 'open' ? 'ML: Abierto' : 'VOX: En Reposo';
    }
  }

  // Sincronizar botón flotante de PTT en el mapa
  const elFloatBtn = document.getElementById('floatingPttBtn');
  const elFloatLock = document.getElementById('floatingLockBtn');
  const elFloatIcon = document.getElementById('floatMicIcon');
  const elFloatText = document.getElementById('floatPttText');

  if (elFloatBtn && elFloatLock && elFloatIcon && elFloatText) {
    if (state.isManualPtt) {
      elFloatBtn.className = 'floating-ptt-btn active';
      elFloatIcon.textContent = '📢';
      elFloatText.textContent = 'HABLANDO';
      elFloatLock.className = 'floating-lock-btn';
      elFloatLock.textContent = '🔒 Manos Libres';
    } else if (state.isHandsFree) {
      elFloatLock.className = 'floating-lock-btn active';
      elFloatLock.textContent = '🔓 Liberar';
      if (state.handsFreeMode === 'open') {
        elFloatBtn.className = 'floating-ptt-btn locked active';
        elFloatIcon.textContent = '📢';
        elFloatText.textContent = 'ABIERTO';
      } else {
        if (state.isTransmitting) {
          elFloatBtn.className = 'floating-ptt-btn active';
          elFloatIcon.textContent = '📢';
          elFloatText.textContent = 'VOX VOZ';
        } else {
          elFloatBtn.className = 'floating-ptt-btn locked';
          elFloatIcon.textContent = '🎙️';
          elFloatText.textContent = 'VOX ESPERA';
        }
      }
    } else {
      elFloatBtn.className = 'floating-ptt-btn';
      elFloatIcon.textContent = '🎙️';
      elFloatText.textContent = 'PTT';
      elFloatLock.className = 'floating-lock-btn';
      elFloatLock.textContent = '🔒 Manos Libres';
    }
  }
}

// PTT Touch & Pointer Events
let lastTap = 0;
elPttBtn.addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  await getLocalStream();

  const now = Date.now();
  if (now - lastTap < 350) {
    state.isHandsFree = !state.isHandsFree;
    if (!state.isHandsFree) {
      state.isVoiceActive = false;
      state.isFilteringNoise = false;
    }
    state.isManualPtt = false;
    syncTransmissionState();
    lastTap = 0;
    return;
  }
  lastTap = now;

  if (!state.isHandsFree) {
    state.isManualPtt = true;
    syncTransmissionState();
  }
});

window.addEventListener('pointerup', () => {
  if (state.isManualPtt) {
    state.isManualPtt = false;
    syncTransmissionState();
  }
});

elLockBtn.addEventListener('click', async () => {
  await getLocalStream();
  state.isHandsFree = !state.isHandsFree;
  if (!state.isHandsFree) {
    state.isVoiceActive = false;
    state.isFilteringNoise = false;
  }
  syncTransmissionState();
});

// Settings Modal
document.getElementById('btnSettings').addEventListener('click', () => {
  elModal.classList.remove('hidden');
  applyHandsFreeMode(state.handsFreeMode);
  applyDataSaverProfile(state.dataSaverMode);
  refreshAudioDevices();
});

document.getElementById('btnDeviceBadge')?.addEventListener('click', () => {
  elModal.classList.remove('hidden');
  applyHandsFreeMode(state.handsFreeMode);
  applyDataSaverProfile(state.dataSaverMode);
  refreshAudioDevices();
});

document.getElementById('btnDspBadge')?.addEventListener('click', () => {
  elModal.classList.remove('hidden');
  applyHandsFreeMode(state.handsFreeMode);
  applyDataSaverProfile(state.dataSaverMode);
  refreshAudioDevices();
});

document.getElementById('selectHandsFreeMode')?.addEventListener('change', (e) => {
  const elVoxGroup = document.getElementById('voxSettingsGroup');
  if (elVoxGroup) {
    elVoxGroup.style.display = e.target.value === 'vox' ? 'block' : 'none';
  }
});

document.getElementById('btnCancelSettings').addEventListener('click', () => {
  elModal.classList.add('hidden');
});

document.getElementById('btnSaveSettings').addEventListener('click', async () => {
  const oldRoom = state.room;
  const oldNick = state.nick;
  const oldServer = state.serverUrl;

  state.room = document.getElementById('inputRoom').value.trim().toUpperCase() || 'RUTA-77';
  state.nick = document.getElementById('inputNick').value.trim() || 'Piloto';
  state.serverUrl = document.getElementById('inputServer').value.trim() || state.serverUrl;

  const selectedHfMode = document.getElementById('selectHandsFreeMode')?.value;
  if (selectedHfMode) {
    applyHandsFreeMode(selectedHfMode);
  }

  const selectedVox = document.getElementById('selectVoxMode')?.value;
  if (selectedVox) {
    applyVoxProfile(selectedVox);
  }

  const selectedDataSaver = document.getElementById('selectDataSaver')?.value;
  const oldDataSaver = state.dataSaverMode;
  if (selectedDataSaver) {
    applyDataSaverProfile(selectedDataSaver);
  }

  const selectedInput = document.getElementById('selectAudioInput')?.value ?? '';
  const selectedOutput = document.getElementById('selectAudioOutput')?.value ?? '';

  if (selectedOutput !== state.selectedAudioOutputId) {
    switchAudioOutput(selectedOutput);
  }

  if (selectedInput !== state.selectedAudioInputId) {
    await switchAudioInput(selectedInput);
  }

  elRoom.textContent = state.room;
  elNick.textContent = state.nick;
  elModal.classList.add('hidden');

  // Solo reconectar si cambiaron datos de conexión a la sala o el perfil de consumo Opus
  if (state.room !== oldRoom || state.nick !== oldNick || state.serverUrl !== oldServer || (selectedDataSaver && selectedDataSaver !== oldDataSaver)) {
    if (state.ws) state.ws.close();
  }
});

// Escuchar conexión y desconexión de auriculares / intercomunicadores Bluetooth
if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    console.log('[Audio] Cambio en dispositivos de audio detectado (Bluetooth conectado/desconectado)');
    await refreshAudioDevices();
  });
}

// ==========================================
// GPS NAVIGATION, MAP & GROUP TRACKING ENGINE
// ==========================================

const MANEUVER_ICONS = {
  'turn-right': '↱',
  'turn-left': '↰',
  'sharp-right': '⮡',
  'sharp-left': '⮠',
  'slight-right': '↗',
  'slight-left': '↖',
  'continue': '↑',
  'straight': '↑',
  'roundabout': '🔄',
  'rotary': '🔄',
  'uturn': '↩',
  'arrive': '🏁',
  'depart': '🏍️'
};

function initTabs() {
  const tabIntercom = document.getElementById('tabIntercom');
  const tabMap = document.getElementById('tabMap');
  const tabSplit = document.getElementById('tabSplit');
  const viewIntercom = document.getElementById('viewIntercom');
  const viewMap = document.getElementById('viewMap');
  const appContainer = document.querySelector('.app-container');

  function setActiveTab(tabName) {
    state.currentView = tabName;
    tabIntercom?.classList.toggle('active', tabName === 'intercom');
    tabMap?.classList.toggle('active', tabName === 'map');
    tabSplit?.classList.toggle('active', tabName === 'split');

    if (tabName === 'intercom') {
      appContainer?.classList.remove('dashboard-mode', 'map-mode');
      viewIntercom?.classList.remove('hidden');
      viewMap?.classList.add('hidden');
    } else if (tabName === 'map') {
      appContainer?.classList.remove('dashboard-mode');
      appContainer?.classList.add('map-mode');
      viewIntercom?.classList.add('hidden');
      viewMap?.classList.remove('hidden');
      initLeafletMapIfNeeded();
      setTimeout(() => state.leafletMap?.invalidateSize(), 200);
    } else if (tabName === 'split') {
      appContainer?.classList.remove('map-mode');
      appContainer?.classList.add('dashboard-mode');
      viewIntercom?.classList.remove('hidden');
      viewMap?.classList.remove('hidden');
      initLeafletMapIfNeeded();
      setTimeout(() => state.leafletMap?.invalidateSize(), 200);
    }
  }

  tabIntercom?.addEventListener('click', () => setActiveTab('intercom'));
  tabMap?.addEventListener('click', () => setActiveTab('map'));
  tabSplit?.addEventListener('click', () => setActiveTab('split'));
}

function initLeafletMapIfNeeded() {
  if (state.leafletMap) return;
  if (typeof L === 'undefined') {
    console.warn('[Map] Leaflet JS no está cargado');
    return;
  }
  const mapContainer = document.getElementById('mapContainer');
  if (!mapContainer) return;

  const defaultCoords = [10.4806, -66.9036];
  const map = L.map('mapContainer', {
    center: defaultCoords,
    zoom: 15,
    zoomControl: false
  });

  L.control.zoom({ position: 'topright' }).addTo(map);

  // Azulejos OpenStreetMap de alta visibilidad para motociclistas
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    subdomains: ['a', 'b', 'c'],
    maxZoom: 19
  }).addTo(map);

  state.leafletMap = map;

  map.on('dragstart', () => {
    state.mapUserInteracted = true;
  });

  // Marcador propio con icono de moto
  const myIcon = L.divIcon({
    className: 'bike-marker-custom',
    html: `<div class="bike-marker-wrap"><span class="bike-marker-icon" id="myBikeIcon">🏍️</span><span class="bike-marker-label">${state.nick} (Tú)</span></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20]
  });

  state.myMarker = L.marker(defaultCoords, { icon: myIcon }).addTo(map);

  initGpsTracking();
  initMapControls();
}

function initGpsTracking() {
  if (!('geolocation' in navigator)) return;

  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const speedKmH = pos.coords.speed !== null && pos.coords.speed >= 0 ? Math.round(pos.coords.speed * 3.6) : 0;
      const heading = pos.coords.heading !== null && !isNaN(pos.coords.heading) ? Math.round(pos.coords.heading) : 0;

      state.currentLocation = { lat, lng, speed: speedKmH, heading };

      // Actualizar velocímetro digital HUD
      const elHudSpeed = document.getElementById('hudSpeed');
      const elHudHeading = document.getElementById('hudHeading');
      if (elHudSpeed) elHudSpeed.textContent = speedKmH;
      if (elHudHeading) {
        const directions = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
        const dirIndex = Math.round(heading / 45) % 8;
        elHudHeading.textContent = `🧭 ${directions[dirIndex] || 'N'}`;
      }

      // Actualizar marcador propio en el mapa
      if (state.myMarker) {
        state.myMarker.setLatLng([lat, lng]);
        const bikeIcon = document.getElementById('myBikeIcon');
        if (bikeIcon && heading) {
          bikeIcon.style.transform = `rotate(${heading}deg)`;
        }
      }

      // Si el mapa aún no se movió manualmente, centrar en la moto
      if (!state.mapUserInteracted) {
        state.leafletMap?.setView([lat, lng], state.leafletMap.getZoom() || 16);
      }

      // Comprobar progreso de navegación giro a giro
      updateNavigationProgress(lat, lng);

      // Transmitir posición a los compañeros cada 3 segundos
      const now = Date.now();
      if (now - state.lastLocationBroadcastTs > 3000) {
        state.lastLocationBroadcastTs = now;
        broadcastLocation(lat, lng, speedKmH, heading);
      }
    },
    (err) => {
      console.warn('[GPS] Error de geolocalización:', err.message);
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}

function broadcastLocation(lat, lng, speed, heading) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'LOCATION',
      coords: { lat, lng, speed, heading }
    }));
  }
}

function updatePeerLocationOnMap(msg) {
  if (!state.leafletMap) return;
  const { peerId, nick, coords } = msg;
  if (!coords || typeof coords.lat !== 'number' || typeof coords.lng !== 'number') return;

  let marker = state.peerMarkers.get(peerId);
  if (!marker) {
    const peerIcon = L.divIcon({
      className: 'bike-marker-custom',
      html: `<div class="bike-marker-wrap"><span class="bike-marker-icon">🏍️</span><span class="bike-marker-label" id="label_${peerId}">${nick} (${coords.speed || 0} km/h)</span></div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });
    marker = L.marker([coords.lat, coords.lng], { icon: peerIcon }).addTo(state.leafletMap);
    state.peerMarkers.set(peerId, marker);
  } else {
    marker.setLatLng([coords.lat, coords.lng]);
    const labelEl = document.getElementById(`label_${peerId}`);
    if (labelEl) labelEl.textContent = `${nick} (${coords.speed || 0} km/h)`;
  }
}

function speakGuidance(text) {
  if (!state.voiceNavEnabled || !window.speechSynthesis) return;
  if (state.lastSpeechText === text) return;
  state.lastSpeechText = text;

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-ES';
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  } catch (e) {}
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function updateNavigationProgress(lat, lng) {
  if (!state.routeSteps || state.routeSteps.length === 0) return;
  if (state.currentStepIndex >= state.routeSteps.length) {
    // Llegada al destino
    const elDist = document.getElementById('navDistance');
    const elInst = document.getElementById('navInstruction');
    if (elDist) elDist.textContent = '🏁 ¡Has llegado!';
    if (elInst) elInst.textContent = 'Destino alcanzado';
    speakGuidance('Has llegado a tu destino.');
    setTimeout(() => {
      cancelCurrentRoute();
    }, 6000);
    return;
  }

  const currentStep = state.routeSteps[state.currentStepIndex];
  const stepCoord = currentStep.maneuver.location; // [lng, lat]
  const dist = calculateDistanceMeters(lat, lng, stepCoord[1], stepCoord[0]);

  // Manejo de giro completado (< 35 metros del punto)
  if (dist < 35) {
    state.currentStepIndex++;
    if (state.currentStepIndex < state.routeSteps.length) {
      const nextStep = state.routeSteps[state.currentStepIndex];
      speakGuidance(nextStep.instruction || 'Continúa por la ruta');
    }
    return;
  }

  // Actualizar UI del banner
  const distLabel = dist > 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`;
  const elDist = document.getElementById('navDistance');
  const elInst = document.getElementById('navInstruction');
  const elIcon = document.getElementById('navManeuverIcon');

  if (elDist) elDist.textContent = `En ${distLabel}`;
  if (elInst) elInst.textContent = currentStep.instruction || currentStep.name || 'Continúa por la ruta';

  const type = currentStep.maneuver.type || 'turn';
  const mod = currentStep.maneuver.modifier || '';
  const iconKey = mod ? `${type}-${mod}` : type;
  if (elIcon) elIcon.textContent = MANEUVER_ICONS[iconKey] || MANEUVER_ICONS[mod] || '↱';

  // Dictar por voz anticipada (a ~250m)
  if (dist <= 260 && dist >= 180 && state.lastSpokenDistance !== 250) {
    state.lastSpokenDistance = 250;
    speakGuidance(`En doscientos metros, ${currentStep.instruction}`);
  }
}

async function searchDestinations(query) {
  const suggestionsBox = document.getElementById('searchSuggestions');
  if (!suggestionsBox) return;

  if (!query || query.trim().length < 3) {
    suggestionsBox.classList.add('hidden');
    return;
  }

  try {
    let url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`;
    if (state.currentLocation) {
      const b = 0.5;
      url += `&viewbox=${state.currentLocation.lng - b},${state.currentLocation.lat + b},${state.currentLocation.lng + b},${state.currentLocation.lat - b}`;
    }

    const res = await fetch(url);
    const data = await res.json();

    if (!data || data.length === 0) {
      suggestionsBox.innerHTML = '<div class="suggestion-item">No se encontraron lugares</div>';
      suggestionsBox.classList.remove('hidden');
      return;
    }

    suggestionsBox.innerHTML = data.map((item) => `
      <div class="suggestion-item" data-lat="${item.lat}" data-lon="${item.lon}">
        <strong>📍 ${item.display_name.split(',')[0]}</strong>
        <div style="font-size:10px; color:#94a3b8;">${item.display_name}</div>
      </div>
    `).join('');

    suggestionsBox.classList.remove('hidden');

    suggestionsBox.querySelectorAll('.suggestion-item').forEach((el) => {
      el.addEventListener('click', () => {
        const lat = parseFloat(el.getAttribute('data-lat'));
        const lon = parseFloat(el.getAttribute('data-lon'));
        suggestionsBox.classList.add('hidden');
        const searchInput = document.getElementById('inputMapSearch');
        if (searchInput) searchInput.value = el.querySelector('strong').textContent.replace('📍 ', '');
        calculateAndStartRoute(lat, lon);
      });
    });
  } catch (e) {
    console.warn('[Search] Error en búsqueda de destino:', e);
  }
}

async function calculateAndStartRoute(destLat, destLng) {
  let startLat, startLng;
  if (state.currentLocation) {
    startLat = state.currentLocation.lat;
    startLng = state.currentLocation.lng;
  } else {
    // Si aún no hay GPS satelital, usar centro del mapa
    const center = state.leafletMap ? state.leafletMap.getCenter() : { lat: 10.4806, lng: -66.9036 };
    startLat = center.lat;
    startLng = center.lng;
  }

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${destLng},${destLat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.routes || data.routes.length === 0) {
      alert('No se pudo encontrar una ruta en carretera hacia ese destino.');
      return;
    }

    const route = data.routes[0];

    // Limpiar ruta anterior
    if (state.routePolyline && state.leafletMap) {
      state.leafletMap.removeLayer(state.routePolyline);
    }

    // Dibujar polilínea en mapa
    state.routePolyline = L.geoJSON(route.geometry, {
      style: { color: '#38bdf8', weight: 6, opacity: 0.85 }
    }).addTo(state.leafletMap);

    state.leafletMap.fitBounds(state.routePolyline.getBounds(), { padding: [40, 40] });

    // Preparar pasos giro a giro
    state.routeSteps = [];
    route.legs.forEach((leg) => {
      leg.steps.forEach((step) => {
        let instruction = step.maneuver.instruction || '';
        if (!instruction) {
          const type = step.maneuver.type;
          const mod = step.maneuver.modifier ? ` a la ${step.maneuver.modifier.replace('left', 'izquierda').replace('right', 'derecha')}` : '';
          const street = step.name ? ` por ${step.name}` : '';
          instruction = `${type === 'turn' ? 'Gira' : 'Continúa'}${mod}${street}`;
        }
        state.routeSteps.push({
          ...step,
          instruction
        });
      });
    });

    state.currentStepIndex = 0;
    state.lastSpokenDistance = -1;

    // Mostrar banner de navegación
    const navBanner = document.getElementById('navGuidanceBanner');
    if (navBanner) navBanner.classList.remove('hidden');

    const km = (route.distance / 1000).toFixed(1);
    const minutes = Math.round(route.duration / 60);

    const elEta = document.getElementById('navEta');
    const elRem = document.getElementById('navRemDist');
    if (elEta) elEta.textContent = `${minutes} min`;
    if (elRem) elRem.textContent = `${km} km`;

    // Dictar por voz al casco
    speakGuidance(`Ruta calculada. Destino a ${km} kilómetros, tiempo estimado ${minutes} minutos. Conduce con cuidado.`);
  } catch (err) {
    console.error('[Route] Error calculando ruta:', err);
    alert('Error al calcular la ruta. Verifica tu conexión de datos.');
  }
}

function cancelCurrentRoute() {
  if (state.routePolyline && state.leafletMap) {
    state.leafletMap.removeLayer(state.routePolyline);
    state.routePolyline = null;
  }
  state.routeSteps = [];
  state.currentStepIndex = 0;
  const navBanner = document.getElementById('navGuidanceBanner');
  if (navBanner) navBanner.classList.add('hidden');
  window.speechSynthesis?.cancel();
}

function initMapControls() {
  const searchInput = document.getElementById('inputMapSearch');
  const btnClear = document.getElementById('btnClearSearch');
  const btnGo = document.getElementById('btnSearchDest');
  const btnCenter = document.getElementById('btnCenterGps');
  const btnVoice = document.getElementById('btnToggleVoiceNav');
  const btnCancel = document.getElementById('btnCancelRoute');

  searchInput?.addEventListener('input', (e) => {
    const val = e.target.value;
    if (btnClear) btnClear.classList.toggle('hidden', !val);
    clearTimeout(state.searchTimeout);
    state.searchTimeout = setTimeout(() => searchDestinations(val), 400);
  });

  btnClear?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    btnClear.classList.add('hidden');
    document.getElementById('searchSuggestions')?.classList.add('hidden');
  });

  btnGo?.addEventListener('click', () => {
    if (searchInput?.value) searchDestinations(searchInput.value);
  });

  btnCenter?.addEventListener('click', () => {
    state.mapUserInteracted = false;
    if (state.currentLocation && state.leafletMap) {
      state.leafletMap.setView([state.currentLocation.lat, state.currentLocation.lng], 16);
    }
  });

  btnVoice?.addEventListener('click', () => {
    state.voiceNavEnabled = !state.voiceNavEnabled;
    btnVoice.classList.toggle('active', state.voiceNavEnabled);
    const icon = document.getElementById('voiceNavIcon');
    if (icon) icon.textContent = state.voiceNavEnabled ? '🔊' : '🔇';
    if (!state.voiceNavEnabled) window.speechSynthesis?.cancel();
  });

  btnCancel?.addEventListener('click', cancelCurrentRoute);

  // Quick Chips
  document.querySelectorAll('.chip-btn[data-search]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const term = btn.getAttribute('data-search');
      if (searchInput) searchInput.value = term;
      searchDestinations(term);
    });
  });

  // Floating PTT Controls
  const floatPtt = document.getElementById('floatingPttBtn');
  const floatLock = document.getElementById('floatingLockBtn');

  floatPtt?.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    await getLocalStream();
    state.isManualPtt = true;
    syncTransmissionState();
  });

  const stopFloatPtt = () => {
    if (state.isManualPtt) {
      state.isManualPtt = false;
      syncTransmissionState();
    }
  };

  floatPtt?.addEventListener('pointerup', stopFloatPtt);
  floatPtt?.addEventListener('pointercancel', stopFloatPtt);
  floatPtt?.addEventListener('pointerleave', stopFloatPtt);

  floatLock?.addEventListener('click', async () => {
    await getLocalStream();
    state.isHandsFree = !state.isHandsFree;
    if (!state.isHandsFree) {
      state.isVoiceActive = false;
      state.isFilteringNoise = false;
    }
    syncTransmissionState();
  });
}

// ==========================================
// PWA (PROGRESSIVE WEB APP) & INSTALACIÓN EN ANDROID / MÓVIL
// ==========================================
let deferredPrompt = null;
const pwaInstallBanner = document.getElementById('pwaInstallBanner');
const btnPwaInstall = document.getElementById('btnPwaInstall');
const btnSettingsInstall = document.getElementById('btnSettingsInstall');
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

if (isStandalone) {
  if (pwaInstallBanner) pwaInstallBanner.classList.add('hidden');
  if (btnSettingsInstall) {
    btnSettingsInstall.textContent = '✅ App Instalada (Modo Nativo)';
    btnSettingsInstall.disabled = true;
    btnSettingsInstall.style.opacity = '0.7';
  }
}

// Registrar Service Worker para permitir instalación y caché offline
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        console.log('[PWA] Service Worker registrado exitosamente:', reg.scope);
      })
      .catch((err) => {
        console.warn('[PWA] No se pudo registrar el Service Worker:', err);
      });
  });
}

// Capturar evento de instalación de Chrome / Android
window.addEventListener('beforeinstallprompt', (e) => {
  // Prevenir que Chrome muestre su mini-infobar por defecto para usar nuestra UI optimizada para motos
  e.preventDefault();
  deferredPrompt = e;
  console.log('[PWA] Evento beforeinstallprompt capturado. Listo para instalación.');

  if (!isStandalone && pwaInstallBanner) {
    pwaInstallBanner.classList.remove('hidden');
  }

  if (btnSettingsInstall && !isStandalone) {
    btnSettingsInstall.textContent = '📲 Instalar en Pantalla de Inicio';
    btnSettingsInstall.disabled = false;
  }
});

async function triggerPwaInstall() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log('[PWA] Elección del usuario:', outcome);
    if (outcome === 'accepted') {
      if (pwaInstallBanner) pwaInstallBanner.classList.add('hidden');
    }
    deferredPrompt = null;
  } else if (isStandalone) {
    alert('¡RiderCom Mesh Pro ya está instalado y ejecutándose como App nativa!');
  } else {
    // Si Chrome aún no disparó el evento o el usuario está en iOS Safari / navegador integrado
    alert('📲 CÓMO INSTALAR EN TU CELULAR:\n\n1. En Google Chrome (Android):\nToca el botón de opciones arriba a la derecha (los 3 puntos ⋮) y selecciona "Instalar aplicación" o "Agregar a la pantalla principal".\n\n2. En Safari (iPhone / iOS):\nToca el botón de Compartir (icono cuadrado con flecha arriba) y elige "Agregar al inicio".');
  }
}

if (btnPwaInstall) {
  btnPwaInstall.addEventListener('click', triggerPwaInstall);
}

if (btnSettingsInstall) {
  btnSettingsInstall.addEventListener('click', triggerPwaInstall);
}

window.addEventListener('appinstalled', () => {
  console.log('[PWA] ¡RiderCom se instaló exitosamente en el teléfono!');
  if (pwaInstallBanner) pwaInstallBanner.classList.add('hidden');
  if (btnSettingsInstall) {
    btnSettingsInstall.textContent = '✅ App Instalada';
    btnSettingsInstall.disabled = true;
    btnSettingsInstall.style.opacity = '0.7';
  }
  deferredPrompt = null;
});

// Start
connect();
