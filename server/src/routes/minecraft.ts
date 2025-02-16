import { Router, Request, Response, NextFunction } from "express";
import { MineflayerService } from "../services/mineflayer.service.js";

const router = Router();

//middleware to validate minecraft bot connection
const checkBotConnection = (
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  console.log("[Minecraft] Checking bot connection...");
  const bot = MineflayerService.getInstance().getBot();

  if (!bot) {
    console.error("[Minecraft] Bot not connected");
    res.status(503).json({ error: "Minecraft bot not connected" });
    return;
  }

  console.log("[Minecraft] Bot connection verified");
  next();
};

//handles minecraft bot chat messages
const handleChat = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { message } = req.body;
    console.log("[Minecraft] Received chat message:", message);

    if (!message) {
      console.error("[Minecraft] No message provided");
      res.status(400).json({ error: "Message is required" });
      return;
    }

    const bot = MineflayerService.getInstance().getBot();
    if (!bot) {
      console.error("[Minecraft] Bot not connected during chat");
      res.status(503).json({ error: "Bot disconnected" });
      return;
    }

    bot.chat(message);
    console.log("[Minecraft] Message sent successfully:", message);
    res.status(200).json({ success: true, message: "Message sent" });
  } catch (error) {
    console.error("[Minecraft Chat] Error:", error);
    next(error);
  }
};

// Apply middleware and route handler
router.post("/chat", [checkBotConnection, handleChat]);

export default router;
