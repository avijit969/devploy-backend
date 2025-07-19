import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { simpleGit } from "simple-git";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import mime from "mime-types";
import dotenv from "dotenv";

dotenv.config({
  path: "./.env",
  override: true,
});

const app = new Hono();
app.use("*", cors());

// Cloudflare R2 S3-compatible client
const s3 = new S3Client({
  region: "auto",
  forcePathStyle: true,
  endpoint: process.env.R2_ENDPOINT || "",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

// Deploy API
app.post("/api/deploy", async (c) => {
  const body = await c.req.json();
  const { repositoryUrl, applicationName } = body;
  console.log(
    process.env.R2_ENDPOINT,
    process.env.R2_ACCESS_KEY_ID,
    process.env.R2_SECRET_ACCESS_KEY,
    process.env.R2_BUCKET_NAME
  );
  const folder = `./tmp/${Date.now()}-${applicationName}`;
  const buildPath = `${folder}/dist`;

  try {
    await simpleGit().clone(repositoryUrl, folder);

    // Run install & build
    await execPromise(`cd ${folder} && npm install && npm run build`);

    // Upload build to R2
    await uploadDirToR2(buildPath, applicationName);

    // Clean up
    fs.rmSync(folder, { recursive: true, force: true });

    return c.json({
      success: true,
      message: "Deployment successful",
      url: `http://${applicationName}${process.env.BASE_URL}`,
    });
  } catch (err) {
    console.error("Deployment Error:", err);
    return c.json({ success: false, message: "Deployment failed" });
  }
});

// Promisify exec
function execPromise(cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      return resolve();
    });
  });
}

// Upload folder recursively to R2
async function uploadDirToR2(dirPath: string, subdomain: string) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const filePath = path.join(dirPath, entry.name);
    const key = `${subdomain}/${entry.name}`;

    if (entry.isDirectory()) {
      await uploadDirToR2(filePath, `${subdomain}/${entry.name}`);
    } else {
      const fileContent = fs.readFileSync(filePath);
      const contentType = mime.lookup(entry.name) || "application/octet-stream";

      const result = await s3.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
          Body: fileContent,
          ContentType: contentType,
        })
      );
    }
  }
}

// Serve deployed files by subdomain
app.get("*", async (c) => {
  const host = c.req.header("host") || "";
  const subdomain = host.split(".")[0];
  const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
  const key = `${subdomain}${reqPath}`;

  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
      })
    );

    return new Response(result.Body as ReadableStream, {
      headers: {
        "Content-Type": result.ContentType || "text/html",
      },
    });
  } catch (err) {
    return c.text("Not Found", 404);
  }
});

// Start server
serve(
  {
    fetch: app.fetch,
    port: 3001,
  },
  (info) => {
    console.log(`🚀 Server running at http://localhost:${info.port}`);
  }
);
