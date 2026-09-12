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
  audioCtx: null,            // AudioContext en memoria exclusivamente para análisis acústico
  voxSourceNode: null,
  analyserNode: null,
  voxMode: localStorage.getItem('ridercom_vox_mode') || 'standard',
  selectedAudioInputId: localStorage.getItem('ridercom_input_device') || '',
  selectedAudioOutputId: localStorage.getItem('ridercom_output_device') || '',
  voxLoopTimer: null,
  voxConsecutiveVoice: 0,
  voxHoldTimer: 0,
  ws: null,
  myId: null
};

// Perfiles de discriminación acústica Voz Humana vs Viento/Motor (VOX Inteligente)
const VOX_PROFILES = {
  highway: {
    label: 'Moto / Autopista (Anti-Viento)',
    minDb: -40,           // Volumen mínimo audible para evaluar
    minVoiceRatio: 0.38,  // Proporción de formantes vocales vs ruido total
    minCrest: 2.1,        // Picos de resonancia vocal en 300-3200Hz
    maxRumbleRatio: 0.62, // Rechazo si los bajos <280Hz dominan (viento/escape)
    hangoverMs: 320       // Tiempo de resaca (ms) para no recortar finales de frases
  },
  standard: {
    label: 'Carretera / Equilibrado',
    minDb: -46,
    minVoiceRatio: 0.28,
    minCrest: 1.75,
    maxRumbleRatio: 0.72,
    hangoverMs: 380
  },
  sensitive: {
    label: 'Ciudad / Alta Sensibilidad',
    minDb: -52,
    minVoiceRatio: 0.20,
    minCrest: 1.5,
    maxRumbleRatio: 0.82,
    hangoverMs: 440
  }
};

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
  // Compatibilidad con perfil seleccionado
  if (VOX_PROFILES[mode]) {
    applyVoxProfile(mode);
  }
}

// Optimización de SDP Opus para activar AEC por hardware y DTX (Supresión de silencio)
function optimizeOpusSdp(sdp) {
  try {
    const match = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
    if (!match) return sdp;
    const pt = match[1];
    // stereo=0 y sprop-stereo=0 fuerzan mono en Android (obligatorio para activar AEC hardware)
    // usedtx=1 detiene la transmisión de paquetes en pausas/silencio
    // useinbandfec=1 protege contra paquetes perdidos en 4G/5G
    const opusParams = 'minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000';

    if (sdp.includes(`a=fmtp:${pt}`)) {
      return sdp.replace(
        new RegExp(`a=fmtp:${pt}\\s+[^\\r\\n]+`, 'g'),
        `a=fmtp:${pt} ${opusParams}`
      );
    } else {
      return sdp.replace(
        new RegExp(`a=rtpmap:${pt}\\s+opus\\/48000\\/2[\\r\\n]+`, 'g'),
        (m) => `${m}a=fmtp:${pt} ${opusParams}\r\n`
      );
    }
  } catch (e) {
    console.warn('[WebRTC] Error optimizando SDP Opus:', e);
    return sdp;
  }
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
applyVoxProfile(state.voxMode);
refreshAudioDevices();

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
    if (audio.srcObject !== e.streams[0]) {
      audio.srcObject = e.streams[0];
    }
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

function removePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (peer) {
    try {
      peer.pc.close();
    } catch (e) {}
    state.peers.delete(peerId);
    renderPeers();
  }
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

// Configuración del Analizador Acústico VOX (En memoria paralela, sin alterar stream nativo)
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

    const source = state.audioCtx.createMediaStreamSource(stream);
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

    // Regla de decisión acústica
    const isAudible = db > prof.minDb;
    const isFormantStructure = voiceRatio >= prof.minVoiceRatio && crestFactor >= prof.minCrest;
    const isRumbleDominant = rumbleRatio > prof.maxRumbleRatio && voiceRatio < (prof.minVoiceRatio * 1.15);

    const isRawVoice = isAudible && isFormantStructure && !isRumbleDominant;
    const isRawNoise = isAudible && !isRawVoice;

    // Lógica temporal de activación (Ataque y Resaca / Hangover)
    if (isRawVoice) {
      state.voxConsecutiveVoice++;
      if (state.voxConsecutiveVoice >= 2) {
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
    elStatus.textContent = '⚪ Silencio ambiental';
  }
}

// Sincronización precisa de pistas WebRTC nativas
function syncTransmissionState() {
  let shouldTransmit = false;

  if (state.isManualPtt) {
    shouldTransmit = true;
  } else if (state.isHandsFree) {
    shouldTransmit = state.isVoiceActive;
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
    if (elDspLabel) elDspLabel.textContent = 'VOX: PTT Manual';
  } else if (state.isHandsFree) {
    elLockBtn.className = 'lock-btn active';
    elLockBtn.textContent = '🔓 Liberar Manos Libres';

    if (state.isTransmitting) {
      elPttBtn.className = 'ptt-button active';
      elPttTitle.textContent = '🟢 VOZ EN VIVO (MANOS LIBRES)';
      elPttLabel.textContent = 'HABLANDO';
      elMicIcon.textContent = '📢';
      if (elDspDot) {
        elDspDot.style.backgroundColor = '#10b981';
        elDspDot.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.8)';
      }
      if (elDspLabel) elDspLabel.textContent = 'VOX: 🟢 Voz Transmitiendo';
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
      elPttTitle.textContent = '⚪ MANOS LIBRES (ESPERANDO VOZ)';
      elPttLabel.textContent = 'VOX AUTO';
      elMicIcon.textContent = '🎙️';
      if (elDspDot) {
        elDspDot.style.backgroundColor = '#38bdf8';
        elDspDot.style.boxShadow = '0 0 6px rgba(56, 189, 248, 0.5)';
      }
      if (elDspLabel) elDspLabel.textContent = 'VOX: 🔵 En Espera';
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
    if (elDspLabel) elDspLabel.textContent = 'VOX: En Reposo';
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
  refreshAudioDevices();
});

document.getElementById('btnDeviceBadge')?.addEventListener('click', () => {
  elModal.classList.remove('hidden');
  refreshAudioDevices();
});

document.getElementById('btnDspBadge')?.addEventListener('click', () => {
  elModal.classList.remove('hidden');
  refreshAudioDevices();
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

  const selectedVox = document.getElementById('selectVoxMode')?.value;
  if (selectedVox) {
    applyVoxProfile(selectedVox);
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

  // Solo reconectar si cambiaron datos de conexión a la sala, NO por cambiar de micrófono o VOX
  if (state.room !== oldRoom || state.nick !== oldNick || state.serverUrl !== oldServer) {
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

// Start
connect();
