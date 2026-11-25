export const MAX_MESSAGE_SIZE = 4096;

const protocolError = (message, code = 1008) => {
  const error = new Error(message);
  error.closeCode = code;
  return error;
};

export const parseMessage = (data, isBinary = false) => {
  if (isBinary) {
    throw protocolError('Binary messages are not supported', 1003);
  }

  if (data.length > MAX_MESSAGE_SIZE) {
    throw protocolError('Message too large', 1009);
  }

  let message;

  try {
    message = JSON.parse(data.toString('utf8'));
  } catch {
    throw protocolError('Invalid JSON', 1007);
  }

  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    message.v !== 1
  ) {
    throw protocolError('Invalid protocol version or shape');
  }

  if (message.type === 'join') {
    if (
      typeof message.room !== 'string' ||
      message.room.length === 0 ||
      message.room.length > 64 ||
      typeof message.name !== 'string' ||
      message.name.trim().length === 0 ||
      message.name.trim().length > 24
    ) {
      throw protocolError('Invalid join message');
    }

    return {
      type: 'join',
      room: message.room,
      name: message.name.trim(),
    };
  }

  if (message.type === 'chat') {
    if (
      typeof message.text !== 'string' ||
      message.text.trim().length === 0 ||
      message.text.length > 300
    ) {
      throw protocolError('Invalid chat message');
    }

    return {
      type: 'chat',
      text: message.text.trim(),
    };
  }

  throw protocolError('Unknown message type');
};
