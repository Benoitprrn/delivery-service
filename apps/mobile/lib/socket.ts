import { io, type Socket } from 'socket.io-client';

function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const API_URL = requireEnv('EXPO_PUBLIC_API_URL', process.env.EXPO_PUBLIC_API_URL);

let socket: Socket | null = null;
let connectedZoneId: string | null = null;

// Le backend (apps/api/src/realtime/socket-handler.ts) ne rejoint la room
// zone_{zoneId} qu'à partir du zoneId présent dans la query du handshake
// initial — il n'existe pas d'événement "join room" séparé après connexion
// côté serveur. zoneId doit donc être connu AVANT d'appeler getSocket().
// `auth.token` est envoyé pour l'identification même si le serveur ne le
// valide pas encore (revue de sécurité socket restée en attente côté
// backend — voir mémoire projet).
export function getSocket(zoneId: string, token: string): Socket {
  if (socket !== null && connectedZoneId === zoneId) {
    return socket;
  }
  disconnectSocket();
  connectedZoneId = zoneId;
  socket = io(API_URL, {
    transports: ['websocket'],
    auth: { token },
    query: { zoneId }
  });
  return socket;
}

export function disconnectSocket(): void {
  if (socket !== null) {
    socket.disconnect();
    socket = null;
    connectedZoneId = null;
  }
}
