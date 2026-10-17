import { loadConfig, missingEnv } from "./config/env.js";
import { createApp } from "./app.js";
import { EmailJobService } from "./services/emailJobService.js";
import { createGmailMailer } from "./services/mailService.js";

const config = loadConfig();
const mailer = createGmailMailer(config);
const jobs = new EmailJobService({ mailer, getSender: () => config });
const app = createApp(config, jobs);

const missing = missingEnv(config);
if (missing.length) {
  console.warn(`Missing environment variables: ${missing.join(", ")}. Listing may fail and sending is disabled until they are set.`);
}

const server = app.listen(config.port, () => {
  console.log(`recruiter-outreach-api listening on http://localhost:${config.port}/api`);
});

const shutdown = () => {
  server.close(() => {
    mailer.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
