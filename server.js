const express = require("express");
const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const sessions = {};

async function startSession(sessionId) {
  const { state, saveCreds } = await useMultiFileAuthState(`sessions/${sessionId}`);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sessions[sessionId] = { sock, qr: null, status: "connecting" };

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async ({ connection, qr }) => {
    if (qr) {
      sessions[sessionId].qr = await QRCode.toDataURL(qr);
    }
    if (connection === "open") {
      sessions[sessionId].status = "connected";
      sessions[sessionId].qr = null;
    }
    if (connection === "close") {
      sessions[sessionId].status = "disconnected";
    }
  });
}

app.post("/session/start", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId obrigatorio" });
  await startSession(sessionId);
  res.json({ status: "iniciando" });
});

app.get("/session/qr/:id", (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.json({ status: "not_found" });
  if (s.status === "connected") return res.json({ conectado: true });
  res.json({ status: "qr", qr: s.qr });
});

app.get("/session/status/:id", (req, res) => {
  const s = sessions[req.params.id];
  res.json({ status: s?.status === "connected" ? "CONNECTED" : s?.status || "not_found" });
});

app.post("/send", async (req, res) => {
  const { sessionId, numero, mensagem } = req.body;
  const s = sessions[sessionId];
  if (!s?.sock || s.status !== "connected") return res.status(400).json({ error: "Nao conectado" });
  try {
    await s.sock.sendMessage(`${numero}@s.whatsapp.net`, { text: mensagem });
    res.json({ status: "enviado" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/session/stop", async (req, res) => {
  const { sessionId } = req.body;
  if (sessions[sessionId]) {
    await sessions[sessionId].sock?.end();
    delete sessions[sessionId];
  }
  res.json({ status: "encerrado" });
});

app.listen(process.env.PORT || 3000, () => console.log("WhatsApp backend rodando na porta " + (process.env.PORT || 3000)));
