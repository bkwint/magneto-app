# Magneto BLE (Expo)

Scans for your ESP32 MagnetoSensor, connects, and shows the live value (Gauss).

> BLE does **not** work in Expo Go. You need a development build.

## Setup

```bash
npx create-expo-app@latest magneto-ble --template blank-typescript
cd magneto-ble

# Install deps (npx expo install picks versions matching your SDK)
npx expo install react-native-ble-plx react-native-safe-area-context
npm install base-64
npm install -D @types/base-64

# Replace the generated App.tsx and app.json with the ones from this folder
```

## Run (development build on a physical device)

```bash
npx expo prebuild
npx expo run:android   # or: npx expo run:ios
```

(Or use EAS: `eas build --profile development --platform android`, install it, then `npx expo start --dev-client`.)

The simulator/emulator has no Bluetooth, so use a real phone.

## How it works

- Scans filtered by service UUID `4fafc201-…914b` (toggle "Show all BLE devices" to see everything).
- Tap a device to connect, read the characteristic once, then subscribe to notifications (your sketch notifies every 200 ms).
- The sketch sends the value as ASCII text, so it's base64-decoded and parsed with `parseFloat`.
- If the device drops, the app returns to the scan screen.
