const admin = require("firebase-admin");
const firestore = require("firebase-admin/firestore");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = firestore.getFirestore();

module.exports = db;
