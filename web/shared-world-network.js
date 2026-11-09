let token, current, busy = false, polling = false;
let desiredDirection = null, inputDirty = false, pendingIntent = null;

async function request(path, body) {
  const response = await fetch(path, {
    headers: { Authorization: 'Bearer ' + token, ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { method: 'POST', body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}
function publish(view) {
  if (current?.epoch === view.epoch && current.revision > view.revision) return;
  if (current && current.epoch !== view.epoch) {
    desiredDirection = null; inputDirty = false; pendingIntent = null;
  }
  current = view;
  if (view.battle && desiredDirection) { desiredDirection = null; inputDirty = true; }
  postMessage({ type: 'view', view });
}
function failed(error) {
  desiredDirection = null;
  inputDirty = false;
  pendingIntent = null;
  postMessage({ type: 'error', error: error.message });
}
async function pump() {
  if (!current || busy) return;
  let input;
  if (inputDirty) {
    inputDirty = false;
    input = desiredDirection ? { type: 'move', direction: desiredDirection } : { type: 'stop' };
  } else if (pendingIntent) { input = pendingIntent; pendingIntent = null; }
  else return;
  busy = true;
  try {
    publish(await request('/intent', { epoch: current.epoch, seq: current.nextSeq, ...input }));
  } catch (error) { failed(error); }
  finally {
    busy = false;
    if (inputDirty || pendingIntent) void pump();
  }
}
self.onmessage = async ({ data }) => {
  if (data.type === 'connect') {
    if (busy) return;
    busy = true;
    current = null;
    token = data.token;
    try {
      const view = await request('/state');
      const terrain = data.threeD ? await request('/terrain') : undefined;
      current = view;
      postMessage({ type: 'connected', view, terrain });
    } catch (error) { postMessage({ type: 'connect-error', error: error.message }); }
    finally { busy = false; }
    return;
  }
  if (!current) return;
  if (data.type === 'direction') {
    desiredDirection = data.direction;
    inputDirty = true;
  }
  if (data.type === 'joinBattle' && !current.battle && !pendingIntent && current.joinOffers.some(offer => offer.battleId === data.battleId)) {
    pendingIntent = { type: 'joinBattle', battleId: data.battleId };
    if (desiredDirection) { desiredDirection = null; inputDirty = true; }
  }
  if (data.type === 'combat' && current.battle && !pendingIntent) {
    pendingIntent = { type: 'combat', battleId: current.battle.id, action: data.action };
    if (desiredDirection) { desiredDirection = null; inputDirty = true; }
  }
  void pump();
};
setInterval(async () => {
  if (!current || !token) return;
  if (desiredDirection && !current.battle) {
    inputDirty = true;
    void pump();
  }
  if (busy || polling) return;
  polling = true;
  try { publish(await request('/state')); }
  catch (error) { failed(error); }
  finally { polling = false; }
}, 200);
