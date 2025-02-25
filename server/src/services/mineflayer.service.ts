import mineflayer from "mineflayer";
import { IService } from "./base.service.js";
import pathfinder from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { plugin as collectBlock } from "mineflayer-collectblock";
import { AnyType } from "src/utils.js";
const { Movements, goals } = pathfinder;

export class MineflayerService implements IService {
  private static instance: MineflayerService;
  private bot: mineflayer.Bot | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  private lastPosition = { x: 0, y: 0, z: 0 };
  private isFollowing = false;
  private followInterval: NodeJS.Timeout | null = null;

  private constructor() {}

  static getInstance(): MineflayerService {
    if (!MineflayerService.instance) {
      MineflayerService.instance = new MineflayerService();
    }
    return MineflayerService.instance;
  }

  async init() {
    try {
      console.log("[Mineflayer] Initializing bot...");

      const config = {
        host: process.env.MINECRAFT_HOST || "localhost",
        port: parseInt(process.env.MINECRAFT_PORT || "25565"),
        username: process.env.MINECRAFT_USERNAME || "StarterKitBot",
        version: process.env.MINECRAFT_VERSION || "1.21.4",
        auth: "offline" as const,
        skipValidation: false,
        checkTimeoutInterval: 60000,
        closeTimeout: 240000,
        keepAlive: true,
      };

      console.log("[Mineflayer] Connecting with config:", config);
      this.bot = mineflayer.createBot(config);

      console.log("[Mineflayer] Loading plugins...");
      this.bot.loadPlugin(pathfinder.pathfinder);
      this.bot.loadPlugin(collectBlock);

      this.setupEventHandlers();
      console.log("[Mineflayer] Bot initialization complete");
    } catch (error) {
      console.error("[Mineflayer] Failed to initialize bot:", error);
      console.dir(error, { depth: null });
      throw error;
    }
  }
  // dont change this _username to username
  private async harvestTree(_username: string, amount: number) {
    if (!this.bot) return;

    try {
      const checkMessage = `Checking inventory for logs...`;
      console.log(`[Mineflayer] ${checkMessage}`);
      this.bot.chat(checkMessage);

      const existingLogs = this.bot.inventory
        .items()
        .filter((item) => item.name.includes("_log"))
        .reduce((total, item) => total + item.count, 0);

      console.dir({ existingLogs, requiredAmount: amount }, { depth: null });

      if (existingLogs >= amount) {
        const enoughLogsMessage = `I already have ${existingLogs} logs, that's enough! 🪵`;
        console.log(`[Mineflayer] ${enoughLogsMessage}`);
        this.bot.chat(enoughLogsMessage);
        return;
      }

      const neededLogs = amount - existingLogs;
      const searchMessage = `I need ${neededLogs} more logs. Looking for trees... 🔍`;
      console.log(`[Mineflayer] ${searchMessage}`);
      this.bot.chat(searchMessage);

      const logBlock = this.bot.findBlock({
        matching: (block) => block.name.includes("_log"),
        maxDistance: 64,
        useExtraInfo: (block) => {
          const leavesNearby = this.bot!.findBlock({
            matching: (b) => b.name.includes("leaves"),
            maxDistance: 2,
            count: 1,
            point: block.position,
          });
          return !!leavesNearby;
        },
      });

      if (logBlock) {
        console.dir(
          { foundLogBlock: logBlock.name, position: logBlock.position },
          { depth: 2 }
        );
      }

      if (!logBlock) {
        const noTreesMessage = "No trees found within 64 blocks! 😢";
        console.log(`[Mineflayer] ${noTreesMessage}`);
        this.bot.chat(noTreesMessage);
        return;
      }

      const startChopMessage = `Found a ${logBlock.name.replace("_", " ")}! Starting to chop... 🪓`;
      console.log(`[Mineflayer] ${startChopMessage}`);
      this.bot.chat(startChopMessage);

      const treeBlocks = this.bot.findBlocks({
        matching: logBlock.type,
        maxDistance: 32,
        count: neededLogs,
        point: logBlock.position,
      });

      let collectedLogs = 0;
      let lastPosition = this.bot.entity.position.clone();
      let stuckCounter = 0;
      const MAX_STUCK_TICKS = 100; // 5 seconds at 20 ticks/sec

      for (const pos of treeBlocks) {
        const block = this.bot.blockAt(pos);
        if (!block || block.type !== logBlock.type) continue;

        try {
          // Check if we're stuck
          const currentPos = this.bot.entity.position;
          if (currentPos.distanceTo(lastPosition) < 0.1) {
            stuckCounter++;
            if (stuckCounter > MAX_STUCK_TICKS) {
              const stuckMessage =
                "I seem to be stuck! Moving to next tree... 🏃";
              console.log(`[Mineflayer] ${stuckMessage}`);
              console.dir(
                {
                  type: "stuck_detection",
                  position: currentPos,
                  lastPosition,
                  stuckTicks: stuckCounter,
                  targetBlock: pos,
                },
                { depth: null }
              );
              this.bot.chat(stuckMessage);

              // Try to unstuck by stopping current action
              (this.bot.collectBlock as AnyType).stop();
              this.bot.setControlState("jump", false);
              await this.bot.waitForTicks(10);

              // Reset counter and update position
              stuckCounter = 0;
              lastPosition = currentPos.clone();
              continue;
            }
          } else {
            // Reset counter if we're moving
            stuckCounter = 0;
            lastPosition = currentPos.clone();
          }

          await this.bot.collectBlock.collect(block);
          collectedLogs++;
          if (collectedLogs % 3 === 0) {
            // Report progress every 3 logs
            const message = `Chopped ${collectedLogs} logs so far... ⚡`;
            console.log(`[Mineflayer] ${message}`);
            this.bot.chat(message);
          }

          // Stack logs after each collection
          const logs = this.bot.inventory
            .items()
            .filter((item) => item.name === logBlock.name);
          if (logs.length > 1) {
            const message = `Organizing inventory... 📦`;
            console.log(`[Mineflayer] ${message}`);
            this.bot.chat(message);
            const bestStack = logs.reduce((prev, current) =>
              64 - current.count > 64 - prev.count ? current : prev
            );

            for (const log of logs) {
              if (log !== bestStack) {
                try {
                  await this.bot.moveSlotItem(log.slot, bestStack.slot);
                  await this.bot.waitForTicks(2);
                } catch (err) {
                  const message = `Oops, had trouble collecting that log... 😅`;
                  console.error(`[Mineflayer] ${message}`, err);
                  console.dir(err, { depth: null });
                  this.bot.chat(message);
                }
              }
            }
          }

          const totalLogs = logs.reduce((sum, item) => sum + item.count, 0);
          if (totalLogs >= amount) {
            const message = `Got all ${amount} logs! Mission accomplished! 🎉`;
            console.log(`[Mineflayer] ${message}`);
            this.bot.chat(message);
            break;
          }
        } catch (err) {
          const errorMessage = `Oops, had trouble collecting that log... 😅`;
          console.error(`[Mineflayer] ${errorMessage}`, err);
          console.dir(err, { depth: null });
          this.bot.chat(errorMessage);

          // Reset stuck detection on error
          stuckCounter = 0;
          lastPosition = this.bot.entity.position.clone();
          continue;
        }
      }

      const finalCount = this.bot.inventory
        .items()
        .filter((item) => item.name.includes("_log"))
        .reduce((total, item) => total + item.count, 0);

      console.dir(
        {
          type: "harvest_complete",
          finalCount,
          originalRequest: amount,
          collectedLogs,
          position: this.bot.entity.position,
        },
        { depth: null }
      );

      const message = `All done! I now have ${finalCount} logs in total 🪵`;
      console.log(`[Mineflayer] ${message}`);
      this.bot.chat(message);
    } catch (error) {
      console.error("[Mineflayer] Error in tree harvesting:", error);
      console.dir(error, { depth: null });
      this.bot.chat("Something went wrong while harvesting... 😢");
    }
  }

