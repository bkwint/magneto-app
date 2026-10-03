import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { BleManager, Device, State, Subscription } from 'react-native-ble-plx';
import { decode, encode } from 'base-64';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Must match the UUIDs in the Arduino sketch
const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
const NAME_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device name (read/write)

const TARE_SAMPLES = 5;
const MAX_NAME_LEN = 29; // must match MAX_NAME_LEN in the Arduino sketch
const DEFAULT_PRECISION = 5; // digits after the decimal point
const MAX_PRECISION = 10;
const PRECISION_KEY = 'settings:precision';

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

// UTF-8 <-> base64 helpers for the device name
function toBase64Utf8(s: string): string {
  return encode(unescape(encodeURIComponent(s)));
}
function fromBase64Utf8(b64: string | null): string | null {
  if (!b64) return null;
  try {
    return decodeURIComponent(escape(decode(b64)));
  } catch {
    try {
      return decode(b64);
    } catch {
      return null;
    }
  }
}
function utf8Length(s: string): number {
  return unescape(encodeURIComponent(s)).length;
}

const CANCELLED = 'cancelled';
let cancelActiveFind: (() => void) | null = null;

// Scan until the device with the given id shows up again (e.g. after it reboots)
function findDevice(id: string, timeoutMs: number): Promise<Device> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      manager.stopDeviceScan();
      if (cancelActiveFind === cancel) cancelActiveFind = null;
    };
    const cancel = () => {
      finish();
      reject(new Error(CANCELLED));
    };
    timer = setTimeout(() => {
      finish();
      reject(
        new Error('Could not find the device. Please scan again.')
      );
    }, timeoutMs);
    cancelActiveFind = cancel;

    manager.startDeviceScan(
      [SERVICE_UUID],
      { allowDuplicates: false },
      (err, device) => {
        if (err) {
          finish();
          reject(err);
          return;
        }
        if (device && device.id === id) {
          finish();
          resolve(device);
        }
      }
    );
  });
}

