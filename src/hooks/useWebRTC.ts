/**
 * Hook useWebRTC - Manejo de conexiones de audio P2P y Push-To-Talk
 * Compatible con WebRTC nativo (react-native-webrtc / Web)
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Peer, IceServer } from '../types';

interface UseWebRTCOptions {
  iceServers: IceServer[];
  sendSignaling: (msg: any) => void;
  webrtcLib?: any; // Para inyectar react-native-webrtc en RN o window en web
}

export function useWebRTC({
  iceServers,
  sendSignaling,
  webrtcLib
}: UseWebRTCOptions) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [isPttLocked, setIsPttLocked] = useState(false);

  const localStreamRef = useRef<any>(null);
  const peersRef = useRef<Map<string, { id: string; nick: string; pc: any; isTalking?: boolean }>>(new Map());

  // Resolver WebRTC según la plataforma (React Native o Web)
  const getRTC = useCallback(() => {
    if (webrtcLib) return webrtcLib;
    if (typeof window !== 'undefined' && (window as any).RTCPeerConnection) {
      return {
        RTCPeerConnection: (window as any).RTCPeerConnection,
        RTCSessionDescription: (window as any).RTCSessionDescription,
        RTCIceCandidate: (window as any).RTCIceCandidate,
        mediaDevices: (navigator as any).mediaDevices
      };
    }
    return null;
  }, [webrtcLib]);

  const updatePeersState = useCallback(() => {
    const list: Peer[] = [];
    peersRef.current.forEach(item => {
      list.push({
        id: item.id,
        nick: item.nick,
        isTalking: item.isTalking
      });
    });
    setPeers(list);
  }, []);

  // Inicializar o recuperar stream del micrófono local
  const getLocalStream = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;

    const rtc = getRTC();
    if (!rtc || !rtc.mediaDevices?.getUserMedia) {
      console.warn('[WebRTC] mediaDevices.getUserMedia no está disponible');
      return null;
    }

    try {
      const stream = await rtc.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 24000,
          channelCount: 1
        },
        video: false
      });

      // PTT: Por defecto el audio está silenciado hasta presionar el botón
      stream.getAudioTracks().forEach((track: any) => {
        track.enabled = false;
      });

      localStreamRef.current = stream;
      return stream;
    } catch (err) {
      console.error('[WebRTC] Error accediendo al micrófono:', err);
      return null;
    }
  }, [getRTC]);

  // Crear o reutilizar conexión Peer
  const createPeerConnection = useCallback(async (
    peerId: string,
    peerNick: string,
    isInitiator: boolean
  ) => {
    if (peersRef.current.has(peerId)) {
      return peersRef.current.get(peerId)?.pc;
    }

    const rtc = getRTC();
    if (!rtc) return null;

    const pc = new rtc.RTCPeerConnection({
      iceServers: iceServers.length > 0 ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    peersRef.current.set(peerId, {
      id: peerId,
      nick: peerNick,
      pc,
      isTalking: false
    });
    updatePeersState();

    // Añadir tracks de audio local a la conexión
    const localStream = await getLocalStream();
    if (localStream) {
      localStream.getTracks().forEach((track: any) => {
        pc.addTrack(track, localStream);
      });
    }

    // Manejar candidatos ICE
    pc.onicecandidate = (event: any) => {
      if (event.candidate) {
        sendSignaling({
          type: 'ICE_CANDIDATE',
          targetId: peerId,
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex
        });
      }
    };

    // Reproducir audio entrante del compañero
    pc.ontrack = (event: any) => {
      const remoteStream = event.streams && event.streams[0];
      if (remoteStream && typeof Audio !== 'undefined') {
        const audioEl = new Audio();
        audioEl.srcObject = remoteStream;
        audioEl.play().catch(e => console.warn('[WebRTC] Auto-play audio bloqueado:', e));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        removePeer(peerId);
      }
    };

    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignaling({
          type: 'OFFER',
          targetId: peerId,
          sdp: offer.sdp
        });
      } catch (err) {
        console.error('[WebRTC] Error creando Offer:', err);
      }
    }

    return pc;
  }, [getRTC, iceServers, getLocalStream, sendSignaling, updatePeersState]);

  const handleOffer = useCallback(async (msg: any) => {
    const rtc = getRTC();
    if (!rtc) return;

    const pc = await createPeerConnection(msg.fromId, msg.fromNick, false);
    if (!pc) return;

    await pc.setRemoteDescription(new rtc.RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sendSignaling({
      type: 'ANSWER',
      targetId: msg.fromId,
      sdp: answer.sdp
    });
  }, [getRTC, createPeerConnection, sendSignaling]);

  const handleAnswer = useCallback(async (msg: any) => {
    const rtc = getRTC();
    if (!rtc) return;

    const peer = peersRef.current.get(msg.fromId);
    if (peer && peer.pc) {
      await peer.pc.setRemoteDescription(new rtc.RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
    }
  }, [getRTC]);

  const handleIceCandidate = useCallback(async (msg: any) => {
    const rtc = getRTC();
    if (!rtc) return;

    const peer = peersRef.current.get(msg.fromId);
    if (peer && peer.pc) {
      try {
        await peer.pc.addIceCandidate(new rtc.RTCIceCandidate({
          candidate: msg.candidate,
          sdpMid: msg.sdpMid,
          sdpMLineIndex: msg.sdpMLineIndex
        }));
      } catch (e) {
        console.warn('[WebRTC] Error agregando ICE Candidate:', e);
      }
    }
  }, [getRTC]);

  const setPeerTalking = useCallback((peerId: string, isTalking: boolean) => {
    const peer = peersRef.current.get(peerId);
    if (peer) {
      peer.isTalking = isTalking;
      updatePeersState();
    }
  }, [updatePeersState]);

  const removePeer = useCallback((peerId: string) => {
    const peer = peersRef.current.get(peerId);
    if (peer) {
      try {
        peer.pc.close();
      } catch (e) {}
      peersRef.current.delete(peerId);
      updatePeersState();
    }
  }, [updatePeersState]);

  const cleanupAllPeers = useCallback(() => {
    peersRef.current.forEach(item => {
      try {
        item.pc.close();
      } catch (e) {}
    });
    peersRef.current.clear();
    updatePeersState();
  }, [updatePeersState]);

  // Transmitir voz (Push-To-Talk)
  const startTransmitting = useCallback(async () => {
    const stream = await getLocalStream();
    if (stream) {
      stream.getAudioTracks().forEach((track: any) => {
        track.enabled = true;
      });
    }

    setIsTransmitting(true);
    sendSignaling({ type: 'TALK_STATE', isTalking: true });
  }, [getLocalStream, sendSignaling]);

  const stopTransmitting = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track: any) => {
        track.enabled = false;
      });
    }

    setIsTransmitting(false);
    setIsPttLocked(false);
    sendSignaling({ type: 'TALK_STATE', isTalking: false });
  }, [sendSignaling]);

  const togglePttLock = useCallback(() => {
    if (isPttLocked) {
      stopTransmitting();
    } else {
      setIsPttLocked(true);
      startTransmitting();
    }
  }, [isPttLocked, startTransmitting, stopTransmitting]);

  useEffect(() => {
    return () => {
      cleanupAllPeers();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t: any) => t.stop());
        localStreamRef.current = null;
      }
    };
  }, [cleanupAllPeers]);

  return {
    peers,
    isTransmitting,
    isPttLocked,
    startTransmitting,
    stopTransmitting,
    togglePttLock,
    createPeerConnection,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    setPeerTalking,
    removePeer,
    cleanupAllPeers
  };
}
