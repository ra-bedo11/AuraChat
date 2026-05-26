import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";

dotenv.config();

const argv = process.argv;
const isProd = process.env.NODE_ENV === "production" || argv.includes("--prod");

// Initialize Gemini Client
let ai: GoogleGenAI | null = null;
if (process.env.GEMINI_API_KEY) {
  try {
    ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build"
        }
      }
    });
    console.log("Gemini API Client successfully initialized.");
  } catch (err) {
    console.error("Failed to initialize Gemini Client:", err);
  }
} else {
  console.warn("GEMINI_API_KEY is not set. Instant support bot fallback mode will be active.");
}

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Server-side state in-memory (No persistent Database, as requested)
interface UserState {
  id: string;
  name: string;
  avatarColor: string;
  avatarEmoji: string;
  customStatus?: string;
  ws?: WebSocket;
}

interface RoomState {
  id: string;
  name: string;
  description: string;
  isPrivate: boolean;
  createdBy: string;
}

interface MemoryMessage {
  id: string;
  roomId?: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  senderColor: string;
  text: string;
  iv?: string;
  encryptedFile?: {
    name: string;
    type: string;
    size: number;
    cipherData: string;
    iv: string;
  };
  timestamp: string;
  isPrivate: boolean;
  recipientId?: string;
  isSystem?: boolean;
  isSupport?: boolean;
  isEncrypted: boolean;
}

const activeUsers = new Map<string, UserState>();
const activeRooms: RoomState[] = [
  { id: "lobby", name: "الغرفة العامة / Public Lobby", description: "المكان العام للترحيب والمناقشات / Public lounge for everyone", isPrivate: false, createdBy: "system" }
];

// Short scrollback memory buffer (e.g., last 50 group messages) to simulate real-time sync when a client joins/reloads
const chatHistoryMemory: MemoryMessage[] = [];
const startTime = Date.now();

// Utility helper to broadcast to everyone
function broadcastRaw(payload: any) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// REST API Endpoints

// 1. Live Server Telemetry (Flex API)
app.get("/api/status", (req, res) => {
  res.json({
    onlineUsersCount: activeUsers.size,
    roomsCount: activeRooms.length,
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    databaseFreeGuarantee: true,
    encryptionE2EE: "Active (AES-256-GCM / PBKDF2)",
    aiSupportStatus: ai ? "Enabled" : "Simulation Fallback"
  });
});

// 1.5 Check username availability
app.post("/api/check-username", (req, res) => {
  const { username } = req.body;
  console.log(`[HTTP API] Username availability check requested for: "${username}"`);
  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }
  const cleanName = username.trim().toLowerCase();
  const isTaken = Array.from(activeUsers.values()).some(
    (u) => u.name.trim().toLowerCase() === cleanName
  );
  const available = !isTaken;
  console.log(`[HTTP API] Username check outcome: "${username}" of status availability is: ${available}`);
  res.json({ available });
});

