const express = require("express");
const cors = require("cors");
const socketIO = require("socket.io");
const http = require("http");
const path = require("path");
const config = require("./config");
const firestore = require("./db");
const { FieldValue } = require("firebase-admin/firestore");

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
app.use(express.json({ extended: true }));

let clientsCount = 0;

io.on("connection", (socket) => {
  io.emit("peoples", {
    count: ++clientsCount,
  });

  socket.on("disconnect", () => {
    io.emit("peoples", {
      count: --clientsCount,
    });
  });

  socket.on("chatting", async (data) => {
    const { nickname, message, msgId, time, userId } = data;

    try {
      const querySnapshot = await firestore
        .collection("chat")
        .where("channelId", "==", "chat")
        .get();

      if (querySnapshot.empty) {
        console.error("Error: No documents found");
        return;
      }

      querySnapshot.forEach(async (doc) => {
        if (!doc.exists) {
          console.error("Error: Document not found");
          return;
        }

        const newMessage = {
          nickname,
          message,
          report: [],
          msgId,
          time,
          userId,
        };

        if (Array.isArray(doc.data().messages)) {
          await doc.ref.update({
            messages: FieldValue.arrayUnion(newMessage),
          });
        } else {
          await doc.ref.update({
            messages: [newMessage],
          });
        }
      });
    } catch (error) {
      console.error("Firebase error:", error);
    }

    io.emit("chatting", {
      nickname,
      message,
      time,
      report: [],
      msgId,
      userId,
    });
  });
});

app.get("/chatLogs", async (req, res) => {
  try {
    const snapshot = await firestore.collection("chat").get();
    let allMessages = [];
    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (Array.isArray(data.messages)) {
        allMessages = allMessages.concat(data.messages);
      }
    });
    res.status(200).json(allMessages);
  } catch (error) {
    res.status(500).send("Error getting chat logs: " + error.message);
  }
});

app.post("/message/report", async (req, res) => {
  try {
    const { msgId, userId, type } = req.body;

    const querySnapshot = await firestore
      .collection("chat")
      .where("channelId", "==", "chat")
      .get();
    querySnapshot.forEach(async (doc) => {
      const messages = doc.data().messages;

      const updatedMessages = messages.map((message) => {
        if (message.msgId === msgId) {
          message.report = message.report || [];
          message.report.push({
            userId: userId,
            reportType: type,
          });
        }
        return message;
      });

      await firestore
        .collection("chat")
        .doc(doc.id)
        .update({ messages: updatedMessages });
    });

    res.status(200);
  } catch (error) {
    res.status(500);
  }
});

server.listen(config.port, () => console.log(`Run on server ${config.port}`));

app.use(express.static(path.join(__dirname, "src")));
