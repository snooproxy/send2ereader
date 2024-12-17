// Import Deno standard library modules
import { serve } from "https://deno.land/std/http/server.ts";
import { join, extname, basename, dirname } from "https://deno.land/std/path/mod.ts";
import { ensureDir } from "https://deno.land/std/fs/mod.ts";
import { copy } from "https://deno.land/std/streams/copy.ts";
import { contentType } from "https://deno.land/std/media_types/mod.ts";
import { Status } from "https://deno.land/std/http/http_status.ts";

// Import Oak framework (Koa-like framework for Deno)
import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { MultipartReader } from "https://deno.land/std/mime/mod.ts";

// Configuration
const port = 3001;
const expireDelay = 30; // 30 seconds
const maxExpireDuration = 1 * 60 * 60; // 1 hour
const maxFileSize = 1024 * 1024 * 800; // 800 MB

const TYPE_EPUB = 'application/epub+zip';
const TYPE_MOBI = 'application/x-mobipocket-ebook';

const allowedTypes = [TYPE_EPUB, TYPE_MOBI, 'application/pdf', 'application/vnd.comicbook+zip', 'application/vnd.comicbook-rar', 'text/html', 'text/plain', 'application/zip', 'application/x-rar-compressed'];
const allowedExtensions = ['epub', 'mobi', 'pdf', 'cbz', 'cbr', 'html', 'txt'];

const keyChars = "23456789ACDEFGHJKLMNPRSTUVWXYZ";
const keyLength = 4;

// Utility functions
function doTransliterate(filename: string): string {
  let name = filename.split(".");
  const ext = "." + name.splice(-1).join(".");
  name = name.join(".");
  
  // Note: Using a simple transliteration for demo - you may want to import a proper transliteration library
  return name.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "-") + ext;
}

function randomKey(): string {
  const choices = Math.pow(keyChars.length, keyLength);
  const rnd = Math.floor(Math.random() * choices);

  return rnd.toString(keyChars.length)
    .padStart(keyLength, '0')
    .split('')
    .map((chr) => keyChars[parseInt(chr, keyChars.length)])
    .join('');
}

// Application setup
const app = new Application();
const router = new Router();

// Store keys in memory
const keys = new Map();

// Middleware to handle file uploads
async function handleUpload(ctx: any) {
  const body = ctx.request.body();
  if (body.type !== "form-data") {
    ctx.throw(Status.BadRequest, "Expected multipart form data");
  }

  const reader = await body.value;
  const data = await reader.read();
  
  // Process file upload
  const file = data.files[0];
  if (!file) {
    ctx.throw(Status.BadRequest, "No file uploaded");
  }

  // Validate file type
  const fileExt = extname(file.filename).toLowerCase().slice(1);
  if (!allowedExtensions.includes(fileExt)) {
    ctx.throw(Status.BadRequest, "Invalid file type");
  }

  // Save file
  const uploadPath = join("uploads", `${crypto.randomUUID()}-${file.filename}`);
  await copy(file.content, await Deno.open(uploadPath, { write: true, create: true }));

  return {
    filename: file.filename,
    path: uploadPath,
    type: file.contentType,
  };
}

// Routes
router.post("/generate", async (ctx) => {
  const agent = ctx.request.headers.get("user-agent") || "";

  let key = null;
  let attempts = 0;
  
  do {
    key = randomKey();
    if (attempts > keys.size) {
      ctx.throw(Status.ServiceUnavailable, "Can't generate more keys");
    }
    attempts++;
  } while (keys.has(key));

  const info = {
    created: new Date(),
    agent: agent,
    file: null,
    urls: [],
    timer: null
  };
  
  keys.set(key, info);
  
  // Set expiration
  info.timer = setTimeout(() => {
    if (keys.get(key) === info) {
      keys.delete(key);
      // Clean up file if exists
      if (info.file?.path) {
        try {
          Deno.removeSync(info.file.path);
        } catch (err) {
          console.error("Error removing file:", err);
        }
      }
    }
  }, maxExpireDuration * 1000);

  ctx.response.body = key;
});

router.post("/upload", async (ctx) => {
  try {
    const file = await handleUpload(ctx);
    const key = ctx.request.headers.get("key")?.toUpperCase();
    
    if (!key || !keys.has(key)) {
      ctx.throw(Status.BadRequest, "Invalid key");
    }

    const info = keys.get(key);
    
    // Clean up previous file if exists
    if (info.file?.path) {
      try {
        await Deno.remove(info.file.path);
      } catch (err) {
        console.error("Error removing previous file:", err);
      }
    }

    info.file = file;
    ctx.response.body = { success: true, message: "File uploaded successfully" };
    
  } catch (err) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { success: false, message: err.message };
  }
});

// Static file serving
router.get("/:filename", async (ctx) => {
  const key = ctx.request.url.searchParams.get("key");
  if (!key || !keys.has(key)) {
    ctx.throw(Status.NotFound);
  }

  const info = keys.get(key);
  if (!info.file) {
    ctx.throw(Status.NotFound);
  }

  const filePath = info.file.path;
  const file = await Deno.open(filePath);
  
  ctx.response.headers.set("Content-Type", contentType(extname(filePath)));
  ctx.response.headers.set("Content-Disposition", `attachment; filename="${info.file.filename}"`);
  
  await copy(file, ctx.response.body);
  file.close();
});

// Initialize upload directory
await ensureDir("uploads");

// Start server
console.log(`Server running on http://localhost:${port}`);
await app.listen({ port });
