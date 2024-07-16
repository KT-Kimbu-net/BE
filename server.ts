const express = require("express");
const cors = require("cors");
const moment = require("moment");
const socketIO = require("socket.io");
const http = require("http");
const path = require("path");
const config = require("./config");
const firestore = require("./db");

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
  },
  pingInterval: 25 * 1000,
  pingTimeout: 60 * 1000,
});

app.use(cors());

io.on("connection", (socket) => {
  const srvSockets = io.sockets.sockets;
  socket.emit("clientsCount", {
    count: Object.keys(srvSockets).length,
  });

  console.log(Object.keys(srvSockets).length);
  io.emit("clientsCount", {
    count: Object.keys(srvSockets).length,
  });

  socket.on("disconnect", () => {
    io.emit("clientsCount", {
      count: Object.keys(srvSockets).length,
    });
  });

  socket.on("chatting", async (data) => {
    const { nickname, message, msgId } = data;
    const timestamp = moment(new Date()).format("h:ss A");
    try {
      await firestore.collection("chat").add({
        nickname,
        message,
        report: [],
        msgId,
        timestamp,
      });
    } catch (error) {
      console.error(error);
    }
    io.emit("chatting", {
      nickname,
      message,
      time: timestamp,
      report: [],
      msgId,
    });
  });
});

app.get("/chatLogs", async (req, res) => {
  try {
    const snapshot = await firestore.collection("chat").get();
    const chatLogs = snapshot.docs.map((doc) => doc.data());
    res.status(200).send(chatLogs);
  } catch (error) {
    res.status(500).send("Error getting chat logs: " + error.message);
  }
});

server.listen(config.port, () => console.log(`Run on server ${config.port}`));

app.use(express.static(path.join(__dirname, "src")));
