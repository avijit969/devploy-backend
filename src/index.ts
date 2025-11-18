import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { simpleGit } from "simple-git";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import mime from "mime-types";
import dotenv from "dotenv";

import { drizzle } from "drizzle-orm/neon-http";
import { builds, projects } from "./db/schema.js";
import { eq } from "drizzle-orm";

dotenv.config({
  path: "./.env",
  override: true,
});

const app = new Hono();
app.use("*", cors());

// Cloudflare R2 client
const s3 = new S3Client({
  region: "auto",
  forcePathStyle: true,
  endpoint: process.env.R2_ENDPOINT || "",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

/* -------------------------------------------------------
   DELETE OLD BUILD FOLDER FROM R2
------------------------------------------------------- */
async function deleteFolderFromR2(prefix: string) {
  const list = await s3.send(
    new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: prefix,
    })
  );

  if (!list.Contents || list.Contents.length === 0) {
    console.log(`ℹ️ No previous build to delete for: ${prefix}`);
    return;
  }

  console.log(`🗑️ Deleting old files in R2: ${prefix}`);

  for (const file of list.Contents) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: file.Key!,
      })
    );
    console.log(`❌ Deleted: ${file.Key}`);
  }
}

/* -------------------------------------------------------
   DETECT FRAMEWORK & BUILDPATH
------------------------------------------------------- */
function detectFramework(pkgJson: any, folder: string) {
  if (pkgJson.dependencies?.next || pkgJson.devDependencies?.next) {
    return { name: "Next.js", buildCommand: "npm run build", outDir: ".next" };
  }
  if (
    pkgJson.dependencies?.vite ||
    fs.existsSync(path.join(folder, "vite.config.js"))
  ) {
    return { name: "Vite", buildCommand: "npm run build", outDir: "dist" };
  }
  if (
    pkgJson.dependencies?.react &&
    fs.existsSync(path.join(folder, "public"))
  ) {
    return { name: "CRA", buildCommand: "npm run build", outDir: "dist" };
  }
  if (
    pkgJson.dependencies?.vue &&
    fs.existsSync(path.join(folder, "vue.config.js"))
  ) {
    return { name: "Vue", buildCommand: "npm run build", outDir: "dist" };
  }

  return { name: "Unknown", buildCommand: "npm run build", outDir: "dist" };
}

/* -------------------------------------------------------
   EXEC HELPER (PROMISE)
------------------------------------------------------- */
function execPromise(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      return resolve(stdout);
    });
  });
}

/* -------------------------------------------------------
   RECURSIVE UPLOAD TO R2
------------------------------------------------------- */
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

      await s3.send(
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

/* -------------------------------------------------------
   START BUILD (TRIGGERED BY WEBHOOK)
------------------------------------------------------- */
async function startBuild(
  projectId: number,
  projectName: string,
  repo_url: string
) {
  const db = drizzle(process.env.DATABASE_URL!);

  const inserted = await db
    .insert(builds)
    .values({
      projectId,
      build_status: "pending",
      build_number: 1,
      build_url: `https://${projectName}${process.env.BASE_URL}`,
      build_log: "",
    })
    .returning();

  console.log("🆕 Build record created:", inserted);

  const buildId = inserted[0].id;

  const tempFolder = `./tmp/${Date.now()}-${projectName}`;
  console.log(`📁 temp folder: ${tempFolder}`);

  try {
    console.log("⏳ Cloning...");
    await simpleGit().clone(repo_url, tempFolder);

    const pkgPath = path.join(tempFolder, "package.json");
    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const {
      name: framework,
      buildCommand,
      outDir,
    } = detectFramework(pkgJson, tempFolder);

    await execPromise(`cd ${tempFolder} && npm install`);
    await execPromise(`cd ${tempFolder} && ${buildCommand}`);

    // DELETE OLD DEPLOY
    await deleteFolderFromR2(`${projectName}/`);

    // UPLOAD NEW BUILD
    await uploadDirToR2(path.join(tempFolder, outDir), projectName);

    fs.rmSync(tempFolder, { recursive: true, force: true });

    await db
      .update(builds)
      .set({ build_status: "success" })
      .where(eq(builds.id, buildId));

    console.log("🎉 Build Successful!");
  } catch (err) {
    console.log("❌ Build Failed", err);

    await db
      .update(builds)
      .set({ build_status: "failed" })
      .where(eq(builds.id, buildId));
  }
}

app.get("/health", (c: Context) => {
  return c.json({ success: true });
});
app.get("/all", async (c: Context) => {
  const db = drizzle(process.env.DATABASE_URL!);
  const allProjects = await db.select().from(projects);
  return c.json({ success: true, projects: allProjects });
});
/* ----------------------
   GITHUB WEBHOOK
---------------------- */
app.post("/api/webhook", async (c: Context) => {
  const db = drizzle(process.env.DATABASE_URL!);
  console.log("📩 Webhook received");

  const body = await c.req.json();
  const repo_url = body.repository.clone_url;

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.repo_url, repo_url));

  if (project.length === 0) {
    return c.json({ success: false, message: "Project not registered" });
  }

  const p = project[0];

  console.log("🚀 Starting build for project:", p.name);

  startBuild(p.id, p.name, repo_url);

  return c.json({ success: true, message: "Build started" });
});

/* ----------------------
   MANUAL DEPLOY API
---------------------- */
app.post("/api/deploy", async (c: Context) => {
  const body = await c.req.json();
  const { repositoryUrl, applicationName } = body;

  const folder = `./tmp/${Date.now()}-${applicationName}`;
  const logs: string[] = [];

  try {
    await simpleGit().clone(repositoryUrl, folder);

    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(folder, "package.json"), "utf-8")
    );
    const { buildCommand, outDir } = detectFramework(pkgJson, folder);

    await execPromise(`cd ${folder} && npm install`);
    await execPromise(`cd ${folder} && ${buildCommand}`);

    // DELETE OLD
    await deleteFolderFromR2(`${applicationName}/`);

    // UPLOAD NEW
    await uploadDirToR2(path.join(folder, outDir), applicationName);

    fs.rmSync(folder, { recursive: true, force: true });

    return c.json({
      success: true,
      message: "Deployment successful",
      url: `https://${applicationName}${process.env.BASE_URL}`,
    });
  } catch (err: any) {
    return c.json({
      success: false,
      message: "Deployment failed",
      error: err.toString(),
    });
  }
});

/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */
serve(
  {
    fetch: app.fetch,
    port: 3001,
  },
  (info) => {
    console.log(`🚀 Server running at http://localhost:${info.port}`);
  }
);
