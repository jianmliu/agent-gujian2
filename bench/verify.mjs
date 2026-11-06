#!/usr/bin/env node
/**
 * verify.mjs — 《古剑奇谭二：永夜初晗凝碧天》(agent-gujian2) 确定性重放核验器 (Deterministic Replay Verifier)
 *
 * 成绩不靠信任，靠重放：
 *   node bench/verify.mjs [runDir...]
 *
 * 对每个 bench/out/<runId> 目录：
 *  1. 读取 result.json 与 episode.jsonl（含 start / call / end 事件）
 *  2. 启动全新的无头引擎子进程 (bin/agent-gujian2-host.mjs --mode <pure|normal> --seed <seed>)
 *  3. 按原顺序、原参数重放每一次工具调用 (move_to / interact / step_dialog / choose_branch / trigger_echo / switch_leader / allocate_astral / craft_puppet / solve_mechanism / home_action / combat_action / ...)
 *  4. 逐步比对每次调用后的区域、3D 坐标、主线剧目进度、分支抉择、星海忆念、Boss 胜场与终局通关状态
 *  5. 计算 result.json + episode.jsonl + client.jsonl 的 SHA-256 指纹，写出 <runDir>/verify.json
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_SCRIPT =
  process.env.AGENT_GUJIAN2_HOST_BIN ||
  path.resolve(__dirname, "../bin/agent-gujian2-host.mjs");
const OUT_ROOT = path.resolve(__dirname, "out");

class HostProcess {
  constructor(mode = "pure", seed = 42) {
    const args = [HOST_SCRIPT, "--mode", mode, "--seed", String(seed)];
    this.proc = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buf = "";
    this.waiters = [];
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk.toString();
      const lines = this.buf.split("\n");
      this.buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const resolve = this.waiters.shift();
        if (resolve) resolve(msg);
      }
    });
  }

  send(cmd, extra = {}) {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.proc.stdin.write(JSON.stringify({ cmd, ...extra }) + "\n");
    });
  }

  close() {
    try {
      this.proc.stdin.write("quit\n");
    } catch {}
    this.proc.kill();
  }
}

export function computeEpisodeDigest(runDir) {
  const h = crypto.createHash("sha256");
  for (const name of ["result.json", "episode.jsonl", "client.jsonl"]) {
    const p = path.join(runDir, name);
    h.update(`\0${name}\0`);
    if (fs.existsSync(p)) {
      h.update(fs.readFileSync(p));
    }
  }
  return h.digest("hex");
}

export function readEpisodeLog(jsonlPath) {
  const lines = fs
    .readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const out = { start: null, calls: [], end: null };
  for (const line of lines) {
    const ev = JSON.parse(line);
    if (ev.type === "start") out.start = ev;
    else if (ev.type === "call") out.calls.push(ev);
    else if (ev.type === "end") out.end = ev;
  }
  if (!out.start) throw new Error(`${jsonlPath}: missing start event`);
  return out;
}

const samePos = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(Number(v) - Number(b[i])) < 1e-2);
};

export async function verifyRunDir(runDir) {
  const runId = path.basename(runDir);
  const resultPath = path.join(runDir, "result.json");
  const logPath = path.join(runDir, "episode.jsonl");
  if (!fs.existsSync(resultPath) || !fs.existsSync(logPath)) {
    return null;
  }

  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const log = readEpisodeLog(logPath);
  const mode = result.mode || log.start?.mode || "pure";
  const seed = Number(result.seed ?? log.start?.seed ?? 42) || 42;
  const host = new HostProcess(mode, seed);
  const diffs = [];

  try {
    const init = await host.send("observe");
    if (log.start?.initial && init.region !== log.start.initial.region) {
      diffs.push(
        `initial region mismatch: logged ${log.start.initial.region}, replayed ${init.region}`,
      );
    }

    let lastState = init;
    for (let i = 0; i < log.calls.length; i++) {
      const call = log.calls[i];
      const args = call.args || {};
      lastState = await host.send(call.tool, args);
      const expected = call.state;
      if (!expected) continue;

      if (expected.ok === false && lastState.ok === false) {
        continue;
      }

      if (lastState.region !== expected.region) {
        diffs.push(
          `step #${call.step} (${call.tool}): region ${expected.region} -> ${lastState.region}`,
        );
        break;
      }
      if (
        expected.leader?.position &&
        lastState.leader?.position &&
        !samePos(expected.leader.position, lastState.leader.position)
      ) {
        diffs.push(
          `step #${call.step} (${call.tool}): leader.position ${JSON.stringify(expected.leader.position)} -> ${JSON.stringify(lastState.leader.position)}`,
        );
        break;
      }
      if (
        expected.combat?.victories !== undefined &&
        lastState.combat?.victories !== expected.combat?.victories
      ) {
        diffs.push(
          `step #${call.step} (${call.tool}): combat.victories ${expected.combat?.victories} -> ${lastState.combat?.victories}`,
        );
        break;
      }
      if (
        expected.story?.scenes_viewed_count !== undefined &&
        lastState.story?.scenes_viewed_count !== expected.story?.scenes_viewed_count
      ) {
        diffs.push(
          `step #${call.step} (${call.tool}): story.scenes_viewed_count ${expected.story?.scenes_viewed_count} -> ${lastState.story?.scenes_viewed_count}`,
        );
        break;
      }
      if (
        expected.story?.echoes_discovered &&
        lastState.story?.echoes_discovered &&
        lastState.story.echoes_discovered.length !== expected.story.echoes_discovered.length
      ) {
        diffs.push(
          `step #${call.step} (${call.tool}): story.echoes_discovered.length ${expected.story.echoes_discovered.length} -> ${lastState.story.echoes_discovered.length}`,
        );
        break;
      }
      if (Boolean(lastState.game_cleared) !== Boolean(expected.game_cleared)) {
        diffs.push(
          `step #${call.step} (${call.tool}): game_cleared ${expected.game_cleared} -> ${lastState.game_cleared}`,
        );
        break;
      }
    }

    if (result.toolCalls !== log.calls.length) {
      diffs.push(
        `toolCalls mismatch: result.json=${result.toolCalls}, episode.jsonl=${log.calls.length}`,
      );
    }

    if (
      result.gameCleared !== undefined &&
      Boolean(result.gameCleared) !== Boolean(lastState.game_cleared)
    ) {
      diffs.push(
        `final gameCleared mismatch: result.json=${result.gameCleared}, replay=${Boolean(lastState.game_cleared)}`,
      );
    }

    const digest = computeEpisodeDigest(runDir);
    const agentTurns = Number(result.agentTurns) || 1;
    const callsPerTurn = Number((log.calls.length / Math.max(1, agentTurns)).toFixed(2));
    const moveToCalls = log.calls.filter((c) => c.tool === "move_to").length;

    let usedExternalScript = false;
    const clientPath = path.join(runDir, "client.jsonl");
    if (fs.existsSync(clientPath)) {
      const clientRaw = fs.readFileSync(clientPath, "utf8");
      if (/\b(drive\.mjs|s\.sh|g\.sh)\b/.test(clientRaw)) {
        usedExternalScript = true;
      }
    }
    const optimizationWarnings = [];
    if (mode === "pure") {
      if (usedExternalScript) {
        optimizationWarnings.push("external_driver_script_detected");
      }
      if (callsPerTurn > 2.5) {
        optimizationWarnings.push(`excessive_turn_batching(${callsPerTurn}_calls_per_turn)`);
      }
      if (moveToCalls === 0 && log.calls.length > 20) {
        optimizationWarnings.push("zero_move_to_navigation");
      }
    }

    const branchesChosenCount = Object.keys(lastState.story?.branches_chosen || {}).length;
    const echoesDiscoveredCount = (lastState.story?.echoes_discovered || []).length;
    const scenesViewedCount = lastState.story?.scenes_viewed_count || 0;
    const linesRead = lastState.story?.lines_read || 0;
    const discoveredRegionsCount = (lastState.discovered_regions || []).length;
    const puppetsCraftedCount = (lastState.puppets?.crafted || []).length;

    const verdict = {
      ok: diffs.length === 0,
      state: diffs.length === 0 ? "verified" : "failed",
      runId,
      model: result.model,
      mode,
      seed,
      toolCalls: log.calls.length,
      agentTurns,
      callsPerTurn,
      moveToCalls,
      optimizationWarnings,
      finalRegion: `${lastState.region} (${lastState.region_name})`,
      discoveredRegionsCount,
      scenesViewedCount,
      linesRead,
      branchesChosenCount,
      echoesDiscoveredCount,
      puppetsCraftedCount,
      ultimatesTriggered: lastState.combat?.ultimates_triggered ?? 0,
      gameCleared: Boolean(lastState.game_cleared),
      victories: lastState.combat?.victories ?? 0,
      episodeDigest: digest,
      verifiedAt: new Date().toISOString(),
      diffs,
    };
    fs.writeFileSync(
      path.join(runDir, "verify.json"),
      JSON.stringify(verdict, null, 2) + "\n",
    );
    return verdict;
  } finally {
    host.close();
  }
}

async function main() {
  if (!fs.existsSync(OUT_ROOT)) {
    console.log("No bench/out directory yet.");
    return;
  }
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const dirs =
    args.length > 0
      ? args.map((d) => path.resolve(d))
      : fs
          .readdirSync(OUT_ROOT, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join(OUT_ROOT, d.name))
          .sort();

  let passed = 0;
  let failed = 0;
  for (const dir of dirs) {
    const v = await verifyRunDir(dir);
    if (!v) continue;
    if (v.ok) {
      passed++;
      console.log(
        `[VERIFIED ✓] ${v.runId} | model=${v.model} | mode=${v.mode} | steps=${v.toolCalls} | scenes=${v.scenesViewedCount}/13 | branches=${v.branchesChosenCount}/7 | echoes=${v.echoesDiscoveredCount}/9 | regions=${v.discoveredRegionsCount}/9 | cleared=${v.gameCleared} | sha256=${v.episodeDigest.slice(0, 12)}`,
      );
    } else {
      failed++;
      console.error(
        `[FAILED ✗]   ${v.runId} | diffs=${v.diffs.join("; ")}`,
      );
    }
  }
  console.log(
    `\nReplay Verification Summary: ${passed} verified, ${failed} failed.`,
  );
  if (failed > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
