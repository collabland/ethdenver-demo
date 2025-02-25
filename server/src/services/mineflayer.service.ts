import mineflayer from "mineflayer";
import { IService } from "./base.service.js";
import pathfinder from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { plugin as collectBlock } from "mineflayer-collectblock";
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

      // Load pathfinder plugin
      this.bot.loadPlugin(pathfinder.pathfinder);

      // Load collectblock plugin
      this.bot.loadPlugin(collectBlock);

      this.setupEventHandlers();
    } catch (error) {
      console.error("[Mineflayer] Failed to initialize bot:", error);
      throw error;
    }
  }

  private async harvestTree(_username: string, amount: number) {
    if (!this.bot) return;

    try {
      // Check inventory first for any type of logs
      const existingLogs = this.bot.inventory
        .items()
        .filter((item) => item.name.includes("_log"))
        .reduce((total, item) => total + item.count, 0);

      if (existingLogs >= amount) {
        this.bot.chat(`I already have ${existingLogs} logs, that's enough!`);
        return;
      }

      const neededLogs = amount - existingLogs;

      // Find and harvest logs
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

      if (!logBlock) {
        this.bot.chat("No trees found nearby!");
        return;
      }

      // Get all connected logs of the same type
      const treeBlocks = this.bot.findBlocks({
        matching: logBlock.type,
        maxDistance: 32,
        count: neededLogs,
        point: logBlock.position,
      });

      // Collect logs using collectBlock plugin
      let collectedLogs = 0;
      for (const pos of treeBlocks) {
        const block = this.bot.blockAt(pos);
        if (!block || block.type !== logBlock.type) continue;

        try {
          await this.bot.collectBlock.collect(block);
          collectedLogs++;
          console.log("[Mineflayer] Collected log", collectedLogs);

          // Stack logs after each collection
          const logs = this.bot.inventory
            .items()
            .filter((item) => item.name === logBlock.name);
          if (logs.length > 1) {
            // Find the stack with the most space
            const bestStack = logs.reduce((prev, current) =>
              64 - current.count > 64 - prev.count ? current : prev
            );

            // Stack other logs into this stack
            for (const log of logs) {
              if (log !== bestStack) {
                try {
                  await this.bot.moveSlotItem(log.slot, bestStack.slot);
                  await this.bot.waitForTicks(2);
                } catch (err) {
                  console.error("[Mineflayer] Failed to stack logs:", err);
                }
              }
            }
          }

          // Check if we have enough logs
          const totalLogs = logs.reduce((sum, item) => sum + item.count, 0);
          if (totalLogs >= amount) break;
        } catch (err) {
          console.error("[Mineflayer] Failed to collect log:", err);
          continue;
        }
      }

      const finalCount = this.bot.inventory
        .items()
        .filter((item) => item.name.includes("_log"))
        .reduce((total, item) => total + item.count, 0);

      this.bot.chat(`Harvesting complete! I now have ${finalCount} logs 🪓`);
    } catch (error) {
      console.error("[Mineflayer] Error in tree harvesting:", error);
      this.bot.chat("Failed to complete the harvesting task 😢");
    }
  }

  private async buildPlatform(username: string, size: number) {
    if (!this.bot || size < 1) return;

    try {
      // Get player position
      const player = this.bot.players[username];
      if (!player?.entity) {
        this.bot.chat("I can't see you!");
        return;
      }
      const playerPos = player.entity.position.clone();

      const requiredLogs = size * size;

      // Check inventory for logs
      const logs = this.bot.inventory
        .items()
        .filter((item) => item.name.includes("_log"));

      const totalLogs = logs.reduce((sum, item) => sum + item.count, 0);

      if (totalLogs < requiredLogs) {
        this.bot.chat(
          `Need ${requiredLogs} logs for ${size}x${size} platform, but only have ${totalLogs}!`
        );
        return;
      }

      // Find the stack with the most logs
      const bestLogStack = logs.reduce((prev, current) =>
        current.count > prev.count ? current : prev
      );

      // Equip the largest stack of logs
      await this.bot.equip(bestLogStack, "hand");

      // Move to starting position (3 blocks ahead)
      const buildPos = new Vec3(playerPos.x, playerPos.y, playerPos.z + 3);

      try {
        const goal = new goals.GoalNear(buildPos.x, buildPos.y, buildPos.z, 1);
        await this.bot.pathfinder.goto(goal);
      } catch (err) {
        console.error("[Mineflayer] Failed to move to building position:", err);
        this.bot.chat("Couldn't move to building position!");
        return;
      }

      // Calculate offsets for centered platform
      const offset = Math.floor(size / 2);

      // Build platform moving backwards
      for (let z = size - 1; z >= 0; z--) {
        for (let x = -offset; x < size - offset; x++) {
          // Check if we still have logs
          const currentLogs = this.bot.inventory
            .items()
            .find((item) => item.name.includes("_log"));
          if (!currentLogs) {
            this.bot.chat("Ran out of logs!");
            return;
          }

          // Re-equip if needed
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

            // Check if block position is at bot's feet
            const botPos = this.bot.entity.position;
            const isBotPosition =
              Math.floor(botPos.x) === Math.floor(blockPos.x) &&
              Math.floor(botPos.z) === Math.floor(blockPos.z) &&
              Math.floor(botPos.y) === Math.floor(blockPos.y + 1);

            if (isBotPosition) {
              // Jump and wait a tick before placing
              this.bot.setControlState("jump", true);
              await this.bot.waitForTicks(1);
              await this.bot.lookAt(blockPos, true);
              await this.bot.placeBlock(refBlock, new Vec3(0, -1, 0));
              this.bot.setControlState("jump", false);
            } else {
              await this.bot.lookAt(blockPos, true);
              await this.bot.placeBlock(refBlock, new Vec3(0, -1, 0));
            }
          } catch (err) {
            console.error(
              `[Mineflayer] Failed to place block at ${blockPos}:`,
              err
            );
            continue;
          }
        }

        // Move back one block after each row
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
          } catch (err) {
            console.error("[Mineflayer] Failed to move back:", err);
          }
        }
      }

      this.bot.chat(`${size}x${size} platform built! 🌳`);
    } catch (error) {
      console.error("[Mineflayer] Error in platform building:", error);
      this.bot.chat("Failed to build the platform 😢");
    }
  }

  private async moveToPlayer(position: Vec3) {
    if (!this.bot) return;
    const goal = new goals.GoalNear(position.x, position.y, position.z, 1);
    try {
      await this.bot.pathfinder.goto(goal);
      this.bot.chat("Here I am!");
    } catch (err) {
      this.bot.chat("I can't find a path to you!");
    }
    return;
  }

  private setupEventHandlers() {
    if (!this.bot) return;

    // Log bot position only when moving
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
          console.log("[Mineflayer] Bot position:", roundedPos);
          this.lastPosition = roundedPos;
        }
      }
    }, 1000);

    this.bot.once("spawn", () => {
      if (!this.bot) return;
      console.log("[Mineflayer] Bot spawned");
      this.bot.chat("GM, just spawned!");

      // Set up initial game rules
      this.bot.chat("/time set day");
      this.bot.chat("/gamerule doDaylightCycle false");
      this.bot.chat("/difficulty peaceful");

      const defaultMove = new Movements(this.bot);
      this.bot.pathfinder.setMovements(defaultMove);
    });

    this.bot.on("chat", async (username, message) => {
      if (!this.bot) return;
      if (username === this.bot.username) return;

      const harvestMatch = message.match(/^!harvest\s+(\d+)$/);
      const platformMatch = message.match(/^!platform\s+(\d+)$/);

      if (harvestMatch) {
        const amount = parseInt(harvestMatch[1]);
        if (amount > 0) {
          await this.harvestTree(username, amount);
        } else {
          this.bot.chat("Please specify a valid number of logs to harvest!");
        }
      } else if (platformMatch) {
        const size = parseInt(platformMatch[1]);
        if (size > 0) {
          await this.buildPlatform(username, size);
        } else {
          this.bot.chat("Please specify a valid platform size!");
        }
      } else if (message === "!come") {
        if (!this.bot) return;
        const player = this.bot.players[username];
        if (!player?.entity) {
          this.bot.chat("I can't see you!");
          return;
        }

        await this.moveToPlayer(player.entity.position);
      } else if (message === "!follow") {
        await this.startFollowing(username);
      } else if (message === "!stopfollow") {
        this.stopFollowing();
      }
    });

    this.bot.on("login", () => {
      console.log("[Mineflayer] Bot logged in successfully");
    });

    this.bot.on("end", (reason: string) => {
      console.log("[Mineflayer] Bot connection ended:", reason);
      this.bot = null;

      // Try to reconnect on unexpected disconnection
      if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
        console.log(
          `[Mineflayer] Connection ended, attempting to reconnect...`
        );
        this.reconnectAttempts++;
        setTimeout(() => this.init(), 5000);
      }
    });

    this.bot.on("error", (error) => {
      console.error("[Mineflayer] Bot error:", error);
      if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
        console.log(
          `[Mineflayer] Attempting to reconnect (${this.reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS})...`
        );
        this.reconnectAttempts++;
        setTimeout(() => this.init(), 5000);
      } else {
        console.error("[Mineflayer] Max reconnection attempts reached");
      }
    });

    this.bot.on("kicked", (reason: string) => {
      console.log("[Mineflayer] Bot was kicked:", reason);
      try {
        const reasonJson = JSON.parse(reason);
        console.log("[Mineflayer] Kick reason:", reasonJson);
      } catch (e) {
        console.log("[Mineflayer] Could not parse kick reason");
      }
    });

    // Add health monitoring
    this.bot.on("health", () => {
      console.log(
        `[Mineflayer] Bot health: ${this.bot?.health}, food: ${this.bot?.food}`
      );
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
