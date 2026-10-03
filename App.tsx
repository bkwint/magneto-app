import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  PermissionsAndroid,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { BleManager, Device, State, Subscription } from 'react-native-ble-plx';
import { decode } from 'base-64';

// Must match the UUIDs in the Arduino sketch
const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

// Single manager instance for the whole app
const manager = new BleManager();

type Status = 'idle' | 'scanning' | 'connecting' | 'connected';

async function requestPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  if (Platform.Version >= 31) {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(result).every(
      (r) => r === PermissionsAndroid.RESULTS.GRANTED
    );
  }

  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

// The ESP32 sends the value as ASCII text (e.g. "12.34"); ble-plx hands it over as base64
function parseValue(base64: string | null): number | null {
  if (!base64) return null;
  try {
    const n = parseFloat(decode(base64));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [devices, setDevices] = useState<Device[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [connected, setConnected] = useState<Device | null>(null);
  const [value, setValue] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const monitorSub = useRef<Subscription | null>(null);
  const disconnectSub = useRef<Subscription | null>(null);

  const stopScan = useCallback(() => {
    manager.stopDeviceScan();
    setStatus((s) => (s === 'scanning' ? 'idle' : s));
  }, []);

  const startScan = useCallback(async () => {
    setError(null);
    setDevices([]);

    if (!(await requestPermissions())) {
      setError('Bluetooth permissions were denied.');
      return;
    }

    const state = await manager.state();
    if (state !== State.PoweredOn) {
      setError('Bluetooth is turned off. Please enable it and try again.');
      return;
    }

    setStatus('scanning');
    manager.startDeviceScan(
      showAll ? null : [SERVICE_UUID],
      { allowDuplicates: false },
      (err, device) => {
        if (err) {
          setError(err.message);
          setStatus('idle');
          return;
        }
        if (!device) return;
        setDevices((prev) =>
          prev.some((d) => d.id === device.id) ? prev : [...prev, device]
        );
      }
    );

    // Auto-stop after 15 seconds to save battery
    setTimeout(() => {
      manager.stopDeviceScan();
      setStatus((s) => (s === 'scanning' ? 'idle' : s));
    }, 15000);
  }, [showAll]);

  const cleanupConnection = useCallback(() => {
    monitorSub.current?.remove();
    monitorSub.current = null;
    disconnectSub.current?.remove();
    disconnectSub.current = null;
  }, []);

  const connect = useCallback(
    async (device: Device) => {
      manager.stopDeviceScan();
      setError(null);
      setStatus('connecting');

      try {
        const d = await manager.connectToDevice(device.id, { timeout: 10000 });
        await d.discoverAllServicesAndCharacteristics();

        disconnectSub.current = d.onDisconnected(() => {
          cleanupConnection();
          setConnected(null);
          setValue(null);
          setUpdatedAt(null);
          setStatus('idle');
          setError('Device disconnected.');
        });

        // Initial read so something shows immediately
        const initial = await d.readCharacteristicForService(
          SERVICE_UUID,
          CHARACTERISTIC_UUID
        );
        const v0 = parseValue(initial.value);
        if (v0 !== null) {
          setValue(v0);
          setUpdatedAt(new Date());
        }

        // Live updates via notifications
        monitorSub.current = d.monitorCharacteristicForService(
          SERVICE_UUID,
          CHARACTERISTIC_UUID,
          (err, characteristic) => {
            if (err) {
              // A cancelled monitor on disconnect is expected; ignore it
              if (err.errorCode !== 201 && err.errorCode !== 2) {
                setError(err.message);
              }
              return;
            }
            const v = parseValue(characteristic?.value ?? null);
            if (v !== null) {
              setValue(v);
              setUpdatedAt(new Date());
            }
          }
        );

        setConnected(d);
        setStatus('connected');
      } catch (e: any) {
        cleanupConnection();
        setError(e?.message ?? 'Failed to connect.');
        setStatus('idle');
      }
    },
    [cleanupConnection]
  );

  const disconnect = useCallback(async () => {
    if (!connected) return;
    cleanupConnection();
    try {
      await manager.cancelDeviceConnection(connected.id);
    } catch {
      // already disconnected
    }
    setConnected(null);
    setValue(null);
    setUpdatedAt(null);
    setStatus('idle');
  }, [connected, cleanupConnection]);

  useEffect(() => {
    return () => {
      manager.stopDeviceScan();
      cleanupConnection();
    };
  }, [cleanupConnection]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <Text style={styles.title}>Magneto Sensor</Text>

        {error && <Text style={styles.error}>{error}</Text>}

        {status === 'connected' && connected ? (
          <View style={styles.readingWrap}>
            <Text style={styles.deviceName}>
              {connected.name ?? connected.localName ?? connected.id}
            </Text>
            <View style={styles.card}>
              <Text style={styles.label}>Magnetic field</Text>
              <Text style={styles.value}>
                {value !== null ? value.toFixed(5) : '—'}
                <Text style={styles.unit}> G</Text>
              </Text>
              <Text style={styles.updated}>
                {updatedAt
                  ? `Updated ${updatedAt.toLocaleTimeString()}`
                  : 'Waiting for data…'}
              </Text>
            </View>
            <Pressable style={[styles.button, styles.danger]} onPress={disconnect}>
              <Text style={styles.buttonText}>Disconnect</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.listWrap}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Show all BLE devices</Text>
              <Switch
                value={showAll}
                onValueChange={setShowAll}
                disabled={status === 'scanning' || status === 'connecting'}
              />
            </View>

            <Pressable
              style={[
                styles.button,
                (status === 'connecting') && styles.disabled,
              ]}
              disabled={status === 'connecting'}
              onPress={status === 'scanning' ? stopScan : startScan}
            >
              {status === 'scanning' ? (
                <View style={styles.inline}>
                  <ActivityIndicator color="#fff" />
                  <Text style={[styles.buttonText, { marginLeft: 10 }]}>
                    Scanning… tap to stop
                  </Text>
                </View>
              ) : (
                <Text style={styles.buttonText}>Scan for devices</Text>
              )}
            </Pressable>

            {status === 'connecting' && (
              <View style={styles.inline}>
                <ActivityIndicator color="#fff" />
                <Text style={styles.hint}>  Connecting…</Text>
              </View>
            )}

            <FlatList
              data={devices}
              keyExtractor={(d) => d.id}
              style={{ marginTop: 12 }}
              ListEmptyComponent={
                <Text style={styles.hint}>
                  {status === 'scanning'
                    ? 'Looking for devices…'
                    : 'No devices yet. Tap “Scan for devices”.'}
                </Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={styles.device}
                  disabled={status === 'connecting'}
                  onPress={() => connect(item)}
                >
                  <Text style={styles.deviceTitle}>
                    {item.name ?? item.localName ?? 'Unnamed device'}
                  </Text>
                  <Text style={styles.deviceSub}>
                    {item.id} · {item.rssi ?? '?'} dBm
                  </Text>
                </Pressable>
              )}
            />
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', paddingHorizontal: 20 },
  title: { color: '#f8fafc', fontSize: 26, fontWeight: '700', marginVertical: 16 },
  error: {
    color: '#fecaca',
    backgroundColor: '#7f1d1d',
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  listWrap: { flex: 1 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  rowLabel: { color: '#cbd5e1', fontSize: 15 },
  inline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  button: {
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  danger: { backgroundColor: '#dc2626', marginTop: 24 },
  disabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  hint: { color: '#94a3b8', marginTop: 12, textAlign: 'center' },
  device: {
    backgroundColor: '#1e293b',
    padding: 14,
    borderRadius: 10,
    marginBottom: 10,
  },
  deviceTitle: { color: '#f1f5f9', fontSize: 16, fontWeight: '600' },
  deviceSub: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  readingWrap: { flex: 1, justifyContent: 'center' },
  deviceName: { color: '#94a3b8', textAlign: 'center', marginBottom: 12 },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 28,
    alignItems: 'center',
  },
  label: { color: '#94a3b8', fontSize: 14, textTransform: 'uppercase', letterSpacing: 1 },
  value: { color: '#f8fafc', fontSize: 45, fontWeight: '700', marginVertical: 8 },
  unit: { fontSize: 28, color: '#94a3b8', fontWeight: '500' },
  updated: { color: '#64748b', fontSize: 12 },
});