  private async buildPlatform(username: string, size: number) {
    if (!this.bot || size < 1) return;

    try {
      const player = this.bot.players[username];
      if (!player?.entity) {
        const cantSeeMessage = "I can't see you! Where are you? 👀";
        console.log(`[Mineflayer] ${cantSeeMessage}`);
        this.bot.chat(cantSeeMessage);
        return;
      }

      const planningMessage = `Planning to build a ${size}x${size} platform... 🏗️`;
      console.log(`[Mineflayer] ${planningMessage}`);
      this.bot.chat(planningMessage);

      const requiredLogs = size * size;
      console.dir(
        {
          platformSize: size,
          requiredLogs,
          playerPosition: player.entity.position,
        },
        { depth: null }
      );

      const logs = this.bot.inventory
        .items()
        .filter((item) => item.name.includes("_log"));
      const totalLogs = logs.reduce((sum, item) => sum + item.count, 0);

      if (totalLogs < requiredLogs) {
        const notEnoughMessage = `I need ${requiredLogs} logs for a ${size}x${size} platform, but only have ${totalLogs}! Try !harvest ${requiredLogs} first! 🪵`;
        console.log(`[Mineflayer] ${notEnoughMessage}`);
        this.bot.chat(notEnoughMessage);
        return;
      }

      const movingMessage = `I have enough logs! Moving into position... 🚶`;
      console.log(`[Mineflayer] ${movingMessage}`);
      this.bot.chat(movingMessage);
      const playerPos = player.entity.position.clone();
      const buildPos = new Vec3(playerPos.x, playerPos.y, playerPos.z + 3);

      try {
        const goal = new goals.GoalNear(buildPos.x, buildPos.y, buildPos.z, 1);
        await this.bot.pathfinder.goto(goal);
        const message = `In position! Starting to build... 🏗️`;
        console.log(`[Mineflayer] ${message}`);
        this.bot.chat(message);
      } catch (err) {
        const message =
          "Can't reach the building position! Is the path blocked? 🚫";
        console.log(`[Mineflayer] ${message}`);
        this.bot.chat(message);
        return;
      }

      const offset = Math.floor(size / 2);
      let blocksPlaced = 0;
      const totalBlocks = size * size;

      for (let z = size - 1; z >= 0; z--) {
        for (let x = -offset; x < size - offset; x++) {
          const currentLogs = this.bot.inventory
            .items()
            .find((item) => item.name.includes("_log"));

          if (!currentLogs) {
            const message = "Uh oh, ran out of logs! 😱";
            console.log(`[Mineflayer] ${message}`);
            this.bot.chat(message);
            return;
          }

          if (!this.bot.heldItem || !this.bot.heldItem.name.includes("_log")) {
            await this.bot.equip(currentLogs, "hand");
          }

          const blockPos = new Vec3(
            Math.floor(playerPos.x) + x,
            Math.floor(playerPos.y) - 1,
            Math.floor(playerPos.z) + z + 2
          );

          try {
            const block = this.bot.blockAt(blockPos);
            if (!block || !this.bot.canDigBlock(block)) continue;

            const refBlock = this.bot.blockAt(blockPos.offset(0, 1, 0));
            if (!refBlock) continue;

            const botPos = this.bot.entity.position;
            const isBotPosition =
              Math.floor(botPos.x) === Math.floor(blockPos.x) &&
              Math.floor(botPos.z) === Math.floor(blockPos.z) &&
              Math.floor(botPos.y) === Math.floor(blockPos.y + 1);

            console.dir(
              {
                action: "place_block",
                botPosition: botPos,
                targetPosition: blockPos,
                isBotPosition,
                blockType: currentLogs?.name,
              },
              { depth: null }
            );

            if (isBotPosition) {
              const message = "Need to jump to place this block! 🦘";
              console.log(`[Mineflayer] ${message}`);
              this.bot.setControlState("jump", true);
              await this.bot.waitForTicks(1);
              await this.bot.lookAt(blockPos, true);
              await this.bot.placeBlock(refBlock, new Vec3(0, -1, 0));
              this.bot.setControlState("jump", false);
            } else {
              await this.bot.lookAt(blockPos, true);
              await this.bot.placeBlock(refBlock, new Vec3(0, -1, 0));
            }

            blocksPlaced++;
            if (blocksPlaced % Math.ceil(totalBlocks / 4) === 0) {
              // Progress update every 25%
              const progress = Math.floor((blocksPlaced / totalBlocks) * 100);
              const message = `Platform ${progress}% complete! 🏗️`;
              console.log(`[Mineflayer] ${message}`);
              console.dir(
                {
                  progress,
                  blocksPlaced,
                  totalBlocks,
                  remainingLogs: this.bot.inventory
                    .items()
                    .filter((item) => item.name.includes("_log"))
                    .reduce((sum, item) => sum + item.count, 0),
                },
                { depth: null }
              );
              this.bot.chat(message);
            }
          } catch (err) {
            const message = `Oops, couldn't place a block here... 😅`;
            console.error(`[Mineflayer] ${message}`, err);
            console.dir(err, { depth: null });
            this.bot.chat(message);
            continue;
          }
        }

        if (z > 0) {
          const moveBackPos = new Vec3(
            buildPos.x,
            buildPos.y,
            buildPos.z + (z - 1)
          );
          try {
            const goal = new goals.GoalNear(
              moveBackPos.x,
              moveBackPos.y,
              moveBackPos.z,
              1
            );
            await this.bot.pathfinder.goto(goal);
            const message = "Moving back for the next row... 🚶";
            console.log(`[Mineflayer] ${message}`);
            this.bot.chat(message);
          } catch (err) {
            const message = "Had trouble moving back... 😅";
            console.log(`[Mineflayer] ${message}`);
            this.bot.chat(message);
          }
        }
      }

      const completionMessage = `${size}x${size} platform complete! 🎉 Used ${blocksPlaced} logs!`;
      console.log(`[Mineflayer] ${completionMessage}`);
      console.dir(
        {
          type: "platform_complete",
          size,
          blocksPlaced,
          remainingLogs: this.bot.inventory
            .items()
            .filter((item) => item.name.includes("_log"))
            .reduce((sum, item) => sum + item.count, 0),
          finalPosition: this.bot.entity.position,
        },
        { depth: null }
      );
      this.bot.chat(completionMessage);
    } catch (error) {
      console.error("[Mineflayer] Error in platform building:", error);
      console.dir(error, { depth: null });
      this.bot.chat("Something went wrong while building... 😢");
    }
  }

