/**
 * RiderCom Mesh Pro - Web/PWA Client
 * Dual-Engine: WebRTC P2P + WebSocket Audio Relay (100% Conectividad en 4G/5G)
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
    { urls: 'stun:stun.relay.metered.ca:80' }
  ],
  localStream: null,
  ws: null,
  myId: null,
  audioMode: localStorage.getItem('ridercom_audio_mode') || 'p2p'
};

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
const elAudioMode = document.getElementById('displayAudioMode');
const elSelectAudioMode = document.getElementById('selectAudioMode');

function updateAudioModeUI() {
  if (elSelectAudioMode) elSelectAudioMode.value = state.audioMode;
  if (elAudioMode) {
    if (state.audioMode === 'p2p') {
      elAudioMode.textContent = '⚡ P2P';
      elAudioMode.title = 'Modo WebRTC P2P Directo (Tiempo Real - Cero Eco)';
    } else if (state.audioMode === 'relay') {
      elAudioMode.textContent = '🌐 RELAY';
      elAudioMode.title = 'Modo Servidor Relay 4G (Garantizado)';
    } else {
      elAudioMode.textContent = '🔄 AUTO';
      elAudioMode.title = 'Modo Híbrido Inteligente (P2P + Respaldo 4G)';
    }
  }

  // Si se activa modo relay, silenciar audio WebRTC para evitar eco
  state.peers.forEach((peer, id) => {
    const audioEl = document.getElementById(`audio_${id}`);
    if (audioEl) {
      audioEl.muted = (state.audioMode === 'relay');
    }
  });
}

// Init fields
elRoom.textContent = state.room;
elNick.textContent = state.nick;
document.getElementById('inputRoom').value = state.room;
document.getElementById('inputNick').value = state.nick;
document.getElementById('inputServer').value = state.serverUrl;
updateAudioModeUI();

// Setup Mic Stream & Unlock Mobile Audio
async function getLocalStream() {
  if (state.localStream) return state.localStream;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    // PTT mute by default
    stream.getAudioTracks().forEach(t => (t.enabled = false));
    state.localStream = stream;

    // Vincular track a todos los pares que ya estén conectados
    state.peers.forEach((peer) => {
      stream.getAudioTracks().forEach((t) => {
        try {
          peer.pc.addTrack(t, stream);
        } catch (e) {}
      });
    });

    if (elUnlockBanner) {
      elUnlockBanner.classList.add('hidden');
    }

    return stream;
  } catch (err) {
    console.warn('[Audio] Esperando permiso del micrófono:', err);
    return null;
  }
}

async function unlockAudio() {
  try {
    await getLocalStream();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      const ctx = new AudioContextClass();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
    }
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
        handleSignaling(msg);
      } catch (err) {}
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
      if (msg.iceServers) state.iceServers = msg.iceServers;
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

    case 'AUDIO_DATA':
      handleIncomingAudio(msg);
      break;

    case 'PONG':
      elLatency.textContent = `${Math.max(1, Date.now() - msg.ts)} ms`;
      break;
  }
}

// WebRTC P2P con soporte para conexiones externas 4G/WAN
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

  try {
    pc.addTransceiver('audio', { direction: 'sendrecv' });
  } catch (e) {}

  const stream = await getLocalStream();
  if (stream) {
    stream.getAudioTracks().forEach((t) => {
      try {
        pc.addTrack(t, stream);
      } catch (e) {}
    });
  }

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

  pc.ontrack = (e) => {
    let audio = document.getElementById(`audio_${peerId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio_${peerId}`;
      audio.autoplay = true;
      audio.playsInline = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
    }
    audio.muted = (state.audioMode === 'relay');
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removePeer(peerId);
    }
  };

  if (isInitiator) {
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      state.ws.send(JSON.stringify({
        type: 'OFFER',
        targetId: peerId,
        sdp: offer.sdp
      }));
    } catch (err) {}
  }

  return pc;
}

async function handleOffer(msg) {
  const pc = await createPeerConnection(msg.fromId, msg.fromNick, false);
  const peer = state.peers.get(msg.fromId);

  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));

  if (peer && peer.pendingCandidates.length > 0) {
    for (const cand of peer.pendingCandidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {}
    }
    peer.pendingCandidates = [];
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  state.ws.send(JSON.stringify({
    type: 'ANSWER',
    targetId: msg.fromId,
    sdp: answer.sdp
  }));
}

async function handleAnswer(msg) {
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
}

async function handleCandidate(msg) {
  const peer = state.peers.get(msg.fromId);
  if (!peer) return;

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
    } catch (e) {}
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
// AUDIO ENGINE: PTT + TRANSMISSION MODES
// ==========================================
let mediaRecorder = null;
let recordedChunks = [];

async function startTalk() {
  const stream = await getLocalStream();
  if (!stream) return;

  // 1. Activar track WebRTC P2P (si no está en modo solo relay)
  if (state.audioMode !== 'relay') {
    stream.getAudioTracks().forEach((t) => (t.enabled = true));
  } else {
    stream.getAudioTracks().forEach((t) => (t.enabled = false));
  }

  // 2. Iniciar grabadora WebSocket (solo si está en relay o auto)
  if (state.audioMode !== 'p2p') {
    try {
      recordedChunks = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : '');

      mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunks.push(e.data);
        }
      };
      mediaRecorder.start(100);
    } catch (err) {
      console.warn('[PTT] MediaRecorder init error:', err);
    }
  }

  state.isTransmitting = true;
  updatePttUI();

  if ('vibrate' in navigator) navigator.vibrate(40);
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'TALK_STATE', isTalking: true }));
  }
}

function stopTalk() {
  if (state.localStream) {
    state.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
  }

  // Detener grabadora y retransmitir por WebSocket (solo si NO es p2p puro)
  if (state.audioMode !== 'p2p' && mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = () => {
      if (recordedChunks.length > 0) {
        const mimeType = mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(recordedChunks, { type: mimeType });
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64Audio = reader.result.split(',')[1];
          if (state.ws?.readyState === WebSocket.OPEN && base64Audio) {
            state.ws.send(JSON.stringify({
              type: 'AUDIO_DATA',
              audio: base64Audio
            }));
          }
        };
        reader.readAsDataURL(blob);
      }
    };
    try {
      mediaRecorder.stop();
    } catch (e) {}
  }

  state.isTransmitting = false;
  state.isLocked = false;
  updatePttUI();

  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'TALK_STATE', isTalking: false }));
  }
}

// Reproducir audio recibido por WebSocket (según modo configurado)
function handleIncomingAudio(msg) {
  if (msg.fromId === state.myId) return;

  // Si el usuario eligió P2P puro, ignorar cualquier audio duplicado de WebSocket
  if (state.audioMode === 'p2p') {
    return;
  }

  // Si estamos en modo AUTO, descartar si el par ya está conectado vía WebRTC
  if (state.audioMode === 'auto') {
    const peer = state.peers.get(msg.fromId);
    const isP2pConnected = peer && peer.pc && (peer.pc.connectionState === 'connected' || peer.pc.iceConnectionState === 'connected');
    if (isP2pConnected) {
      // Ya se escuchó en vivo por P2P: descartar para evitar eco
      return;
    }
  }

  setPeerTalking(msg.fromId, true);

  try {
    const binaryStr = atob(msg.audio);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'audio/webm' });
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    audio.volume = 1.0;

    const cleanup = () => {
      setPeerTalking(msg.fromId, false);
      URL.revokeObjectURL(audioUrl);
    };

    audio.onended = cleanup;
    audio.onerror = cleanup;

    audio.play().catch((err) => {
      console.warn('[Audio] Autoplay bloqueado. Toca la pantalla para escuchar:', err);
      cleanup();
    });
  } catch (err) {
    console.error('[Audio] Error al reproducir audio entrante:', err);
    setPeerTalking(msg.fromId, false);
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

  if (elSelectAudioMode) {
    state.audioMode = elSelectAudioMode.value || 'p2p';
    localStorage.setItem('ridercom_audio_mode', state.audioMode);
    updateAudioModeUI();
  }

  elRoom.textContent = state.room;
  elNick.textContent = state.nick;
  elModal.classList.add('hidden');

  if (state.ws) state.ws.close();
});

// Start
connect();
