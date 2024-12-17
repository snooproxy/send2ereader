import { serve } from "https://deno.land/std@0.220.0/http/server.ts";
import { Router } from "https://deno.land/x/router@v2.0.1/mod.ts";

// Configuration
const expireDelay = 30; // 30 seconds
const maxExpireDuration = 1 * 60 * 60; // 1 hour
const maxFileSize = 1024 * 1024 * 800; // 800 MB

const TYPE_EPUB = 'application/epub+zip';
const TYPE_MOBI = 'application/x-mobipocket-ebook';

const allowedTypes = [TYPE_EPUB, TYPE_MOBI, 'application/pdf', 'application/vnd.comicbook+zip', 'application/vnd.comicbook-rar', 'text/html', 'text/plain', 'application/zip', 'application/x-rar-compressed'];
const allowedExtensions = ['epub', 'mobi', 'pdf', 'cbz', 'cbr', 'html', 'txt'];

const keyChars = "23456789ACDEFGHJKLMNPRSTUVWXYZ";
const keyLength = 4;

// In-memory storage
const keys = new Map();
const files = new Map();

// Utility functions
function randomKey(): string {
  const choices = Math.pow(keyChars.length, keyLength);
  const rnd = Math.floor(Math.random() * choices);
  return rnd.toString(keyChars.length)
    .padStart(keyLength, '0')
    .split('')
    .map((chr) => keyChars[parseInt(chr, keyChars.length)])
    .join('');
}

// Create router
const router = new Router();

// Routes
router.post("/api/generate", async (req) => {
  const agent = req.headers.get("user-agent") || "";

  let key = null;
  let attempts = 0;
  
  do {
    key = randomKey();
    if (attempts > keys.size) {
      return new Response("Can't generate more keys", { status: 503 });
    }
    attempts++;
  } while (keys.has(key));

  const info = {
    created: new Date(),
    agent: agent,
    fileId: null,
    urls: [],
  };
  
  keys.set(key, info);
  
  // Set expiration
  setTimeout(() => {
    if (keys.has(key)) {
      const info = keys.get(key);
      if (info.fileId && files.has(info.fileId)) {
        files.delete(info.fileId);
      }
      keys.delete(key);
    }
  }, maxExpireDuration * 1000);

  return new Response(key);
});

router.post("/api/upload", async (req) => {
  try {
    if (!req.body) {
      throw new Error("No body provided");
    }

    const formData = await req.formData();
    const key = formData.get("key")?.toString().toUpperCase();
    const file = formData.get("file");

    if (!key || !keys.has(key)) {
      throw new Error("Invalid key");
    }

    if (!file || !(file instanceof File)) {
      throw new Error("No file uploaded");
    }

    const fileExt = file.name.split('.').pop()?.toLowerCase();
    if (!fileExt || !allowedExtensions.includes(fileExt)) {
      throw new Error("Invalid file type");
    }

    const info = keys.get(key);
    const fileId = crypto.randomUUID();
    const fileData = await file.arrayBuffer();

    // Store file in memory
    files.set(fileId, {
      data: fileData,
      name: file.name,
      type: file.type,
    });

    // Update key info
    info.fileId = fileId;

    return new Response(JSON.stringify({
      success: true,
      message: "File uploaded successfully"
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({
      success: false,
      message: err.message
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
});

router.get("/api/download/:key", async (req) => {
  const { key } = req.params;
  
  if (!key || !keys.has(key)) {
    return new Response("File not found", { status: 404 });
  }

  const info = keys.get(key);
  if (!info.fileId || !files.has(info.fileId)) {
    return new Response("File not found", { status: 404 });
  }

  const file = files.get(info.fileId);
  
  return new Response(file.data, {
    headers: {
      "Content-Type": file.type,
      "Content-Disposition": `attachment; filename="${file.name}"`,
    },
  });
});

// Serve static files for the frontend
router.get("/", async () => {
  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Send to E-Reader</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
    <h1>Send to E-Reader</h1>
    <div id="upload-form">
        <button onclick="generateKey()">Generate Key</button>
        <div id="key-display"></div>
        <form id="file-form" style="display:none">
            <input type="file" name="file" accept=".epub,.mobi,.pdf,.cbz,.cbr,.html,.txt">
            <button type="submit">Upload</button>
        </form>
    </div>
    <script>
    let currentKey = '';
    
    async function generateKey() {
        const response = await fetch('/api/generate', { method: 'POST' });
        currentKey = await response.text();
        document.getElementById('key-display').textContent = 'Your key: ' + currentKey;
        document.getElementById('file-form').style.display = 'block';
    }

    document.getElementById('file-form').onsubmit = async (e) => {
        e.preventDefault();
        const formData = new FormData();
        formData.append('key', currentKey);
        formData.append('file', e.target.file.files[0]);
        
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        alert(result.message);
    };
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
});

// Start the server
serve((req) => {
  return router.handle(req);
});
