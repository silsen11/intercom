import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ConnectionStatus } from '../types';

interface StatusBarProps {
  status: ConnectionStatus;
  latency: number | null;
  roomCode: string;
  nickname: string;
  pilotCount: number;
}

export const StatusBarComponent: React.FC<StatusBarProps> = ({
  status,
  latency,
  roomCode,
  nickname,
  pilotCount
}) => {
  const getStatusColor = () => {
    switch (status) {
      case 'connected':
        return '#10b981';
      case 'connecting':
      case 'reconnecting':
        return '#f59e0b';
      default:
        return '#ef4444';
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'connected':
        return 'EN LÍNEA';
      case 'connecting':
        return 'CONECTANDO...';
      case 'reconnecting':
        return 'RECONECTANDO...';
      default:
        return 'DESCONECTADO';
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <View style={styles.pill}>
          <Text style={styles.pillLabel}>SALA</Text>
          <Text style={styles.pillValue}>{roomCode}</Text>
        </View>

        <View style={styles.statusIndicator}>
          <View style={[styles.dot, { backgroundColor: getStatusColor() }]} />
          <Text style={[styles.statusText, { color: getStatusColor() }]}>
            {getStatusText()}
          </Text>
        </View>

        <View style={styles.pill}>
          <Text style={styles.pillLabel}>LATENCIA</Text>
          <Text style={styles.pillValue}>{latency ? `${latency} ms` : '--'}</Text>
        </View>
      </View>

      <View style={styles.bottomRow}>
        <Text style={styles.nickText}>
          Piloto: <Text style={styles.nickHighlight}>{nickname}</Text>
        </Text>
        <Text style={styles.pilotsText}>
          👥 {pilotCount} en ruta
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#111827',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1f293d'
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8
  },
  pill: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#374151',
    alignItems: 'center'
  },
  pillLabel: {
    color: '#64748b',
    fontSize: 9,
    fontWeight: 'bold',
    letterSpacing: 0.5
  },
  pillValue: {
    color: '#f59e0b',
    fontSize: 13,
    fontWeight: 'bold',
    fontFamily: 'monospace'
  },
  statusIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  statusText: {
    fontSize: 11,
    fontWeight: 'bold',
    letterSpacing: 1
  },
  nickText: {
    color: '#94a3b8',
    fontSize: 12
  },
  nickHighlight: {
    color: '#f8fafc',
    fontWeight: 'bold'
  },
  pilotsText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: 'bold'
  }
});
