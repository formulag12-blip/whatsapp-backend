const express = require("express");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BACKEND_TOKEN = process.env.BACKEND_TOKEN || "";
const SESSION_DIR = process.env.SESSION_DIR || "/app/auth_sessions";

// Garantir que o diretório de sessões existe
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Middleware de autenticação
function authMiddleware(req, res, next) {
  if (!BACKEND_TOKEN) return next();
  const token = req.headers["x-backend-token"];
  if (token !== BACKEND_TOKEN) {
    return res.status(401).json({ error: "Token inválido" });
  }
  next();
}

app.use(authMiddleware);

// Estado das sessões em memória
const sessions = {};

function getSessionPath(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(SESSION_DIR, safe);
}

async function createSession(sessionId) {
  const sessionPath = getSessionPath(sessionId);

  if (sessions[sessionId]?.socket) {
    try { sessions[sessionId].socket.end(); } catch {}
  }

  sessions[sessionId] = {
    socket: null,
    qr: null,
    status: "connecting",
    connected: false,
    lastError: null,
  };

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: ["IntegraZap", "Chrome", "1.0.0"],
    });

    sessions[sessionId].socket = socket;

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          sessions[sessionId].qr = qrDataUrl;
          sessions[sessionId].status = "qr";
          sessions[sessionId].connected = false;
          console.log(`[${sessionId}] QR Code gerado`);
        } catch (err) {
          console.error(`[${sessionId}] Erro ao gerar QR:`, err.message);
        }
      }

      if (connection === "open") {
        sessions[sessionId].qr = null;
        sessions[sessionId].status = "connected";
        sessions[sessionId].connected = true;
        sessions[sessionId].lastError = null;
        console.log(`[${sessionId}] Conectado!`);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || `Código: ${statusCode}`;
        console.log(`[${sessionId}] Desconectado: ${reason}`);

        sessions[sessionId].connected = false;
        sessions[sessionId].qr = null;

        if (statusCode === DisconnectReason.loggedOut) {
          sessions[sessionId].status = "disconnected";
          sessions[sessionId].lastError = "Deslogado do WhatsApp";
          // Limpar sessão salva
          try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch {}
        } else if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
          sessions[sessionId].status = "reconnecting";
          sessions[sessionId].lastError = `Reconectando... (${reason})`;
          setTimeout(() => createSession(sessionId), 3000);
        } else {
          sessions[sessionId].status = "disconnected";
          sessions[sessionId].lastError = `Desconectado (código: ${statusCode})`;
        }
      }
    });
  } catch (err) {
    console.error(`[${sessionId}] Erro ao criar sessão:`, err.message);
    sessions[sessionId].status = "error";
    sessions[sessionId].lastError = err.message;
  }
}

// ===== ROTAS =====

// Health check
app.get("/", (req, res) => {
  res.json({ status: "online", timestamp: new Date().toISOString() });
});

// Iniciar sessão
app.post("/session/start", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId obrigatório" });

  console.log(`[session/start] sessionId=${sessionId}`);
  await createSession(sessionId);
  res.json({ status: "iniciando" });
});

// Buscar QR Code
app.get("/session/qr/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];

  if (!session) {
    return res.json({ status: "not_found", qr: null, connected: false, lastError: null });
  }

  res.json({
    status: session.status,
    qr: session.qr,
    connected: session.connected,
    lastError: session.lastError,
  });
});

// Verificar status
app.get("/session/status/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];

  if (!session) {
    return res.json({ status: "disconnected", connected: false, lastError: null });
  }

  res.json({
    status: session.status,
    connected: session.connected,
    lastError: session.lastError,
  });
});

// Enviar mensagem
app.post("/send", async (req, res) => {
  const { sessionId, numero, mensagem } = req.body;
  if (!sessionId || !numero || !mensagem) {
    return res.status(400).json({ error: "sessionId, numero e mensagem obrigatórios" });
  }

  const session = sessions[sessionId];
  if (!session?.connected || !session.socket) {
    return res.status(400).json({ error: "Sessão não conectada" });
  }

  try {
    const jid = numero.includes("@s.whatsapp.net") ? numero : `${numero}@s.whatsapp.net`;
    await session.socket.sendMessage(jid, { text: mensagem });
    res.json({ success: true, message: "Mensagem enviada" });
  } catch (err) {
    console.error(`[send] Erro:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Encerrar sessão
app.post("/session/stop", (req, res) => {
  const { sessionId } = req.body;
  const session = sessions[sessionId];

  if (session?.socket) {
    try { session.socket.end(); } catch {}
  }

  if (session) {
    session.status = "disconnected";
    session.connected = false;
    session.qr = null;
  }

  delete sessions[sessionId];
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`WhatsApp Backend rodando na porta ${PORT}`);
  console.log(`Token de autenticação: ${BACKEND_TOKEN ? "CONFIGURADO" : "NÃO CONFIGURADO (público)"}`);
  console.log(`Diretório de sessões: ${SESSION_DIR}`);
});
