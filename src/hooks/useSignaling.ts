/**
 * Hook de Señalización Resiliente con Auto-Reconexión (Tolerante a caídas 4G/5G en ruta)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { ConnectionStatus, SignalingMessage } from '../types';

interface UseSignalingOptions {
  serverUrl: string;
  roomCode: string;
  nickname: string;
  onMessage: (msg: SignalingMessage) => void;
}

export function useSignaling({
  serverUrl,
  roomCode,
  nickname,
  onMessage
}: UseSignalingOptions) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [latency, setLatency] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<any>(null);
  const pingIntervalRef = useRef<any>(null);
  const isUnmountedRef = useRef(false);

  const send = useCallback((msg: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  const clearTimers = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  };

  const scheduleReconnect = useCallback(() => {
    if (isUnmountedRef.current || reconnectTimeoutRef.current) return;

    setStatus('reconnecting');
    // Exponential backoff: 1s, 2s, 4s, up to 10s max
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttemptsRef.current), 10000);
    reconnectAttemptsRef.current += 1;

    console.log(`[Signaling] Reconectando en ${Math.round(delay / 1000)}s (intento ${reconnectAttemptsRef.current})...`);

    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectTimeoutRef.current = null;
      connect();
    }, delay);
  }, []);

  const startPingLoop = (ws: WebSocket) => {
    if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);

    pingIntervalRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'PING', ts: Date.now() }));
      }
    }, 5000);
  };

  const connect = useCallback(() => {
    if (isUnmountedRef.current) return;
    clearTimers();

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
    }

    try {
      setStatus('connecting');
      const ws = new WebSocket(serverUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (isUnmountedRef.current) return;
        setStatus('connected');
        reconnectAttemptsRef.current = 0;

        // Unirse a la sala con apodo
        ws.send(JSON.stringify({
          type: 'JOIN',
          room: roomCode.trim().toUpperCase(),
          nick: nickname.trim()
        }));

        startPingLoop(ws);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data.toString()) as SignalingMessage;

          if (msg.type === 'PONG') {
            const rtt = Math.max(1, Date.now() - msg.ts);
            setLatency(rtt);
            return;
          }

          onMessage(msg);
        } catch (err) {
          console.error('[Signaling] Error procesando mensaje:', err);
        }
      };

      ws.onerror = (err) => {
        console.warn('[Signaling] Error en conexión WebSocket:', err);
      };

      ws.onclose = () => {
        if (isUnmountedRef.current) return;
        setStatus('disconnected');
        scheduleReconnect();
      };
    } catch (err) {
      console.error('[Signaling] Excepción al conectar:', err);
      scheduleReconnect();
    }
  }, [serverUrl, roomCode, nickname, onMessage, scheduleReconnect]);

  useEffect(() => {
    isUnmountedRef.current = false;
    connect();

    return () => {
      isUnmountedRef.current = true;
      clearTimers();
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch (e) {}
        wsRef.current = null;
      }
    };
  }, [connect]);

  return {
    status,
    latency,
    send,
    reconnect: connect
  };
}
