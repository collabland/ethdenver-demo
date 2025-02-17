import mineflayer from "mineflayer";
import { IService } from "./base.service.js";
import pathfinder from "mineflayer-pathfinder";
const { Movements, goals } = pathfinder;

export class MineflayerService implements IService {
  private static instance: MineflayerService;
  private bot: mineflayer.Bot | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  private lastPosition = { x: 0, y: 0, z: 0 };

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

      this.setupEventHandlers();
    } catch (error) {
      console.error("[Mineflayer] Failed to initialize bot:", error);
      throw error;
    }
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
      // Initialize movements
      if (this.bot) {
        const movements = new Movements(this.bot);
        this.bot.pathfinder.setMovements(movements);
      }
    });

    // Follow nearest player continuously
    setInterval(() => {
      if (!this.bot) return;

      const playerEntity = this.bot.nearestEntity(
        (entity) => entity.type === "player"
      );
      if (playerEntity) {
        const goal = new goals.GoalFollow(playerEntity, 2); // Follow at 2 blocks distance
        this.bot.pathfinder.setGoal(goal);
      }
    }, 1000);

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

    this.bot.on("error", (err) => {
      console.error("[Mineflayer] Bot error:", err);
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
