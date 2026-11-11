// Absolute simulation ticks are persisted with combat and party changes in one CAS.
export function createBattleClock(tick, warning = true) {
  return { version: 1, phase: warning ? 'warning' : 'recovery',
    phaseUntil: tick + (warning ? 30 : 20), iframeUntil: 0, guardUntil: 0,
    actionUntil: 0, defenseUntil: 0, strikes: 0 };
}

export function validBattleClock(c, tick) {
  return c?.version === 1 && ['warning', 'recovery'].includes(c.phase) &&
    ['phaseUntil', 'iframeUntil', 'guardUntil', 'actionUntil', 'defenseUntil', 'strikes']
      .every(k => Number.isSafeInteger(c[k]) && c[k] >= 0) &&
    c.phaseUntil > tick && c.phaseUntil <= tick + (c.phase === 'warning' ? 30 : 20) &&
    c.iframeUntil <= tick + 9 && c.guardUntil <= tick + 9 &&
    c.actionUntil <= tick + 6 && c.defenseUntil <= tick + 18;
}

export function syncBattleClock(battle, tick) {
  const c = battle.clock, combat = battle.combat;
  combat.iframe_timer = Math.max(0, c.iframeUntil - tick) * 0.05;
  combat.guard_active = c.guardUntil > tick;
  combat.telegraph_active = c.phase === 'warning';
  combat.telegraph_timer = c.phase === 'warning' ? Math.max(0, c.phaseUntil - tick) * 0.05 : 0;
}

export function advanceBattleClock(engine, battle, party, tick) {
  const c = battle.clock;
  syncBattleClock(battle, tick);
  if (tick >= c.phaseUntil) {
    engine.party = party; engine.combat = battle.combat;
    if (c.phase === 'warning') {
      battle.combat.last_combat_log = engine.resolveEnemyAttack({ timed: true });
      c.guardUntil = 0;
      c.strikes++;
      c.phase = 'recovery'; c.phaseUntil = tick + 20;
    } else {
      c.phase = 'warning'; c.phaseUntil = tick + 30;
    }
    syncBattleClock(battle, tick);
  }
}

export function performTimedAction(engine, battle, party, action, tick, { livingOnly = false } = {}) {
  const c = battle.clock, defense = action === 'dodge' || action === 'guard';
  if (tick < c.actionUntil || (defense && tick < c.defenseUntil)) {
    throw Object.assign(Error('combat action cooldown'), { status: 409 });
  }
  engine.party = party; engine.combat = battle.combat;
  syncBattleClock(battle, tick);
  engine.combatAction(action, { deferEnemyAttack: true, livingOnly });
  c.actionUntil = tick + 6;
  if (defense) {
    c.defenseUntil = tick + 18;
    c[action === 'dodge' ? 'iframeUntil' : 'guardUntil'] = tick + 9;
  }
  syncBattleClock(battle, tick);
}
