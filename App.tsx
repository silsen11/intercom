import React, { useState, useCallback, useMemo } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Modal
} from 'react-native';

import { IceServer, SignalingMessage } from './src/types';
import { useSignaling } from './src/hooks/useSignaling';
import { useWebRTC } from './src/hooks/useWebRTC';
import { StatusBarComponent } from './src/components/StatusBar';
import { PTTButton } from './src/components/PTTButton';
import { PeerList } from './src/components/PeerList';

// Servidor por defecto (puede ser Termux local o Nube)
const DEFAULT_SERVER_URL = 'ws://localhost:8765';

export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [roomCode, setRoomCode] = useState('RUTA-77');
  const [nickname, setNickname] = useState('Piloto Alfa');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [iceServers, setIceServers] = useState<IceServer[]>([
    { urls: 'stun:stun.l.google.com:19302' }
  ]);

  // Mensajero para WebRTC
  const signalingSenderRef = React.useRef<(msg: any) => void>(() => {});

  const {
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
    removePeer
  } = useWebRTC({
    iceServers,
    sendSignaling: (msg) => signalingSenderRef.current(msg)
  });

  // Manejador de eventos entrantes de señalización
  const handleSignalingMessage = useCallback((msg: SignalingMessage) => {
    switch (msg.type) {
      case 'CONFIG':
        if (msg.iceServers && msg.iceServers.length > 0) {
          setIceServers(msg.iceServers);
        }
        break;

      case 'PEERS':
        // Conectar con cada uno de los pilotos existentes
        msg.peers.forEach((peer) => {
          createPeerConnection(peer.id, peer.nick, true);
        });
        break;

      case 'PEER_JOINED':
        // Nuevo piloto se une a la sala (responderá a nuestra oferta)
        createPeerConnection(msg.id, msg.nick, false);
        break;

      case 'PEER_LEFT':
        removePeer(msg.id);
        break;

      case 'OFFER':
        handleOffer(msg);
        break;

      case 'ANSWER':
        handleAnswer(msg);
        break;

      case 'ICE_CANDIDATE':
        handleIceCandidate(msg);
        break;

      case 'PEER_TALK_STATE':
        setPeerTalking(msg.peerId, msg.isTalking);
        break;
    }
  }, [createPeerConnection, handleOffer, handleAnswer, handleIceCandidate, setPeerTalking, removePeer]);

  // Hook de señalización WebSocket
  const { status, latency, send, reconnect } = useSignaling({
    serverUrl,
    roomCode,
    nickname,
    onMessage: handleSignalingMessage
  });

  // Conectar referencia de envío para WebRTC
  signalingSenderRef.current = send;

  const handleSaveSettings = () => {
    setIsSettingsOpen(false);
    reconnect();
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#080c14" />

      {/* HEADER SUPERIOR */}
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <Text style={styles.logoIcon}>🏍️</Text>
          <View>
            <View style={styles.titleRow}>
              <Text style={styles.brandTitle}>RiderCom</Text>
              <View style={styles.meshBadge}>
                <Text style={styles.meshBadgeText}>MESH PRO</Text>
              </View>
            </View>
            <Text style={styles.brandSubtitle}>Intercomunicador PTT P2P</Text>
          </View>
        </View>

        <TouchableOpacity
          style={styles.settingsBtn}
          onPress={() => setIsSettingsOpen(true)}>
          <Text style={styles.settingsBtnText}>⚙️</Text>
        </TouchableOpacity>
      </View>

      {/* BARRA DE ESTADO / LATENCIA / SALA */}
      <StatusBarComponent
        status={status}
        latency={latency}
        roomCode={roomCode}
        nickname={nickname}
        pilotCount={peers.length}
      />

      {/* BOTÓN CENTRAL PTT (PUSH-TO-TALK) */}
      <PTTButton
        isTransmitting={isTransmitting}
        isLocked={isPttLocked}
        onPressIn={startTransmitting}
        onPressOut={stopTransmitting}
        onToggleLock={togglePttLock}
        disabled={status !== 'connected'}
      />

      {/* LISTA DE PILOTOS CONECTADOS */}
      <PeerList peers={peers} currentNick={nickname} />

      {/* MODAL DE CONFIGURACIÓN (SALA, APODO, SERVIDOR TERMUX/NUBE) */}
      <Modal
        visible={isSettingsOpen}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setIsSettingsOpen(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>⚙️ Configuración de Ruta</Text>

            <Text style={styles.inputLabel}>CÓDIGO DE SALA:</Text>
            <TextInput
              style={styles.input}
              value={roomCode}
              onChangeText={setRoomCode}
              autoCapitalize="characters"
              placeholder="Ej: RUTA-66"
              placeholderTextColor="#475569"
            />

            <Text style={styles.inputLabel}>TU APODO DE PILOTO:</Text>
            <TextInput
              style={styles.input}
              value={nickname}
              onChangeText={setNickname}
              placeholder="Ej: Piloto Alfa"
              placeholderTextColor="#475569"
            />

            <Text style={styles.inputLabel}>SERVIDOR DE SEÑALIZACIÓN:</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              placeholder="ws://192.168.43.1:8765 o wss://..."
              placeholderTextColor="#475569"
            />
            <Text style={styles.helperText}>
              💡 En Termux usa tu IP local (Hotspot) o el enlace de Cloudflare Tunnel.
            </Text>

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setIsSettingsOpen(false)}>
                <Text style={styles.cancelBtnText}>Cancelar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.saveBtn}
                onPress={handleSaveSettings}>
                <Text style={styles.saveBtnText}>Guardar y Conectar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#080c14'
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b'
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  logoIcon: {
    fontSize: 28
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  brandTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0.5
  },
  meshBadge: {
    backgroundColor: '#f59e0b',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4
  },
  meshBadgeText: {
    color: '#080c14',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5
  },
  brandSubtitle: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 2
  },
  settingsBtn: {
    padding: 8,
    backgroundColor: '#1e293b',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155'
  },
  settingsBtnText: {
    fontSize: 18
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    padding: 20
  },
  modalContent: {
    backgroundColor: '#111827',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#1f293d'
  },
  modalTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 16
  },
  inputLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: 'bold',
    marginBottom: 6,
    marginTop: 10
  },
  input: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f8fafc',
    borderWidth: 1,
    borderColor: '#374151',
    fontSize: 14
  },
  helperText: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 6
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 20
  },
  cancelBtn: {
    flex: 1,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#1f2937',
    alignItems: 'center'
  },
  cancelBtnText: {
    color: '#94a3b8',
    fontWeight: 'bold',
    fontSize: 13
  },
  saveBtn: {
    flex: 1.5,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#f59e0b',
    alignItems: 'center'
  },
  saveBtnText: {
    color: '#080c14',
    fontWeight: 'bold',
    fontSize: 13
  }
});
