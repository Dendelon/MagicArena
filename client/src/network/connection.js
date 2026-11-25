const textEncoder = new TextEncoder();

const byteLength = (text) => textEncoder.encode(text).length;

export const createConnection = ({ name, roomId }) => {
  const events = new EventTarget();

  let socket = null;
  let retryTimer = null;
  let reconnectAttempts = 0;
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

  const connect = () => {
    if (stopped) return;

    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

    const url = `${scheme}//${window.location.host}/ws`;

    socket = new WebSocket(url);

    emit('status', 'Connecting...');

    socket.addEventListener('open', () => {
      reconnectAttempts = 0;

      // При кожному перепідключенні знову входимо в кімнату
      transmit(
        JSON.stringify({
          v: 1,
          type: 'join',
          room: roomId,
          name,
        }),
        'join',
      );

      // Надсилаємо накопичені повідомлення
      while (queue.length > 0) {
        const item = queue.shift();
        transmit(item.data, item.type);
      }

      emit('status', 'Connected');
    });

    socket.addEventListener('message', (event) => {
      try {
        const bytes =
          typeof event.data === 'string'
            ? byteLength(event.data)
            : (event.data?.byteLength ?? 0);

        const message = JSON.parse(event.data);

        if (!message || typeof message.type !== 'string' || message.v !== 1) {
          return;
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

    socket.addEventListener('close', () => {
      socket = null;

      if (stopped) return;

      reconnectAttempts++;

      const delay = Math.min(10000, 500 * 2 ** Math.min(reconnectAttempts, 5));

      emit('status', `Reconnecting in ${delay} ms...`);

      retryTimer = setTimeout(connect, delay);
    });

    socket.addEventListener('error', () => {
      emit('status', 'Connection error');
    });
  };

  const send = (message) => {
    const data = JSON.stringify({
      v: 1,
      ...message,
    });

    if (socket?.readyState === WebSocket.OPEN) {
      transmit(data, message.type);
      return;
    }

    if (queue.length < 50) {
      queue.push({ data, type: message.type });
    }
  };

  const close = () => {
    stopped = true;

    clearTimeout(retryTimer);

    queue.length = 0;

    socket?.close(1000, 'Leaving game');
  };

  return {
    connect,
    send,
    close,
    isOpen: () => socket?.readyState === WebSocket.OPEN,
    addEventListener: (type, callback) => events.addEventListener(type, callback),
    removeEventListener: (type, callback) => events.removeEventListener(type, callback),
  };
};
