// Basic Express server for testing deployment
import express from "express";
const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("✅ Hello from Hangman Server!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
