const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ====== ROOM STATE (conteo) ======
const rooms = new Map(); // room -> { hostId: string|null, listeners: Set<string> }

function getRoomState(room) {
  if (!rooms.has(room)) rooms.set(room, { hostId: null, listeners: new Set() });
  return rooms.get(room);
}

function emitRoomStats(room) {
  const st = rooms.get(room);
  if (!st) return;
  io.to(room).emit("room-stats", {
    room,
    hostConnected: !!st.hostId,
    listeners: st.listeners.size,
    total: (st.hostId ? 1 : 0) + st.listeners.size,
  });
}
// 
// ====== MUSIC DIR ======
const MUSIC_DIR = path.join(__dirname, "music");
if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });

// ====== STATIC ======
app.use(express.static(path.join(__dirname, "public")));
app.use("/music", express.static(MUSIC_DIR)); // 👈 sirve los mp3 subidos

// ====== UPLOAD MP3 API ======
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MUSIC_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const isMp3 =
      file.mimetype === "audio/mpeg" ||
      file.mimetype === "audio/mp3" ||
      file.originalname.toLowerCase().endsWith(".mp3");
    if (!isMp3) return cb(new Error("Solo MP3 permitido"), false);
    cb(null, true);
  },
});

// Subir mp3 (form-data: key="file")
app.post("/api/upload-mp3", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const url = `/music/${req.file.filename}`;
  res.json({ url, filename: req.file.filename });
});

// (Opcional) Manejo básico de errores de multer
app.use((err, req, res, next) => {
  if (err && err.message) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

// ====== SOCKET.IO SIGNALING ======
io.on("connection", (socket) => {
  socket.on("join", ({ room, role }) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.role = role;

    // ====== actualizar estado sala ======
    const st = getRoomState(room);

    if (role === "host") {
      st.hostId = socket.id;
    } else if (role === "listener") {
      st.listeners.add(socket.id);
    }

    // avisar a otros (tu lógica existente)
    socket.to(room).emit("peer-joined", { id: socket.id, role });

    // emitir stats a TODOS en el room
    emitRoomStats(room);
  });

  socket.on("webrtc-offer", ({ to, sdp, room }) => {
    io.to(to).emit("webrtc-offer", { from: socket.id, sdp, room });
  });

  socket.on("webrtc-answer", ({ to, sdp, room }) => {
    io.to(to).emit("webrtc-answer", { from: socket.id, sdp, room });
  });

  socket.on("webrtc-ice", ({ to, candidate, room }) => {
    io.to(to).emit("webrtc-ice", { from: socket.id, candidate, room });
  });

  socket.on("disconnect", () => {
    const room = socket.data.room;
    const role = socket.data.role;

    if (room) {
      // ====== limpiar estado sala ======
      const st = rooms.get(room);
      if (st) {
        if (role === "host" && st.hostId === socket.id) st.hostId = null;
        if (role === "listener") st.listeners.delete(socket.id);

        // si sala quedó vacía, bórrala
        if (!st.hostId && st.listeners.size === 0) rooms.delete(room);
      }

      socket.to(room).emit("peer-left", { id: socket.id });

      // emitir stats actualizados
      emitRoomStats(room);
    }
  });

  socket.on("chat-message", ({ room, text }) => {
    if (!room) return;
    const clean = String(text || "").trim().slice(0, 300);
    if (!clean) return;

    // nombre fijo "Usuario" como pediste
    io.to(room).emit("chat-message", {
      user: "Usuario",
      text: clean,
    });
  });
});


// ====== START ======
const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ WebRTC Radio en http://0.0.0.0:${PORT}`);
});