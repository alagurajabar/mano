import { config } from "./config.js";
import { createDatabase } from "./database/database.js";
import { createApp } from "./app.js";

const database = await createDatabase(config.DATABASE_PATH);
const app = createApp(database, config);

const server = app.listen(config.PORT, () => {
  console.info(`DriveVault API listening on port ${config.PORT}`);
});

function shutdown(): void {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
