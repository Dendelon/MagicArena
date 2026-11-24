import './lobby.css';

export const mountLobby = (lobby, { onJoinGesture = () => {} } = {}) => {
  const overlay = document.createElement('section');
  overlay.className = 'magic-lobby';
  overlay.setAttribute('aria-label', 'Magic Arena lobby');

  const title = document.createElement('h1');
  title.textContent = 'MAGIC ARENA';
  const subtitle = document.createElement('p');
  subtitle.textContent = 'Choose your name and arena room';
  const form = document.createElement('form');
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Player name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 24;
  nameInput.placeholder = 'Mage';
  nameInput.value = 'Mage';
  nameInput.required = true;
  const roomLabel = document.createElement('label');
  roomLabel.textContent = 'Room';
  const roomsSelect = document.createElement('select');
  roomsSelect.required = true;
  roomsSelect.disabled = true;
  const status = document.createElement('p');
  status.className = 'magic-lobby-status';
  status.textContent = 'Loading rooms...';
  const joinButton = document.createElement('button');
  joinButton.type = 'submit';
  joinButton.textContent = 'Join';
  joinButton.disabled = true;
  nameLabel.append(nameInput);
  roomLabel.append(roomsSelect);
  form.append(nameLabel, roomLabel, status, joinButton);
  overlay.append(title, subtitle, form);
  document.body.append(overlay);

  const onRooms = (event) => {
    const selected = roomsSelect.value;
    roomsSelect.replaceChildren();
    for (const room of event.detail) {
      const option = document.createElement('option');
      option.value = room.id;
      option.textContent = `${room.name} (${room.players ?? 0}/${room.maxPlayers ?? 4})`;
      roomsSelect.append(option);
    }
    if (event.detail.some((room) => room.id === selected)) roomsSelect.value = selected;
    const hasRooms = event.detail.length > 0;
    roomsSelect.disabled = !hasRooms;
    joinButton.disabled = !hasRooms;
    status.textContent = hasRooms
      ? 'Rooms refreshed automatically every 5 seconds'
      : 'No rooms available';
  };

  const onError = (event) => {
    status.textContent = `Room request failed: ${event.detail.message}. Retrying...`;
  };

  const onSubmit = (event) => {
    event.preventDefault();
    if (!nameInput.value.trim() || !roomsSelect.value) return;
    onJoinGesture(); // AudioContext.resume is initiated in a real click gesture.
    if (!lobby.join(nameInput.value, roomsSelect.value)) {
      status.textContent = 'Choose a valid player name and room.';
    }
  };

  form.addEventListener('submit', onSubmit);
  lobby.addEventListener('roomsChanged', onRooms);
  lobby.addEventListener('error', onError);
  lobby.open();

  return () => {
    form.removeEventListener('submit', onSubmit);
    lobby.removeEventListener('roomsChanged', onRooms);
    lobby.removeEventListener('error', onError);
    overlay.remove();
  };
};
