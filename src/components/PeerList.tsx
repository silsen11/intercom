import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Peer } from '../types';

interface PeerListProps {
  peers: Peer[];
  currentNick: string;
}

export const PeerList: React.FC<PeerListProps> = ({ peers, currentNick }) => {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>🏍️ PILOTOS EN SALA</Text>
        <Text style={styles.counter}>{peers.length + 1} en total</Text>
      </View>

      <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
        {/* Usuario actual */}
        <View style={[styles.item, styles.itemMe]}>
          <View style={styles.itemLeft}>
            <Text style={styles.avatar}>👑</Text>
            <View>
              <Text style={styles.name}>{currentNick} (Tú)</Text>
              <Text style={styles.subtext}>Transmisor local</Text>
            </View>
          </View>
          <View style={styles.statusBadge}>
            <Text style={styles.statusText}>● Activo</Text>
          </View>
        </View>

        {/* Lista de compañeros */}
        {peers.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>📡</Text>
            <Text style={styles.emptyTitle}>Esperando compañeros de ruta</Text>
            <Text style={styles.emptySubtitle}>
              Comparte el código de la sala para que otros pilotos se unan
            </Text>
          </View>
        ) : (
          peers.map((peer) => (
            <View
              key={peer.id}
              style={[styles.item, peer.isTalking && styles.itemTalking]}>
              <View style={styles.itemLeft}>
                <Text style={styles.avatar}>
                  {peer.isTalking ? '📢' : '👤'}
                </Text>
                <View>
                  <Text style={[styles.name, peer.isTalking && styles.nameTalking]}>
                    {peer.nick}
                  </Text>
                  <Text style={styles.subtext}>
                    {peer.isTalking ? 'Hablando ahora...' : 'En escucha'}
                  </Text>
                </View>
              </View>

              <View
                style={[
                  styles.statusBadge,
                  peer.isTalking && styles.statusBadgeTalking
                ]}>
                <Text
                  style={[
                    styles.statusText,
                    peer.isTalking && styles.statusTextTalking
                  ]}>
                  {peer.isTalking ? '🔊 HABLANDO' : '● Conectado'}
                </Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b1120',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
    borderWidth: 1,
    borderColor: '#1f293d'
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12
  },
  headerTitle: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: 'bold',
    letterSpacing: 1
  },
  counter: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: 'bold'
  },
  list: {
    flex: 1
  },
  item: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#111827',
    padding: 12,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1f293d'
  },
  itemMe: {
    borderColor: '#374151',
    backgroundColor: '#131d33'
  },
  itemTalking: {
    borderColor: '#10b981',
    backgroundColor: '#064e3b'
  },
  itemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  avatar: {
    fontSize: 20
  },
  name: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: 'bold'
  },
  nameTalking: {
    color: '#34d399'
  },
  subtext: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 2
  },
  statusBadge: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6
  },
  statusBadgeTalking: {
    backgroundColor: '#10b981'
  },
  statusText: {
    color: '#10b981',
    fontSize: 10,
    fontWeight: 'bold'
  },
  statusTextTalking: {
    color: '#022c22'
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 28,
    paddingHorizontal: 16
  },
  emptyIcon: {
    fontSize: 32,
    marginBottom: 8
  },
  emptyTitle: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 4
  },
  emptySubtitle: {
    color: '#64748b',
    fontSize: 12,
    textAlign: 'center'
  }
});
