import express from "express";
import { createApp } from "./backend/dist/app.js";
import { config } from "./backend/dist/config.js";
import { createDatabase } from "./backend/dist/database/database.js";

const database = await createDatabase(config.DATABASE_PATH);
const app = createApp(database, config, express());

export default app;
