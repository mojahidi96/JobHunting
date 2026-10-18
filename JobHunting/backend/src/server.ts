import mongoose from "mongoose";
import { ConfigError, loadConfig } from "./config/env.js";
import { connectDb, syncIndexes } from "./db/connect.js";
import { createApp } from "./app.js";
import { JobRunner, recoverInterruptedJobs } from "./services/jobRunner.js";
import { createMailerFactory } from "./services/mailService.js";
import { createAuthMailer } from "./services/authMailer.js";
import { createGoogleClient } from "./services/googleService.js";

async function main() {
  const config = loadConfig();
  await connectDb(config.mongoUri);
  if (config.env !== "production") await syncIndexes();
  const recovered = await recoverInterruptedJobs();
  if (recovered) console.warn(`Closed ${recovered} job(s) interrupted by a previous shutdown.`);

  const googleClient = config.google ? createGoogleClient(config.google) : null;
  const mailerFactory = createMailerFactory({ googleClient });
  const runner = new JobRunner({ config, mailerFactory });
  const authMailer = config.authSmtp ? createAuthMailer(config.authSmtp) : null;
  if (!googleClient) console.warn("Google sign-in disabled: set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI.");
  if (!authMailer) console.warn("Email OTP sign-in disabled: set AUTH_SMTP_HOST / AUTH_SMTP_USER / AUTH_SMTP_PASS / AUTH_SMTP_FROM.");
  const app = createApp({ config, mailerFactory, runner, googleClient, authMailer });
  const server = app.listen(config.port, () => {
    console.log(`jobhunting-api listening on http://localhost:${config.port}/api (${config.env})`);
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.exit(1), 30_000).unref();
    server.close();
    await runner.stop();
    await recoverInterruptedJobs();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : `Startup failed: ${e instanceof Error ? e.name : "unknown"}`);
  process.exit(1);
});
