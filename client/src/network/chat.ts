import './chat.css';

import type { Connection } from './connection.ts';

export const mountRoomChat = (connection: Connection): (() => void) => {
  const panel = document.createElement('aside');
  panel.className = 'magic-chat';

  const title = document.createElement('h3');
  title.textContent = 'ROOM CHAT';

  const status = document.createElement('p');
  status.className = 'magic-chat-status';
  status.textContent = 'Connecting...';

  const roster = document.createElement('p');
  roster.className = 'magic-chat-roster';
  roster.textContent = 'Players: —';

  const messages = document.createElement('div');
  messages.className = 'magic-chat-messages';

  const form = document.createElement('form');
  form.className = 'magic-chat-form';

  const input = document.createElement('input');
  input.placeholder = 'Type a message...';
  input.maxLength = 300;
  input.required = true;

  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Send';

  form.append(input, button);
  panel.append(title, status, roster, messages, form);
  document.body.append(panel);

  const addMessage = (text: string): void => {
    const line = document.createElement('div');
    line.textContent = text;

    messages.append(line);

    // Не зберігаємо нескінченну кількість повідомлень у DOM
    if (messages.children.length > 100) {
      messages.firstElementChild?.remove();
    }

    messages.scrollTop = messages.scrollHeight;
  };

  connection.addEventListener('status', (event) => {
    status.textContent = event.detail;
  });

  connection.addEventListener('joined', (event) => {
    addMessage(`Joined ${event.detail.room.name}`);
  });

  connection.addEventListener('roster', (event) => {
    const names = event.detail.players.map((player) => player.name);

    roster.textContent = `Players: ${names.join(', ') || '—'}`;
  });

  connection.addEventListener('notice', (event) => {
    addMessage(`• ${event.detail.text}`);
  });

  connection.addEventListener('chat', (event) => {
    addMessage(`${event.detail.name}: ${event.detail.text}`);
  });

  // Клавіші під час введення чату не повинні керувати мечем
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
  });

  input.addEventListener('keyup', (event) => {
    event.stopPropagation();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const text = input.value.trim();
    if (!text) return;

    connection.send({
      type: 'chat',
      text,
    });

    input.value = '';
  });

  return () => {
    connection.close();
    panel.remove();
  };
};

