import { livingLeader } from './shared-battle-lifecycle.js';
import { syncBattleClock, validBattleClock, performTimedAction } from './shared-battle-clock.js';

const personalFields = ['combo_step', 'victories', 'dodges_succeeded', 'shields_broken',
  'ultimates_triggered', 'companion_attacks', 'companion_heals', 'puppet_strikes', 'last_combat_log'];
const defenseFields = ['iframeUntil', 'guardUntil', 'actionUntil', 'defenseUntil'];
const derivedFields = ['iframe_timer', 'guard_active', 'telegraph_active', 'telegraph_timer'];
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));
const sharedCombat = combat => Object.fromEntries(Object.entries(combat)
  .filter(([key]) => !personalFields.includes(key) && !derivedFields.includes(key)));

export function cooperativeBattle(old) {
  return { id: old.id, monsterId: old.monsterId, combat: sharedCombat(old.combat),
    clock: { version: 2, ...pick(old.clock, ['phase', 'phaseUntil', 'strikes']) },
    participants: { [old.owner]: { combat: pick(old.combat, personalFields), clock: pick(old.clock, defenseFields) } } };
}

// Only this temporary native context combines enemy and participant components.
export function participantBattle(battle, id) {
  const member = battle.participants[id];
  return { combat: { ...battle.combat, ...member.combat },
    clock: { ...battle.clock, ...member.clock, version: 1 } };
}
function saveParticipant(battle, id, temporary) {
  battle.participants[id] = { combat: pick(temporary.combat, personalFields), clock: pick(temporary.clock, defenseFields) };
}
export function addParticipant(battle, id, initialCombat) {
  battle.participants[id] = { combat: pick(initialCombat, personalFields),
    clock: Object.fromEntries(defenseFields.map(key => [key, 0])) };
}
export function performCooperativeAction(engine, battle, id, party, action, tick) {
  const temporary = participantBattle(battle, id);
  engine.leaderIdx = livingLeader(party);
  performTimedAction(engine, temporary, party, action, tick, { livingOnly: true });
  saveParticipant(battle, id, temporary);
  battle.combat = sharedCombat(temporary.combat);
}
export function advanceCooperativeBattle(engines, battle, parties, tick) {
  const c = battle.clock;
  if (tick < c.phaseUntil) return;
  if (c.phase === 'warning') {
    for (const id of Object.keys(battle.participants).sort()) {
      if (parties[id].life?.status === 'downed') continue;
      const temporary = participantBattle(battle, id), engine = engines[id];
      syncBattleClock(temporary, tick);
      engine.party = parties[id].party; engine.combat = temporary.combat;
      engine.leaderIdx = livingLeader(engine.party);
      temporary.combat.last_combat_log = engine.resolveEnemyAttack({ timed: true, lethal: true });
      temporary.clock.guardUntil = 0;
      saveParticipant(battle, id, temporary);
    }
    c.strikes++;
    c.phase = 'recovery'; c.phaseUntil = tick + 20;
  } else {
    c.phase = 'warning'; c.phaseUntil = tick + 30;
  }
}
export function validCooperativeBattle(battle, tick, occupied) {
  const members = battle.participants;
  if (battle.owner !== undefined || battle.clock?.version !== 2 || !members || Array.isArray(members) ||
      ![1, 2].includes(Object.keys(members).length) ||
      Object.keys(battle.clock).sort().join() !== 'phase,phaseUntil,strikes,version' ||
      personalFields.concat(derivedFields).some(key => Object.hasOwn(battle.combat, key))) return false;
  for (const [id, member] of Object.entries(members)) {
    if (!['a', 'b'].includes(id) || occupied.has(id) || !member?.combat || !member.clock ||
        Object.keys(member.clock).sort().join() !== [...defenseFields].sort().join() ||
        Object.keys(member.combat).sort().join() !== [...personalFields].sort().join() ||
        typeof member.combat.last_combat_log !== 'string' ||
        personalFields.filter(key => key !== 'last_combat_log').some(key => !Number.isSafeInteger(member.combat[key]) || member.combat[key] < 0) ||
        member.combat.combo_step > 3 || !validBattleClock(participantBattle(battle, id).clock, tick)) return false;
    occupied.add(id);
  }
  return true;
}
