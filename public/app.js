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
  // Amplificador de Volumen para Cascos (Boost hasta 300%)
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
    // Configurar pipeline con amplificación Boost y compresor anti-distorsión
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
  state.intercomVolume = Math.max(50, Math.min(300, volPercent));
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
  else if (vol <= 160) modeLabel = `${vol}% (Fuerte - Moto)`;
  else if (vol <= 220) modeLabel = `${vol}% (Extra Casco)`;
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
  // Cicla: 100% -> 150% -> 200% -> 250% -> 100%
  const current = state.intercomVolume;
  let next = 150;
  if (current < 130) next = 150;
  else if (current < 180) next = 200;
  else if (current < 230) next = 250;
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
