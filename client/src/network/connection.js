const textEncoder = new TextEncoder();

const byteLength = (text) => textEncoder.encode(text).length;

const TRANSIENT_TYPES = new Set(['input', 'ping']);

export const createConnection = ({ name, roomId }) => {
  const events = new EventTarget();

  let socket = null;
  let retryTimer = null;
  let reconnectAttempts = 0;
  let joined = false;
  let stopped = false;

  const queue = [];

  const emit = (type, detail) => {
    events.dispatchEvent(new CustomEvent(type, { detail }));
  };

  const transmit = (data, type) => {
    socket.send(data);
    emit('tx', {
      bytes: byteLength(data),
      type,
    });
  };

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const connect = () => {
    if (stopped) return;

    clearRetryTimer();

    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${window.location.host}/ws`;

    joined = false;
    const currentSocket = new WebSocket(url);
    socket = currentSocket;

    emit('status', 'Connecting...');

    currentSocket.addEventListener('open', () => {
      if (socket !== currentSocket || stopped) return;

      // При кожному підключенні спочатку входимо в кімнату
      transmit(
        JSON.stringify({
          v: 1,
          type: 'join',
          room: roomId,
          name,
        }),
        'join',
      );

      emit('status', 'Connected');
    });

    currentSocket.addEventListener('message', (event) => {
      if (socket !== currentSocket) return;

      try {
        const bytes =
          typeof event.data === 'string'
            ? byteLength(event.data)
            : (event.data?.byteLength ?? 0);

        const message = JSON.parse(event.data);

        if (!message || typeof message.type !== 'string' || message.v !== 1) {
          return;
        }

        if (message.type === 'joined') {
          joined = true;
          reconnectAttempts = 0;

          while (queue.length > 0) {
            const item = queue.shift();
            transmit(item.data, item.type);
          }
        }

        emit('rx', {
          bytes,
          type: message.type,
        });

        emit(message.type, message);
      } catch (error) {
        console.error('Invalid server message:', error);
      }
    });

    currentSocket.addEventListener('close', (event) => {
      if (socket !== currentSocket) return;

      console.info('[WS] Closed:', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      socket = null;
      joined = false;
      queue.length = 0;

      emit('disconnected', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      if (stopped) return;

      reconnectAttempts += 1;

      const delay = Math.min(10000, 500 * 2 ** Math.min(reconnectAttempts, 5));

      emit('status', `Reconnecting in ${delay} ms...`);

      clearRetryTimer();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    });

    currentSocket.addEventListener('error', () => {
      if (socket !== currentSocket) return;

      emit('status', 'Connection error');
    });
  };

  const send = (message) => {
    if (TRANSIENT_TYPES.has(message.type)) {
      if (!joined || socket?.readyState !== WebSocket.OPEN) {
        return;
      }

      const data = JSON.stringify({
        v: 1,
        ...message,
      });

      transmit(data, message.type);
      return;
    }

    const data = JSON.stringify({
      v: 1,
      ...message,
    });

    if (socket?.readyState === WebSocket.OPEN && joined) {
      transmit(data, message.type);
      return;
    }

    if (!stopped && queue.length < 20) {
      queue.push({ data, type: message.type });
    }
  };

  const close = () => {
    stopped = true;
    joined = false;

    clearRetryTimer();
    queue.length = 0;

    socket?.close(1000, 'Leaving game');
  };

  return {
    connect,
    send,
    close,
    isOpen: () => socket?.readyState === WebSocket.OPEN,
    isJoined: () => Boolean(socket?.readyState === WebSocket.OPEN && joined),
    addEventListener: (type, callback) => events.addEventListener(type, callback),
    removeEventListener: (type, callback) => events.removeEventListener(type, callback),
  };
};