// 2. Integration Webhook - Allows external services to post updates into rooms (System messages)
app.post("/api/webhook", (req, res) => {
  const { roomId, message, senderName } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: "Message parameter is mandatory" });
  }

  const targetRoom = activeRooms.find(r => r.id === (roomId || "lobby"));
  const cleanRoomId = targetRoom ? targetRoom.id : "lobby";

  const webhookMessage: MemoryMessage = {
    id: `web-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    roomId: cleanRoomId,
    senderId: "webhook-service",
    senderName: senderName || "Webhook service",
    senderAvatar: "🤖",
    senderColor: "from-blue-600 to-indigo-600",
    text: message,
    timestamp: new Date().toISOString(),
    isPrivate: false,
    isSystem: true,
    isEncrypted: false
  };

  // Push to history
  chatHistoryMemory.push(webhookMessage);
  if (chatHistoryMemory.length > 200) chatHistoryMemory.shift();

  // Send to all WS connections
  broadcastRaw({
    type: "message",
    message: webhookMessage
  });

  res.json({ success: true, description: "Delivered to channel " + cleanRoomId, message: webhookMessage });
});

// 3. Gemini Direct Support AI Assistant (Live Direct chat assistant inside the UI)
app.post("/api/support", async (req, res) => {
  const { message, history, language } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: "Query message is required" });
  }

  const isAr = language === "ar" || /[\u0600-\u06FF]/.test(message);

  const systemInstruction = `You are "الفني الفوري" - the highly skilled Artificial Intelligence technical support specialist for AuraChat (أورا شات).
AuraChat is a lightweight, ultra-secure full-stack instant chat platform.
Key AuraChat characteristics you should describe to users if they ask:
- No Database: Zero permanent databases exist ("لا توجد قاعدة بيانات"). Relay occurs entirely in cloud RAM memory for total volatility.
- End-to-End Encryption (E2EE): Uses Web Crypto API (AES-GCM 256 generated via browser PBKDF2). Messages and files are encrypted and decrypted in the browser. The server only sees base64 encrypted ciphertexts. Passphrases are strictly local.
- Real-time: Synchronized instantly over premium WebSockets.
- File Sharing: Full Support for encrypting local file binaries on client side before dispatch.
- Dark Theme: Auto-dark mode based on device preference, plus customized gorgeous skins (Neon Purple, Mint Green, Cyberpunk, Amber Gold).
- Webhook Support: External apps can broadcast notifications into paths using POST on '/api/webhook' triggering raw JSON formats.
- Mobile Ready: Premium flexible responsive layouts that adapt beautifully to Android and iOS WebViews.

Respond in ${isAr ? "Arabic (العربية)" : "English"}. Let your tone be highly supportive, friendly, simple, logical, and technically precise. Keep responses incredibly concise (maximum 120 words) to fit directly in the chatbot bubble interface. Provide actual tips on how E2EE holds secure.`;

  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: message,
        config: {
          systemInstruction,
          temperature: 0.7
        }
      });
      return res.json({ response: response.text });
    } catch (err) {
      console.error("Gemini invocation failed:", err);
    }
  }

  // Backup fallback responses if Gemini client is unavailable
  const arFallback = "مرحباً! أنا الدعم الفني لأورا شات. لضمان أمن اتصالك، نقوم بتشفير الرسائل تماًماماً في المتصفح باستخدام AES-256-GCM. لا يتم حفظ كلمات المرور أو الملفات في خوادمنا لضمان السرية المطلقة حيث لا يوجد قاعدة بيانات!";
  const enFallback = "Hello! I am AuraChat Support. To keep your discussions totally private, we use local AES-256-GCM encryption inside your browser. No passphrases or unencrypted logs are stored on our servers, ensuring pure volatility!";
  res.json({ response: isAr ? arFallback : enFallback });
});

// Configure upgrade flow for WS
server.on("upgrade", (request, socket, head) => {
  const reqUrl = request.url || "";
  if (reqUrl.startsWith("/ws")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  }
});

// WebSocket Event Processing
wss.on("connection", (ws: WebSocket) => {
  let clientId: string | null = null;

  ws.on("message", (rawMessage) => {
    try {
      const payload = JSON.parse(rawMessage.toString());
      
      switch (payload.type) {
        case "join": {
          const { id, name, avatarColor, avatarEmoji, customStatus } = payload.user;
          
          const cleanName = name.trim().toLowerCase();
          const nameTaken = Array.from(activeUsers.values()).some(
            (u) => u.id !== id && u.name.trim().toLowerCase() === cleanName
          );

          if (nameTaken) {
            ws.send(JSON.stringify({
              type: "error",
              error: "username_taken",
              message: "This username is already taken by another active user. Please choose another one."
            }));
            return;
          }

          clientId = id;
          
          activeUsers.set(id, {
            id,
            name,
            avatarColor,
            avatarEmoji,
            customStatus,
            ws
          });

          // Compose general lists
          const listOnline = Array.from(activeUsers.values()).map(u => ({
            id: u.id,
            name: u.name,
            avatarColor: u.avatarColor,
            avatarEmoji: u.avatarEmoji,
            customStatus: u.customStatus
          }));

          // Send immediate state to joining client
          ws.send(JSON.stringify({
            type: "init-state",
            onlineUsers: listOnline,
            rooms: activeRooms,
            recentMessages: chatHistoryMemory
          }));

          // Broadcast user arrival
          broadcastRaw({
            type: "user-joined",
            user: { id, name, avatarColor, avatarEmoji, customStatus },
            onlineUsers: listOnline
          });
          break;
        }

        case "update-profile": {
          if (!clientId) return;
          const { name, avatarColor, avatarEmoji, customStatus } = payload.user;
          const user = activeUsers.get(clientId);
          if (user) {
            user.name = name;
            user.avatarColor = avatarColor;
            user.avatarEmoji = avatarEmoji;
            user.customStatus = customStatus;

            const listOnline = Array.from(activeUsers.values()).map(u => ({
              id: u.id,
              name: u.name,
              avatarColor: u.avatarColor,
              avatarEmoji: u.avatarEmoji,
              customStatus: u.customStatus
            }));

            broadcastRaw({
              type: "user-updated",
              user: { id: clientId, name, avatarColor, avatarEmoji, customStatus },
              onlineUsers: listOnline
            });
          }
          break;
        }

        case "create-room": {
          const { id, name, description, isPrivate, createdBy } = payload.room;
          const newRoom: RoomState = { id, name, description, isPrivate, createdBy };
          activeRooms.push(newRoom);
          
          broadcastRaw({
            type: "room-created",
            room: newRoom
          });
          break;
        }

        case "message": {
          const message: MemoryMessage = payload.message;
          
          // Save in memory for group message history (if not private direct)
          if (!message.isPrivate) {
            chatHistoryMemory.push(message);
            // Limit memory array to protect memory consumption
            if (chatHistoryMemory.length > 200) {
              chatHistoryMemory.shift();
            }
          }

          // If private, only send specifically to target client or sender
          if (message.isPrivate && message.recipientId) {
            const recipient = activeUsers.get(message.recipientId);
            const sender = activeUsers.get(message.senderId);
            
            const rawMsgStr = JSON.stringify({ type: "message", message });
            if (recipient && recipient.ws && recipient.ws.readyState === WebSocket.OPEN) {
              recipient.ws.send(rawMsgStr);
            }
            if (sender && sender.ws && sender.ws.readyState === WebSocket.OPEN) {
              sender.ws.send(rawMsgStr);
            }
          } else {
            // Group chat: Broadcast to all connected clients
            broadcastRaw({
              type: "message",
              message
            });
          }
          break;
        }

        case "typing": {
          // Relays typing info to group or private recipient
          if (payload.isPrivate && payload.recipientId) {
            const target = activeUsers.get(payload.recipientId);
            if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
              target.ws.send(JSON.stringify(payload));
            }
          } else {
            // Group typing: Relay to everyone except typing user
            wss.clients.forEach((client) => {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(payload));
              }
            });
          }
          break;
        }
      }
    } catch (err) {
      console.error("Failed to parse socket payload:", err);
    }
  });

  ws.on("close", () => {
    if (clientId) {
      activeUsers.delete(clientId);
      const listOnline = Array.from(activeUsers.values()).map(u => ({
        id: u.id,
        name: u.name,
        avatarColor: u.avatarColor,
        avatarEmoji: u.avatarEmoji,
        customStatus: u.customStatus
      }));

      // Broadcast disconnection
      broadcastRaw({
        type: "user-left",
        userId: clientId,
        onlineUsers: listOnline
      });
    }
  });
});

// Mount Vite Dev Server Middleware or Static Distribution
async function startServer() {
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    // Use Vite middleware to process static files & hot assets in dev mode
    app.use(vite.middlewares);
    console.log("Vite middleware configured in development mode.");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    console.log("Static file server running pointing to:", distPath);
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`AuraChat listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
