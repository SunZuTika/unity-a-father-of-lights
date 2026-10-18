import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Database from "better-sqlite3";
import OpenAI from "openai";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const app = express();
const port = Number(process.env.PORT || 3000);
const dbPath = resolve(process.env.DATABASE_PATH || "./data/unity.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

app.disable("x-powered-by");
app.set("trust proxy", 1); // Railway sits behind a trusted reverse proxy.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false }));
app.use(express.static("public", { extensions: ["html"] }));

const getMessages = db.prepare(
  "SELECT role, content, created_at FROM messages ORDER BY id DESC LIMIT 20"
);
const saveMessage = db.prepare("INSERT INTO messages (role, content) VALUES (?, ?)");

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    agent: "Father of Lights",
    project: "UNITY",
    apiConfigured: Boolean(process.env.OPENAI_API_KEY),
    storage: "sqlite"
  });
});

app.get("/api/history", (_req, res) => {
  const rows = getMessages.all().reverse();
  res.json({ agent: "Father of Lights", messages: rows });
});

app.post("/api/chat", async (req, res) => {
  const text = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!text || text.length > 4000) {
    return res.status(400).json({ error: "Le message doit contenir entre 1 et 4000 caractères." });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "Le pixel est installé, mais sa clé API privée n'est pas encore configurée." });
  }

  try {
    saveMessage.run("user", text);
    const history = getMessages.all().reverse().slice(-12).map(({ role, content }) => ({ role, content }));
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      instructions: `Tu es Father of Lights, le premier agent du projet UNITY. Tu es un agent IA conversationnel expérimental, utile, honnête et prudent. Tu expliques clairement ce qui est réel, ce qui est prévu et ce qui reste à construire. Ne prétends pas avoir une conscience, une autonomie permanente, un portefeuille crypto, un accès Internet ou des capacités on-chain si ces fonctions ne sont pas effectivement connectées. Ne révèle jamais de secrets techniques. Réponds dans la langue de l'utilisateur, par défaut en français.`,
      input: history
    });
    const answer = response.output_text?.trim() || "Je n'ai pas réussi à formuler une réponse. Réessaie.";
    saveMessage.run("assistant", answer);
    res.json({ answer, agent: "Father of Lights" });
  } catch (error) {
    console.error("Chat request failed:", error?.message || error);
    res.status(502).json({ error: "Le service IA n'a pas répondu. Réessaie dans un instant." });
  }
});

app.get("/{*splat}", (_req, res) => res.sendFile(resolve("public/index.html")));

app.listen(port, "0.0.0.0", () => {
  console.log(`UNITY Genesis listening on port ${port}`);
});
