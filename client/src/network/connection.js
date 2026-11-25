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
      socket.send(
        JSON.stringify({
          v: 1,
          type: 'join',
          room: roomId,
          name,
        }),
      );

      // Надсилаємо накопичені повідомлення
      while (queue.length > 0) {
        socket.send(queue.shift());
      }

      emit('status', 'Connected');
    });

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);

        if (!message || typeof message.type !== 'string' || message.v !== 1) {
          return;
        }

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
      socket.send(data);
      return;
    }

    if (queue.length < 50) {
      queue.push(data);
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
    addEventListener: (type, callback) => events.addEventListener(type, callback),
    removeEventListener: (type, callback) => events.removeEventListener(type, callback),
  };
};
