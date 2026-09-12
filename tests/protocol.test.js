const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');

// Importar servidor
const { server, wss, rooms } = require('../server/signal-server');

test('Servidor de Señalización - Endpoint /health', async (t) => {
  const address = server.address();
  const port = address ? address.port : 8765;

  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, (res) => {
      assert.strictEqual(res.statusCode, 200);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const json = JSON.parse(data);
        assert.strictEqual(json.status, 'ok');
        assert.strictEqual(json.service, 'RiderCom Mesh Signaling Server');
        resolve();
      });
    }).on('error', reject);
  });
});

test('Servidor de Señalización - Flujo WebSocket JOIN y PING/PONG', async (t) => {
  const address = server.address();
  const port = address ? address.port : 8765;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      // 1. Enviar JOIN a sala de prueba
      ws.send(JSON.stringify({
        type: 'JOIN',
        room: 'TEST-ROOM-101',
        nick: 'PilotoTest'
      }));
    });

    let configReceived = false;
    let peersReceived = false;

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'CONFIG') {
        configReceived = true;
        assert.strictEqual(msg.roomId, 'TEST-ROOM-101');
        assert.strictEqual(msg.nick, 'PilotoTest');
        assert.ok(Array.isArray(msg.iceServers));

        // Enviar PING
        ws.send(JSON.stringify({ type: 'PING', ts: Date.now() }));
      }

      if (msg.type === 'PEERS') {
        peersReceived = true;
        assert.ok(Array.isArray(msg.peers));
      }

      if (msg.type === 'PONG') {
        assert.ok(configReceived);
        assert.ok(peersReceived);
        ws.close();
        resolve();
      }
    });

    ws.on('error', reject);
  });
});

test.after(() => {
  server.close();
  wss.close();
});