  private async moveToPlayer(position: Vec3) {
    if (!this.bot) return;

    console.log("[Mineflayer] Moving to position:", position);
    const goal = new goals.GoalNear(position.x, position.y, position.z, 1);

    try {
      await this.bot.pathfinder.goto(goal);
      const message = "Here I am!";
      console.log("[Mineflayer] Reached target position");
      this.bot.chat(message);
    } catch (err) {
      const message = "I can't find a path to you!";
      console.error("[Mineflayer] Pathfinding failed:", err);
      console.dir(err, { depth: null });
      this.bot.chat(message);
    }
  }

  private setupEventHandlers() {
    if (!this.bot) return;

    // Position logging
    setInterval(() => {
      if (this.bot?.entity?.position) {
        const pos = this.bot.entity.position;
        const roundedPos = {
          x: Math.round(pos.x * 100) / 100,
          y: Math.round(pos.y * 100) / 100,
          z: Math.round(pos.z * 100) / 100,
        };

        if (
          roundedPos.x !== this.lastPosition.x ||
          roundedPos.y !== this.lastPosition.y ||
          roundedPos.z !== this.lastPosition.z
        ) {
          console.log("[Mineflayer] Bot position updated:", roundedPos);
          console.dir(
            {
              oldPosition: this.lastPosition,
              newPosition: roundedPos,
              movement: {
                dx: roundedPos.x - this.lastPosition.x,
                dy: roundedPos.y - this.lastPosition.y,
                dz: roundedPos.z - this.lastPosition.z,
              },
            },
            { depth: null }
          );
          this.lastPosition = roundedPos;
        }
      }
    }, 1000);

    this.bot.once("spawn", () => {
      if (!this.bot) return;
      console.log("[Mineflayer] Bot spawned");
      console.dir(
        {
          position: this.bot.entity.position,
          health: this.bot.health,
          food: this.bot.food,
          gameMode: this.bot.game.gameMode,
        },
        { depth: null }
      );

      this.bot.chat("GM, just spawned!");

      // Set up initial game rules
      console.log("[Mineflayer] Setting up game rules...");
      this.bot.chat("/time set day");
      this.bot.chat("/gamerule doDaylightCycle false");
      this.bot.chat("/difficulty peaceful");

      const defaultMove = new Movements(this.bot);
      this.bot.pathfinder.setMovements(defaultMove);
      console.log("[Mineflayer] Initial setup complete");
    });

    this.bot.on("chat", async (username, message) => {
      if (!this.bot) return;
      if (username === this.bot.username) return;

      console.log("[Mineflayer] Chat received:", { username, message });

      const harvestMatch = message.match(/^!harvest\s+(\d+)$/);
      const platformMatch = message.match(/^!platform\s+(\d+)$/);

      if (harvestMatch) {
        const amount = parseInt(harvestMatch[1]);
        console.log("[Mineflayer] Harvest command received:", { amount });
        if (amount > 0) {
          await this.harvestTree(username, amount);
        } else {
          const message = "Please specify a valid number of logs to harvest!";
          console.log("[Mineflayer] Invalid harvest amount");
          this.bot.chat(message);
        }
      } else if (platformMatch) {
        const size = parseInt(platformMatch[1]);
        console.log("[Mineflayer] Platform command received:", { size });
        if (size > 0) {
          await this.buildPlatform(username, size);
        } else {
          const message = "Please specify a valid platform size!";
          console.log("[Mineflayer] Invalid platform size");
          this.bot.chat(message);
        }
      } else if (message === "!come") {
        console.log("[Mineflayer] Come command received from:", username);
        const player = this.bot.players[username];
        if (!player?.entity) {
          const message = "I can't see you!";
          console.log("[Mineflayer] Player not found:", username);
          this.bot.chat(message);
          return;
        }
        console.dir(
          {
            command: "come",
            player: username,
            targetPosition: player.entity.position,
            botPosition: this.bot.entity.position,
          },
          { depth: null }
        );
        await this.moveToPlayer(player.entity.position);
      } else if (message === "!follow") {
        await this.startFollowing(username);
      } else if (message === "!stopfollow") {
        this.stopFollowing();
      } else if (message === "!throw") {
        await this.throwLogs(username);
      }
    });

    this.bot.on("login", () => {
      console.log("[Mineflayer] Bot logged in successfully");
      console.dir(
        {
          username: this.bot?.username,
          version: this.bot?.version,
          connected: true,
          gameMode: this.bot?.game.gameMode,
        },
        { depth: null }
      );
    });

    this.bot.on("end", (reason: string) => {
      console.log("[Mineflayer] Bot connection ended:", reason);
      console.dir(
        {
          reason,
          reconnectAttempts: this.reconnectAttempts,
          maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
        },
        { depth: null }
      );
      this.bot = null;

      if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
        console.log(
          `[Mineflayer] Attempting reconnect ${this.reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS}`
        );
        this.reconnectAttempts++;
        setTimeout(() => this.init(), 5000);
      }
    });

