import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

function readToken(): string {
  return typeof window !== 'undefined' ? localStorage.getItem('rabitech_token') || '' : '';
}

function getSocketBaseUrl(): string {
  if (typeof window === 'undefined') {
    return process.env.NEXT_SERVER_API_URL || process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:4000';
  }

  if (process.env.NEXT_PUBLIC_SOCKET_URL) return process.env.NEXT_PUBLIC_SOCKET_URL;

  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:4000`;
}

export function getSocket(): Socket {
  const token = readToken();
  if (!socket) {
    socket = io(getSocketBaseUrl(), {
      path: '/socket.io',
      addTrailingSlash: false,
      auth: { token },
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 2000,
    });
    return socket;
  }
  // Re-auth after login without full page reload
  if (token && socket.auth && (socket.auth as { token?: string }).token !== token) {
    socket.auth = { token };
    if (socket.connected) socket.disconnect().connect();
  }
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
