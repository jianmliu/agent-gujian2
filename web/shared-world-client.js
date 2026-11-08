const get = id => document.getElementById(id);
const names = { a: '甲', b: '乙' };
const movement = ['north', 'south', 'west', 'east'];
const combat = ['attack', 'heavy', 'guard'];
const keyboard = { ArrowUp: 'north', ArrowDown: 'south', ArrowLeft: 'west', ArrowRight: 'east' };
let token, current, visual, busy = false, polling = false;
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
  current = view;
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

async function request(path, body) {
  const response = await fetch(path, {
    headers: { Authorization: 'Bearer ' + token, ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { method: 'POST', body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}

get('connect').onsubmit = async event => {
  event.preventDefault();
  if (busy || polling || current) return;
  busy = true;
  token = get('token').value;
  try {
    const view = await request('/state');
    if (get('scene3d') && !visual) {
      get('notice').textContent = '正在载入地形和角色…';
      const { createSharedScene } = await import('/shared-world-3d.js');
      visual = await createSharedScene(get('scene3d'), view, await request('/terrain'));
    }
    render(view);
    get('token').value = '';
    get('connect').hidden = true;
    get('notice').textContent = '';
  } catch (error) {
    token = undefined;
    get('notice').textContent = error.message;
  } finally { busy = false; }
};
async function submit(input) {
  if (!current || busy) return;
  busy = true;
  try {
    render(await request('/intent', { epoch: current.epoch, seq: current.nextSeq, ...input }));
    get('notice').textContent = '';
  } catch (error) {
    get('notice').textContent = error.message;
  } finally { busy = false; }
}

for (const direction of movement) get(direction).onclick = () => submit({ type: 'move', direction });
for (const action of combat) get(action).onclick = () => {
  if (current?.battle) submit({ type: 'combat', battleId: current.battle.id, action });
};
window.addEventListener('keydown', event => {
  const direction = keyboard[event.key];
  if (current && direction && !current.battle && event.target.tagName !== 'INPUT') {
    event.preventDefault();
    get(direction).click();
  }
});
setInterval(async () => {
  if (!current || !token || busy || polling) return;
  polling = true;
  try { render(await request('/state')); }
  catch (error) { get('notice').textContent = error.message; }
  finally { polling = false; }
}, 200);
