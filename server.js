const express = require("express");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());

const BACKEND_TOKEN = process.env.BACKEND_TOKEN || "";
const SESSION_DIR = process.env.SESSION_DIR || "/app/auth_sessions";

// Middleware de autenticação
function authMiddleware(req, res, next) {
  if (!BACKEND_TOKEN) return next(); // sem token configurado, aceita tudo
  const token = req.headers["x-backend-token"];
  if (token !== BACKEND_TOKEN) {
    return res.status(401).json({ error: "Token inválido" });
  }
  next();
}

app.use(authMiddleware);

const sessions = {};

async function startSession(sessionId) {
  // Se já existe sessão ativa, retorna
  if (sessions[sessionId] && sessions[sessionId].status === "connecting") {
    return;
  }

  const sessionPath = path.join(SESSION_DIR, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  
  const sock = makeWASocket({ 
    auth: state, 
    printQRInTerminal: false,
    browser: ["IntegraZap", "Chrome", "1.0.0"]
  });

  sessions[sessionId] = { sock, qr: null, status: "connecting", lastError: null };

  sock.ev.on("creds.update", saveCreds);
  
  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;
    
    console.log(`[${sessionId}] connection.update:`, JSON.stringify({ connection, hasQR: !!qr }));
    
    if (qr) {
      try {
        sessions[sessionId].qr = await QRCode.toDataURL(qr);
        sessions[sessionId].status = "qr";
        console.log(`[${sessionId}] QR Code gerado com sucesso`);
      } catch (err) {
        console.error(`[${sessionId}] Erro ao gerar QR:`, err.message);
        sessions[sessionId].lastError = err.message;
      }
    }
    
    if (connection === "open") {
      sessions[sessionId].status = "connected";
      sessions[sessionId].qr = null;
      sessions[sessionId].lastError = null;
      console.log(`[${sessionId}] Conectado!`);
    }
    
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason;
      sessions[sessionId].status = "disconnected";
      sessions[sessionId].lastError = `Desconectado (código: ${statusCode})`;
      console.log(`[${sessionId}] Desconectado, código: ${statusCode}`);
      
      // Reconectar automaticamente se não foi logout manual
      if (statusCode !== reason.loggedOut) {
        console.log(`[${sessionId}] Tentando reconectar...`);
        setTimeout(() => startSession(sessionId), 3000);
      }
    }
  });
}

app.post("/session/start", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId obrigatório" });
  
  try {
    await startSession(sessionId);
    res.json({ status: "iniciando" });
  } catch (err) {
    console.error(`Erro ao iniciar sessão ${sessionId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/session/qr/:id", (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.json({ status: "not_found", qr: null });
  if (s.status === "connected") return res.json({ connected: true, status: "connected", qr: null });
  res.json({ status: s.status, qr: s.qr, lastError: s.lastError });
});

app.get("/session/status/:id", (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.json({ status: "not_found", connected: false });
  res.json({ 
    status: s.status, 
    connected: s.status === "connected",
    lastError: s.lastError 
  });
});

app.post("/send", async (req, res) => {
  const { sessionId, numero, mensagem } = req.body;
  const s = sessions[sessionId];
  if (!s || s.status !== "connected") {
    return res.status(400).json({ error: "Sessão não conectada" });
  }
  try {
    const jid = numero.includes("@") ? numero : `${numero}@s.whatsapp.net`;
    await s.sock.sendMessage(jid, { text: mensagem });
    res.json({ success: true });
  } catch (err) {
    console.error(`Erro ao enviar para ${numero}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/session/stop", (req, res) => {
  const { sessionId } = req.body;
  const s = sessions[sessionId];
  if (s?.sock) {
    s.sock.end();
    delete sessions[sessionId];
  }
  res.json({ success: true });
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", sessions: Object.keys(sessions).length });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`WhatsApp Backend rodando na porta ${PORT}`));
