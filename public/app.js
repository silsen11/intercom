/**
 * RiderCom Mesh Pro - Web/PWA Client
 * 100% WebRTC P2P Direct Mesh (Audio en Vivo de Baja Latencia)
 */

const state = {
  room: 'RUTA-77',
  nick: 'Piloto_' + Math.floor(1000 + Math.random() * 9000),
  serverUrl: '',
  isTransmitting: false,
  isLocked: false,
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
  localStream: null,     // MediaStream procesado por DSP para transmitir vía WebRTC
  rawMicStream: null,    // Flujo crudo del micrófono
  audioCtx: null,        // AudioContext para el DSP
  dspSource: null,
  highpassNode: null,    // Filtro pasa-altos para vibraciones y viento
  lowpassNode: null,     // Filtro pasa-bajos para silbidos de viento
  presenceNode: null,    // Realce de presencia vocal
  compressorNode: null,  // Control automático de dinámica y nivel
  gateGainNode: null,    // Puerta de ruido (Noise Gate)
  analyserNode: null,    // Analizador de nivel para VAD (Voice Activity Detection)
  dspMode: localStorage.getItem('ridercom_dsp') || 'standard',
  vadInterval: null,
  vadTalking: false,
  ws: null,
  myId: null
};

// Perfiles de supresión de ruido externa y anti-retorno (Estilo Teams / Discord Krisp)
const DSP_PROFILES = {
  aggressive: {
    label: 'Moto / Viento Fuerte',
    threshold: -38, // dB
    highpass: 130,   // Hz (corta escape y viento grave)
    lowpass: 5500,  // Hz (corta silbido de viento)
    ducking: 12     // dB extra de umbral cuando otro habla (anti-retorno de altavoz)
  },
  standard: {
    label: 'Equilibrado',
    threshold: -44, // dB
    highpass: 100,   // Hz
    lowpass: 6500,  // Hz
    ducking: 10     // dB
  },
  sensitive: {
    label: 'Alta Sensibilidad',
    threshold: -50, // dB
    highpass: 80,    // Hz
    lowpass: 7500,  // Hz
    ducking: 8      // dB
  }
};

function applyDspProfile(mode) {
  if (!DSP_PROFILES[mode]) mode = 'standard';
  state.dspMode = mode;
  localStorage.setItem('ridercom_dsp', mode);

  const prof = DSP_PROFILES[mode];
  if (state.audioCtx && state.audioCtx.state !== 'closed') {
    if (state.highpassNode) {
      state.highpassNode.frequency.setValueAtTime(prof.highpass, state.audioCtx.currentTime);
    }
    if (state.lowpassNode) {
      state.lowpassNode.frequency.setValueAtTime(prof.lowpass, state.audioCtx.currentTime);
    }
  }

  const elDspLabel = document.getElementById('dspLabel');
  if (elDspLabel) {
    elDspLabel.textContent = `Supresión DSP: ${prof.label}`;
  }
  const elSelect = document.getElementById('selectNoiseSuppression');
  if (elSelect) {
    elSelect.value = mode;
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

// Init fields
elRoom.textContent = state.room;
elNick.textContent = state.nick;
document.getElementById('inputRoom').value = state.room;
document.getElementById('inputNick').value = state.nick;
document.getElementById('inputServer').value = state.serverUrl;
applyDspProfile(state.dspMode);

// Setup Mic Stream & Web Audio DSP Engine
async function getLocalStream() {
  if (state.localStream && state.localStream.active) {
    const tracks = state.localStream.getAudioTracks();
    if (tracks.length > 0 && tracks[0].readyState === 'live') {
      return state.localStream;
    }
  }

  try {
    // Restricciones de audio de nivel empresarial (Teams / Meet)
    const rawStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 }, // Mono estricto para activar AEC en Android
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        // Flags WebKit / Chrome
        googEchoCancellation: { ideal: true },
        googAutoGainControl: { ideal: true },
        googNoiseSuppression: { ideal: true },
        googHighpassFilter: { ideal: true },
        googTypingNoiseDetection: { ideal: true },
        googAudioMirroring: { ideal: false }
      },
      video: false
    });

    state.rawMicStream = rawStream;

    // Inicializar AudioContext
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!state.audioCtx || state.audioCtx.state === 'closed') {
      state.audioCtx = new AudioCtx({ latencyHint: 'interactive' });
    }
    const ctx = state.audioCtx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    // Desconectar fuente previa si existía
    if (state.dspSource) {
      try { state.dspSource.disconnect(); } catch (e) {}
    }

    const source = ctx.createMediaStreamSource(rawStream);
    state.dspSource = source;

    const prof = DSP_PROFILES[state.dspMode] || DSP_PROFILES.standard;

    // 1. High-Pass Filter: corta vibraciones graves del motor y golpes de viento
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = prof.highpass;
    highpass.Q.value = 0.707;
    state.highpassNode = highpass;

    // 2. Low-Pass Filter: corta silbidos agudos de aire en carretera
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = prof.lowpass;
    lowpass.Q.value = 0.707;
    state.lowpassNode = lowpass;

    // 3. Speech Presence EQ: +3.5dB a 2200Hz para máxima inteligibilidad en casco
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2200;
    presence.Q.value = 1.0;
    presence.gain.value = 3.5;
    state.presenceNode = presence;

    // 4. Dynamics Compressor: nivelación automática de voz
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 12;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;
    state.compressorNode = compressor;

    // 5. Analyser para VAD y medición RMS en tiempo real
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    state.analyserNode = analyser;

    // 6. Noise Gate (Puerta de ruido)
    const gateGain = ctx.createGain();
    gateGain.gain.value = 0.0; // Inicia cerrada
    state.gateGainNode = gateGain;

    // 7. Destino final hacia WebRTC
    const destination = ctx.createMediaStreamDestination();

    // Conexión en cascada
    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(presence);
    presence.connect(compressor);
    compressor.connect(analyser);
    compressor.connect(gateGain);
    gateGain.connect(destination);

    const processedStream = destination.stream;
    processedStream.getAudioTracks().forEach((t) => (t.enabled = false));
    state.localStream = processedStream;

    // Iniciar bucle de monitoreo VAD
    startVadLoop();

    // Vincular track a todos los pares que ya estén conectados
    state.peers.forEach((peer) => {
      if (peer.pc && peer.pc.signalingState !== 'closed') {
        const senders = peer.pc.getSenders();
        processedStream.getAudioTracks().forEach((t) => {
          const alreadyAdded = senders.some((s) => s.track === t);
          if (!alreadyAdded) {
            try {
              peer.pc.addTrack(t, processedStream);
            } catch (e) {}
          }
        });
      }
    });

    if (elUnlockBanner) {
      elUnlockBanner.classList.add('hidden');
    }

    return processedStream;
  } catch (err) {
    console.warn('[Audio] Esperando permiso del micrófono:', err);
    return null;
  }
}

