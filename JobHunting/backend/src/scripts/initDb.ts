import { ConfigError, loadConfig } from "../config/env.js";
import { connectDb, disconnectDb, syncIndexes } from "../db/connect.js";

try {
  const config = loadConfig();
  const conn = await connectDb(config.mongoUri);
  await syncIndexes();
  console.log(`Database "${conn.name}" ready: collections and indexes created.`);
  console.log("Collections:", (await conn.db!.listCollections().toArray()).map((c) => c.name).sort().join(", "));
  await disconnectDb();
} catch (e) {
  if (e instanceof ConfigError) console.error(e.message);
  else if ((e as Error)?.name === "MongooseServerSelectionError") {
    console.error("Could not reach MongoDB Atlas. In Atlas > Security > Network Access, add this machine's IP address (or your deployment's), then retry. Also check the user/password in MONGODB_URI.");
  } else console.error(`Failed: ${(e as Error)?.name ?? "unknown error"}`);
  process.exit(1);
}