export default function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [devices, setDevices] = useState<Device[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [connected, setConnected] = useState<Device | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  // rawValue is exactly what the sensor sent; the displayed value is rawValue - offset
  const [rawValue, setRawValue] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [taring, setTaring] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Options dropdown
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuTop, setMenuTop] = useState(0);
  const menuBtnRef = useRef<View>(null);

  // Rename dialog
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectMsg, setReconnectMsg] = useState('Reconnecting…');

  // Settings screen
  const [screen, setScreen] = useState<'main' | 'settings'>('main');
  const [precision, setPrecision] = useState(DEFAULT_PRECISION);
  const [precisionText, setPrecisionText] = useState(String(DEFAULT_PRECISION));
  const [precisionError, setPrecisionError] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const renamingRef = useRef(false);
  const pendingRenameRef = useRef(false); // iOS: open rename after the menu modal is gone
  // Background/foreground handling
  const connectedRef = useRef<Device | null>(null);
  const offsetRef = useRef(0);
  const resumeIdRef = useRef<string | null>(null); // device to reconnect to on foreground
  const resumeOffsetRef = useRef(0);
  const resumingRef = useRef(false);

  const monitorSub = useRef<Subscription | null>(null);
  const disconnectSub = useRef<Subscription | null>(null);

  const value = rawValue !== null ? rawValue - offset : null;

  const resetReading = useCallback(() => {
    setRawValue(null);
    setOffset(0);
    setTaring(false);
    setUpdatedAt(null);
  }, []);

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
          // During a rename the device reboots on purpose; the rename flow handles it
          if (renamingRef.current) return;
          cleanupConnection();
          setConnected(null);
          resetReading();
          setStatus('idle');
          setError('Device disconnected.');
        });

        // Prefer the name stored on the device; fall back to the advertised name
        let name =
          d.name ?? d.localName ?? device.name ?? device.localName ?? d.id;
        try {
          const n = await d.readCharacteristicForService(
            SERVICE_UUID,
            NAME_CHAR_UUID
          );
          const stored = fromBase64Utf8(n.value);
          if (stored) name = stored;
        } catch {
          // firmware without the name characteristic
        }
        setDisplayName(name);

        // Initial read so something shows immediately
        const initial = await d.readCharacteristicForService(
          SERVICE_UUID,
          CHARACTERISTIC_UUID
        );
        const v0 = parseValue(initial.value);
        if (v0 !== null) {
          setRawValue(v0);
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
              setRawValue(v);
              setUpdatedAt(new Date());
            }
          }
        );

        setOffset(0); // fresh connection starts untared
        connectedRef.current = d;
        setConnected(d);
        setStatus('connected');
      } catch (e: any) {
        cleanupConnection();
        setError(e?.message ?? 'Failed to connect.');
        setStatus('idle');
      }
    },
    [cleanupConnection, resetReading]
  );

  const disconnect = useCallback(async () => {
    if (!connected) return;
    setMenuOpen(false);
    cleanupConnection();
    try {
      await manager.cancelDeviceConnection(connected.id);
    } catch {
      // already disconnected
    }
    setConnected(null);
    resetReading();
    setStatus('idle');
  }, [connected, cleanupConnection, resetReading]);

  // Take TARE_SAMPLES raw readings from the sensor, average them, and use the
  // average as the zero point for all following measurements.
  const tare = useCallback(async () => {
    if (!connected || taring) return;
    setError(null);
    setTaring(true);
    try {
      const samples: number[] = [];
      for (let i = 0; i < TARE_SAMPLES; i++) {
        const c = await connected.readCharacteristicForService(
          SERVICE_UUID,
          CHARACTERISTIC_UUID
        );
        const v = parseValue(c.value);
        if (v !== null) samples.push(v);
      }
      if (samples.length === 0) {
        setError('Tare failed: no valid readings received.');
        return;
      }
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      setOffset(avg);
    } catch (e: any) {
      setError(e?.message ?? 'Tare failed.');
    } finally {
      setTaring(false);
    }
  }, [connected, taring]);

  // Write the new name, let the ESP32 reboot, then scan for it and reconnect
  const renameDevice = useCallback(
    async (newName: string) => {
      if (!connected) return;
      const id = connected.id;

      setRenameBusy(true);
      setRenameError(null);
      renamingRef.current = true;

      try {
        await connected.writeCharacteristicWithResponseForService(
          SERVICE_UUID,
          NAME_CHAR_UUID,
          toBase64Utf8(newName)
        );
      } catch (e: any) {
        renamingRef.current = false;
        setRenameError(e?.message ?? 'Failed to rename the device.');
        setRenameBusy(false);
        return;
      }

      setRenameBusy(false);
      setRenameOpen(false);
      setError(null);
      setReconnectMsg('Renaming and reconnecting…');
      setReconnecting(true);
      setStatus('connecting');

      // Drop the connection ourselves; the device restarts about a second after the write
      cleanupConnection();
      try {
        await manager.cancelDeviceConnection(id);
      } catch {
        // already gone
      }
      setConnected(null);
      resetReading();

      try {
        await new Promise((r) => setTimeout(r, 2500)); // give it time to boot
        const dev = await findDevice(id, 20000);
        await connect(dev);
      } catch (e: any) {
        setError(e?.message ?? 'Could not reconnect after renaming.');
        setStatus('idle');
      } finally {
        renamingRef.current = false;
        setReconnecting(false);
      }
    },
    [connected, cleanupConnection, resetReading, connect]
  );

  const confirmRename = useCallback(() => {
    const name = renameText.trim();
    if (!name) {
      setRenameError('The name cannot be empty.');
      return;
    }
    if (utf8Length(name) > MAX_NAME_LEN) {
      setRenameError(
        `Name is too long (max ${MAX_NAME_LEN} bytes; special characters take more than one).`
      );
      return;
    }
    renameDevice(name);
  }, [renameText, renameDevice]);

  const openMenu = useCallback(() => {
    menuBtnRef.current?.measureInWindow((_x, y, _w, h) => {
      setMenuTop(y + h + 6);
      setMenuOpen(true);
    });
  }, []);

  const openRename = useCallback(() => {
    setRenameText(displayName ?? '');
    setRenameError(null);
    if (Platform.OS === 'ios') {
      // iOS can't present a modal while another one is still dismissing
      pendingRenameRef.current = true;
      setMenuOpen(false);
    } else {
      setMenuOpen(false);
      setRenameOpen(true);
    }
  }, [displayName]);

  const openSettings = useCallback(() => {
    setMenuOpen(false);
    setPrecisionText(String(precision));
    setPrecisionError(null);
    setScreen('settings');
  }, [precision]);

  const closeSettings = useCallback(() => {
    Keyboard.dismiss();
    setPrecisionError(null);
    setScreen('main');
  }, []);

  const onPrecisionChange = (t: string) => {
    const digits = t.replace(/[^0-9]/g, '');
    setPrecisionText(digits);
    const n = parseInt(digits, 10);
    if (digits === '' || n > MAX_PRECISION) {
      setPrecisionError(`Enter a number between 0 and ${MAX_PRECISION}.`);
      return; // keep the last valid precision
    }
    setPrecisionError(null);
    setPrecision(n);
  };

  const onPrecisionBlur = () => {
    // Snap the field back to the precision actually in use
    setPrecisionText(String(precision));
    setPrecisionError(null);
  };

  // Leave the settings screen if the connection goes away
  useEffect(() => {
    if (status !== 'connected' && !reconnecting) setScreen('main');
  }, [status, reconnecting]);

  // Android back button returns from settings
  useEffect(() => {
    if (screen !== 'settings') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeSettings();
      return true;
    });
    return () => sub.remove();
  }, [screen, closeSettings]);

  // Load the saved precision once at startup
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(PRECISION_KEY);
        if (saved !== null) {
          const n = parseInt(saved, 10);
          if (Number.isInteger(n) && n >= 0 && n <= MAX_PRECISION) {
            setPrecision(n);
            setPrecisionText(String(n));
          }
        }
      } catch {
        // storage unavailable: just use the default
      } finally {
        setSettingsLoaded(true);
      }
    })();
  }, []);

  // Save whenever it changes (but not before the saved value has been loaded)
  useEffect(() => {
    if (!settingsLoaded) return;
    AsyncStorage.setItem(PRECISION_KEY, String(precision)).catch(() => {});
  }, [precision, settingsLoaded]);

  // Keep refs in sync so AppState handlers always see current values
  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  // App went to the background: drop the BLE connection and remember the device
  const suspendConnection = useCallback(async () => {
    if (renamingRef.current) return;
    if (resumingRef.current) {
      // Still reconnecting; stop the scan and try again on next foreground
      cancelActiveFind?.();
      return;
    }
    const d = connectedRef.current;
    if (!d) return;

    resumeIdRef.current = d.id;
    resumeOffsetRef.current = offsetRef.current;

    cleanupConnection(); // removes the disconnect listener, so no error banner
    connectedRef.current = null;
    setMenuOpen(false);
    setRenameOpen(false);
    setConnected(null);
    resetReading();
    setStatus('idle');
    try {
      await manager.cancelDeviceConnection(d.id);
    } catch {
      // already disconnected
    }
  }, [cleanupConnection, resetReading]);

  // App is back in the foreground: find the same device again and reconnect
  const resumeConnection = useCallback(async () => {
    const id = resumeIdRef.current;
    if (!id || resumingRef.current) return;

    resumingRef.current = true;
    setError(null);
    setReconnectMsg('Reconnecting…');
    setReconnecting(true);
    setStatus('connecting');

    try {
      // Give the ESP32 a moment to resume advertising after our disconnect
      await new Promise((r) => setTimeout(r, 500));
      const dev = await findDevice(id, 15000);
      resumeIdRef.current = null;
      await connect(dev);
      if (connectedRef.current) setOffset(resumeOffsetRef.current); // keep the tare
    } catch (e: any) {
      if (e?.message === CANCELLED) {
        setStatus('idle'); // resume id is kept for the next foreground
      } else {
        resumeIdRef.current = null;
        setError(e?.message ?? 'Could not reconnect.');
        setStatus('idle');
      }
    } finally {
      resumingRef.current = false;
      setReconnecting(false);
      // Backgrounded again while we were reconnecting
      if (AppState.currentState !== 'active') suspendConnection();
    }
  }, [connect, suspendConnection]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') suspendConnection();
      else if (next === 'active') resumeConnection();
    });
    return () => sub.remove();
  }, [suspendConnection, resumeConnection]);

  useEffect(() => {
    return () => {
      manager.stopDeviceScan();
      cleanupConnection();
    };
  }, [cleanupConnection]);

  const isConnected = status === 'connected' && connected;
  const inSettings = screen === 'settings' && !!isConnected && !reconnecting;
  const renameUnchanged = renameText.trim() === (displayName ?? '');

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />

        <View style={styles.header}>
          {inSettings && (
            <Pressable style={styles.backBtn} onPress={closeSettings}>
              <Text style={styles.menuBtnText}>‹ Back</Text>
            </Pressable>
          )}
          <Text style={styles.title}>{inSettings ? 'Settings' : 'Magneto Sensor'}</Text>
          {inSettings && <View style={styles.backBtnSpacer} />}
          {isConnected && !reconnecting && !inSettings && (
            <Pressable
              ref={menuBtnRef}
              collapsable={false}
              style={styles.menuBtn}
              onPress={openMenu}
            >
              <Text style={styles.menuBtnText}>Options ▾</Text>
            </Pressable>
          )}
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        {reconnecting ? (
          <View style={styles.readingWrap}>
            <ActivityIndicator color="#fff" size="large" />
            <Text style={styles.hint}>{reconnectMsg}</Text>
          </View>
        ) : inSettings ? (
          <Pressable style={styles.settingsWrap} onPress={Keyboard.dismiss}>
            <View style={styles.settingRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.settingLabel}>Display precision</Text>
                <Text style={styles.settingHint}>
                  Digits after the decimal point (0–{MAX_PRECISION})
                </Text>
              </View>
              <TextInput
                style={styles.settingInput}
                value={precisionText}
                onChangeText={onPrecisionChange}
                onBlur={onPrecisionBlur}
                keyboardType="number-pad"
                maxLength={2}
                selectTextOnFocus
              />
            </View>
            {precisionError && <Text style={styles.dialogError}>{precisionError}</Text>}
            <Text style={[styles.settingHint, { marginTop: 16 }]}>
              Current reading: {value !== null ? value.toFixed(precision) : '—'} G
            </Text>
          </Pressable>
        ) : isConnected ? (
          <View style={styles.readingWrap}>
            <Text style={styles.deviceName}>
              {displayName ?? connected.name ?? connected.localName ?? connected.id}
            </Text>
            <View style={styles.card}>
              <Text style={styles.label}>Magnetic field</Text>
              <Text style={styles.value}>
                {value !== null ? value.toFixed(precision) : '—'}
                <Text style={styles.unit}> G</Text>
              </Text>
              <Text style={styles.updated}>
                {updatedAt
                  ? `Updated ${updatedAt.toLocaleTimeString()}`
                  : 'Waiting for data…'}
              </Text>
              {offset !== 0 && (
                <Text style={styles.updated}>Tared (offset {offset.toFixed(precision)} G)</Text>
              )}
            </View>
            <Pressable
              style={[styles.button, styles.tare, taring && styles.disabled]}
              disabled={taring}
              onPress={tare}
            >
              {taring ? (
                <View style={styles.inline}>
                  <ActivityIndicator color="#fff" />
                  <Text style={[styles.buttonText, { marginLeft: 10 }]}>Taring…</Text>
                </View>
              ) : (
                <Text style={styles.buttonText}>Tare</Text>
              )}
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

        {/* Options dropdown */}
        <Modal
          transparent
          visible={menuOpen}
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => setMenuOpen(false)}
          onDismiss={() => {
            if (pendingRenameRef.current) {
              pendingRenameRef.current = false;
              setRenameOpen(true);
            }
          }}
        >
          <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
            <View style={[styles.dropdown, { top: menuTop }]}>
              <Pressable style={styles.menuItem} onPress={openRename}>
                <Text style={styles.menuItemText}>Rename device</Text>
              </Pressable>
              <View style={styles.menuDivider} />
              <Pressable style={styles.menuItem} onPress={openSettings}>
                <Text style={styles.menuItemText}>Settings</Text>
              </Pressable>
              <View style={styles.menuDivider} />
              <Pressable style={styles.menuItem} onPress={disconnect}>
                <Text style={[styles.menuItemText, styles.menuItemDanger]}>
                  Disconnect
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Modal>

        {/* Rename dialog: floating modal that moves up with the keyboard */}
        <Modal
          transparent
          visible={renameOpen}
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => {
            if (!renameBusy) setRenameOpen(false);
          }}
        >
          <KeyboardAvoidingView
            style={styles.overlay}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            <View style={styles.dialog}>
              <Text style={styles.dialogTitle}>Rename device</Text>
              <TextInput
                style={styles.input}
                value={renameText}
                onChangeText={(t) => {
                  setRenameText(t);
                  setRenameError(null);
                }}
                maxLength={MAX_NAME_LEN}
                autoFocus
                autoCorrect={false}
                selectTextOnFocus
                editable={!renameBusy}
                placeholder="New device name"
                placeholderTextColor="#64748b"
                returnKeyType="done"
                onSubmitEditing={confirmRename}
              />
              <Text style={styles.counter}>
                {renameText.length}/{MAX_NAME_LEN}
              </Text>
              {renameError && <Text style={styles.dialogError}>{renameError}</Text>}
              <View style={styles.dialogButtons}>
                <Pressable
                  style={[styles.dialogBtn, styles.dialogCancel]}
                  disabled={renameBusy}
                  onPress={() => setRenameOpen(false)}
                >
                  <Text style={styles.buttonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.dialogBtn,
                    styles.dialogPrimary,
                    (renameBusy || !renameText.trim() || renameUnchanged) &&
                      styles.disabled,
                  ]}
                  disabled={renameBusy || !renameText.trim() || renameUnchanged}
                  onPress={confirmRename}
                >
                  {renameBusy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Rename</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', paddingHorizontal: 20 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 16,
  },
  title: { color: '#f8fafc', fontSize: 26, fontWeight: '700' },
  menuBtn: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  menuBtnText: { color: '#f8fafc', fontSize: 14, fontWeight: '600' },
  backBtn: { width: 80, paddingVertical: 8 },
  backBtnSpacer: { width: 80 },
  settingsWrap: { flex: 1 },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
  },
  settingLabel: { color: '#f1f5f9', fontSize: 16, fontWeight: '600' },
  settingHint: { color: '#94a3b8', fontSize: 13, marginTop: 2 },
  settingInput: {
    width: 70,
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingVertical: 10,
    fontSize: 18,
    textAlign: 'center',
  },
  menuBackdrop: { flex: 1 },
  dropdown: {
    position: 'absolute',
    right: 20,
    minWidth: 180,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    overflow: 'hidden',
    elevation: 8,
  },
  menuItem: { paddingVertical: 14, paddingHorizontal: 16 },
  menuItemText: { color: '#f1f5f9', fontSize: 16 },
  menuItemDanger: { color: '#f87171' },
  menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#334155' },
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
  tare: { marginTop: 24 },
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
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  dialog: { backgroundColor: '#1e293b', borderRadius: 16, padding: 20 },
  dialogTitle: { color: '#f8fafc', fontSize: 20, fontWeight: '700', marginBottom: 14 },
  input: {
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  counter: { color: '#64748b', fontSize: 12, textAlign: 'right', marginTop: 6 },
  dialogError: { color: '#fca5a5', fontSize: 13, marginTop: 8 },
  dialogButtons: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 },
  dialogBtn: {
    minWidth: 90,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginLeft: 10,
  },
  dialogCancel: { backgroundColor: '#334155' },
  dialogPrimary: { backgroundColor: '#2563eb' },
});