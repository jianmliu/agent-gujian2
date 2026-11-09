import * as THREE from 'three';
import { loadCharProto, makeChar, animateChar, loadProps, makeProp } from '/render/assets.js';
import { buildBeast, animateBeast, makeLabelSprite } from '/render/entities.js';

function groundMesh(data, texture, baseHeight) {
  const vertices = [], uv = [], indices = [];
  const { size, radius, spacing, arena } = data;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = -radius + column * spacing, z = -radius + row * spacing;
      vertices.push(x, data.heights[row * size + column] - baseHeight, z);
      uv.push((arena.x + x - data.originX) / data.worldW, (arena.z + z - data.originZ) / data.worldH);
      if (row < size - 1 && column < size - 1) {
        const a = row * size + column;
        indices.push(a, a + size, a + 1, a + 1, a + size, a + size + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }));
}

export async function createSharedScene(canvas, initial, terrain) {
  const [texture] = await Promise.all([
    new THREE.TextureLoader().loadAsync('/assets/world.colormap.png'),
    loadCharProto('101'), loadCharProto('103'),
  ]);
  texture.colorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#a9c2b5');
  scene.fog = new THREE.Fog('#a9c2b5', 42, 76);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.1, 150);
  scene.add(new THREE.HemisphereLight('#e7f0ff', '#485640', 2.3));
  const sun = new THREE.DirectionalLight('#fff1da', 2.4);
  sun.position.set(-15, 30, 12);
  scene.add(sun);
  const baseHeight = initial.monsters['trial-1'].y;
  scene.add(groundMesh(terrain, texture, baseHeight));

  const boundary = [];
  const extent = initial.arena.extent;
  for (let side = 0; side < 4; side++) {
    for (let step = -extent; step < extent; step++) {
      const [x, z] = [[step, -extent], [extent, step], [-step, extent], [-extent, -step]][side];
      const row = Math.round((z + terrain.radius) / terrain.spacing);
      const column = Math.round((x + terrain.radius) / terrain.spacing);
      boundary.push(new THREE.Vector3(x, terrain.heights[row * terrain.size + column] - baseHeight + 0.08, z));
    }
  }
  scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(boundary),
    new THREE.LineBasicMaterial({ color: '#d8c99b', transparent: true, opacity: 0.6 })));

  const actors = new Map();
  const roster = document.getElementById('roster');
  for (const [id, model] of [['a', '101'], ['b', '103']]) {
    const character = makeChar(model);
    const label = '玩家' + (id === 'a' ? '甲' : '乙') + (id === initial.self ? ' · 你' : '');
    const sprite = makeLabelSprite(label, id === initial.self ? '#93e4ff' : '#ffdb8c');
    sprite.position.y = (character.height + 0.5) / character.group.scale.x;
    sprite.scale.divideScalar(character.group.scale.x);
    character.group.add(sprite);
    scene.add(character.group);
    actors.set(id, { ...character, target: new THREE.Vector3(), attackAt: -10 });
    const item = document.createElement('span');
    item.dataset.player = id;
    item.textContent = label + ' ';
    roster.append(item);
  }

  const beasts = new Map();
  for (const monster of Object.values(initial.monsters)) {
    const beast = buildBeast(monster.id === 'trial-1' ? 0x775267 : 0x557a61, 1.5);
    beast.group.position.set(monster.x - initial.arena.x, monster.y - baseHeight, monster.z - initial.arena.z);
    const label = makeLabelSprite(monster.name, '#ffd3bd');
    label.position.y = 1.65;
    beast.group.add(label);
    scene.add(beast.group);
    beasts.set(monster.id, beast);
  }
  if (terrain.props.length) {
    const prototypes = new Map((await loadProps()).map(prop => [prop.name, prop]));
    for (const prop of terrain.props) {
      const prototype = prototypes.get(prop.name);
      if (!prototype) throw Error('建筑模型缺失');
      const mesh = makeProp(prototype);
      mesh.position.set(prop.x - initial.arena.x, prop.y - baseHeight, prop.z - initial.arena.z);
      mesh.rotation.y = prop.rot;
      mesh.scale.setScalar(prop.scale);
      scene.add(mesh);
    }
  }

  let view, previousTime, animation, dragging, angle = 0, distance = 13, stopped = false;
  const target = new THREE.Vector3(), clip = new THREE.Vector3();
  function update(next) {
    const snap = !view || view.epoch !== next.epoch;
    for (const [id, actor] of actors) {
      const position = next.players[id];
      actor.target.set(position.x - next.arena.x, position.y - baseHeight, position.z - next.arena.z);
      if (snap) actor.group.position.copy(actor.target);
    }
    if (view?.battle && next.battle?.id === view.battle.id && next.battle.actionUntilTick > view.battle.actionUntilTick) actors.get(next.self).attackAt = performance.now() / 1000;
    for (const [id, beast] of beasts) beast.group.visible = next.monsters[id].status !== 'defeated';
    view = next;
  }
  update(initial);
  const resize = new ResizeObserver(() => {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  resize.observe(canvas);
  renderer.setSize(960, 540, false);
  canvas.addEventListener('pointerdown', event => {
    dragging = { x: event.clientX, angle };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (dragging) angle = dragging.angle + (event.clientX - dragging.x) * 0.008;
  });
  canvas.addEventListener('pointerup', () => { dragging = null; });
  canvas.addEventListener('pointercancel', () => { dragging = null; });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    distance = THREE.MathUtils.clamp(distance + event.deltaY * 0.012, 9, 34);
  }, { passive: false });

  function frame(now) {
    if (stopped) return;
    const dt = previousTime === undefined ? 0 : Math.min((now - previousTime) / 1000, 0.1);
    previousTime = now;
    for (const actor of actors.values()) {
      const before = actor.group.position.clone();
      actor.group.position.lerp(actor.target, 1 - Math.exp(-18 * dt));
      const dx = actor.target.x - before.x, dz = actor.target.z - before.z;
      if (Math.hypot(dx, dz) > 0.015) actor.group.rotation.y = Math.atan2(dx, dz);
      const speed = dt ? before.distanceTo(actor.group.position) / dt : 0;
      const attack = Math.max(0, 1 - (now / 1000 - actor.attackAt) * 3);
      animateChar(actor.parts, speed, now / 1000, attack);
    }
    for (const beast of beasts.values()) animateBeast(beast, 0, now / 1000);
    target.copy(actors.get(view.self).group.position).add(new THREE.Vector3(0, 1.2, 0));
    camera.position.set(target.x + Math.sin(angle) * distance, target.y + distance * 0.65, target.z + Math.cos(angle) * distance);
    camera.lookAt(target);
    renderer.render(scene, camera);
    canvas.dataset.render = JSON.stringify({
      drawCalls: renderer.info.render.calls,
      monsters: [...beasts].map(([id, beast]) => ({ id, visible: beast.group.visible,
        x: beast.group.position.x + view.arena.x, z: beast.group.position.z + view.arena.z })),
      actors: [...actors].map(([id, actor]) => {
        clip.copy(actor.group.position).add(new THREE.Vector3(0, actor.height / 2, 0)).project(camera);
        return {
          id, x: actor.group.position.x + view.arena.x, z: actor.group.position.z + view.arena.z,
          visible: Math.abs(clip.x) < 1 && Math.abs(clip.y) < 1 && clip.z > -1 && clip.z < 1,
          skinned: actor.parts.mesh.isSkinnedMesh,
        };
      }),
    });
    canvas.dataset.ready = 'true';
    animation = requestAnimationFrame(frame);
  }
  animation = requestAnimationFrame(frame);
  window.addEventListener('pagehide', () => {
    stopped = true;
    cancelAnimationFrame(animation);
    resize.disconnect();
    renderer.dispose();
  }, { once: true });
  return { update };
}
