#!/usr/bin/env node
/**
 * run-argon.mjs — 使用 agy-cli 驱动《古剑奇谭二：永夜初晗凝碧天》(agent-gujian2-host) 进行无头 3D 开放世界全剧情闯关评测
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { verifyRunDir } from "./verify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const HOST_SCRIPT =
  process.env.AGENT_GUJIAN2_HOST_BIN ||
  path.join(ROOT_DIR, "bin", "agent-gujian2-host.mjs");
const AGY_BIN =
  process.env.BENCH_AGY_BIN || path.join(os.homedir(), ".local", "bin", "agy");

function parseCliArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return fallback;
}

const MODEL = parseCliArg("--model", process.env.BENCH_MODEL || "gemini-4-argon-medium");
const MODE =
  parseCliArg("--mode", process.env.BENCH_MODE || "pure").toLowerCase() === "normal"
    ? "normal"
    : "pure";
const SEED = Number(parseCliArg("--seed", "42")) || 42;

class HostBridge {
  constructor(scriptPath, mode, seed) {
    const args = [scriptPath, "--mode", mode, "--seed", String(seed)];
    this.proc = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.queue = [];
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      const resolver = this.queue.shift();
      if (resolver) resolver(JSON.parse(line));
    });
  }

  rpc(payload) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Host RPC timeout: ${JSON.stringify(payload)}`)),
        15000,
      );
      this.queue.push((res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this.proc.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  close() {
    try {
      this.proc.stdin.write("quit\n");
      this.proc.kill();
    } catch {}
  }
}

const TOOLS = [
  {
    name: "observe",
    description:
      "Observe current 3D open-world state, region, journal (objective, waypoint, nearby_echoes), world_objects, party, astral, puppets, home, mechanisms, dialog, story progress (scenes_viewed, branches_chosen, pending_branch, echoes_discovered), and combat telemetry.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "move_to",
    description:
      "Navigate party leader in 3D world space toward (x, z) across the 9 regions with 2D OBB building collision, bridge elevation, and cliff slope checks.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Target X coordinate" },
        z: { type: "number", description: "Target Z coordinate" },
        max_steps: { type: "number", description: "Max physics steps (default 300)" },
      },
      required: ["x", "z"],
    },
  },
  {
    name: "interact",
    description:
      "Interact with a named world object/NPC/boss/altar/echo within 35m (or omit `target` when `dialog.visible` is true to confirm/close the current dialog and auto-select any pending branch).",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Optional object/NPC/boss/echo ID to interact with (must be within 35m in pure mode)",
        },
      },
    },
  },
  {
    name: "step_dialog",
    description:
      "Advance the active story cutscene dialog by 1 line and cut the 3D cinematic camera to the next shot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "choose_branch",
    description:
      "Choose a multi-branch dialogue option (`branch_id`, `option` index 0..2 or option ID) to shape alignment (benevolence/resolve/insight), companion affection, party stats, and exclusive story keepsakes.",
    inputSchema: {
      type: "object",
      properties: {
        branch_id: { type: "string", description: "Branch ID (e.g. from story.pending_branch.id)" },
        option: { type: "number", description: "Option index (0, 1, or 2)" },
      },
    },
  },
  {
    name: "trigger_echo",
    description:
      "Resonate with a regional Star-Sea Memory Echo stele (`echo_id`, must be within 35m in pure mode) to view its side-story script and receive its keepsake reward.",
    inputSchema: {
      type: "object",
      properties: {
        echo_id: { type: "string", description: "Echo ID (e.g. from journal.nearby_echoes)" },
      },
      required: ["echo_id"],
    },
  },
  {
    name: "switch_leader",
    description:
      "Switch controlled party leader (0=乐无异, 1=闻人羽, 2=夏夷则, 3=阿阮). Target hero must have `in_team: true`.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number", description: "Hero slot index (0..3)" },
      },
      required: ["index"],
    },
  },
  {
    name: "allocate_astral",
    description:
      "Allocate Star Souls (`points`) on the Four-Symbol Astral Chart for `role_id` (101=乐无异, 102=闻人羽, 103=夏夷则, 104=阿阮) to unlock elemental skills and Astral Ultimates.",
    inputSchema: {
      type: "object",
      properties: {
        role_id: { type: "number", description: "Hero role_id (101, 102, 103, or 104)" },
        points: { type: "number", description: "Star soul points to allocate (default 3)" },
      },
      required: ["role_id"],
    },
  },
  {
    name: "craft_puppet",
    description:
      "Craft and deploy an automaton puppet in the Yanshi Workshop (`zhusun_baozi`, `mujia_shiwei`, or `feitian_yanjia`).",
    inputSchema: {
      type: "object",
      properties: {
        puppet_id: {
          type: "string",
          description: '"zhusun_baozi", "mujia_shiwei", or "feitian_yanjia"',
        },
      },
      required: ["puppet_id"],
    },
  },
  {
    name: "solve_mechanism",
    description:
      "Solve an ancient tomb or ruin mechanism (`mech_jiangling_tomb` or `mech_juandu_armillary`, must be within 35m in pure mode).",
    inputSchema: {
      type: "object",
      properties: {
        mechanism_id: {
          type: "string",
          description: '"mech_jiangling_tomb" or "mech_juandu_armillary"',
        },
      },
      required: ["mechanism_id"],
    },
  },
  {
    name: "home_action",
    description:
      'Execute Peach-Blossom Home (桃源仙居) activities (`action`: "plant", "woodwork", "cook", or "all"; optional `item` name).',
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: '"plant", "woodwork", "cook", or "all"' },
        item: { type: "string", description: "Optional crafted woodwork or cooked dish name" },
      },
      required: ["action"],
    },
  },
  {
    name: "combat_action",
    description:
      'Execute a real-time 4-hero ARPG combat command when `combat.active` is true: "dodge" (0.45s iframe to evade red-circle boss AOE), "guard" (parry & break shield), "attack" (3-hit light combo), "heavy" (shield-breaker), "skill" (elemental skill), or "ultimate" (Astral Ultimate).',
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: '"dodge", "guard", "attack", "heavy", "skill", or "ultimate"',
        },
      },
      required: ["action"],
    },
  },
  {
    name: "save_checkpoint",
    description: "Save an instant in-memory state snapshot under `slot`.",
    inputSchema: {
      type: "object",
      properties: {
        slot: { type: "string", description: "Checkpoint slot name" },
      },
      required: ["slot"],
    },
  },
  {
    name: "load_checkpoint",
    description: "Restore a previously saved in-memory snapshot from `slot`.",
    inputSchema: {
      type: "object",
      properties: {
        slot: { type: "string", description: "Checkpoint slot name" },
      },
      required: ["slot"],
    },
  },
];

function isFullStoryCleared(state) {
  if (!state || !state.game_cleared) return false;
  const scenes = state.story?.scenes_viewed_count || 0;
  const branches = Object.keys(state.story?.branches_chosen || {}).length;
  const echoes = (state.story?.echoes_discovered || []).length;
  const regions = (state.discovered_regions || []).length;
  return scenes >= 13 && branches >= 7 && echoes >= 9 && regions >= 9;
}

function compactStateForModel(state) {
  if (!state || !state.ok) return state;
  const pendingObjects = (state.world_objects || []).filter((o) => !o.interacted);
  return {
    ok: state.ok,
    event: state.event,
    tick: state.tick,
    region: state.region,
    region_name: state.region_name,
    chapter_title: state.chapter_title,
    journal: state.journal,
    unvisited_world_objects: pendingObjects.slice(0, 10),
    discovered_regions: state.discovered_regions,
    game_cleared: state.game_cleared,
    leader: state.leader,
    party: state.party.map((p) => ({
      role_id: p.role_id,
      name: p.name,
      in_team: p.in_team,
      level: p.level,
      hp: p.hp,
      max_hp: p.max_hp,
      attack: p.attack,
      equipped_weapon: p.equipped_weapon,
      astral_totem: p.astral_totem,
      astral_points: p.astral_points,
      ultimate_unlocked: p.ultimate_unlocked,
      ultimate_name: p.ultimate_name,
    })),
    astral: state.astral,
    puppets: state.puppets,
    home: state.home,
    mechanisms: state.mechanisms,
    combat: state.combat,
    dialog: state.dialog?.visible
      ? {
          visible: true,
          scene_id: state.dialog.scene_id,
          scene_title: state.dialog.scene_title,
          speaker: state.dialog.speaker,
          text: state.dialog.text,
          line_index: state.dialog.line_index,
          total_lines: state.dialog.total_lines,
          branch_id: state.dialog.branch_id,
        }
      : { visible: false },
    story: {
      scenes_viewed_count: state.story?.scenes_viewed_count,
      scenes_viewed: state.story?.scenes_viewed,
      lines_read: state.story?.lines_read,
      branches_chosen_count: Object.keys(state.story?.branches_chosen || {}).length,
      branches_chosen: state.story?.branches_chosen,
      pending_branch: state.story?.pending_branch,
      echoes_discovered_count: (state.story?.echoes_discovered || []).length,
      echoes_discovered: state.story?.echoes_discovered,
      alignment: state.story?.alignment,
      affection: state.story?.affection,
    },
  };
}

function modelPrefix(modelName) {
  const m = modelName.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("glm")) return "glm";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("qwen")) return "qwen";
  if (m.includes("flash")) return "flash";
  return "argon";
}

async function main() {
  if (!fs.existsSync(HOST_SCRIPT)) {
    throw new Error(`Missing host script: ${HOST_SCRIPT}`);
  }
  if (!fs.existsSync(AGY_BIN)) {
    throw new Error(`Missing agy CLI binary: ${AGY_BIN}`);
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const prefix = modelPrefix(MODEL);
  const outDir = path.join(ROOT_DIR, "bench", "out", `${prefix}-${stamp}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-gujian2-bench-"));
  fs.mkdirSync(outDir, { recursive: true });

  const host = new HostBridge(HOST_SCRIPT, MODE, SEED);
  const initialObs = await host.rpc({ cmd: "observe" });

  const traceFile = path.join(outDir, "episode.jsonl");
  const clientLogFile = path.join(outDir, "client.jsonl");
  const resultFile = path.join(outDir, "result.json");
  const traceStream = fs.createWriteStream(traceFile, { flags: "a" });
  traceStream.write(
    JSON.stringify({
      type: "start",
      timestamp: new Date().toISOString(),
      model: `agy-cli:${MODEL}`,
      mode: MODE,
      seed: SEED,
      initial: initialObs,
    }) + "\n",
  );

  let toolCalls = 0;
  let callsInCurrentTurn = 0;
  const MAX_PURE_CALLS_PER_TURN = 2;
  let clearedState = null;

  const purgeUnauthorizedScripts = () => {
    if (MODE !== "pure") return [];
    const removed = [];
    try {
      for (const ent of fs.readdirSync(tmpDir, { withFileTypes: true })) {
        if (ent.name === "gj2bench.mjs") continue;
        if (ent.isFile() && /\.(mjs|cjs|js|sh|py|rb|pl)$/i.test(ent.name)) {
          fs.unlinkSync(path.join(tmpDir, ent.name));
          removed.push(ent.name);
        }
      }
    } catch {}
    return removed;
  };

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body || "{}");
    if (msg.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } }));
      return;
    }
    if (msg.method === "tools/call") {
      const { name, arguments: args = {} } = msg.params || {};
      const removedScripts = purgeUnauthorizedScripts();
      if (MODE === "pure" && removedScripts.length > 0) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: false,
                    error: `pure_mode_violation: external automation scripts (${removedScripts.join(", ")}) are forbidden in pure mode and have been removed. Issue commands directly via gj2bench.mjs step-by-step.`,
                  }),
                },
              ],
            },
          }),
        );
        return;
      }
      if (MODE === "pure" && name !== "observe") {
        callsInCurrentTurn++;
        if (callsInCurrentTurn > MAX_PURE_CALLS_PER_TURN) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      ok: false,
                      error: `pure_mode_turn_limit: at most ${MAX_PURE_CALLS_PER_TURN} action commands are allowed per agent reasoning turn in pure mode. Do not batch or loop commands; inspect the current observation and decide your next step in the next turn.`,
                    }),
                  },
                ],
              },
            }),
          );
          return;
        }
      }
      toolCalls++;
      const payload = { cmd: name, ...args };
      const state = await host.rpc(payload);
      traceStream.write(
        JSON.stringify({ type: "call", step: toolCalls, tool: name, args, state }) + "\n",
      );
      console.log(
        `[Step ${toolCalls}] ${name}(${JSON.stringify(args)}) -> reg=${state.region} event=${state.event} pos=${JSON.stringify(state.leader?.position)} scenes=${state.story?.scenes_viewed_count}/13 branches=${Object.keys(state.story?.branches_chosen || {}).length}/7 echoes=${state.story?.echoes_discovered?.length}/9 victories=${state.combat?.victories} cleared=${state.game_cleared}`,
      );
      if (isFullStoryCleared(state) && !clearedState) {
        clearedState = state;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [
              { type: "text", text: JSON.stringify(compactStateForModel(state), null, 2) },
            ],
          },
        }),
      );
      return;
    }
    res.writeHead(400);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;

  const helperFile = path.join(tmpDir, "gj2bench.mjs");
  fs.writeFileSync(
    helperFile,
    `#!/usr/bin/env node
const [,, name, rawArgs] = process.argv;
const args = rawArgs ? JSON.parse(rawArgs) : {};
const r = await fetch(${JSON.stringify(url)}, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: name === '--list' ? 'tools/list' : 'tools/call',
    params: name === '--list' ? {} : { name, arguments: args }
  })
});
const j = await r.json();
if (name === '--list') console.log(JSON.stringify(j.result?.tools || [], null, 2));
else console.log((j.result?.content || []).map(c => c.text || '').join('\\n'));
`,
    { mode: 0o755 },
  );

  const toolsDoc = TOOLS.map(
    (t) =>
      `- \`node ${helperFile} ${t.name} '${JSON.stringify(
        Object.fromEntries(
          Object.keys(t.inputSchema.properties || {}).map((k) => [k, `<${k}>`]),
        ),
      )}'\`: ${t.description}`,
  ).join("\n");

  const pureGuide = [
    `You are playing Gujian 2 (《古剑奇谭二：永夜初晗凝碧天》 - Open-Gujian2 Deterministic Headless Runtime) in PURE (Zero-Prior / Anti-Cheat) mode.`,
    `Your goal is a 100% FULL-STORY PLAYTHROUGH across all 7 Chapters and all 9 Regions:`,
    `1. Complete ALL 13/13 Main Story Scenes (\`story.scenes_viewed_count === 13\`).`,
    `2. Make ALL 7/7 Story Branch Choices (\`story.branches_chosen_count === 7\`) using \`choose_branch\` whenever \`story.pending_branch\` is non-null (including during/after \`boss_jingang\` and \`boss_shenye\`!).`,
    `3. Discover ALL 9/9 Regional Side Echoes (\`story.echoes_discovered_count === 9\`) by moving within 35m of each \`echo_*\` stele listed in \`journal.nearby_echoes\` or \`unvisited_world_objects\` and calling \`trigger_echo\` (or \`interact\`).`,
    `4. Unlock all 4 Heroes, allocate Astral points (\`allocate_astral\` for role_ids 101, 102, 103, 104) to unlock all 4 Astral Ultimates, perform Peach-Blossom Home actions (\`home_action\` with \`{"action": "all"}\`), and craft all 3 Puppets (\`zhusun_baozi\`, \`mujia_shiwei\`, \`feitian_yanjia\`).`,
    `5. Defeat all 3 Bosses (\`boss_jingang\`, \`boss_huayue\`, \`boss_shenye\`) using real-time ARPG combat (\`dodge\` when \`telegraph_active\` is true, \`heavy\`/\`guard\` to break shields, and \`skill\`/\`ultimate\` to deal massive damage), and interact with \`altar_grand_ending\` ONLY AFTER all 9 echoes and all 7 branches are completed so \`game_cleared\` becomes \`true\` with 100% story completion!`,
    ``,
    `PURE MODE RULES:`,
    `- In pure mode, \`interact\`, \`solve_mechanism\`, and \`trigger_echo\` require your leader to be within 35m of the target's \`(x, z)\` coordinates! Always call \`move_to\` (\`{"x": <x>, "z": <z>, "max_steps": 400}\`) first.`,
    `- Whenever \`story.pending_branch\` is present, call \`choose_branch\` (\`{"branch_id": "<id>", "option": 0}\`) to record your branch decision!`,
    `- Do NOT write any helper/driver scripts (\`.mjs\`, \`.js\`, \`.sh\`, \`.py\`) or shell loops. At most ${MAX_PURE_CALLS_PER_TURN} action commands are permitted per agent reasoning turn (you may chain at most 2 \`node ${helperFile} ...\` calls with \`&&\` in a single shell command).`,
  ];

  console.log("================================================================");
  console.log(
    `  Launching agy-cli:${MODEL} [mode=${MODE}, seed=${SEED}] on agent-gujian2 Full-Story Campaign`,
  );
  console.log(`  Output Directory: ${outDir}`);
  console.log("================================================================");

  const clientLog = fs.createWriteStream(clientLogFile, { flags: "a" });
  let agentTurns = 0;
  let finalResult = null;
  const t0 = Date.now();
  const maxSessions = 4;

  for (let session = 1; session <= maxSessions && !clearedState; session++) {
    callsInCurrentTurn = 0;
    const curObs = session === 1 ? initialObs : await host.rpc({ cmd: "observe" });
    if (isFullStoryCleared(curObs)) {
      clearedState = curObs;
      break;
    }
    const prompt = [
      ...pureGuide,
      ``,
      `### Tool Execution Interface`,
      `Call game tools ONLY by executing \`node ${helperFile} <tool_name> '<json_args>'\` via your shell/command tool. Do NOT read or access any files outside \`${tmpDir}\`, and do NOT create any script files in \`${tmpDir}\`.`,
      `Strict Turn Policy: Execute at most ${MAX_PURE_CALLS_PER_TURN} tool calls per turn (e.g. \`move_to\` followed by \`interact\`/\`trigger_echo\`/\`solve_mechanism\`), inspect the JSON observation, and reason step-by-step.`,
      `Available tools:`,
      toolsDoc,
      ``,
      `### Current Observation (Session ${session}, Step ${toolCalls})`,
      "```json",
      JSON.stringify(compactStateForModel(curObs), null, 2),
      "```",
      ``,
      `Continue playing from the current state until \`game_cleared: true\`, \`scenes_viewed_count: 13\`, \`branches_chosen_count: 7\`, and \`echoes_discovered_count: 9\` are all achieved, then summarize your playthrough in 3-4 sentences.`,
    ].join("\n");

    const agyLog = path.join(outDir, `agy-s${session}.log`);
    const cliModel = MODEL.startsWith("claude-") || MODEL.startsWith("gemini-") ? MODEL : "gemini-4-argon-medium";
    const agyArgs = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "600s",
      "--model",
      cliModel,
      "--log-file",
      agyLog,
    ];

    console.log(
      `--- Starting Agent Session ${session}/${maxSessions} (steps so far: ${toolCalls}) ---`,
    );
    const agy = spawn(AGY_BIN, agyArgs, {
      cwd: tmpDir,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/Users/jianmingliu/.local/bin:${process.env.PATH || ""}`,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });

    const rl = readline.createInterface({ input: agy.stdout });
    rl.on("line", (line) => {
      clientLog.write(line + "\n");
      try {
        const ev = JSON.parse(line);
        if (
          ev.event === "step_update" &&
          ev.step_update?.state === "DONE" &&
          ev.step_update?.step_type === "agent_response"
        ) {
          agentTurns++;
          callsInCurrentTurn = 0;
        }
        if (ev.event === "result" && ev.result) {
          finalResult = ev.result;
        }
      } catch {}
    });

    await new Promise((resolve) => agy.on("close", resolve));
  }
  const durationMs = Date.now() - t0;

  const finalObs = await host.rpc({ cmd: "observe" });
  const summary = {
    ok: Boolean(clearedState || finalObs.game_cleared),
    model: `agy-cli:${MODEL}`,
    mode: MODE,
    seed: SEED,
    toolCalls,
    agentTurns: agentTurns || finalResult?.num_turns || 0,
    durationMs,
    region: finalObs.region,
    regionName: finalObs.region_name,
    chapterTitle: finalObs.chapter_title,
    discoveredRegions: finalObs.discovered_regions,
    gameCleared: finalObs.game_cleared,
    story: {
      scenesViewedCount: finalObs.story?.scenes_viewed_count || 0,
      scenesViewed: finalObs.story?.scenes_viewed || [],
      linesRead: finalObs.story?.lines_read || 0,
      branchesChosenCount: Object.keys(finalObs.story?.branches_chosen || {}).length,
      branchesChosen: finalObs.story?.branches_chosen || {},
      echoesDiscoveredCount: (finalObs.story?.echoes_discovered || []).length,
      echoesDiscovered: finalObs.story?.echoes_discovered || [],
      alignment: finalObs.story?.alignment || {},
      affection: finalObs.story?.affection || {},
    },
    combat: finalObs.combat,
    leader: finalObs.leader,
    party: finalObs.party,
    astral: finalObs.astral,
    puppets: finalObs.puppets,
    home: finalObs.home,
    mechanisms: finalObs.mechanisms,
    inventory: finalObs.inventory,
    usage: finalResult?.usage || null,
  };

  fs.writeFileSync(resultFile, JSON.stringify(summary, null, 2));
  await new Promise((resolve) =>
    traceStream.write(JSON.stringify({ type: "end", summary }) + "\n", resolve),
  );
  await new Promise((resolve) => traceStream.end(resolve));
  await new Promise((resolve) => clientLog.end(resolve));
  host.close();
  server.close();

  const verdict = await verifyRunDir(outDir);
  console.log("================================================================");
  console.log("  Gujian 2 Playthrough Summary & Replay Verdict:");
  console.log(JSON.stringify({ summary, verdict }, null, 2));
  console.log("================================================================");

  if (!summary.gameCleared) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