    this.bot.on("error", (error) => {
      console.error("[Mineflayer] Bot error:", error);
      console.dir(error, { depth: null });
    });

    // Additional event handlers
    this.bot.on("health", () => {
      console.log("[Mineflayer] Health updated:", {
        health: this.bot?.health,
        food: this.bot?.food,
      });
    });

    this.bot.on("death", () => {
      console.log("[Mineflayer] Bot died", {
        position: this.bot?.entity.position,
        lastPosition: this.lastPosition,
      });
      this.bot?.chat("Oops, I died! 💀");
    });

    this.bot.on("kicked", (reason: string) => {
      console.log("[Mineflayer] Bot was kicked:", reason);
      console.dir({ reason }, { depth: null });
    });

    this.bot.on("blockUpdate", (oldBlock, newBlock) => {
      if (oldBlock?.type !== newBlock?.type) {
        console.log("[Mineflayer] Block updated:", {
          oldType: oldBlock?.type,
          newType: newBlock?.type,
          position: newBlock?.position,
        });
      }
    });
  }

  private async startFollowing(username: string) {
    if (!this.bot) return;

    const player = this.bot.players[username];
    if (!player?.entity) {
      this.bot.chat("I can't see you!");
      return;
    }

    this.isFollowing = true;
    this.bot.chat("I'll follow you!");

    this.followInterval = setInterval(async () => {
      if (!this.isFollowing || !this.bot) {
        if (this.followInterval) clearInterval(this.followInterval);
        return;
      }

      const target = this.bot.players[username]?.entity;
      if (!target) return;

      const goal = new goals.GoalNear(
        target.position.x,
        target.position.y,
        target.position.z,
        2
      );
      try {
        await this.bot.pathfinder.setGoal(goal);
      } catch (err) {
        console.error("[Mineflayer] Failed to follow player:", err);
      }
    }, 1000);
  }

  private stopFollowing() {
    if (!this.bot) return;

    this.isFollowing = false;
    if (this.followInterval) {
      clearInterval(this.followInterval);
      this.followInterval = null;
    }
    this.bot.pathfinder.setGoal(null);
    this.bot.chat("Stopped following!");
  }

  private async throwLogs(username: string) {
    if (!this.bot) return;

    const logs = this.bot.inventory
      .items()
      .filter((item) => item.name.includes("_log"));
    if (logs.length === 0) {
      this.bot.chat("I don't have any logs to throw! 🤷");
      return;
    }

    const player = this.bot.players[username]?.entity;
    if (!player) {
      this.bot.chat("I can't see you! Come closer! 👀");
      return;
    }

    // Move to player first
    try {
      const goal = new goals.GoalNear(
        player.position.x,
        player.position.y,
        player.position.z,
        2
      );
      await this.bot.pathfinder.goto(goal);
      await this.bot.lookAt(player.position);
    } catch (err) {
      console.error("[Mineflayer] Failed to reach player:", err);
      this.bot.chat("I can't reach you! 😢");
      return;
    }

    const count = logs.reduce((sum, item) => sum + item.count, 0);
    const position = this.bot.entity.position;
    const roundedPos = {
      x: Math.round(position.x * 10) / 10,
      y: Math.round(position.y * 10) / 10,
      z: Math.round(position.z * 10) / 10,
    };

    console.log("[Mineflayer] Throwing logs:", { count, position: roundedPos });
    this.bot.chat(
      `Throwing ${count} logs at x:${roundedPos.x} y:${roundedPos.y} z:${roundedPos.z}! 🎯`
    );

    for (const log of logs) {
      try {
        await this.bot.tossStack(log);
        await this.bot.waitForTicks(2);
      } catch (err) {
        console.error("[Mineflayer] Error throwing item:", err);
      }
    }

    this.bot.chat("All logs thrown! 🎊");
  }

  getBot() {
    return this.bot;
  }

  async shutdown() {
    if (this.bot) {
      console.log("[Mineflayer] Shutting down bot...");
      this.bot.end();
      this.bot = null;
    }
  }

  async start() {
    await this.init();
  }

  async stop() {
    await this.shutdown();
  }
}
