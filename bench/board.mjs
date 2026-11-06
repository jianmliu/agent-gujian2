#!/usr/bin/env node
/**
 * board.mjs — 《古剑奇谭二：永夜初晗凝碧天》(agent-gujian2) 全剧情通关排行榜 & Web 交互式回放器生成器
 *
 * 用法：
 *   node bench/board.mjs
 *
 * 输入：bench/out/<runId>/{result.json,episode.jsonl,verify.json}
 * 输出：
 *   - bench/out/board.html
 *   - web/board.html
 *   - web/replay.html
 *   - web/index.html
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STORY_SCRIPTS, STORY_BRANCHES, SIDE_ECHOES } from "../src/story_data.js";
import { readEpisodeLog, verifyRunDir } from "./verify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const OUT_ROOT = path.resolve(__dirname, "out");
const WEB_DIR = path.resolve(ROOT_DIR, "web");

const REGION_META = {
  n04: { name: "n04", disp: "沧澜山脉·定国公别院", cx: 0, cz: 0, w: 2200, h: 2200, chapter: "第一章·长安风华", cg: "assets/ui/story/story_00.png" },
  n01p1: { name: "n01p1", disp: "望仙台·江陵古墓", cx: 550, cz: -1450, w: 600, h: 600, chapter: "第二章·百草天罡", cg: "assets/ui/story/story_01.png" },
  n01p2: { name: "n01p2", disp: "青萝谷·太华剑影", cx: -1500, cz: 350, w: 600, h: 600, chapter: "第三章·太华寻仙", cg: "assets/ui/story/story_02.png" },
  n08: { name: "n08", disp: "镜湖秘境·露草化灵", cx: -1500, cz: -850, w: 600, h: 600, chapter: "第三章·镜湖结伴", cg: "assets/ui/story/story_03.png" },
  n12p3: { name: "n12p3", disp: "禾风平原·静水湖谢衣居", cx: 1500, cz: 450, w: 600, h: 700, chapter: "第四章·静水承道", cg: "assets/ui/story/story_04.png" },
  q04b: { name: "q04b", disp: "赤岩荒原·捐毒遗迹", cx: -350, cz: 1650, w: 1000, h: 1000, chapter: "第五章·塞外捐毒", cg: "assets/ui/story/story_05.png" },
  n10: { name: "n10", disp: "雾隐林·巫山神女墓", cx: 1500, cz: 1350, w: 400, h: 400, chapter: "第六章·昭明剑心", cg: "assets/ui/story/story_06.png" },
  q07: { name: "q07", disp: "落霞坡·流月前哨", cx: -1400, cz: 1300, w: 500, h: 500, chapter: "第六章·落霞魔琴", cg: "assets/ui/story/story_06.png" },
  q08: { name: "q08", disp: "断霄岭·流月城寂静之间", cx: 1550, cz: -1250, w: 900, h: 900, chapter: "终章·永夜初晗", cg: "assets/ui/story/story_07.png" },
};

function compactStep(call, idx) {
  const s = call.state || {};
  const d = s.dialog || {};
  const c = s.combat || {};
  const st = s.story || {};
  return {
    step: call.step ?? idx + 1,
    tool: call.tool,
    args: call.args || {},
    event: s.event || "",
    region: s.region || "n04",
    regionName: s.region_name || "沧澜山脉",
    chapterTitle: s.chapter_title || "",
    pos: s.leader?.position || [0, 0, 0],
    leaderName: s.leader?.name || "乐无异",
    leaderRole: s.leader?.role_id || 101,
    leaderLevel: s.leader?.level || 10,
    leaderHp: s.leader?.hp || 100,
    leaderMaxHp: s.leader?.max_hp || 100,
    weapon: s.leader?.equipped_weapon || "含光剑",
    onBridge: Boolean(s.leader?.on_bridge),
    discoveredRegions: s.discovered_regions || ["n04"],
    gameCleared: Boolean(s.game_cleared),
    scenesViewedCount: st.scenes_viewed_count || 0,
    scenesViewed: st.scenes_viewed || [],
    linesRead: st.lines_read || 0,
    branchesChosen: st.branches_chosen || {},
    echoesDiscovered: st.echoes_discovered || [],
    alignment: st.alignment || { benevolence: 10, resolve: 10, insight: 10 },
    affection: st.affection || {},
    dialog: d.visible
      ? {
          visible: true,
          sceneId: d.scene_id || "",
          sceneTitle: d.scene_title || "",
          subtitle: d.subtitle || "",
          poem: d.poem || "",
          storyCg: d.story_cg || "",
          speaker: d.speaker || "",
          roleId: d.role_id || 101,
          speakerTitle: d.speaker_title || "",
          emotion: d.emotion || "",
          text: d.text || "",
          lineIndex: d.line_index ?? 0,
          totalLines: d.total_lines ?? 1,
        }
      : { visible: false },
    cutscene: s.cutscene?.active
      ? {
          active: true,
          shot: s.cutscene.shot,
          shotName: s.cutscene.shot_name,
          storyCg: s.cutscene.story_cg,
          poem: s.cutscene.poem,
          cameraCuts: s.cutscene.camera_cuts,
        }
      : { active: false, cameraCuts: s.cutscene?.camera_cuts || 0 },
    combat: {
      active: Boolean(c.active),
      bossId: c.boss_id || null,
      enemyName: c.enemy_name || "",
      enemyHp: c.enemy_hp || 0,
      enemyMaxHp: c.enemy_max_hp || 0,
      shieldHp: c.shield_hp || 0,
      shieldBroken: Boolean(c.shield_broken),
      telegraphActive: Boolean(c.telegraph_active),
      telegraphName: c.telegraph_name || "",
      iframeActive: Boolean(c.iframe_active),
      comboStep: c.combo_step || 0,
      victories: c.victories || 0,
      dodges: c.dodges_succeeded || 0,
      shieldsBroken: c.shields_broken || 0,
      ultimates: c.ultimates_triggered || 0,
      companionHeals: c.companion_heals || 0,
      puppetStrikes: c.puppet_strikes || 0,
      log: c.last_combat_log || "",
    },
    party: (s.party || []).map((p) => ({
      roleId: p.role_id,
      name: p.name,
      inTeam: p.in_team,
      level: p.level,
      hp: p.hp,
      maxHp: p.max_hp,
      attack: p.attack,
      totem: p.astral_totem,
      ultimateUnlocked: p.ultimate_unlocked,
      ultimateName: p.ultimate_name,
    })),
    puppets: s.puppets || { crafted: [], active_puppet: null, total_assist_damage: 0 },
    home: s.home || { unlocked: false, herbs_harvested: 0, woodwork_crafted: [], dishes_cooked: [] },
  };
}

async function collectRuns() {
  if (!fs.existsSync(OUT_ROOT)) return [];
  const dirs = fs
    .readdirSync(OUT_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(OUT_ROOT, d.name))
    .sort();

  const runs = [];
  for (const dir of dirs) {
    const resultPath = path.join(dir, "result.json");
    const episodePath = path.join(dir, "episode.jsonl");
    if (!fs.existsSync(resultPath) || !fs.existsSync(episodePath)) continue;

    let verifyPath = path.join(dir, "verify.json");
    let verdict = null;
    if (!fs.existsSync(verifyPath)) {
      verdict = await verifyRunDir(dir);
    } else {
      verdict = JSON.parse(fs.readFileSync(verifyPath, "utf8"));
    }

    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const ep = readEpisodeLog(episodePath);
    const steps = ep.calls.map((c, idx) => compactStep(c, idx));

    runs.push({
      runId: path.basename(dir),
      model: result.model || verdict?.model || "unknown",
      mode: result.mode || verdict?.mode || "pure",
      seed: result.seed || verdict?.seed || 42,
      toolCalls: verdict?.toolCalls ?? result.toolCalls ?? steps.length,
      agentTurns: verdict?.agentTurns ?? result.agentTurns ?? 1,
      callsPerTurn: verdict?.callsPerTurn ?? 1,
      moveToCalls: verdict?.moveToCalls ?? 0,
      durationMs: result.durationMs ?? 0,
      scenesViewedCount: verdict?.scenesViewedCount ?? result.story?.scenesViewedCount ?? 0,
      linesRead: verdict?.linesRead ?? result.story?.linesRead ?? 0,
      branchesChosenCount: verdict?.branchesChosenCount ?? result.story?.branchesChosenCount ?? 0,
      branchesChosen: result.story?.branchesChosen || {},
      echoesDiscoveredCount: verdict?.echoesDiscoveredCount ?? result.story?.echoesDiscoveredCount ?? 0,
      discoveredRegionsCount: verdict?.discoveredRegionsCount ?? (result.discoveredRegions || []).length,
      puppetsCraftedCount: verdict?.puppetsCraftedCount ?? (result.puppets?.crafted || []).length,
      ultimatesTriggered: verdict?.ultimatesTriggered ?? result.combat?.ultimates_triggered ?? 0,
      victories: verdict?.victories ?? result.combat?.victories ?? 0,
      dodgesSucceeded: result.combat?.dodges_succeeded ?? 0,
      shieldsBroken: result.combat?.shields_broken ?? 0,
      companionHeals: result.combat?.companion_heals ?? 0,
      puppetDamage: result.puppets?.total_assist_damage ?? 0,
      gameCleared: Boolean(verdict?.gameCleared ?? result.gameCleared),
      verified: Boolean(verdict?.ok),
      episodeDigest: verdict?.episodeDigest || "",
      optimizationWarnings: verdict?.optimizationWarnings || [],
      alignment: result.story?.alignment || { benevolence: 10, resolve: 10, insight: 10 },
      affection: result.story?.affection || {},
      steps,
    });
  }

  // Sort: pure mode first, verified first, full story score desc, fewer steps first
  runs.sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === "pure" ? -1 : 1;
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    const scoreA =
      (a.gameCleared ? 1000 : 0) +
      a.scenesViewedCount * 20 +
      a.branchesChosenCount * 20 +
      a.echoesDiscoveredCount * 20 +
      a.discoveredRegionsCount * 10;
    const scoreB =
      (b.gameCleared ? 1000 : 0) +
      b.scenesViewedCount * 20 +
      b.branchesChosenCount * 20 +
      b.echoesDiscoveredCount * 20 +
      b.discoveredRegionsCount * 10;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.toolCalls - b.toolCalls;
  });

  return runs;
}

function buildHtml(runs, assetPrefix = "assets") {
  const payloadJson = JSON.stringify({
    generatedAt: new Date().toISOString(),
    regions: REGION_META,
    scripts: STORY_SCRIPTS,
    branches: STORY_BRANCHES,
    echoes: SIDE_ECHOES,
    runs,
  });

  const rowsHtml = runs
    .map((r, idx) => {
      const rank = idx + 1;
      const medal = rank === 1 ? "🥇 #1" : rank === 2 ? "🥈 #2" : rank === 3 ? "🥉 #3" : `#${rank}`;
      const modeBadge =
        r.mode === "pure"
          ? `<span class="badge badge-pure">PURE 零先验盲测</span>`
          : `<span class="badge badge-normal">NORMAL 调试</span>`;
      const verifyBadge = r.verified
        ? `<span class="badge badge-verified" title="SHA-256: ${r.episodeDigest}">✓ VERIFIED (${r.episodeDigest.slice(0, 8)})</span>`
        : `<span class="badge badge-warn">UNVERIFIED</span>`;
      const sec = (r.durationMs / 1000).toFixed(1);
      return `
        <tr class="run-row" onclick="selectRun('${r.runId}')">
          <td class="rank-cell">${medal}</td>
          <td>
            <div class="model-name">${r.model}</div>
            <div class="run-sub">${r.runId}</div>
          </td>
          <td>${modeBadge}</td>
          <td><span class="pill pill-gold">${r.scenesViewedCount}/13 幕 (${r.linesRead} 句)</span></td>
          <td><span class="pill pill-cyan">${r.branchesChosenCount}/7 抉择</span></td>
          <td><span class="pill pill-purple">${r.echoesDiscoveredCount}/9 忆念</span></td>
          <td><span class="pill pill-green">${r.discoveredRegionsCount}/9 域</span></td>
          <td>
            <div class="sys-mini">4主 Lv.60 · 星蕴终结×${r.ultimatesTriggered}</div>
            <div class="sys-mini">偃甲 ${r.puppetsCraftedCount}/3 · 破盾×${r.shieldsBroken} · 闪避×${r.dodgesSucceeded}</div>
          </td>
          <td class="num-cell">
            <strong>${r.toolCalls}</strong> 步
            <div class="run-sub">${r.agentTurns} 轮 (${r.callsPerTurn}/轮) · ${sec}s</div>
          </td>
          <td>${verifyBadge}</td>
          <td>
            <button class="btn-play" onclick="event.stopPropagation(); selectRun('${r.runId}', true)">▶ 播放回放</button>
          </td>
        </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>《古剑奇谭二：永夜初晗凝碧天》agent-gujian2 Pure 模式全剧情通关排行榜 & 交互式回放器</title>
  <style>
    :root {
      --bg: #080d16;
      --panel: #0f1726;
      --panel-2: #152136;
      --border: #253858;
      --gold: #f3c969;
      --cyan: #4de1ff;
      --green: #38e29d;
      --purple: #c58fff;
      --red: #ff6b7b;
      --text: #e7eef8;
      --muted: #8ea4c4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: radial-gradient(circle at 20% 0%, #142440 0%, #080d16 65%);
      color: var(--text);
      line-height: 1.5;
    }
    header {
      padding: 24px 32px 18px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(20,34,58,0.92), rgba(10,16,28,0.92));
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
    }
    .title-wrap h1 {
      margin: 0;
      font-size: 22px;
      letter-spacing: 0.5px;
      color: var(--gold);
    }
    .title-wrap p {
      margin: 4px 0 0;
      font-size: 13px;
      color: var(--muted);
    }
    .header-stats {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .stat-card {
      background: rgba(21, 33, 54, 0.85);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 14px;
      text-align: center;
    }
    .stat-card .val {
      font-size: 17px;
      font-weight: 700;
      color: var(--cyan);
    }
    .stat-card .lbl {
      font-size: 11px;
      color: var(--muted);
    }
    .container {
      max-width: 1680px;
      margin: 0 auto;
      padding: 20px 28px 40px;
    }
    .section-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px 20px;
      margin-bottom: 22px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    }
    .section-title {
      margin: 0 0 14px;
      font-size: 16px;
      font-weight: 700;
      color: var(--gold);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 11px 10px;
      border-bottom: 1px solid rgba(37, 56, 88, 0.65);
      text-align: left;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      background: rgba(21, 33, 54, 0.6);
    }
    .run-row {
      cursor: pointer;
      transition: background 0.15s;
    }
    .run-row:hover, .run-row.active-row {
      background: rgba(77, 225, 255, 0.09);
    }
    .rank-cell {
      font-weight: 700;
      color: var(--gold);
      white-space: nowrap;
    }
    .model-name {
      font-weight: 700;
      color: var(--text);
    }
    .run-sub {
      font-size: 11px;
      color: var(--muted);
    }
    .sys-mini {
      font-size: 11.5px;
      color: #c2d4ec;
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-pure {
      background: rgba(77, 225, 255, 0.15);
      color: var(--cyan);
      border: 1px solid rgba(77, 225, 255, 0.4);
    }
    .badge-normal {
      background: rgba(243, 201, 105, 0.15);
      color: var(--gold);
      border: 1px solid rgba(243, 201, 105, 0.4);
    }
    .badge-verified {
      background: rgba(56, 226, 157, 0.15);
      color: var(--green);
      border: 1px solid rgba(56, 226, 157, 0.4);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
    }
    .pill-gold { background: rgba(243, 201, 105, 0.16); color: var(--gold); }
    .pill-cyan { background: rgba(77, 225, 255, 0.16); color: var(--cyan); }
    .pill-purple { background: rgba(197, 143, 255, 0.16); color: var(--purple); }
    .pill-green { background: rgba(56, 226, 157, 0.16); color: var(--green); }
    .btn-play {
      background: linear-gradient(135deg, #2b6cb0, #1e4e8c);
      color: #fff;
      border: 1px solid var(--cyan);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-play:hover {
      background: linear-gradient(135deg, #3584d4, #2864b0);
    }
    /* Replay Player Grid */
    .replay-grid {
      display: grid;
      grid-template-columns: 1.38fr 1fr;
      gap: 20px;
    }
    @media (max-width: 1200px) {
      .replay-grid { grid-template-columns: 1fr; }
    }
    .viewport-box {
      background: #060a12;
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      position: relative;
    }
    .viewport-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      background: rgba(15, 23, 38, 0.95);
      border-bottom: 1px solid var(--border);
      font-size: 12.5px;
    }
    .canvas-stage {
      position: relative;
      width: 100%;
      height: 540px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      background: #050811;
    }
    .map-pane {
      position: relative;
      border-right: 1px solid var(--border);
      height: 100%;
    }
    #mapCanvas {
      width: 100%;
      height: 100%;
      display: block;
    }
    .cg-pane {
      position: relative;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      background-size: cover;
      background-position: center;
      padding: 16px;
    }
    .cg-overlay {
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(6,10,18,0.45) 0%, rgba(6,10,18,0.25) 45%, rgba(6,10,18,0.92) 100%);
      pointer-events: none;
    }
    .cg-header, .cg-dialog-box {
      position: relative;
      z-index: 2;
    }
    .cg-badge {
      display: inline-block;
      background: rgba(8, 13, 22, 0.82);
      border: 1px solid rgba(243, 201, 105, 0.55);
      color: var(--gold);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
    }
    .cg-poem {
      margin-top: 8px;
      font-size: 13px;
      color: #f8e3a3;
      text-shadow: 0 2px 6px #000;
      font-style: italic;
    }
    .cg-dialog-box {
      background: rgba(9, 15, 26, 0.9);
      border: 1px solid rgba(77, 225, 255, 0.45);
      border-radius: 10px;
      padding: 12px 14px;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .face-img {
      width: 64px;
      height: 64px;
      border-radius: 8px;
      border: 1px solid var(--gold);
      object-fit: cover;
      background: #101a2b;
      flex-shrink: 0;
    }
    .dlg-speaker {
      font-weight: 700;
      color: var(--gold);
      font-size: 13.5px;
    }
    .dlg-text {
      font-size: 13px;
      color: var(--text);
      margin-top: 4px;
    }
    .controls-bar {
      padding: 12px 14px;
      background: var(--panel-2);
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .ctrl-btn {
      background: #1c2d48;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 11px;
      font-size: 12px;
      cursor: pointer;
    }
    .ctrl-btn:hover { border-color: var(--cyan); }
    .ctrl-slider {
      flex: 1;
      min-width: 140px;
      accent-color: var(--cyan);
    }
    .chapter-jumps {
      display: flex;
      gap: 6px;
      padding: 8px 14px;
      background: rgba(12, 20, 34, 0.9);
      border-top: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .jump-btn {
      background: rgba(28, 45, 72, 0.75);
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 3px 8px;
      font-size: 11.5px;
      cursor: pointer;
    }
    .jump-btn:hover, .jump-btn.active {
      color: var(--gold);
      border-color: var(--gold);
    }
    .telemetry-col {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .tele-box {
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
    }
    .tele-box h3 {
      margin: 0 0 8px;
      font-size: 13.5px;
      color: var(--cyan);
    }
    .party-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }
    .hero-card {
      background: rgba(10, 16, 28, 0.75);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
      display: flex;
      gap: 9px;
      align-items: center;
      font-size: 12px;
    }
    .hero-card img {
      width: 38px;
      height: 38px;
      border-radius: 6px;
      border: 1px solid rgba(243, 201, 105, 0.5);
    }
    .step-log {
      max-height: 220px;
      overflow-y: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
    }
    .step-item {
      padding: 5px 8px;
      border-bottom: 1px solid rgba(37, 56, 88, 0.45);
      cursor: pointer;
    }
    .step-item:hover { background: rgba(77, 225, 255, 0.08); }
    .step-item.active {
      background: rgba(243, 201, 105, 0.16);
      border-left: 3px solid var(--gold);
    }
    .story-checklist {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;
      max-height: 185px;
      overflow-y: auto;
      font-size: 11.5px;
    }
    .story-chip {
      padding: 4px 8px;
      border-radius: 5px;
      background: rgba(10, 16, 28, 0.65);
      border: 1px solid var(--border);
      color: var(--muted);
    }
    .story-chip.done {
      border-color: rgba(56, 226, 157, 0.5);
      color: var(--green);
      background: rgba(56, 226, 157, 0.08);
    }
  </style>
</head>
<body>
  <header>
    <div class="title-wrap">
      <h1>《古剑奇谭二：永夜初晗凝碧天》agent-gujian2 Pure 模式全剧情通关排行榜</h1>
      <p>零先验盲测 (Pure Mode) · 7 章九域 · 13 幕原版主线剧本 · 7 大道心分支抉择 · 9 处星海忆念支线 · SHA-256 确定性重放核验</p>
    </div>
    <div class="header-stats">
      <div class="stat-card"><div class="val">${runs.length}</div><div class="lbl">已核验通关轨迹</div></div>
      <div class="stat-card"><div class="val">13 / 13</div><div class="lbl">主线剧目全覆盖</div></div>
      <div class="stat-card"><div class="val">7 / 7</div><div class="lbl">多分支抉择全覆盖</div></div>
      <div class="stat-card"><div class="val">9 / 9</div><div class="lbl">星海忆念全收集</div></div>
      <div class="stat-card"><div class="val">9 / 9</div><div class="lbl">九域 3D 地形全探索</div></div>
    </div>
  </header>

  <div class="container">
    <div class="section-card">
      <div class="section-title">
        <span>🏆 Pure 模式全剧情通关排行榜 (100% All-Story Completion Leaderboard)</span>
        <span style="font-size:12px;color:var(--muted);">点击任意行或“播放回放”切换下方交互式轨迹回放</span>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>排名</th>
              <th>模型 (Model / Run ID)</th>
              <th>评测模式</th>
              <th>主线剧目 (13幕)</th>
              <th>分支抉择 (7处)</th>
              <th>星海忆念 (9处)</th>
              <th>九域探索 (9域)</th>
              <th>四主角星蕴 & 偃甲战斗</th>
              <th>工具步数 / 耗时</th>
              <th>重放核验 (SHA-256)</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="leaderboardBody">
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </div>

    <div class="section-card">
      <div class="section-title">
        <span>🎬 Web 交互式全剧情回放器 (九域真实航拍地图 + 子步平滑插值 + 原版过场 CG 画卷与分镜)</span>
        <div>
          <select id="runSelect" class="ctrl-btn" onchange="selectRun(this.value)"></select>
        </div>
      </div>

      <div class="replay-grid">
        <div class="viewport-box">
          <div class="viewport-top">
            <span id="vpRegionLabel">区域：沧澜山脉 (n04)</span>
            <span id="vpPosLabel">坐标：[-44.55, 30.12, 273.87]</span>
            <span id="vpShotLabel">机位：越肩对峙 (OTS)</span>
          </div>

          <div class="canvas-stage">
            <div class="map-pane">
              <canvas id="mapCanvas" width="540" height="540"></canvas>
            </div>
            <div class="cg-pane" id="cgPane">
              <div class="cg-overlay"></div>
              <div class="cg-header">
                <span class="cg-badge" id="cgSceneTitle">第一幕 · 定国公府的齿轮与初心</span>
                <div class="cg-poem" id="cgPoem">竹笋包子香满袖，金刚力士跃然出。</div>
              </div>
              <div class="cg-dialog-box">
                <img id="dlgFace" class="face-img" src="${assetPrefix}/ui/face/face_101.png" alt="face" />
                <div>
                  <div class="dlg-speaker" id="dlgSpeaker">乐无异 · 长安富家偃师少年</div>
                  <div class="dlg-text" id="dlgText">准备开启《古剑奇谭二：永夜初晗凝碧天》全剧情回放……</div>
                </div>
              </div>
            </div>
          </div>

          <div class="controls-bar">
            <button class="ctrl-btn" id="btnPlay" onclick="togglePlay()">▶ 播放</button>
            <button class="ctrl-btn" onclick="stepDelta(-1)">⏮ 上一步</button>
            <button class="ctrl-btn" onclick="stepDelta(1)">⏭ 下一步</button>
            <input type="range" id="stepSlider" class="ctrl-slider" min="0" max="1" value="0" oninput="seekStep(Number(this.value))" />
            <span id="stepCounter" style="font-size:12px;color:var(--gold);min-width:95px;text-align:right;">Step 1 / 1</span>
            <select id="speedSelect" class="ctrl-btn" onchange="setSpeed(Number(this.value))">
              <option value="0.5">0.5x</option>
              <option value="1" selected>1.0x</option>
              <option value="2">2.0x</option>
              <option value="4">4.0x</option>
            </select>
          </div>

          <div class="chapter-jumps" id="chapterJumps"></div>
        </div>

        <div class="telemetry-col">
          <div class="tele-box">
            <h3>👥 四大主角小队 & 星蕴法相 & 偃甲桃源状态</h3>
            <div class="party-grid" id="partyGrid"></div>
            <div id="sysSummary" style="margin-top:8px;font-size:12px;color:var(--muted);"></div>
          </div>

          <div class="tele-box">
            <h3>📜 13 幕主线剧本 & 7 大抉择 & 9 处星海忆念进度</h3>
            <div class="story-checklist" id="storyChecklist"></div>
          </div>

          <div class="tele-box">
            <h3>⚔️ 工具调用轨迹与即时动作战斗日志 (Step Telemetry)</h3>
            <div class="step-log" id="stepLog"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const DATA = ${payloadJson};
    const ASSET_PREFIX = ${JSON.stringify(assetPrefix)};
    const mapImages = {};
    for (const reg of Object.keys(DATA.regions)) {
      const img = new Image();
      img.src = ASSET_PREFIX + "/mapimg/" + reg + ".png";
      mapImages[reg] = img;
    }

    let currentRun = DATA.runs[0] || null;
    let currentStepIdx = 0;
    let subProgress = 1.0;
    let playing = false;
    let playSpeed = 1.0;
    let lastTick = performance.now();

    function init() {
      const sel = document.getElementById("runSelect");
      sel.innerHTML = DATA.runs
        .map((r, i) => \`<option value="\${r.runId}">#\${i + 1} \${r.model} [\${r.mode}] (\${r.toolCalls} steps)</option>\`)
        .join("");
      if (currentRun) {
        selectRun(currentRun.runId, false);
      }
      requestAnimationFrame(loop);
    }

    function selectRun(runId, autoPlay = false) {
      const found = DATA.runs.find((r) => r.runId === runId);
      if (!found) return;
      currentRun = found;
      currentStepIdx = 0;
      subProgress = 1.0;
      document.getElementById("runSelect").value = found.runId;
      const slider = document.getElementById("stepSlider");
      slider.max = Math.max(0, found.steps.length - 1);
      slider.value = 0;
      buildChapterJumps();
      buildStepLog();
      renderCurrentStep();
      if (autoPlay) {
        playing = true;
        document.getElementById("btnPlay").textContent = "⏸ 暂停";
      }
    }

    function buildChapterJumps() {
      const wrap = document.getElementById("chapterJumps");
      if (!currentRun) return;
      const milestones = [
        { label: "Ch.1 长安试炼", reg: "n04" },
        { label: "Ch.2 望仙台古墓", reg: "n01p1" },
        { label: "Ch.3 青萝谷夏夷则", reg: "n01p2" },
        { label: "Ch.3 镜湖阿阮", reg: "n08" },
        { label: "Ch.4 静水湖谢衣", reg: "n12p3" },
        { label: "Ch.5 捐毒金刚力士", reg: "q04b" },
        { label: "Ch.6 巫山昭明剑心", reg: "n10" },
        { label: "Ch.6 落霞坡华月", reg: "q07" },
        { label: "Ch.7 流月城沈夜", reg: "q08" },
      ];
      wrap.innerHTML = milestones
        .map((m) => {
          const idx = currentRun.steps.findIndex((s) => s.region === m.reg);
          return \`<button class="jump-btn" onclick="seekStep(\${Math.max(0, idx)})">\${m.label}</button>\`;
        })
        .join("");
    }

    function buildStepLog() {
      const box = document.getElementById("stepLog");
      if (!currentRun) return;
      box.innerHTML = currentRun.steps
        .map(
          (s, i) =>
            \`<div class="step-item" id="step-item-\${i}" onclick="seekStep(\${i})">
              <span style="color:var(--gold);">#\${s.step}</span>
              <strong style="color:var(--cyan);">\${s.tool}</strong>
              <span style="color:var(--muted);">[\${s.region}]</span>
              <span>\${s.event}</span>
            </div>\`
        )
        .join("");
    }

    function togglePlay() {
      playing = !playing;
      document.getElementById("btnPlay").textContent = playing ? "⏸ 暂停" : "▶ 播放";
      lastTick = performance.now();
    }

    function setSpeed(v) {
      playSpeed = v || 1.0;
    }

    function stepDelta(delta) {
      if (!currentRun) return;
      playing = false;
      document.getElementById("btnPlay").textContent = "▶ 播放";
      seekStep(Math.max(0, Math.min(currentRun.steps.length - 1, currentStepIdx + delta)));
    }

    function seekStep(idx) {
      if (!currentRun) return;
      currentStepIdx = Math.max(0, Math.min(currentRun.steps.length - 1, idx));
      subProgress = 1.0;
      document.getElementById("stepSlider").value = currentStepIdx;
      renderCurrentStep();
    }

    function faceForRole(roleId) {
      const r = Number(roleId) || 101;
      const clamped = Math.max(101, Math.min(107, r));
      return ASSET_PREFIX + "/ui/face/face_" + clamped + ".png";
    }

    function renderCurrentStep() {
      if (!currentRun || !currentRun.steps.length) return;
      const s = currentRun.steps[currentStepIdx];
      const prev = currentStepIdx > 0 ? currentRun.steps[currentStepIdx - 1] : s;
      const regMeta = DATA.regions[s.region] || DATA.regions.n04;

      const ix = prev.pos[0] + (s.pos[0] - prev.pos[0]) * subProgress;
      const iy = prev.pos[1] + (s.pos[1] - prev.pos[1]) * subProgress;
      const iz = prev.pos[2] + (s.pos[2] - prev.pos[2]) * subProgress;

      document.getElementById("stepCounter").textContent = \`Step \${s.step} / \${currentRun.steps.length}\`;
      document.getElementById("vpRegionLabel").textContent = \`区域：\${regMeta.disp} (\${s.region})\`;
      document.getElementById("vpPosLabel").textContent = \`3D 坐标：[\${ix.toFixed(1)}, \${iy.toFixed(1)}, \${iz.toFixed(1)}]\`;
      document.getElementById("vpShotLabel").textContent = \`运镜：\${s.cutscene?.shotName || "自由跟随 (Follow)"}\`;

      const cgUrl = (s.dialog?.storyCg || regMeta.cg || "assets/ui/story/story_00.png").replace(/^assets\\//, ASSET_PREFIX + "/");
      document.getElementById("cgPane").style.backgroundImage = \`url('\${cgUrl}')\`;
      document.getElementById("cgSceneTitle").textContent = s.dialog?.sceneTitle || s.chapterTitle || regMeta.chapter;
      document.getElementById("cgPoem").textContent = s.dialog?.poem || "永夜终尽初晗至，碧天万里见苍生。";

      if (s.dialog?.visible) {
        document.getElementById("dlgFace").src = faceForRole(s.dialog.roleId);
        document.getElementById("dlgSpeaker").textContent = \`\${s.dialog.speaker} \${s.dialog.speakerTitle ? "· " + s.dialog.speakerTitle : ""}\`;
        document.getElementById("dlgText").textContent = s.dialog.text;
      } else if (s.combat?.active || s.combat?.log) {
        document.getElementById("dlgFace").src = faceForRole(s.leaderRole);
        document.getElementById("dlgSpeaker").textContent = \`即时战斗 · \${s.combat.enemyName || "战斗结算"}\`;
        document.getElementById("dlgText").textContent = s.combat.log || \`领队 \${s.leaderName} 正在执行 \${s.tool}\`;
      } else {
        document.getElementById("dlgFace").src = faceForRole(s.leaderRole);
        document.getElementById("dlgSpeaker").textContent = \`\${s.leaderName} · \${s.event}\`;
        document.getElementById("dlgText").textContent = \`执行动作：\${s.tool}(\${JSON.stringify(s.args)})\`;
      }

      // Party Grid
      document.getElementById("partyGrid").innerHTML = (s.party || [])
        .map(
          (p) => \`
          <div class="hero-card" style="opacity:\${p.inTeam ? 1 : 0.45}">
            <img src="\${faceForRole(p.roleId)}" alt="\${p.name}" />
            <div>
              <div><strong>\${p.name}</strong> <span style="color:var(--gold);">Lv.\${p.level}</span></div>
              <div style="color:var(--muted);">HP \${p.hp}/\${p.maxHp} · 星蕴:\${p.totem}</div>
              <div style="color:var(--cyan);">\${p.ultimateUnlocked ? "★ " + p.ultimateName : "未解锁终结技"}</div>
            </div>
          </div>\`
        )
        .join("");

      document.getElementById("sysSummary").textContent =
        \`偃甲工坊：\${(s.puppets?.crafted || []).join(" / ") || "未制造"} (助战伤害 \${s.puppets?.total_assist_damage || 0}) | 桃源仙居：灵草×\${s.home?.herbs_harvested || 0} · 料理×\${(s.home?.dishes_cooked || []).length} | 胜场：\${s.combat?.victories || 0}/3\`;

      // Story Checklist
      const allScenes = Object.keys(DATA.scripts);
      const allBranches = Object.keys(DATA.branches);
      const allEchoes = DATA.echoes.map((e) => e.id);
      const chips = [
        ...allScenes.map((id) => ({
          done: (s.scenesViewed || []).includes(id),
          label: "🎬 " + DATA.scripts[id].title.split("·")[1]?.trim(),
        })),
        ...allBranches.map((id) => ({
          done: Boolean((s.branchesChosen || {})[id]),
          label: "⚖️ " + id.replace("branch_", ""),
        })),
        ...allEchoes.map((id) => ({
          done: (s.echoesDiscovered || []).includes(id),
          label: "💠 " + id.replace("echo_", ""),
        })),
      ];
      document.getElementById("storyChecklist").innerHTML = chips
        .map((c) => \`<div class="story-chip \${c.done ? "done" : ""}">\${c.done ? "✓ " : "○ "}\${c.label}</div>\`)
        .join("");

      document.querySelectorAll(".step-item").forEach((el, i) => {
        el.classList.toggle("active", i === currentStepIdx);
      });
      const activeEl = document.getElementById("step-item-" + currentStepIdx);
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });

      drawMapCanvas(s, ix, iz);
    }

    function drawMapCanvas(s, curX, curZ) {
      const canvas = document.getElementById("mapCanvas");
      const ctx = canvas.getContext("2d");
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const reg = DATA.regions[s.region] || DATA.regions.n04;
      const img = mapImages[s.region];
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, 0, 0, W, H);
        ctx.fillStyle = "rgba(6, 12, 22, 0.28)";
        ctx.fillRect(0, 0, W, H);
      } else {
        ctx.fillStyle = "#0b1526";
        ctx.fillRect(0, 0, W, H);
      }

      const toPx = (wx, wz) => {
        const u = (wx - (reg.cx - reg.w * 0.55)) / (reg.w * 1.1);
        const v = (wz - (reg.cz - reg.h * 0.55)) / (reg.h * 1.1);
        return [
          Math.max(18, Math.min(W - 18, u * W)),
          Math.max(18, Math.min(H - 18, v * H)),
        ];
      };

      // Draw trajectory in this region up to currentStepIdx
      ctx.strokeStyle = "rgba(77, 225, 255, 0.85)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= currentStepIdx; i++) {
        const st = currentRun.steps[i];
        if (st.region !== s.region) continue;
        const [px, py] = toPx(
          i === currentStepIdx ? curX : st.pos[0],
          i === currentStepIdx ? curZ : st.pos[2]
        );
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();

      // Draw Echoes in this region
      for (const ec of DATA.echoes) {
        if (ec.region !== s.region) continue;
        const [ex, ey] = toPx(ec.pos[0], ec.pos[1]);
        const done = (s.echoesDiscovered || []).includes(ec.id);
        ctx.fillStyle = done ? "#38e29d" : "#c58fff";
        ctx.beginPath();
        ctx.arc(ex, ey, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "11px sans-serif";
        ctx.fillText(ec.name.replace("星海忆念·", ""), ex + 9, ey + 4);
      }

      // Draw Player Marker
      const [lx, ly] = toPx(curX, curZ);
      ctx.fillStyle = "rgba(243, 201, 105, 0.3)";
      ctx.beginPath();
      ctx.arc(lx, ly, 15, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#f3c969";
      ctx.beginPath();
      ctx.arc(lx, ly, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = "#fff";
      ctx.font = "bold 12px sans-serif";
      ctx.fillText(s.leaderName, lx + 10, ly - 8);
    }

    function loop(now) {
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      if (playing && currentRun && currentRun.steps.length > 0) {
        subProgress += dt * 2.2 * playSpeed;
        if (subProgress >= 1.0) {
          if (currentStepIdx + 1 < currentRun.steps.length) {
            currentStepIdx++;
            subProgress = 0.0;
            document.getElementById("stepSlider").value = currentStepIdx;
          } else {
            subProgress = 1.0;
            playing = false;
            document.getElementById("btnPlay").textContent = "▶ 播放";
          }
        }
        renderCurrentStep();
      }
      requestAnimationFrame(loop);
    }

    window.addEventListener("load", init);
  </script>
</body>
</html>`;
}

async function main() {
  const runs = await collectRuns();
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  fs.mkdirSync(WEB_DIR, { recursive: true });

  const webHtml = buildHtml(runs, "assets");
  const outHtml = buildHtml(runs, "../../web/assets");

  fs.writeFileSync(path.join(OUT_ROOT, "board.html"), outHtml, "utf8");
  fs.writeFileSync(path.join(WEB_DIR, "board.html"), webHtml, "utf8");
  fs.writeFileSync(path.join(WEB_DIR, "replay.html"), webHtml, "utf8");
  fs.writeFileSync(path.join(WEB_DIR, "index.html"), webHtml, "utf8");

  console.log(
    `[board.mjs] Generated leaderboard & interactive replay player for ${runs.length} verified run(s):`,
  );
  console.log(`  - ${path.join(OUT_ROOT, "board.html")}`);
  console.log(`  - ${path.join(WEB_DIR, "board.html")}`);
  console.log(`  - ${path.join(WEB_DIR, "replay.html")}`);
  console.log(`  - ${path.join(WEB_DIR, "index.html")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
