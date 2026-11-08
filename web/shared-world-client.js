const get = id => document.getElementById(id);
const names = { a: '甲', b: '乙' };
const movement = ['north', 'south', 'west', 'east'];
const combat = ['attack', 'heavy', 'guard'];
const keyboard = { ArrowUp: 'north', ArrowDown: 'south', ArrowLeft: 'west', ArrowRight: 'east' };
let token, current, visual, busy = false, initializing = false, pendingView;
let desiredDirection = null;
const network = new Worker('/shared-world-network.js', { type: 'module' });
const heldKeys = new Map();
const svg = tag => document.createElementNS('http://www.w3.org/2000/svg', tag);

function marker(x, z, label, color, player) {
  const group = svg('g');
  if (player) group.dataset.player = player;
  group.setAttribute('transform', 'translate(' + x + ' ' + z + ')');
  const dot = svg('circle'), text = svg('text');
  dot.setAttribute('r', '1.4');
  dot.setAttribute('fill', color);
  text.setAttribute('y', '-2');
  text.textContent = label;
  group.append(dot, text);
  return group;
}

function render(view) {
  if (current?.epoch === view.epoch && current.revision > view.revision) return;
  if (current && current.epoch !== view.epoch) { heldKeys.clear(); desiredDirection = null; }
  current = view;
  if (view.battle && desiredDirection) setDirection(null);
  const { self, arena, monster, players, battle } = view;
  const markers = get('markers');
  if (markers) {
    markers.replaceChildren(...Object.entries(players).map(([id, p]) =>
      marker(p.x - arena.x, p.z - arena.z, names[id], id === self ? '#6ad6f0' : '#f5d278', id)));
    markers.append(marker(0, 0, '怪', monster.status === 'defeated' ? '#9e9e9e' : '#ee947c'));
  }
  visual?.update(view);
  get('identity').textContent = '玩家' + names[self] + ' · ' + arena.region;
  get('monster').textContent = monster.name + ' · ' +
    ({ available: '可接触', engaged: '战斗中', defeated: '已击败' })[monster.status];
  get('battle').hidden = !battle;
  get('battle-info').textContent = battle ?
    '怪物 ' + battle.hp + '/' + battle.maxHp + ' · 队伍气血 ' + battle.partyHp + (battle.log ? ' · ' + battle.log : '') : '';
  for (const id of movement) get(id).disabled = !!battle;
  get('world').dataset.view = JSON.stringify(view);
  get('world').hidden = false;
}

network.onmessage = async ({ data }) => {
  if (data.type === 'error' || data.type === 'connect-error') {
    heldKeys.clear();
    desiredDirection = null;
    get('notice').textContent = data.error;
    if (data.type === 'connect-error') busy = false;
    return;
  }
  if (data.type === 'view') {
    if (initializing) pendingView = data.view;
    else if (current) { render(data.view); get('notice').textContent = ''; }
    return;
  }
  if (data.type !== 'connected') return;
  initializing = true;
  try {
    if (get('scene3d') && !visual) {
      get('notice').textContent = '正在载入地形和角色…';
      const { createSharedScene } = await import('/shared-world-3d.js');
      visual = await createSharedScene(get('scene3d'), data.view, data.terrain);
    }
    render(pendingView ?? data.view);
    get('token').value = '';
    get('connect').hidden = true;
    get('notice').textContent = '';
  } catch (error) {
    get('notice').textContent = error.message;
  } finally { busy = false; initializing = false; pendingView = undefined; }
};
get('connect').onsubmit = event => {
  event.preventDefault();
  if (busy || current) return;
  busy = true;
  token = get('token').value;
  network.postMessage({ type: 'connect', token, threeD: !!get('scene3d') });
};
function setDirection(direction) {
  if (!current || desiredDirection === direction) return;
  desiredDirection = direction;
  network.postMessage({ type: 'direction', direction });
}

function releaseInput() {
  heldKeys.clear();
  setDirection(null);
}
for (const direction of movement) {
  const button = get(direction);
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    setDirection(direction);
  });
  button.addEventListener('pointerup', releaseInput);
  button.addEventListener('pointercancel', releaseInput);
  button.addEventListener('lostpointercapture', releaseInput);
  button.addEventListener('click', event => {
    // Keyboard activation of a movement button produces a short, bounded hold.
    if (event.detail === 0) {
      setDirection(direction);
      setTimeout(() => { if (desiredDirection === direction) releaseInput(); }, 200);
    }
  });
}
for (const action of combat) get(action).onclick = () => {
  if (current?.battle) network.postMessage({ type: 'combat', action });
};
window.addEventListener('keydown', event => {
  const direction = keyboard[event.key];
  if (current && direction && !current.battle && event.target.tagName !== 'INPUT') {
    event.preventDefault();
    if (heldKeys.has(event.key) || event.repeat) return;
    heldKeys.set(event.key, direction);
    setDirection(direction);
  }
});
window.addEventListener('keyup', event => {
  if (!heldKeys.delete(event.key)) return;
  event.preventDefault();
  setDirection([...heldKeys.values()].at(-1) ?? null);
});
window.addEventListener('blur', releaseInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseInput(); });
window.addEventListener('pagehide', () => {
  if (!current || !token) return;
  heldKeys.clear();
  desiredDirection = null;
  network.postMessage({ type: 'direction', direction: null });
  // Lease expiry also bounds movement when this best-effort release is lost.
  void fetch('/intent', {
    method: 'POST', keepalive: true,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ epoch: current.epoch, seq: current.nextSeq, type: 'stop' }),
  }).catch(() => {});
});
