import mineflayer from "mineflayer";
import { IService } from "./base.service.js";

export class MineflayerService implements IService {
  private static instance: MineflayerService;
  private bot: mineflayer.Bot | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 3;

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
        username: process.env.MINECRAFT_USERNAME || "MineflyBot",
        version: process.env.MINECRAFT_VERSION || "1.21.4",
        auth: "offline" as const,
        skipValidation: true,
        checkTimeoutInterval: 60000, // Keep connection alive
        closeTimeout: 240000, // Wait longer before closing connection
        keepAlive: true, // Enable keep-alive packets
      };

      console.log("[Mineflayer] Connecting with config:", config);
      this.bot = mineflayer.createBot(config);

      this.setupEventHandlers();
    } catch (error) {
      console.error("[Mineflayer] Failed to initialize bot:", error);
      throw error;
    }
  }

  private setupEventHandlers() {
    if (!this.bot) return;

    this.bot.on("spawn", () => {
      console.log("[Mineflayer] Bot spawned in game");
      this.reconnectAttempts = 0;

      // Send a message when joining
      this.bot?.chat("Hello! Bot connected successfully.");
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
