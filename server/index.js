import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

export const PROTOCOL = 'Mafia-2026';
const OPEN = WebSocket.OPEN;
const WAITING = 'Ожидание игроков';
const PLAYING = 'Игра началась';
const FINISHED = 'Партия завершена';
const NIGHT = 'Ночь';
const DAY = 'День';
const VOTING = 'Голосование';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CAPACITIES = new Set([4, 6, 8, 10, 12, 16, 20]);
const MAFIA_ROLES = new Set(['Мафия', 'Дон']);
const SPECIAL_ROLES = new Set(['Мафия', 'Дон', 'Комиссар', 'Доктор', 'Любовница']);
const MAX_CHAT_MESSAGES = 100;
const MAX_JOURNAL_ENTRIES = 100;
const MAX_CLIENT_ID_LENGTH = 128;

const ROLE_DESCRIPTIONS = {
  'Мирный житель': 'Обсуждай, анализируй и помоги городу найти мафию.',
  'Мафия': 'Ночью выбери цель вместе с мафией. Днём не выдай себя.',
  'Дон': 'Ты глава мафии. Помогай команде и вычисляй угрозы.',
  'Комиссар': 'Ночью проверь одного игрока.',
  'Доктор': 'Ночью выбери игрока, которого хочешь спасти.',
  'Любовница': 'Ночью выбери игрока, чтобы отвлечь его. Его ночное действие будет отменено.'
};

function cleanText(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  return cleaned || fallback;
}

function cleanClientId(value) {
  if (typeof value !== 'string' || value.length > MAX_CLIENT_ID_LENGTH) return '';
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(value) ? value : '';
}

function cleanAvatar(value) {
  return cleanText(value, 12, '🎭');
}

function makeCode(rooms) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let code = '';
    for (let i = 0; i < 5; i += 1) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Не удалось создать свободный код комнаты. Попробуй ещё раз.');
}

