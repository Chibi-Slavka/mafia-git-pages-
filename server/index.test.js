import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { assignRoles, createGameServer, PROTOCOL } from './index.js';

function makeClient(socket, name) {
  const messages = [];
  const waiters = [];
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });

  function waitFor(type, predicate = () => true, timeoutMs = 2500) {
    const index = messages.findIndex((message) => message.type === type && predicate(message));
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: (message) => message.type === type && predicate(message),
        resolve,
        timeout: setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeoutMs)
      };
      waiters.push(waiter);
    });
  }

  return {
    socket,
    name,
    waitFor,
    send(message) {
      socket.send(JSON.stringify(message));
    },
    close() {
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise((resolve) => {
        socket.once('close', resolve);
        socket.close();
      });
    }
  };
}

async function startHarness(t) {
  const app = createGameServer({
    env: { ALLOWED_ORIGINS: '*' },
    logger: { error() {}, warn() {} }
  });
  app.httpServer.listen(0, '127.0.0.1');
  await once(app.httpServer, 'listening');
  const address = app.httpServer.address();
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    await app.close();
  });

  async function connect(name, clientId = `client-${Buffer.from(name).toString('hex')}`) {
    const socket = new WebSocket(url, { origin: 'http://localhost:8000' });
    await once(socket, 'open');
    const client = makeClient(socket, name);
    clients.push(client);
    client.send({
      type: 'hello',
      protocol: PROTOCOL,
      clientId,
      playerName: name,
      avatar: '🎭'
    });
    await client.waitFor('hello_ack');
    await client.waitFor('rooms_list');
    return client;
  }

  return { app, connect };
}

test('role deck matches the app rules and always fills the table', () => {
  for (const count of [4, 5, 6, 7, 8, 12, 20]) {
    const roles = assignRoles(count);
    assert.equal(roles.length, count);
    assert.equal(roles.filter((role) => role === 'Мафия').length, Math.max(1, Math.floor(count / 4)));
    assert.equal(roles.filter((role) => role === 'Мирный житель').length + roles.filter((role) => role !== 'Мирный житель').length, count);
  }
  assert.throws(() => assignRoles(3), RangeError);
});

test('HTTP health endpoint reports the protocol', async (t) => {
  const { app } = await startHarness(t);
  const address = app.httpServer.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.protocol, PROTOCOL);
});

test('players can create and join a room, and role data stays private', async (t) => {
  const { connect } = await startHarness(t);
  const host = await connect('Хозяин');
  host.send({
    type: 'create_room',
    room: {
      name: 'Ночная смена',
      mode: 'Классическая',
      capacity: 4,
      privacy: 'public',
      nightDuration: 60,
      dayDuration: 180
    }
  });
  const created = await host.waitFor('room_state', (message) => message.state?.status === 'Ожидание игроков');
  const code = created.state.code;
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
  assert.equal(created.state.players.length, 1);
  assert.equal(created.state.isHost, true);

  const players = [host];
  for (const name of ['Игрок 2', 'Игрок 3', 'Игрок 4']) {
    const client = await connect(name);
    client.send({ type: 'join_room', code, playerName: name });
    const joined = await client.waitFor('room_state', (message) => message.state?.players.length === players.length + 1);
    assert.equal(joined.state.code, code);
    players.push(client);
    await host.waitFor('room_state', (message) => message.state?.players.length === players.length);
  }

  players[1].send({ type: 'start_game' });
  const denied = await players[1].waitFor('error');
  assert.match(denied.message, /только ведущему/i);

  host.send({ type: 'start_game' });
  const hostStarted = await host.waitFor('room_state', (message) => message.state?.status === 'Игра началась');
  const states = new Map([[host.name, hostStarted.state]]);
  const ownRole = hostStarted.state.players.find((player) => player.name === host.name)?.role;
  assert.ok(ownRole);
  assert.equal(hostStarted.state.players.filter((player) => player.role).length, 1);

  for (const client of players.slice(1)) {
    const started = await client.waitFor('room_state', (message) => message.state?.status === 'Игра началась');
    const privateRole = started.state.players.find((player) => player.name === client.name)?.role;
    assert.equal(started.state.players.filter((player) => player.role).length, 1);
    assert.ok(privateRole);
    states.set(client.name, started.state);
  }

  const mafiaClient = players.find((client) => states.get(client.name).players
    .some((player) => player.name === client.name && player.role === 'Мафия'));
  assert.ok(mafiaClient);
  const mafiaTarget = players.find((client) => client.name !== mafiaClient.name).name;
  mafiaClient.send({ type: 'phase_action', target: mafiaTarget, round: 1 });
  await mafiaClient.waitFor('notification', (message) => message.message === 'Ночное действие принято.');

  host.send({ type: 'host_action', action: 'next_phase' });
  const dayState = await host.waitFor('room_state', (message) => message.state?.phase === 'День');
  host.send({ type: 'host_action', action: 'next_phase' });
  await host.waitFor('room_state', (message) => message.state?.phase === 'Голосование');

  const livingPlayers = players.filter((client) => dayState.state.players
    .some((player) => player.name === client.name && player.alive));
  for (const client of livingPlayers) {
    if (client === mafiaClient) client.send({ type: 'vote', abstain: true });
    else client.send({ type: 'vote', target: mafiaClient.name, round: 1 });
  }
  await host.waitFor('room_state', (message) => message.state?.phase === 'Голосование'
    && Object.keys(message.state.votes).length === livingPlayers.length);
  host.send({ type: 'host_action', action: 'next_phase' });
  const finished = await host.waitFor('room_state', (message) => message.state?.status === 'Партия завершена');
  assert.ok(finished.state.journal.some((entry) => entry.text === 'Победа города!'));
});
