import "dotenv/config";
import { createServer } from "node:http";
import express from "express";
import cookieParser from "cookie-parser";
import { toNodeHandler } from "better-auth/node";
import { auth } from "@repo/auth";
import cors from "cors";
import { projectRouter } from "./modules/projects/project.routes";
import { aiRouter } from "./modules/ai/ai.routes";
import { githubRouter } from "./modules/github/github.routes";
import { errorHandler } from "./middleware/error.middleware";
import { attachCollabServer } from "./modules/collab/collab.server";
const app = express();
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      process.env.CLIENT_URL!,
    ],
    credentials: true,
  }),
);

//better auth first
app.all("/api/auth/*any", toNodeHandler(auth));

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.use("/api/projects", projectRouter);
app.use("/api/ai", aiRouter);
app.use("/api/github", githubRouter);

app.use(errorHandler);

const server = createServer(app);

// Realtime collaboration (Phase 1: rooms + presence) on /ws/collab.
// REST and Better Auth routes above are untouched.
attachCollabServer(server);

server.listen(process.env.PORT || 5000, () => {
  console.log(`Server is running on port ${process.env.PORT || 5000}`);
  console.log(
    `AI provider: ${process.env["AI_PROVIDER"] ?? "ollama (default)"} / model: ${process.env["AI_DEFAULT_MODEL"] || process.env["OLLAMA_MODEL"] || "provider default"}`,
  );
});