export function assignRoles(playerCount) {
  if (!Number.isInteger(playerCount) || playerCount < 4 || playerCount > 20) {
    throw new RangeError('Для игры нужно от 4 до 20 игроков.');
  }

  const roles = Array(Math.max(1, Math.floor(playerCount / 4))).fill('Мафия');
  if (playerCount >= 7) roles.push('Дон');
  if (playerCount >= 5) roles.push('Комиссар', 'Доктор');
  if (playerCount >= 6) roles.push('Любовница');
  while (roles.length < playerCount) roles.push('Мирный житель');

  for (let i = roles.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

function roleDescription(role) {
  return ROLE_DESCRIPTIONS[role] || 'Выполняй задачу своей роли.';
}

function isAllowedOrigin(origin, env) {
  if (!origin) return true;
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.includes('*') || configured.includes(origin)) return true;
  return origin === 'https://chibi-slavka.github.io'
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function jsonResponse(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}

export function createGameServer({ env = process.env, logger = console } = {}) {
  const rooms = new Map();
  const connections = new Map();
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      jsonResponse(response, 200, {
        ok: true,
        protocol: PROTOCOL,
        activeRooms: rooms.size,
        connectedClients: connections.size
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      jsonResponse(response, 200, {
        name: 'MAFIA game server',
        protocol: PROTOCOL,
        websocket: '/ws',
        health: '/health'
      });
      return;
    }
    jsonResponse(response, 404, { error: 'Not found' });
  });

  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    perMessageDeflate: false
  });

  function send(socket, message) {
    if (!socket || socket.readyState !== OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function sendError(socket, message) {
    send(socket, { type: 'error', message });
  }

  function findPlayer(room, clientId) {
    return room?.players.find((player) => player.clientId === clientId) || null;
  }

  function roomFor(socket) {
    return socket.roomCode ? rooms.get(socket.roomCode) || null : null;
  }

  function timerSeconds(room, now = Date.now()) {
    if (!room || room.status !== PLAYING) return null;
    if (room.paused) return Math.max(0, room.pausedRemaining || 0);
    if (!room.phaseDeadline) return null;
    return Math.max(0, Math.ceil((room.phaseDeadline - now) / 1000));
  }

  function addJournal(room, text) {
    room.journal.push({ time: Date.now(), text: cleanText(text, 240, 'Обновление игры.') });
    if (room.journal.length > MAX_JOURNAL_ENTRIES) room.journal.splice(0, room.journal.length - MAX_JOURNAL_ENTRIES);
  }

  function projectVotes(room) {
    const result = {};
    for (const [voterId, targetId] of room.votes) {
      const voter = findPlayer(room, voterId);
      const target = targetId ? findPlayer(room, targetId) : null;
      if (voter) result[voter.name] = target?.name || null;
    }
    return result;
  }

  function roomState(room, viewerId) {
    const viewer = findPlayer(room, viewerId);
    const players = room.players.map((player) => {
      const visible = {
        name: player.name,
        avatar: player.avatar,
        host: player.clientId === room.hostId,
        connected: player.connected,
        alive: player.alive
      };
      // Roles are only ever included in the snapshot delivered to that player.
      if (player.clientId === viewerId && player.role) visible.role = player.role;
      return visible;
    });

    return {
      code: room.code,
      name: room.name,
      mode: room.mode,
      capacity: room.capacity,
      privacy: room.privacy,
      created: room.created,
      host: findPlayer(room, room.hostId)?.name || room.hostName,
      isHost: viewerId === room.hostId,
      players,
      status: room.status,
      phase: room.phase,
      round: room.round,
      timer: timerSeconds(room),
      nightDuration: room.nightDuration,
      dayDuration: room.dayDuration,
      paused: room.paused,
      votes: projectVotes(room),
      chat: room.chat.slice(-MAX_CHAT_MESSAGES),
      journal: room.journal.slice(-MAX_JOURNAL_ENTRIES),
      role: viewer?.role || undefined
    };
  }

  function publicRoomList() {
    return [...rooms.values()]
      .filter((room) => room.privacy === 'public' && room.status !== FINISHED)
      .sort((a, b) => b.created - a.created)
      .map((room) => ({
        code: room.code,
        name: room.name,
        mode: room.mode,
        capacity: room.capacity,
        privacy: room.privacy,
        created: room.created,
        host: findPlayer(room, room.hostId)?.name || room.hostName,
        players: room.players.map((player) => ({
          name: player.name,
          avatar: player.avatar,
          host: player.clientId === room.hostId,
          connected: player.connected
        })),
        status: room.status,
        phase: room.phase,
        round: room.round
      }));
  }

  function sendRoomsList(socket) {
    send(socket, { type: 'rooms_list', rooms: publicRoomList() });
  }

  function broadcastRoomsList() {
    const list = publicRoomList();
    for (const socket of webSocketServer.clients) {
      if (socket.handshaken && socket.readyState === OPEN) send(socket, { type: 'rooms_list', rooms: list });
    }
  }

  function sendRoomState(room) {
    for (const player of room.players) {
      const socket = connections.get(player.clientId);
      if (socket?.readyState === OPEN) send(socket, { type: 'room_state', state: roomState(room, player.clientId) });
    }
  }

  function sendTimer(room) {
    const timer = timerSeconds(room);
    for (const player of room.players) {
      const socket = connections.get(player.clientId);
      if (socket?.readyState === OPEN) {
        send(socket, { type: 'timer', roomCode: room.code, phase: room.phase, timer });
      }
    }
  }

  function sendRole(room, player) {
    const socket = connections.get(player.clientId);
    if (socket?.readyState === OPEN && player.role) {
      send(socket, {
        type: 'role',
        roomCode: room.code,
        role: player.role,
        description: roleDescription(player.role)
      });
    }
  }

  function broadcastRoomState(room) {
    sendRoomState(room);
    broadcastRoomsList();
  }

  function beginPhase(room, phase, seconds) {
    room.phase = phase;
    room.paused = false;
    room.pausedRemaining = 0;
    room.phaseDeadline = Date.now() + Math.max(1, seconds) * 1000;
    room.lastTimerValue = timerSeconds(room);
  }

  function endGame(room, result) {
    if (room.status === FINISHED) return;
    room.status = FINISHED;
    room.phaseDeadline = null;
    room.paused = false;
    room.pausedRemaining = 0;
    room.lastTimerValue = null;
    addJournal(room, result);
    sendRoomState(room);

    for (const player of room.players) {
      const socket = connections.get(player.clientId);
      if (socket?.readyState === OPEN) {
        send(socket, {
          type: 'history',
          match: {
            date: new Date().toISOString(),
            room: room.name,
            players: room.players.length,
            round: room.round || 1,
            role: player.role || '—',
            result
          }
        });
        send(socket, { type: 'notification', message: result });
      }
    }
    broadcastRoomsList();
  }

  function winner(room) {
    const alive = room.players.filter((player) => player.alive);
    const mafiaCount = alive.filter((player) => MAFIA_ROLES.has(player.role)).length;
    if (mafiaCount === 0) return 'Победа города!';
    if (mafiaCount >= alive.length - mafiaCount) return 'Победа мафии!';
    return null;
  }

  function phaseLength(room, phase) {
    return phase === NIGHT ? room.nightDuration : room.dayDuration;
  }

  function resolveNight(room) {
    const alive = room.players.filter((player) => player.alive);
    const actionFor = (player) => {
      const action = player ? room.actions.get(player.clientId) : null;
      return action?.round === room.round ? action.targetId : null;
    };

    const lover = alive.find((player) => player.role === 'Любовница');
    const blockedId = actionFor(lover);
    const isBlocked = (player) => Boolean(player && player.clientId === blockedId);

    const mafiaTargets = new Map();
    for (const player of alive) {
      if (!MAFIA_ROLES.has(player.role) || isBlocked(player)) continue;
      const targetId = actionFor(player);
      const target = targetId ? findPlayer(room, targetId) : null;
      if (target?.alive && !MAFIA_ROLES.has(target.role)) {
        mafiaTargets.set(targetId, (mafiaTargets.get(targetId) || 0) + 1);
      }
    }

    let attackedId = null;
    if (mafiaTargets.size) {
      const maxVotes = Math.max(...mafiaTargets.values());
      const tiedTargets = [...mafiaTargets.entries()]
        .filter(([, count]) => count === maxVotes)
        .map(([targetId]) => targetId);
      attackedId = tiedTargets[randomInt(tiedTargets.length)];
    }

    const doctor = alive.find((player) => player.role === 'Доктор' && !isBlocked(player));
    const protectedId = actionFor(doctor);
    const commissioner = alive.find((player) => player.role === 'Комиссар' && !isBlocked(player));
    const investigationId = actionFor(commissioner);
    if (commissioner && investigationId) {
      const suspect = findPlayer(room, investigationId);
      const socket = connections.get(commissioner.clientId);
      if (suspect && socket?.readyState === OPEN) {
        send(socket, {
          type: 'notification',
          message: `${suspect.name}: ${MAFIA_ROLES.has(suspect.role) ? 'принадлежит мафии' : 'не мафия'}`
        });
      }
    }

    if (attackedId) {
      const target = findPlayer(room, attackedId);
      if (target && protectedId === attackedId) {
        addJournal(room, 'Ночное нападение предотвращено доктором.');
      } else if (target?.alive) {
        target.alive = false;
        addJournal(room, `Утром обнаружено: ${target.name} выбыл из игры.`);
      }
    } else {
      addJournal(room, 'Город просыпается. Ночью никто не выбыл.');
    }

    room.actions.clear();
    const result = winner(room);
    if (result) {
      endGame(room, result);
      return;
    }
    addJournal(room, 'Наступил день. Обсуждение открыто.');
    beginPhase(room, DAY, room.dayDuration);
    broadcastRoomState(room);
  }

  function resolveVote(room) {
    const counts = new Map();
    for (const [voterId, targetId] of room.votes) {
      const voter = findPlayer(room, voterId);
      const target = targetId ? findPlayer(room, targetId) : null;
      if (!voter?.alive || !target?.alive) continue;
      counts.set(targetId, (counts.get(targetId) || 0) + 1);
    }

    if (counts.size) {
      const maxVotes = Math.max(...counts.values());
      const leaders = [...counts.entries()].filter(([, count]) => count === maxVotes);
      if (leaders.length === 1) {
        const eliminated = findPlayer(room, leaders[0][0]);
        if (eliminated?.alive) {
          eliminated.alive = false;
          addJournal(room, `${eliminated.name} исключён по итогам голосования.`);
        }
      } else {
        addJournal(room, 'Ничья: никто не исключён.');
      }
    } else {
      addJournal(room, 'Голосование завершено: никто не выбыл.');
    }

    room.votes.clear();
    room.actions.clear();
    const result = winner(room);
    if (result) {
      endGame(room, result);
      return;
    }
    room.round += 1;
    addJournal(room, `Раунд ${room.round}: наступила ночь.`);
    beginPhase(room, NIGHT, room.nightDuration);
    broadcastRoomState(room);
  }

  function advancePhase(room) {
    if (!room || room.status !== PLAYING || room.paused) return;
    if (room.phase === NIGHT) {
      resolveNight(room);
      return;
    }
    if (room.phase === DAY) {
      addJournal(room, 'Началось дневное голосование.');
      room.votes.clear();
      beginPhase(room, VOTING, room.dayDuration);
      broadcastRoomState(room);
      return;
    }
    if (room.phase === VOTING) resolveVote(room);
  }

  function hostForRoom(room, socket) {
    if (room.hostId !== socket.clientId) {
      sendError(socket, 'Это действие доступно только ведущему комнаты.');
      return false;
    }
    return true;
  }

  function notifyAll(room, message) {
    for (const player of room.players) {
      const socket = connections.get(player.clientId);
      if (socket?.readyState === OPEN) send(socket, { type: 'notification', message });
    }
  }

  function createRoom(socket, input) {
    if (roomFor(socket)) {
      sendError(socket, 'Сначала выйди из текущей комнаты.');
      return;
    }
    const requested = input && typeof input === 'object' ? input : {};
    const capacity = Number(requested.capacity);
    if (!CAPACITIES.has(capacity)) {
      sendError(socket, 'Выбери допустимое число игроков от 4 до 20.');
      return;
    }
    const code = makeCode(rooms);
    const room = {
      code,
      name: cleanText(requested.name, 32, 'Новая комната'),
      mode: cleanText(requested.mode, 24, 'Классическая'),
      capacity,
      privacy: requested.privacy === 'private' ? 'private' : 'public',
      created: Date.now(),
      hostId: socket.clientId,
      hostName: socket.playerName,
      players: [],
      status: WAITING,
      phase: 'Ожидание',
      round: 0,
      nightDuration: Math.min(300, Math.max(15, Math.trunc(Number(requested.nightDuration) || 60))),
      dayDuration: Math.min(600, Math.max(30, Math.trunc(Number(requested.dayDuration) || 180))),
      phaseDeadline: null,
      paused: false,
      pausedRemaining: 0,
      lastTimerValue: null,
      rolesAssigned: false,
      votes: new Map(),
      actions: new Map(),
      journal: [],
      chat: []
    };
    const player = {
      clientId: socket.clientId,
      name: socket.playerName,
      avatar: socket.avatar,
      connected: true,
      alive: true,
      role: null
    };
    room.players.push(player);
    rooms.set(code, room);
    socket.roomCode = code;
    addJournal(room, 'Лобби создано. Ожидаем игроков.');
    sendRoomState(room);
    broadcastRoomsList();
  }

  function joinRoom(socket, input) {
    const code = cleanText(input.code || input.roomCode || socket.roomCode || '', 12).toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      sendError(socket, 'Комната не найдена. Проверь код.');
      return;
    }
    const existing = findPlayer(room, socket.clientId);
    if (existing) {
      socket.roomCode = room.code;
      existing.connected = true;
      existing.name = socket.playerName;
      existing.avatar = socket.avatar;
      sendRoomState(room);
      if (existing.role) sendRole(room, existing);
      return;
    }
    if (roomFor(socket)) {
      sendError(socket, 'Сначала выйди из текущей комнаты.');
      return;
    }
    if (room.status !== WAITING) {
      sendError(socket, 'Игра уже началась — присоединиться можно только к лобби.');
      return;
    }
    if (room.players.length >= room.capacity) {
      sendError(socket, 'В комнате больше нет мест.');
      return;
    }
    const duplicateName = room.players.some((player) => player.name.toLocaleLowerCase('ru-RU') === socket.playerName.toLocaleLowerCase('ru-RU'));
    if (duplicateName) {
      sendError(socket, 'Это имя уже занято в комнате. Измени имя в профиле и попробуй снова.');
      return;
    }
    room.players.push({
      clientId: socket.clientId,
      name: socket.playerName,
      avatar: socket.avatar,
      connected: true,
      alive: true,
      role: null
    });
    socket.roomCode = room.code;
    promoteHost(room);
    addJournal(room, `${socket.playerName} присоединился к комнате.`);
    broadcastRoomState(room);
  }

  function promoteHost(room) {
    if (!room.players.length || room.players.some((player) => player.clientId === room.hostId && player.connected)) return;
    const next = room.players.find((player) => player.connected) || room.players[0];
    room.hostId = next.clientId;
    room.hostName = next.name;
    addJournal(room, `${next.name} стал ведущим.`);
  }

  function leaveRoom(socket) {
    const room = roomFor(socket);
    if (!room) {
      socket.roomCode = null;
      send(socket, { type: 'left_room' });
      return;
    }
    const leaving = findPlayer(room, socket.clientId);
    if (leaving) {
      room.players = room.players.filter((player) => player.clientId !== socket.clientId);
      room.votes.delete(socket.clientId);
      room.actions.delete(socket.clientId);
      if (room.hostId === socket.clientId) {
        room.hostId = null;
        promoteHost(room);
      }
      if (!room.players.length) {
        rooms.delete(room.code);
      } else {
        addJournal(room, `${leaving.name} покинул комнату.`);
        if (room.status === PLAYING) {
          const result = winner(room);
          if (result) endGame(room, result);
          else broadcastRoomState(room);
        } else {
          broadcastRoomState(room);
        }
      }
    }
    socket.roomCode = null;
    send(socket, { type: 'left_room' });
    broadcastRoomsList();
  }

  function startGame(socket, room) {
    if (!hostForRoom(room, socket)) return;
    if (room.status !== WAITING) {
      sendError(socket, 'Партия уже запущена.');
      return;
    }
    if (room.players.length < 4) {
      sendError(socket, 'Для начала нужно минимум 4 игрока.');
      return;
    }
    const roles = assignRoles(room.players.length);
    room.players.forEach((player, index) => {
      player.role = roles[index];
      player.alive = true;
    });
    room.rolesAssigned = true;
    room.status = PLAYING;
    room.round = 1;
    room.votes.clear();
    room.actions.clear();
    addJournal(room, 'Началась партия. Раунд 1 — ночь.');
    beginPhase(room, NIGHT, room.nightDuration);
    sendRoomState(room);
    for (const player of room.players) sendRole(room, player);
    notifyAll(room, 'Партия началась. Удачи!');
    broadcastRoomsList();
  }

  function submitPhaseAction(socket, room, message) {
    const player = findPlayer(room, socket.clientId);
    if (room.status !== PLAYING || room.phase !== NIGHT) {
      sendError(socket, 'Ночные действия доступны только ночью.');
      return;
    }
    if (!player?.alive) {
      sendError(socket, 'Выбывший игрок не может действовать.');
      return;
    }
    if (!SPECIAL_ROLES.has(player.role)) {
      sendError(socket, 'У твоей роли нет ночного действия.');
      return;
    }
    if (message.round != null && Number(message.round) !== room.round) {
      sendError(socket, 'Раунд уже изменился. Обнови состояние комнаты.');
      return;
    }
    if (room.actions.has(socket.clientId)) {
      sendError(socket, 'Ночное действие уже отправлено в этом раунде.');
      return;
    }
    const targetName = cleanText(message.target, 32);
    const target = room.players.find((candidate) => candidate.name === targetName && candidate.alive);
    if (!target || target.clientId === socket.clientId) {
      sendError(socket, 'Выбери другого живого игрока.');
      return;
    }
    if (MAFIA_ROLES.has(player.role) && MAFIA_ROLES.has(target.role)) {
      sendError(socket, 'Мафия не может выбирать целью участника своей команды.');
      return;
    }
    room.actions.set(socket.clientId, { targetId: target.clientId, round: room.round });
    send(socket, { type: 'notification', message: 'Ночное действие принято.' });
  }

  function submitVote(socket, room, message) {
    const voter = findPlayer(room, socket.clientId);
    if (room.status !== PLAYING || room.phase !== VOTING) {
      sendError(socket, 'Голосовать можно только во время голосования.');
      return;
    }
    if (!voter?.alive) {
      sendError(socket, 'Выбывший игрок не может голосовать.');
      return;
    }
    if (message.round != null && Number(message.round) !== room.round) {
      sendError(socket, 'Раунд уже изменился. Обнови состояние комнаты.');
      return;
    }
    if (room.votes.has(socket.clientId)) {
      sendError(socket, 'Ты уже проголосовал в этом раунде.');
      return;
    }

    let targetId = null;
    if (!message.abstain && message.target != null && message.target !== '') {
      const targetName = cleanText(message.target, 32);
      const target = room.players.find((candidate) => candidate.name === targetName && candidate.alive);
      if (!target || target.clientId === socket.clientId) {
        sendError(socket, 'Выбери другого живого игрока.');
        return;
      }
      targetId = target.clientId;
    }
    room.votes.set(socket.clientId, targetId);
    broadcastRoomState(room);
  }

  function hostAction(socket, room, action) {
    if (!hostForRoom(room, socket)) return;
    if (action === 'start_game') {
      startGame(socket, room);
      return;
    }
    if (action === 'next_phase') {
      if (room.status !== PLAYING) {
        sendError(socket, 'Сначала начни партию.');
        return;
      }
      advancePhase(room);
      return;
    }
    if (action === 'pause' || action === 'resume') {
      if (room.status !== PLAYING) {
        sendError(socket, 'Пауза доступна только во время партии.');
        return;
      }
      if (action === 'pause' && !room.paused) {
        room.pausedRemaining = timerSeconds(room) ?? 0;
        room.paused = true;
        room.phaseDeadline = null;
        notifyAll(room, 'Ведущий поставил партию на паузу.');
      } else if (action === 'resume' && room.paused) {
        room.paused = false;
        room.phaseDeadline = Date.now() + Math.max(1, room.pausedRemaining) * 1000;
        room.pausedRemaining = 0;
        notifyAll(room, 'Ведущий возобновил партию.');
      }
      room.lastTimerValue = timerSeconds(room);
      sendRoomState(room);
      return;
    }
    if (action === 'finish_game') {
      if (room.status !== PLAYING) {
        sendError(socket, 'Партия уже завершена или ещё не началась.');
        return;
      }
      endGame(room, 'Ведущий завершил партию.');
      return;
    }
    sendError(socket, 'Неизвестное действие ведущего.');
  }

  function updateProfile(socket, message) {
    const nextName = cleanText(message.playerName || socket.playerName, 24, 'Игрок');
    const room = roomFor(socket);
    const player = findPlayer(room, socket.clientId);
    if (room && room.players.some((candidate) => candidate.clientId !== socket.clientId
      && candidate.name.toLocaleLowerCase('ru-RU') === nextName.toLocaleLowerCase('ru-RU'))) {
      sendError(socket, 'Это имя уже занято в комнате.');
      return;
    }
    socket.playerName = nextName;
    socket.avatar = cleanAvatar(message.avatar || socket.avatar);
    if (player) {
      player.name = socket.playerName;
      player.avatar = socket.avatar;
      broadcastRoomState(room);
    }
  }

  function handleHello(socket, message) {
    if (message.protocol !== PROTOCOL) {
      sendError(socket, `Несовместимый протокол. Нужен ${PROTOCOL}.`);
      socket.close(1008, 'Unsupported protocol');
      return;
    }
    const clientId = cleanClientId(message.clientId);
    if (!clientId) {
      sendError(socket, 'Не удалось проверить идентификатор клиента. Перезагрузи страницу.');
      socket.close(1008, 'Invalid client id');
      return;
    }

    const previous = connections.get(clientId);
    socket.clientId = clientId;
    socket.playerName = cleanText(message.playerName, 24, 'Игрок');
    socket.avatar = cleanAvatar(message.avatar);
    socket.handshaken = true;
    connections.set(clientId, socket);
    if (previous && previous !== socket && previous.readyState === OPEN) {
      previous.close(4001, 'This client reconnected elsewhere');
    }

    send(socket, { type: 'hello_ack', protocol: PROTOCOL, server: 'MAFIA', version: '1.0.0' });
    sendRoomsList(socket);

    for (const room of rooms.values()) {
      const player = findPlayer(room, clientId);
      if (!player) continue;
      const conflictingName = room.players.some((candidate) => candidate.clientId !== clientId
        && candidate.name.toLocaleLowerCase('ru-RU') === socket.playerName.toLocaleLowerCase('ru-RU'));
      if (!conflictingName) player.name = socket.playerName;
      player.avatar = socket.avatar;
      player.connected = true;
      socket.roomCode = room.code;
      send(socket, { type: 'room_state', state: roomState(room, clientId) });
      if (room.status === PLAYING && player.role) sendRole(room, player);
      broadcastRoomState(room);
      break;
    }
  }

  function handleMessage(socket, message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
      sendError(socket, 'Ожидалось JSON-сообщение с полем type.');
      return;
    }
    if (!socket.handshaken) {
      if (message.type !== 'hello') {
        sendError(socket, 'Сначала выполни handshake протокола Mafia-2026.');
        return;
      }
      handleHello(socket, message);
      return;
    }

    switch (message.type) {
      case 'hello':
        sendError(socket, 'Handshake уже выполнен.');
        break;
      case 'list_rooms':
        sendRoomsList(socket);
        break;
      case 'create_room':
        createRoom(socket, message.room);
        break;
      case 'join_room':
        joinRoom(socket, message);
        break;
      case 'leave_room':
        leaveRoom(socket);
        break;
      case 'update_profile':
        updateProfile(socket, message);
        break;
      case 'start_game': {
        const room = roomFor(socket);
        if (!room) sendError(socket, 'Сначала войди в комнату.');
        else startGame(socket, room);
        break;
      }
      case 'phase_action': {
        const room = roomFor(socket);
        if (!room) sendError(socket, 'Сначала войди в комнату.');
        else submitPhaseAction(socket, room, message);
        break;
      }
      case 'vote': {
        const room = roomFor(socket);
        if (!room) sendError(socket, 'Сначала войди в комнату.');
        else submitVote(socket, room, message);
        break;
      }
      case 'chat': {
        const room = roomFor(socket);
        const player = findPlayer(room, socket.clientId);
        const text = cleanText(message.message, 300);
        if (!room || !player) sendError(socket, 'Сначала войди в комнату.');
        else if (!text) sendError(socket, 'Сообщение не должно быть пустым.');
        else {
          room.chat.push({
            playerName: player.name,
            avatar: player.avatar,
            message: text,
            time: Date.now()
          });
          if (room.chat.length > MAX_CHAT_MESSAGES) room.chat.splice(0, room.chat.length - MAX_CHAT_MESSAGES);
          broadcastRoomState(room);
        }
        break;
      }
      case 'host_action': {
        const room = roomFor(socket);
        if (!room) sendError(socket, 'Сначала войди в комнату.');
        else hostAction(socket, room, cleanText(message.action, 32));
        break;
      }
      default:
        sendError(socket, 'Неизвестная команда протокола Mafia-2026.');
    }
  }

  function detachSocket(socket) {
    if (!socket.clientId || connections.get(socket.clientId) !== socket) return;
    connections.delete(socket.clientId);
    const room = roomFor(socket);
    const player = findPlayer(room, socket.clientId);
    if (!room || !player) return;
    player.connected = false;
    if (room.hostId === socket.clientId) promoteHost(room);
    broadcastRoomState(room);
  }

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isAllowedOrigin(request.headers.origin, env)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (socket) => {
    socket.handshaken = false;
    socket.clientId = null;
    socket.roomCode = null;
    socket.isAlive = true;
    socket.messageTimes = [];
    socket.joinAttempts = [];

    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (raw) => {
      const now = Date.now();
      socket.messageTimes = socket.messageTimes.filter((time) => now - time < 10_000);
      if (socket.messageTimes.length >= 80) {
        sendError(socket, 'Слишком много запросов. Подожди немного.');
        return;
      }
      socket.messageTimes.push(now);
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendError(socket, 'Некорректный JSON.');
        return;
      }
      if (message?.type === 'join_room') {
        socket.joinAttempts = socket.joinAttempts.filter((time) => now - time < 60_000);
        if (socket.joinAttempts.length >= 12) {
          sendError(socket, 'Слишком много попыток входа. Попробуй позже.');
          return;
        }
        socket.joinAttempts.push(now);
      }
      try {
        handleMessage(socket, message);
      } catch (error) {
        logger.error?.('Mafia server message failed:', error);
        sendError(socket, 'Не удалось обработать запрос. Попробуй ещё раз.');
      }
    });
    socket.on('close', () => detachSocket(socket));
    socket.on('error', (error) => logger.warn?.('WebSocket connection error:', error.message));
  });

  const heartbeat = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 25_000);
  heartbeat.unref?.();

  const gameClock = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.status !== PLAYING || room.paused) continue;
      const seconds = timerSeconds(room, now);
      if (seconds === 0) {
        advancePhase(room);
      } else if (seconds !== room.lastTimerValue) {
        room.lastTimerValue = seconds;
        sendTimer(room);
      }
    }
  }, 250);
  gameClock.unref?.();

  function close() {
    clearInterval(heartbeat);
    clearInterval(gameClock);
    for (const socket of webSocketServer.clients) socket.terminate();
    return new Promise((resolve) => {
      webSocketServer.close(() => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close(() => resolve());
      });
    });
  }

  return { httpServer, webSocketServer, rooms, connections, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { httpServer } = createGameServer();
  const port = Number(process.env.PORT) || 10_000;
  const host = process.env.HOST || '0.0.0.0';
  httpServer.listen(port, host, () => {
    console.log(`MAFIA server (${PROTOCOL}) listening on ${host}:${port}`);
  });
  httpServer.on('error', (error) => {
    console.error('Unable to start MAFIA server:', error);
    process.exitCode = 1;
  });
}
