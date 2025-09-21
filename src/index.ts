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

// Utility: detect framework and get build output directory
function detectFramework(
  pkgJson: any,
  folder: string
): {
  name: string;
  buildCommand: string;
  outDir: string;
} {
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
  if (
    pkgJson.dependencies?.astro &&
    fs.existsSync(path.join(folder, "astro.config.mjs"))
  ) {
    return { name: "Astro", buildCommand: "npm run build", outDir: "dist" };
  }
  if (
    pkgJson.dependencies?.svelte &&
    fs.existsSync(path.join(folder, "svelte.config.js"))
  ) {
    return { name: "Svelte", buildCommand: "npm run build", outDir: "dist" };
  }

  // fallback
  return { name: "Unknown", buildCommand: "npm run build", outDir: "dist" };
}

app.get("/health", (c: Context) => {
  return c.json({ success: true });
});
app.post("/api/deploy", async (c: Context) => {
  const body = await c.req.json();
  const { repositoryUrl, applicationName } = body;
  const folder = `./tmp/${Date.now()}-${applicationName}`;
  const logs: string[] = [];

  try {
    await simpleGit().clone(repositoryUrl, folder);
    console.log(`✅ Cloned repo: ${repositoryUrl}`);
    logs.push(`✅ Cloned repo: ${repositoryUrl}`);

    // Load and parse package.json
    const pkgPath = path.join(folder, "package.json");
    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

    // Detect framework
    const {
      name: framework,
      buildCommand,
      outDir,
    } = detectFramework(pkgJson, folder);
    console.log(`📦 Detected Framework: ${framework}`);
    console.log(`⚙️ Build Command: ${buildCommand}`);
    console.log(`⚙️ OutDir: ${outDir}`);
    logs.push(`📦 Detected Framework: ${framework}`);
    logs.push(`⚙️ Build Command: ${buildCommand}`);

    // Install dependencies
    const installResult = await execPromise(`cd ${folder} && npm install`);
    logs.push(`📥 npm install:\n${installResult}`);
    console.log(`📥 npm install:\n${installResult}`);

    // Run build
    const buildResult = await execPromise(`cd ${folder} && ${buildCommand}`);
    logs.push(`🔨 Build Output:\n${buildResult}`);
    console.log(`🔨 Build Output:\n${buildResult}`);

    // Upload to R2
    const buildOutputPath = path.join(folder, outDir);
    await uploadDirToR2(buildOutputPath, applicationName);
    logs.push(`🚀 Uploaded to R2 under: ${applicationName}/`);
    console.log(`🚀 Uploaded to R2 under: ${applicationName}/`);

    // Clean up
    fs.rmSync(folder, { recursive: true, force: true });
    console.log(`🗑️ Cleaned up: ${folder}`);

    return c.json({
      success: true,
      message: "Deployment successful",
      url: `http://${applicationName}${process.env.BASE_URL}`,
      logs: logs.join("\n\n"),
    });
  } catch (err: any) {
    console.error("Deployment Error:", err);
    if (err.stdout || err.stderr) {
      logs.push(`❌ Error:\n${err.stderr || err.error}`);
      logs.push(`🧾 Partial stdout:\n${err.stdout}`);
      console.log(`❌ Error:\n${err.stderr || err.error}`);
      console.log(`🧾 Partial stdout:\n${err.stdout}`);
    } else {
      logs.push(`❌ Unexpected Error:\n${err.toString()}`);
      console.log(`❌ Unexpected Error:\n${err.toString()}`);
    }

    return c.json({
      success: false,
      message: "Deployment failed",
      logs: logs.join("\n\n"),
    });
  }
});

// Promisify exec
function execPromise(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      return resolve(stdout);
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
  const host = c.req.header("Host") || "";
  // "https://avijit.devploy-backend.avijit.site/"
  const domainRoot = "devploy-backend.avijit.site"; // your apex domain
  const subdomain = host.replace(`.${domainRoot}`, "");

  const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
  const key = `${subdomain}${reqPath}`;

  console.log(`Serving ${key}\nsubdomain: ${subdomain}\nreqPath: ${reqPath}`);

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
