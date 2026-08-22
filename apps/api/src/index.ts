import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { toNodeHandler } from "better-auth/node";
import { auth } from "@repo/auth";
import cors from "cors";
import { projectRouter } from "./modules/projects/project.routes";
import { errorHandler } from "./middleware/error.middleware";
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

app.use(errorHandler);

app.listen(process.env.PORT || 5000, () => {
  console.log(`Server is running on port ${process.env.PORT || 5000}`);
});
