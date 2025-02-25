import {
  Payments,
  EnvironmentName,
  FIRST_STEP_NAME,
  AgentExecutionStatus,
  Step,
  generateStepId,
  Task,
  CreateTaskResultDto,
} from "@nevermined-io/payments";
import { BaseService } from "./base.service.js";
// import { TelegramService } from "./telegram.service.js";
import { parseUnits } from "ethers";
import * as path from "path";
import * as fs from "fs/promises";
import { AnyType } from "src/utils.js";
import { MineflayerService } from "./mineflayer.service.js";

//FIXME: Remove once Nevermined SDK is updated
interface NeverminedStep extends Step {
  did: string;
}
interface NeverminedTask extends Omit<Task, "steps" | "name"> {
  did: string;
}

export class NeverminedService extends BaseService {
  private client: Payments | null = null;
  private paymentPlanDID: string | null = null;
  private agentDID: string | null = null;
  private static instance: NeverminedService;
  private mineflayerService: MineflayerService | null = null;
  constructor() {
    super();
  }

  async start(): Promise<void> {
    if (!process.env.NEVERMINED_API_KEY) {
      throw new Error("NEVERMINED_API_KEY must be defined");
    }

    this.client = Payments.getInstance({
      environment:
        (process.env.NEVERMINED_ENVIRONMENT as EnvironmentName) ?? "testing",
      nvmApiKey: process.env.NEVERMINED_API_KEY!,
    });

    this.mineflayerService = MineflayerService.getInstance();

    if (!this.client.isLoggedIn) {
      throw new Error("Nevermined client not logged in");
    }

    console.log(
      "[NeverminedService] Nevermined service started on network:",
      this.client.environment
    );

    // Try to load DIDs from file first
    const loadedDIDs = await this.loadDIDsFromFile();

    if (loadedDIDs) {
      console.log("[NeverminedService] Loaded DIDs from file");
      this.paymentPlanDID = loadedDIDs.paymentPlanDID;
      this.agentDID = loadedDIDs.agentDID;
    } else {
      console.log("[NeverminedService] No saved DIDs found, creating new ones");
      this.paymentPlanDID = await this.getPaymentPlanDID();
      this.agentDID = await this.getAgentDID();

      // Save DIDs to file for persistence
      await this.saveDIDsToFile();
    }

    console.log("[NeverminedService] Payment plan DID: ", this.paymentPlanDID);
    console.log("[NeverminedService] Agent DID: ", this.agentDID);

    await this.client.query.subscribe(this.processQuery(this.client), {
      getPendingEventsOnSubscribe: false,
      joinAccountRoom: false,
      joinAgentRooms: [this.agentDID!],
      subscribeEventTypes: ["step-updated"],
    });
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client = null;
    }
  }

  public static getInstance() {
    if (!NeverminedService.instance) {
      NeverminedService.instance = new NeverminedService();
    }
    return NeverminedService.instance;
  }

  public getClient(): Payments {
    if (!this.client) {
      throw new Error("NeverminedService not started");
    }
    return this.client;
  }

  public async getPaymentPlanDID(): Promise<string> {
    if (!this.client) {
      throw new Error("NeverminedService not started");
    }

    // Check if we have a DID in the data directory for this bot
    const loadedDIDs = await this.loadDIDsFromFile();
    if (loadedDIDs && loadedDIDs.paymentPlanDID) {
      this.paymentPlanDID = loadedDIDs.paymentPlanDID;
      console.log(
        "[NeverminedService] Using payment plan DID from data file:",
        this.paymentPlanDID
      );
      return this.paymentPlanDID;
    }

    // Create a new payment plan with a unique name based on bot username and timestamp
    try {
      console.log("[NeverminedService] Creating new payment plan...");
      const botInfo = await this.mineflayerService?.getBotInfo();
      const uniqueId = `${botInfo?.username ?? "unknown"}-${Date.now()}`;
      console.log("[NeverminedService] Bot info:", botInfo);

      const paymentPlan = await this.client.createCreditsPlan({
        name: `PaymentPlan:::${uniqueId}`,
        description: `Payment plan to access the agent ${botInfo?.username ?? "<unknown>"}`,
        price: parseUnits("1", 6), //1 USDC per plan
        tokenAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", //USDC on Arbitrum Sepolia
        amountOfCredits: 100,
      });

      console.log("[NeverminedService] Payment plan created:", paymentPlan);
      this.paymentPlanDID = paymentPlan.did;

      // Save to data file
      await this.saveDIDsToFile();

      return this.paymentPlanDID!;
    } catch (e) {
      console.error("[NeverminedService] Error creating payment plan:", e);
      throw e;
    }
  }

  public async getAgentDID(): Promise<string> {
    if (!this.client) {
      throw new Error("NeverminedService not started");
    }

    // Check if we have a DID in the data directory for this bot
    const loadedDIDs = await this.loadDIDsFromFile();
    if (loadedDIDs && loadedDIDs.agentDID) {
      this.agentDID = loadedDIDs.agentDID;
      console.log(
        "[NeverminedService] Using agent DID from data file:",
        this.agentDID
      );
      return this.agentDID;
    }

    // Create a new agent with a unique name
    try {
      console.log("[NeverminedService] Creating new agent...");
      const botInfo = await this.mineflayerService?.getBotInfo();
      const uniqueId = `${botInfo?.username ?? "unknown"}-${Date.now()}`;

      const agent = await this.client.createAgent({
        name: `Agent:::${uniqueId}`,
        description: `Agent ${botInfo?.username ?? "<unknown>"}`,
        planDID: await this.getPaymentPlanDID(),
        serviceChargeType: "dynamic",
        usesAIHub: true,
      });

      console.log("[NeverminedService] Agent created:", agent);
      this.agentDID = agent.did;

      // Save to data file
      await this.saveDIDsToFile();

      return this.agentDID!;
    } catch (e) {
      console.error("[NeverminedService] Error creating agent:", e);
      throw e;
    }
  }

  private processQuery(payments: Payments) {
    return async (data: AnyType) => {
      const eventData = JSON.parse(data);
      console.log("[NeverminedService] Event data: ", eventData);
      const step = (await payments.query.getStep(
        eventData.step_id
      )) as NeverminedStep;
      console.log("[NeverminedService] Step: ", step);
      await payments.query.logTask({
        level: "info",
        task_id: step.task_id,
        message: `Processing step ${step.name}...`,
      });
      switch (step.name) {
        case FIRST_STEP_NAME: {
          await payments.query.logTask({
            level: "info",
            task_id: step.task_id,
            message: `Step received ${step.name}, creating the additional steps...`,
          });
          console.log("[NeverminedService] Step received ", step);
          const fetchDataStepId = generateStepId();
          const encryptDataStepId = generateStepId();

          const steps = [
            {
              step_id: fetchDataStepId,
              task_id: step.task_id,
              predecessor: step.step_id, // "fetchData" follows "init"
              name: "fetchData",
              is_last: false,
            },
            {
              step_id: encryptDataStepId,
              task_id: step.task_id,
              predecessor: fetchDataStepId, // "encryptData" follows "fetchData"
              name: "encryptData",
              is_last: true,
            },
          ];
          console.log("[NeverminedService] Steps to be created: ", steps);
          const createResult = await payments.query.createSteps(
            step.did,
            step.task_id,
            { steps }
          );

          await payments.query.logTask({
            task_id: step.task_id,
            level: createResult.success === true ? "info" : "error",
            message:
              createResult.success === true
                ? "Steps created successfully."
                : `Error creating steps: ${JSON.stringify(createResult.data)}`,
          });

          await payments.query.updateStep(step.did, {
            ...step,
            step_status: AgentExecutionStatus.Completed,
            output: step.input_query,
          });
          return;
        }
        case "fetchData": {
          await payments.query.logTask({
            level: "info",
            task_id: step.task_id,
            step_id: step.step_id,
            task_status: AgentExecutionStatus.In_Progress,
            message: `Step received ${step.name}, fetching data...`,
          });
          const mockData = step.input_query ?? `step-1-mock-data-${Date.now()}`;
          await payments.query.logTask({
            level: "info",
            task_id: step.task_id,
            step_id: step.step_id,
            task_status: AgentExecutionStatus.In_Progress,
            message: `Data fetched: ${mockData}`,
          });
          console.log(
            "[NeverminedService] Data fetched: ",
            mockData,
            step.task_id,
            step.step_id
          );
          await payments.query.updateStep(step.did, {
            ...step,
            step_status: AgentExecutionStatus.Completed,
            output: mockData,
            cost: 3,
          });
          await payments.query.logTask({
            level: "info",
            task_id: step.task_id,
            task_status: AgentExecutionStatus.In_Progress,
            message: `Step 1 completed, data fetched`,
          });
          return;
        }
        case "encryptData": {
          await payments.query.logTask({
            level: "info",
            task_id: step.task_id,
            step_id: step.step_id,
            task_status: AgentExecutionStatus.In_Progress,
            message: `Step received ${step.name}, encrypting data...`,
          });
          console.log(
            "[NeverminedService] Step received encrypting data...",
            step.task_id,
            step.step_id
          );
          const data = Buffer.from(step.input_query, "utf-8").toString("hex");
          await payments.query.logTask({
            level: "info",
            task_id: step.task_id,
            step_id: step.step_id,
            task_status: AgentExecutionStatus.In_Progress,
            message: `Data encrypted: ${data}`,
          });
          console.log(
            "[NeverminedService] Data encrypted: ",
            data,
            step.task_id,
            step.step_id
          );
          await payments.query.updateStep(step.did, {
            ...step,
            step_status: AgentExecutionStatus.Completed,
            output: data,
            cost: 2,
            is_last: true,
          });
          await payments.query.logTask({
            level: "info",
            task_id: step.task_id,
            task_status: AgentExecutionStatus.Completed,
            message: `Step 2, data fetched and encrypted`,
          });
          return;
        }
        default: {
          await payments.query.logTask({
            level: "info",
            task_id: step.task_id,
            message: `Unknown step ${step.name}, Skipping...`,
          });
          return;
        }
      }
    };
  }
  public async getPlanCreditBalance(
    //FIXME: Remove after demo, should be dynamic
    planDID = "did:nv:95933c24a7f3c181b62b2ee91d7b7e6ec0fce5430a0fd19f4cf5c4dc864efb6d"
  ): Promise<bigint> {
    if (!this.client) {
      throw new Error("NeverminedService not started");
    }
    const balance = await this.client.getPlanBalance(planDID);
    console.log(`Plan: ${planDID}\nBalance: ${JSON.stringify(balance)}`);
    if (!balance.isSubscriptor || balance.balance === BigInt(0)) {
      console.log("Not subscribed to plan, or plan exhausted: ", planDID);
      console.log("Subscribing...");
      const agreement = await this.client.orderPlan(planDID);
      console.log("Subscribed, Agreement: ", agreement);
      const balance = await this.client.getPlanBalance(planDID);
      console.log(`Plan: ${planDID}\nBalance:, ${JSON.stringify(balance)}`);
      return balance.balance;
    }
    return balance.balance;
  }

  public async submitTask(
    //FIXME: Remove after demo, should be dynamic
    agentDID = "did:nv:ed26319e8551d5578b09563c3261df7cd4e3b1f4130434d04478a036c29e4403",
    planDID = "did:nv:95933c24a7f3c181b62b2ee91d7b7e6ec0fce5430a0fd19f4cf5c4dc864efb6d",
    query = `hello-demo-agent-${Date.now()}`,
    callback?: (data: string) => Promise<void>
  ): Promise<CreateTaskResultDto | undefined> {
    if (!this.client) {
      throw new Error("NeverminedService not started");
    }
    console.log(
      `[NeverminedService] Submitting task: agentDID: ${agentDID}, planDID: ${planDID}, query: ${query}`
    );
    const balance = await this.getPlanCreditBalance(planDID);
    console.log(`Plan: ${planDID}\nBalance: ${JSON.stringify(balance)}`);
    if (balance <= BigInt(0)) {
      throw new Error("Insufficient balance");
    }
    const accessConfig =
      await this.client.query.getServiceAccessConfig(agentDID);
    console.log(
      `[NeverminedService] Access config: ${JSON.stringify(accessConfig)}`
    );
    const taskCallback =
      callback ??
      (async (data: string) => {
        console.log(`Received data:`);
        const parsedData = JSON.parse(data) as NeverminedTask;
        console.dir(parsedData, { depth: null });
      });
    const { data } = await this.client.query.createTask(
      agentDID,
      {
        input_query: query,
      },
      accessConfig,
      taskCallback
    );
    console.log(`Task sent to agent: ${JSON.stringify(data)}`);
    return data;
  }

  private async saveDIDsToFile(): Promise<void> {
    try {
      const dataDir = path.resolve(process.cwd(), "data");
      await fs.mkdir(dataDir, { recursive: true });
      const filePath = path.join(dataDir, "nevermined-credentials.json");

      // Get bot username to use as key
      const botInfo = await this.mineflayerService?.getBotInfo();
      const botUsername = botInfo?.username ?? "unknown";

      // Try to read existing file first
      let existingData: Record<
        string,
        { agentDID: string; paymentPlanDID: string; role: string }
      > = {};
      try {
        const existingContent = await fs.readFile(filePath, "utf8");
        existingData = JSON.parse(existingContent);
      } catch (error) {
        // File doesn't exist or is invalid, start with empty object
      }

      // Update with this bot's DIDs
      existingData[botUsername] = {
        agentDID: this.agentDID!,
        paymentPlanDID: this.paymentPlanDID!,
        role: botInfo?.role ?? "merchant",
      };

      // Write back to file
      await fs.writeFile(
        filePath,
        JSON.stringify(existingData, null, 2),
        "utf8"
      );
      console.log(
        `[NeverminedService] Saved DIDs for ${botUsername} to ${filePath}`
      );
    } catch (error) {
      console.error("[NeverminedService] Error saving DIDs to file:", error);
    }
  }

  private async loadDIDsFromFile(): Promise<{
    agentDID: string;
    paymentPlanDID: string;
  } | null> {
    try {
      const dataDir = path.resolve(process.cwd(), "data");
      console.log("[NeverminedService] Data directory:", dataDir);
      const filePath = path.join(dataDir, "nevermined-credentials.json");

      // Get bot username to use as key
      const botInfo = await this.mineflayerService?.getBotInfo();
      const botUsername = botInfo?.username ?? "unknown";
      console.log(
        `[NeverminedService] Looking for DIDs for bot: ${botUsername}`
      );

      // Check if file exists
      try {
        await fs.access(filePath);
      } catch (error) {
        console.log("[NeverminedService] No DIDs file found");
        return null;
      }

      // Read and parse file
      const fileContent = await fs.readFile(filePath, "utf8");
      const allData = JSON.parse(fileContent);

      // Get this bot's DIDs
      const botData = allData[botUsername];
      if (!botData || !botData.agentDID || !botData.paymentPlanDID) {
        console.log(`[NeverminedService] No DIDs found for bot ${botUsername}`);
        return null;
      }

      console.log(`[NeverminedService] Found DIDs for bot ${botUsername}`);
      return {
        agentDID: botData.agentDID,
        paymentPlanDID: botData.paymentPlanDID,
      };
    } catch (error) {
      console.error("[NeverminedService] Error loading DIDs from file:", error);
      return null;
    }
  }
}
