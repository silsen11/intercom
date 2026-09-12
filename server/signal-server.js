/**
 * RiderCom Mesh Pro - Signaling Server
 * Optimized for Termux & Cloud Deployments (Render, Railway, Fly.io)
 * WebRTC P2P Signaling + STUN/TURN fallback
 */

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8765;

// STUN and free TURN servers for 4G/5G mobile NAT traversal
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
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
];

// Room state: roomId -> Map<ws, { id: string, nick: string, isTalking: boolean, lastPing: number }>
const rooms = new Map();
// Client reverse lookup: ws -> { roomId: string, id: string, nick: string }
const clients = new Map();

// HTTP server for health-checks, status, and ping
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.url === '/health' || req.url === '/status') {
    let totalClients = 0;
    const roomSummaries = [];

    rooms.forEach((room, roomId) => {
      totalClients += room.size;
      roomSummaries.push({
        room: roomId,
        pilots: room.size
      });
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'RiderCom Mesh Signaling Server',
      uptime: Math.round(process.uptime()),
      totalPilots: totalClients,
      activeRooms: rooms.size,
      rooms: roomSummaries,
      timestamp: Date.now()
    }, null, 2));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('🏍️ RiderCom Mesh Pro - Servidor de Señalización Activo');
});

// WebSocket Server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientId = 'pilot_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  console.log(`[+] Conexión establecida: ${clientId} (${clientIp})`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(ws, msg, clientId);
    } catch (err) {
      console.error(`[!] Error parseando mensaje de ${clientId}:`, err.message);
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', (err) => {
    console.error(`[!] Error en cliente ${clientId}:`, err.message);
    handleDisconnect(ws);
  });
});

function handleMessage(ws, msg, clientId) {
  switch (msg.type) {
    case 'JOIN':
      handleJoin(ws, msg, clientId);
      break;

    case 'OFFER':
    case 'ANSWER':
    case 'ICE_CANDIDATE':
      relayMessage(ws, msg);
      break;

    case 'TALK_STATE':
      handleTalkState(ws, msg);
      break;

    case 'PING':
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'PONG', ts: msg.ts, serverTime: Date.now() }));
      }
      break;

    default:
      console.warn(`[?] Tipo de mensaje desconocido: ${msg.type}`);
  }
}

function handleJoin(ws, msg, clientId) {
  const roomId = (msg.room || 'RUTA-DEFAULT').trim().toUpperCase();
  const nick = (msg.nick || `Piloto_${clientId.slice(-4)}`).trim();

  // If client was already in a room, leave it first
  if (clients.has(ws)) {
    handleDisconnect(ws);
  }

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }

  const room = rooms.get(roomId);
  const clientInfo = {
    id: clientId,
    nick,
    isTalking: false,
    joinedAt: Date.now()
  };

  clients.set(ws, { roomId, id: clientId, nick });
  room.set(ws, clientInfo);

  // Send config & ICE servers to the joining client
  ws.send(JSON.stringify({
    type: 'CONFIG',
    clientId,
    roomId,
    nick,
    iceServers: ICE_SERVERS
  }));

  // Collect existing peers
  const existingPeers = [];
  room.forEach((info, peerWs) => {
    if (peerWs !== ws && peerWs.readyState === WebSocket.OPEN) {
      existingPeers.push({
        id: info.id,
        nick: info.nick,
        isTalking: info.isTalking
      });

      // Notify existing peer about the new rider
      peerWs.send(JSON.stringify({
        type: 'PEER_JOINED',
        id: clientId,
        nick
      }));
    }
  });

  // Send the list of existing peers to the newcomer
  ws.send(JSON.stringify({
    type: 'PEERS',
    peers: existingPeers,
    you: { id: clientId, nick, room: roomId }
  }));

  console.log(`[✓] ${nick} (${clientId}) se unió a sala '${roomId}' (${room.size} conectados)`);
}

function relayMessage(ws, msg) {
  const sender = clients.get(ws);
  if (!sender) return;

  const room = rooms.get(sender.roomId);
  if (!room) return;

  const targetId = msg.targetId;
  let targetWs = null;

  room.forEach((info, peerWs) => {
    if (info.id === targetId) {
      targetWs = peerWs;
    }
  });

  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify({
      ...msg,
      fromId: sender.id,
      fromNick: sender.nick
    }));
  }
}

function handleTalkState(ws, msg) {
  const sender = clients.get(ws);
  if (!sender) return;

  const room = rooms.get(sender.roomId);
  if (!room) return;

  const clientInfo = room.get(ws);
  if (clientInfo) {
    clientInfo.isTalking = Boolean(msg.isTalking);
  }

  // Broadcast talk state to all other peers in the room
  room.forEach((info, peerWs) => {
    if (peerWs !== ws && peerWs.readyState === WebSocket.OPEN) {
      peerWs.send(JSON.stringify({
        type: 'PEER_TALK_STATE',
        peerId: sender.id,
        isTalking: Boolean(msg.isTalking)
      }));
    }
  });
}

function handleDisconnect(ws) {
  const client = clients.get(ws);
  if (!client) return;

  const { roomId, id, nick } = client;
  clients.delete(ws);

  const room = rooms.get(roomId);
  if (room) {
    room.delete(ws);

    // Notify peers that this rider left
    room.forEach((info, peerWs) => {
      if (peerWs.readyState === WebSocket.OPEN) {
        peerWs.send(JSON.stringify({
          type: 'PEER_LEFT',
          id,
          nick
        }));
      }
    });

    if (room.size === 0) {
      rooms.delete(roomId);
      console.log(`[i] Sala vacía eliminada: '${roomId}'`);
    }
  }

  console.log(`[-] ${nick} (${id}) desconectado`);
}

// Liveness heartbeat to clean up silently dropped mobile connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  });
}, 30000);
if (heartbeatInterval.unref) {
  heartbeatInterval.unref();
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('============================================================');
  console.log(' 🏍️  RIDERCOM MESH PRO - SERVIDOR DE SEÑALIZACIÓN INICIADO');
  console.log('============================================================');
  console.log(` ► Puerto: ${PORT}`);
  console.log(` ► Estado HTTP: http://localhost:${PORT}/health`);
  console.log(` ► WebRTC P2P con STUN/TURN integrado`);
  console.log(` ► Modo Termux / Nube (Render, Railway, Fly.io)`);
  console.log('============================================================');
});

module.exports = { server, wss, rooms, clients };
