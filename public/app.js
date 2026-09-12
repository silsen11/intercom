/**
 * RiderCom Mesh Pro - Web/PWA Client
 * Push-To-Talk + WebRTC P2P
 */

const state = {
  room: 'RUTA-77',
  nick: 'Piloto_' + Math.floor(1000 + Math.random() * 9000),
  serverUrl: '',
  isTransmitting: false,
  isLocked: false,
  peers: new Map(), // peerId -> { id, nick, pc, isTalking }
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  localStream: null,
  ws: null,
  myId: null
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

// Init fields
elRoom.textContent = state.room;
elNick.textContent = state.nick;
document.getElementById('inputRoom').value = state.room;
document.getElementById('inputNick').value = state.nick;
document.getElementById('inputServer').value = state.serverUrl;

// Setup Mic Stream
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
    stream.getAudioTracks().forEach(t => t.enabled = false);
    state.localStream = stream;
    return stream;
  } catch (err) {
    alert('Permiso de micrófono requerido para hablar en el intercomunicador.');
    return null;
  }
}

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

// Signaling Handler
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

    case 'PONG':
      elLatency.textContent = `${Math.max(1, Date.now() - msg.ts)} ms`;
      break;
  }
}

// WebRTC P2P
async function createPeerConnection(peerId, nick, isInitiator) {
  if (state.peers.has(peerId)) return state.peers.get(peerId).pc;

  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  state.peers.set(peerId, { id: peerId, nick, pc, isTalking: false });
  renderPeers();

  const stream = await getLocalStream();
  if (stream) {
    stream.getAudioTracks().forEach(t => pc.addTrack(t, stream));
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
    const audio = new Audio();
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {});
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.ws.send(JSON.stringify({
      type: 'OFFER',
      targetId: peerId,
      sdp: offer.sdp
    }));
  }

  return pc;
}

async function handleOffer(msg) {
  const pc = await createPeerConnection(msg.fromId, msg.fromNick, false);
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
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
  if (peer) {
    await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
  }
}

async function handleCandidate(msg) {
  const peer = state.peers.get(msg.fromId);
  if (peer) {
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate({
        candidate: msg.candidate,
        sdpMid: msg.sdpMid,
        sdpMLineIndex: msg.sdpMLineIndex
      }));
    } catch (e) {}
  }
}

function removePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (peer) {
    peer.pc.close();
    state.peers.delete(peerId);
    renderPeers();
  }
}

function cleanupPeers() {
  state.peers.forEach(p => p.pc.close());
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

  state.peers.forEach(peer => {
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

// PTT Handling
async function startTalk() {
  const stream = await getLocalStream();
  if (stream) {
    stream.getAudioTracks().forEach(t => t.enabled = true);
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
    state.localStream.getAudioTracks().forEach(t => t.enabled = false);
  }
  state.isTransmitting = false;
  state.isLocked = false;
  updatePttUI();

  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'TALK_STATE', isTalking: false }));
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

// PTT Touch & Mouse Events
let lastTap = 0;
elPttBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const now = Date.now();
  if (now - lastTap < 350) {
    // Doble toque = fijar manos libres
    state.isLocked = !state.isLocked;
    if (state.isLocked) startTalk(); else stopTalk();
    lastTap = 0;
    return;
  }
  lastTap = now;

  if (!state.isLocked) startTalk();
});

window.addEventListener('pointerup', () => {
  if (!state.isLocked) stopTalk();
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

  elRoom.textContent = state.room;
  elNick.textContent = state.nick;
  elModal.classList.add('hidden');

  if (state.ws) state.ws.close();
});

// Start
connect();
