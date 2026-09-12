import React, { useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Vibration
} from 'react-native';

const { width } = Dimensions.get('window');
const BUTTON_SIZE = Math.min(Math.max(width * 0.55, 200), 260);

interface PTTButtonProps {
  isTransmitting: boolean;
  isLocked: boolean;
  onPressIn: () => void;
  onPressOut: () => void;
  onToggleLock: () => void;
  disabled?: boolean;
}

export const PTTButton: React.FC<PTTButtonProps> = ({
  isTransmitting,
  isLocked,
  onPressIn,
  onPressOut,
  onToggleLock,
  disabled = false
}) => {
  const lastTapRef = useRef(0);

  const handlePressIn = () => {
    if (disabled) return;

    try {
      Vibration.vibrate(50);
    } catch (e) {}

    const now = Date.now();
    // Doble toque rápido activa el bloqueo de manos libres
    if (now - lastTapRef.current < 350) {
      onToggleLock();
      lastTapRef.current = 0;
      return;
    }
    lastTapRef.current = now;

    if (!isLocked) {
      onPressIn();
    }
  };

  const handlePressOut = () => {
    if (disabled || isLocked) return;
    onPressOut();
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        {isTransmitting
          ? isLocked
            ? '🔴 MANOS LIBRES ACTIVO'
            : '🎙️ TRANSMITIENDO VOZ'
          : '⚪ EN ESPERA'}
      </Text>

      <Text style={styles.instruction}>
        {isLocked
          ? 'Toca dos veces para apagar el micrófono'
          : 'Mantén presionado para hablar (doble toque = fijar)'}
      </Text>

      <TouchableOpacity
        activeOpacity={0.85}
        disabled={disabled}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[
          styles.button,
          isTransmitting && styles.buttonActive,
          isLocked && styles.buttonLocked,
          disabled && styles.buttonDisabled
        ]}>
        <View
          style={[
            styles.innerCircle,
            isTransmitting && styles.innerCircleActive,
            isLocked && styles.innerCircleLocked
          ]}>
          <Text style={styles.micIcon}>
            {isTransmitting ? '📢' : '🎙️'}
          </Text>
        </View>

        <Text
          style={[
            styles.buttonLabel,
            isTransmitting && styles.buttonLabelActive
          ]}>
          {disabled
            ? 'DESCONECTADO'
            : isLocked
            ? 'BLOQUEADO'
            : isTransmitting
            ? 'HABLANDO'
            : 'PTT HABLAR'}
        </Text>
      </TouchableOpacity>

      {/* Botón secundario para fijar/desfijar manos libres */}
      <TouchableOpacity
        style={[styles.lockButton, isLocked && styles.lockButtonActive]}
        onPress={onToggleLock}
        disabled={disabled}>
        <Text style={[styles.lockButtonText, isLocked && styles.lockButtonTextActive]}>
          {isLocked ? '🔓 Liberar Micrófono' : '🔒 Fijar Manos Libres'}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24
  },
  title: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 1.5,
    marginBottom: 6
  },
  instruction: {
    color: '#64748b',
    fontSize: 11,
    textAlign: 'center',
    marginBottom: 20
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    backgroundColor: '#0f172a',
    borderWidth: 8,
    borderColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 15,
    elevation: 10
  },
  buttonActive: {
    backgroundColor: '#dc2626',
    borderColor: '#f87171',
    transform: [{ scale: 1.04 }]
  },
  buttonLocked: {
    backgroundColor: '#d97706',
    borderColor: '#fcd34d'
  },
  buttonDisabled: {
    opacity: 0.4,
    borderColor: '#1e293b'
  },
  innerCircle: {
    width: BUTTON_SIZE * 0.38,
    height: BUTTON_SIZE * 0.38,
    borderRadius: (BUTTON_SIZE * 0.38) / 2,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10
  },
  innerCircleActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.25)'
  },
  innerCircleLocked: {
    backgroundColor: 'rgba(255, 255, 255, 0.3)'
  },
  micIcon: {
    fontSize: 34
  },
  buttonLabel: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 2
  },
  buttonLabelActive: {
    color: '#ffffff'
  },
  lockButton: {
    marginTop: 18,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#1e293b',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#334155'
  },
  lockButtonActive: {
    backgroundColor: '#f59e0b',
    borderColor: '#fcd34d'
  },
  lockButtonText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: 'bold'
  },
  lockButtonTextActive: {
    color: '#0f172a'
  }
});