// Bucle Inteligente VAD (Voice Activity Detection) con Anti-Retorno / Ducking
function startVadLoop() {
  if (state.vadInterval) return;

  const dataArray = new Float32Array(512);
  let holdTimer = 0;

  state.vadInterval = setInterval(() => {
    if (!state.analyserNode || !state.gateGainNode || !state.audioCtx) return;

    // Si no estamos transmitiendo en absoluto (mic silenciado): compuerta a 0
    if (!state.isTransmitting) {
      if (state.gateGainNode.gain.value !== 0) {
        state.gateGainNode.gain.setValueAtTime(0, state.audioCtx.currentTime);
      }
      return;
    }

    // Verificar si algún compañero está hablando en este momento
    let someoneElseTalking = false;
    state.peers.forEach((peer) => {
      if (peer.isTalking) someoneElseTalking = true;
    });

    // En PTT manual (botón presionado con el dedo): abrir compuerta directamente
    const isManualPtt = state.isTransmitting && !state.isLocked;
    if (isManualPtt) {
      state.gateGainNode.gain.setTargetAtTime(1.0, state.audioCtx.currentTime, 0.008);
      return;
    }

    // Modo Manos Libres Bloqueado (Locked):
    state.analyserNode.getFloatTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sum / dataArray.length);
    const db = 20 * Math.log10(Math.max(rms, 1e-5));

    const prof = DSP_PROFILES[state.dspMode] || DSP_PROFILES.standard;
    let threshold = prof.threshold;

    // DUCKING ANTI-RETORNO:
    // Si otro compañero está hablando, aumentamos el umbral para evitar que la voz
    // emitida por el altavoz del teléfono vuelva a filtrarse al micrófono.
    if (someoneElseTalking) {
      threshold += prof.ducking;
    }

    if (db > threshold) {
      // Voz real detectada: abrir puerta de ruido suavemente (8ms)
      state.gateGainNode.gain.setTargetAtTime(1.0, state.audioCtx.currentTime, 0.008);
      holdTimer = 250; // Mantener 250ms tras última vocal para no cortar palabras
      if (!state.vadTalking) {
        state.vadTalking = true;
        broadcastTalkState(true);
      }
    } else {
      if (holdTimer > 0) {
        holdTimer -= 30;
      } else {
        // Silencio o ruido exterior: cerrar puerta de ruido suavemente (40ms)
        state.gateGainNode.gain.setTargetAtTime(0.0, state.audioCtx.currentTime, 0.04);
        if (state.vadTalking) {
          state.vadTalking = false;
          broadcastTalkState(false);
        }
      }
    }
  }, 30);
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
// AUDIO ENGINE: PTT 100% WEBRTC P2P EN VIVO
// ==========================================
async function startTalk() {
  const stream = await getLocalStream();
  if (!stream) return;

  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    await state.audioCtx.resume().catch(() => {});
  }

  // Activar tracks de audio WebRTC en tiempo real
  stream.getAudioTracks().forEach((t) => (t.enabled = true));

  state.isTransmitting = true;

  // En PTT manual abrimos la compuerta directamente
  if (!state.isLocked && state.gateGainNode && state.audioCtx) {
    state.gateGainNode.gain.setTargetAtTime(1.0, state.audioCtx.currentTime, 0.008);
  }

  updatePttUI();

  if ('vibrate' in navigator) navigator.vibrate(40);
  broadcastTalkState(true);
}

