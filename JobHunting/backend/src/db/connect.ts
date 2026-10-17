import mongoose from "mongoose";
import { allModels } from "../models/index.js";

export async function connectDb(uri: string) {
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  return mongoose.connection;
}

/** Creates collections and indexes (idempotent). */
export async function syncIndexes() {
  for (const m of allModels) {
    await m.createCollection().catch(() => undefined);
    await m.syncIndexes();
  }
}

export const disconnectDb = () => mongoose.disconnect();
