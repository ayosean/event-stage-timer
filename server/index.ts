import { createApp } from "./app.js";
const production = process.env.NODE_ENV === "production";
const password = process.env.ADMIN_PASSWORD;
const secret = process.env.SESSION_SECRET;
if (!password || password.length < 12 || !secret || secret.length < 32)
  throw new Error(
    "Set ADMIN_PASSWORD (12+ characters) and SESSION_SECRET (32+ characters).",
  );
if (
  production &&
  (!process.env.PUBLIC_URL?.startsWith("https://") ||
    !process.env.DATA_DIR?.startsWith("/"))
)
  throw new Error(
    "Production requires HTTPS PUBLIC_URL and absolute DATA_DIR on a persistent volume.",
  );
const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (
  production &&
  process.env.RAILWAY_PROJECT_ID &&
  (!mount ||
    !(
      process.env.DATA_DIR === mount ||
      process.env.DATA_DIR?.startsWith(mount + "/")
    ))
)
  throw new Error(
    "Attach a Railway persistent volume and set DATA_DIR to its mount path.",
  );
const publicUrl = process.env.PUBLIC_URL
  ? new URL(process.env.PUBLIC_URL).origin
  : undefined;
const service = createApp({
  password,
  secret,
  production,
  publicUrl,
  dbPath: `${process.env.DATA_DIR ?? "./data"}/stage-timer.sqlite`,
});
service.server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () =>
  console.log("Stage timer listening"),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    void service.close().then(() => process.exit(0));
  });