function stopTalk() {
  // Cerrar puerta de ruido inmediatamente
  if (state.gateGainNode && state.audioCtx) {
    state.gateGainNode.gain.setTargetAtTime(0.0, state.audioCtx.currentTime, 0.03);
  }

  // Silenciar micrófono tras pequeña rampa de 40ms para evitar clicks
  if (state.localStream) {
    setTimeout(() => {
      if (!state.isTransmitting && state.localStream) {
        state.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
      }
    }, 40);
  }

  state.isTransmitting = false;
  state.isLocked = false;
  state.vadTalking = false;
  updatePttUI();

  broadcastTalkState(false);
}

function broadcastTalkState(isTalking) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'TALK_STATE', isTalking }));
  }
}

function updatePttUI() {
  if (state.isTransmitting) {
    elPttBtn.className = `ptt-button ${state.isLocked ? 'locked' : 'active'}`;
    elPttTitle.textContent = state.isLocked ? '🔴 MANOS LIBRES ACTIVO' : '🎙️ TRANSMITIENDO VOZ';
    elPttLabel.textContent = state.isLocked ? 'BLOQUEADO' : 'HABLANDO';
    elMicIcon.textContent = '📢';
    elLockBtn.className = `lock-btn ${state.isLocked ? 'active' : ''}`;
    elLockBtn.textContent = state.isLocked ? '🔓 Liberar Micrófono' : '🔒 Fijar Manos Libres';
  } else {
    elPttBtn.className = 'ptt-button';
    elPttTitle.textContent = '⚪ EN ESPERA';
    elPttLabel.textContent = 'PTT HABLAR';
    elMicIcon.textContent = '🎙️';
    elLockBtn.className = 'lock-btn';
    elLockBtn.textContent = '🔒 Fijar Manos Libres';
  }
}

// PTT Touch & Pointer Events
let lastTap = 0;
elPttBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const now = Date.now();
  if (now - lastTap < 350) {
    state.isLocked = !state.isLocked;
    if (state.isLocked) startTalk(); else stopTalk();
    lastTap = 0;
    return;
  }
  lastTap = now;

  if (!state.isLocked) startTalk();
});

window.addEventListener('pointerup', () => {
  if (!state.isLocked && state.isTransmitting) stopTalk();
});

elLockBtn.addEventListener('click', () => {
  state.isLocked = !state.isLocked;
  if (state.isLocked) startTalk(); else stopTalk();
});

// Settings Modal
document.getElementById('btnSettings').addEventListener('click', () => {
  elModal.classList.remove('hidden');
});

document.getElementById('btnCancelSettings').addEventListener('click', () => {
  elModal.classList.add('hidden');
});

document.getElementById('btnSaveSettings').addEventListener('click', () => {
  state.room = document.getElementById('inputRoom').value.trim().toUpperCase() || 'RUTA-77';
  state.nick = document.getElementById('inputNick').value.trim() || 'Piloto';
  state.serverUrl = document.getElementById('inputServer').value.trim() || state.serverUrl;

  const selectedDsp = document.getElementById('selectNoiseSuppression')?.value;
  if (selectedDsp) {
    applyDspProfile(selectedDsp);
  }

  elRoom.textContent = state.room;
  elNick.textContent = state.nick;
  elModal.classList.add('hidden');

  if (state.ws) state.ws.close();
});

// Start
connect();
