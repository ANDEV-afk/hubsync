import express from "express";
import cors from "cors";
import hubspotRoutes from "./routes/hubspot.js";
import contactRoutes from "./routes/contacts.js";
import noteRoutes from "./routes/notes.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();

const frontendOrigin = process.env.FRONTEND_URL?.trim();
app.use(cors(frontendOrigin ? { origin: frontendOrigin } : { origin: false }));
app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "HubSync API is running",
  });
});

app.use("/auth", hubspotRoutes);
app.use("/api", hubspotRoutes);
app.use("/api", contactRoutes);
app.use("/api", noteRoutes);

app.use((_request, response) => {
  response.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
    },
  });
});

app.use(errorHandler);

export default app;
