const express = require("express");
const cors = require("cors");
const socketIO = require("socket.io");
const http = require("http");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");
const firestore = require("./db");
const { FieldValue } = require("firebase-admin/firestore");
const path = require("path");

const app = express();
app.use(cors());

const server = http.createServer(app);

const REDIS_URL = process.env.REDIS_URL;

const redisClient = new Redis(REDIS_URL, {
  retryStrategy: (times: any) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redisClient.on("error", (err: any) => {
  console.error("Redis Client Error", err);
});

async function initializeUserCount() {
  await redisClient.set("userCount", 0, "NX");
}

initializeUserCount();

const pubClient = createClient({ url: REDIS_URL });
const subClient = pubClient.duplicate();

(async () => {
  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    const io = socketIO(server, {
      cors: {
        origin: "*",
      },
    });

    io.adapter(createAdapter(pubClient, subClient));

    app.options("*", cors());
    app.use(express.json({ extended: true }));

    const gameNamespace = io.of("/game");
    gameNamespace.on("connection", (socket: any) => {
      socket.on("changeScore", async (data: any) => {
        try {
          const today = new Date();
          const year = today.getFullYear();
          const month = String(today.getMonth() + 1).padStart(2, "0");
          const day = String(today.getDate()).padStart(2, "0");
          const currentDate = `${year}${month}${day}`;
          const liveScoreRef = firestore.collection("liveScore");
          const snapshot = await liveScoreRef
            .where("gameId", "==", currentDate)
            .get();

          let docRef;

          if (snapshot.empty) {
            docRef = await liveScoreRef.add({
              gameId: currentDate,
              liveData: {
                kt: { pitcher: "쿠에바스", score: [] },
                opponent: { pitcher: "이재학", score: [] },
              },
            });
          } else {
            console.log("Document found for current date.");
            docRef = snapshot.docs[0].ref;
          }

          const fieldToUpdate = data.isKtwiz ? "kt.score" : "opponent.score";
          const docSnapshot = await docRef.get();
          const currentScores =
            docSnapshot.get(`liveData.${fieldToUpdate}`) || [];

          currentScores.push(data.score);

          await docRef.update({
            [`liveData.${fieldToUpdate}`]: currentScores,
          });
          console.log("Firestore updated successfully.");

          gameNamespace.emit("changeScore", data);
        } catch (error: any) {
          console.error("Error updating Firestore: ", error);
        }
      });

      socket.on("changePitcher", (data: any) => {
        gameNamespace.emit("changePitcher", data);
      });
    });

    const chatNamespace = io.of("/chat");

    chatNamespace.on("connection", async (socket: any) => {
      await redisClient.incr("userCount");
      const userCount = await redisClient.get("userCount");
      chatNamespace.emit("peoples", {
        count: parseInt(userCount),
      });

      socket.on("disconnect", async () => {
        await redisClient.decr("userCount");
        const userCount = await redisClient.get("userCount");
        chatNamespace.emit("peoples", {
          count: parseInt(userCount),
        });
      });
      socket.on("chatting", async (data: any) => {
        const { nickname, message, msgId, time, userId, type } = data;
        chatNamespace.emit("chatting", {
          nickname,
          message,
          time,
          report: [],
          msgId,
          userId,
          type,
        });
        try {
          const querySnapshot = await firestore
            .collection("chat")
            .where("channelId", "==", "chat")
            .get();

          if (querySnapshot.empty) {
            console.error("Error: No documents found");
            return;
          }

          querySnapshot.forEach(async (doc: any) => {
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
              type,
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
        } catch (error: any) {
          console.error("Firebase error:", error);
        }
      });
    });

    app.get("/liveinfo", async (req: any, res: any) => {
      try {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, "0");
        const day = String(today.getDate()).padStart(2, "0");
        const currentDate = `${year}${month}${day}`;

        const liveScoreRef = firestore.collection("liveScore");
        const snapshot = await liveScoreRef
          .where("gameId", "==", currentDate)
          .get();

        if (snapshot.empty) {
          const newDocRef = await liveScoreRef.add({
            gameId: currentDate,
            liveData: {
              kt: { pitcher: "쿠에바스", score: [] },
              opponent: { pitcher: "이재학", score: [] },
            },
          });

          const newDoc = await newDocRef.get();
          const liveData = newDoc.data().liveData;
          return res.status(200).json(liveData);
        }

        const liveData = snapshot.docs[0].data().liveData;
        res.status(200).json(liveData);
      } catch (error: any) {
        console.error("Error getting game data:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    app.get("/chatLogs", async (req: any, res: any) => {
      try {
        const snapshot = await firestore.collection("chat").get();
        if (snapshot.empty) {
          return res.status(404).json({ message: "No chat logs found" });
        }

        const allMessagesPromises = snapshot.docs.map(async (doc: any) => {
          const data = doc.data();
          if (Array.isArray(data.messages)) {
            return data.messages;
          }
          return [];
        });

        const allMessagesArrays = await Promise.all(allMessagesPromises);
        const allMessages = allMessagesArrays.flat();

        res.status(200).json(allMessages);
      } catch (error: any) {
        console.error("Error getting chat logs:", error);
        res.status(500).send("Error getting chat logs: " + error.message);
      }
    });

    app.post("/message/report", async (req: any, res: any) => {
      try {
        const { msgId, userId, type } = req.body;
        if (!msgId || !userId || !type) {
          return res.status(400).json({ error: "Missing required fields" });
        }

        const querySnapshot = await firestore
          .collection("chat")
          .where("channelId", "==", "chat")
          .get();

        if (querySnapshot.empty) {
          return res.status(404).json({ error: "No chat documents found" });
        }

        const batch = firestore.batch();

        querySnapshot.docs.forEach((doc: any) => {
          const messages = doc.data().messages;
          const updatedMessages = messages.map((message: any) => {
            if (message.msgId === msgId) {
              message.report = message.report || [];
              message.report.push({
                userId: userId,
                reportType: type,
              });
            }
            return message;
          });

          batch.update(doc.ref, { messages: updatedMessages });
        });

        await batch.commit();

        res.status(200).json({ success: true });
      } catch (error: any) {
        console.error("Error updating messages:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    app.delete("/deleteLiveInfo", async (req: any, res: any) => {
      try {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, "0");
        const day = String(today.getDate()).padStart(2, "0");
        const currentDate = `${year}${month}${day}`;

        const liveScoreRef = firestore.collection("liveScore");
        const snapshot = await liveScoreRef
          .where("gameId", "==", currentDate)
          .get();

        if (snapshot.empty) {
          return res
            .status(404)
            .json({ message: "No game data found for today" });
        }

        const deletePromises = snapshot.docs.map((doc: any) =>
          doc.ref.delete()
        );
        await Promise.all(deletePromises);

        res
          .status(200)
          .json({ message: "Today's game data deleted successfully" });
      } catch (error: any) {
        console.error("Error deleting game data:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    server.listen(5000, () => console.log(`Run on server 5000`));

    app.use(express.static(path.join(__dirname, "src")));
  } catch (error) {
    console.error("Error connecting to Redis:", error);
  }
})();
