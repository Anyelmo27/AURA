// pc_bridge.js - Puente PC <-> NEXO
// Servidor HTTP ligero (sin dependencias) para listar/descargar/subir archivos y carpetas, y controlar el volumen.
// Uso: node pc_bridge.js
// Endpoints:
//   GET  /health
//   GET  /listar?carpeta=...&token=...
//   GET  /archivo?ruta=...&token=...                 (descarga archivo)
//   GET  /descargar-carpeta?carpeta=...&token=...    (descarga carpeta como .zip)
//   POST /subir?carpeta=...&ruta=rel/path/file.bin&token=...   (sube archivo, body binario)
//   GET  /volumen?nivel=15&token=...  (0-100 | accion=subir/bajar/mute | sin params = consulta)
//
// Seguridad: token + whitelist de carpetas base.

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const os = require("os");
const { spawn, exec } = require("child_process");

// ============ CONFIGURACION ============
const PORT = 8766;
const TOKEN = "nexo-pc-2026";
const SCRIPTS = __dirname;
const BASES = {
  descargas: "C:\\Users\\ANM\\Downloads",
  documentos: "C:\\Users\\ANM\\Documents",
  escritorio: "C:\\Users\\ANM\\Desktop",
  imagenes: "C:\\Users\\ANM\\Pictures",
};
// ======================================

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "x-token, content-type",
  });
  res.end(body);
}

function checkToken(req, q) {
  const h = req.headers["x-token"];
  const t = (q && q.token) || h;
  return t === TOKEN;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });
}

function resolvePath(input) {
  if (!input) return null;
  const lower = input.toLowerCase();
  if (BASES[lower]) return path.resolve(BASES[lower]);
  for (const key of Object.keys(BASES)) {
    const prefix = key + path.sep;
    if (lower.startsWith(prefix)) return path.resolve(BASES[key], input.slice(prefix.length));
    const prefix2 = key + "/";
    if (lower.startsWith(prefix2)) return path.resolve(BASES[key], input.slice(prefix2.length));
  }
  return path.resolve(input);
}

function isAllowed(resolved) {
  if (!resolved) return false;
  const norm = path.resolve(resolved).toLowerCase();
  for (const base of Object.values(BASES)) {
    const b = path.resolve(base).toLowerCase();
    if (norm === b || norm.startsWith(b + path.sep.toLowerCase())) return true;
  }
  return false;
}

function listarDir(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = path.join(dirPath, e.name);
    let stat;
    try { stat = fs.statSync(full); } catch (err) { continue; }
    out.push({
      nombre: e.name,
      tipo: e.isDirectory() ? "carpeta" : "archivo",
      tamano: e.isDirectory() ? null : stat.size,
      modificado: stat.mtime.toISOString(),
    });
  }
  out.sort((a, b) => {
    if (a.tipo !== b.tipo) return a.tipo === "carpeta" ? -1 : 1;
    return a.nombre.localeCompare(b.nombre, "es");
  });
  return out;
}

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".json": "application/json",
  ".zip": "application/zip", ".exe": "application/octet-stream", ".msi": "application/octet-stream",
  ".iso": "application/octet-stream", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// Abre una URL en el navegador predeterminado
function abrirUrl(urlStr) {
  return new Promise((resolve) => {
    if (!/^https?:\/\//i.test(urlStr)) return resolve({ ok: false, error: "URL invalida (debe empezar con http/https)" });
    // usar start para abrir en el navegador predeterminado
    const cmd = 'start "" "' + urlStr.replace(/"/g, "") + '"';
    exec(cmd, { windowsHide: true }, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, url: urlStr });
    });
  });
}

const OPENCODE_CLI = "C:\\\\Users\\\\ANM\\\\AppData\\\\Roaming\\\\ai.opencode.desktop\\\\cli\\\\2.1.1-x64\\\\opencode-cli.exe";

function runOpenCode(prompt, cwd, model) {
  return new Promise((resolve) => {
    const args = ["run", "--auto", "--format", "json"];
    const m = model || "google/gemini-3.5-flash-lite";
    args.push("--model", m);
    args.push(prompt);
    const workdir = cwd && fs.existsSync(cwd) ? cwd : "C:\\Users\\ANM\\Documents";
    const proc = spawn(OPENCODE_CLI, args, { cwd: workdir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", stdoutBuf = Buffer.alloc(0);
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ ok: false, error: "timeout (120s)" }); }, 120000);
    proc.stdout.on("data", (d) => { stdoutBuf = Buffer.concat([stdoutBuf, d]); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const outStr = stdoutBuf.toString("utf8");
      const texts = [];
      let errObj = null;
      for (const line of outStr.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const j = JSON.parse(t);
          if (j.type === "text" && j.part && j.part.text) texts.push(j.part.text);
          if (j.type === "error") errObj = j.error;
        } catch (e) {}
      }
      const out = texts.join("\n").trim();
      if (code === 0 && out) resolve({ ok: true, output: out });
      else if (code === 0 && !out) resolve({ ok: true, output: outStr.slice(0, 4000) });
      else resolve({ ok: false, error: (errObj && (errObj.message || JSON.stringify(errObj))) || stderr.trim() || ("exit " + code), raw: outStr.slice(0, 2000) });
    });
    proc.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

// ===== Helpers para nuevas funcionalidades =====

// A: Portapapeles
function clipboardRead() {
  return new Promise((resolve) => {
    exec('powershell -NoProfile -Command "Get-Clipboard"', { windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      resolve({ ok: true, texto: stdout.replace(/\r?\n$/, "") });
    });
  });
}
function clipboardWrite(texto) {
  return new Promise((resolve) => {
    const ps = spawn("powershell", ["-NoProfile", "-Command", "Set-Clipboard -Value $input"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    ps.stdin.write(texto || "");
    ps.stdin.end();
    let err = "";
    ps.stderr.on("data", (d) => { err += d.toString(); });
    ps.on("close", (code) => {
      if (code === 0) resolve({ ok: true, hecho: "Portapapeles actualizado." });
      else resolve({ ok: false, error: err.trim() || ("exit " + code) });
    });
    ps.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}

// B: Captura de pantalla
function screenshot() {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), "nexo_shot_" + Date.now() + ".png");
    const cmd = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save('${tmp.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose(); Write-Output '${tmp.replace(/'/g, "''")}'`;
    exec("powershell -NoProfile -Command \"" + cmd + "\"", { windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      const p = stdout.trim();
      if (!p || !fs.existsSync(p)) return resolve({ ok: false, error: "no se genero la captura" });
      resolve({ ok: true, path: p });
    });
  });
}

// K: Control de medios (teclas multimedia)
function mediaKey(accion) {
  return new Promise((resolve) => {
    const map = { play: 179, pause: 179, playpause: 179, siguiente: 176, next: 176, anterior: 177, prev: 177, subir: 175, bajar: 174 };
    const vk = map[String(accion || "").toLowerCase()];
    if (!vk) return resolve({ ok: false, error: "accion no reconocida: " + accion });
    const cmd = `$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys([char]${vk})`;
    exec("powershell -NoProfile -Command \"" + cmd + "\"", { windowsHide: true }, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, hecho: "Tecla multimedia enviada: " + accion });
    });
  });
}

// M: Texto a voz en la PC
function ttsPC(texto) {
  return new Promise((resolve) => {
    const safe = String(texto || "").replace(/'/g, "''");
    const cmd = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${safe}')`;
    exec("powershell -NoProfile -Command \"" + cmd + "\"", { windowsHide: true, timeout: 30000 }, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, hecho: "La PC dijo: " + texto });
    });
  });
}

// D: Procesos
function listarProcesos() {
  return new Promise((resolve) => {
    exec('powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 25 Name, Id, @{N=\'CPU\';E={[math]::Round($_.CPU,1)}}, @{N=\'MemMB\';E={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json"', { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      try {
        let j = JSON.parse(stdout.trim());
        if (!Array.isArray(j)) j = [j];
        resolve({ ok: true, procesos: j });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  });
}
function matarProceso(nombreOrPid) {
  return new Promise((resolve) => {
    const v = String(nombreOrPid || "").trim();
    const cmd = /^\d+$/.test(v)
      ? `Stop-Process -Id ${v} -Force -ErrorAction SilentlyContinue; Write-Output ok`
      : `Get-Process -Name '${v.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Stop-Process -Force; Write-Output ok`;
    exec("powershell -NoProfile -Command \"" + cmd + "\"", { windowsHide: true }, (err, stdout) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, hecho: "Proceso terminado: " + v });
    });
  });
}

// ===== Helpers adicionales (C,F,E,J,O,P,Q) =====

// C: Ventanas
function listarVentanas() {
  return new Promise((resolve) => {
    exec('powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, Name, MainWindowTitle | ConvertTo-Json"', { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      try {
        let j = JSON.parse(stdout.trim());
        if (!Array.isArray(j)) j = [j];
        resolve({ ok: true, ventanas: j });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  });
}
function accionVentana(accion, titulo) {
  return new Promise((resolve) => {
    const t = String(titulo || "").replace(/'/g, "''");
    let cmd = "";
    if (accion === "cerrar") {
      cmd = `Get-Process | Where-Object { $_.MainWindowTitle -like '*${t}*' } | Stop-Process -Force; Write-Output ok`;
    } else if (accion === "enfocar") {
      cmd = `$wsh = New-Object -ComObject WScript.Shell; $wsh.AppActivate('${t}'); Write-Output ok`;
    } else if (accion === "minimizar") {
      cmd = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Name Win -Namespace Native; Get-Process | Where-Object { $_.MainWindowTitle -like '*${t}*' } | ForEach-Object { [Native.Win]::ShowWindow($_.MainWindowHandle, 6) | Out-Null }; Write-Output ok`;
    } else {
      return resolve({ ok: false, error: "accion no reconocida: " + accion });
    }
    exec("powershell -NoProfile -Command \"" + cmd + "\"", { windowsHide: true }, (err, stdout) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, hecho: accion + " ventana: " + titulo });
    });
  });
}

// F: Busqueda de archivos
function buscarArchivos(base, nombre, contenido) {
  return new Promise((resolve) => {
    const b = resolvePath(base || "descargas");
    if (!b || !isAllowed(b)) return resolve({ ok: false, error: "carpeta no permitida" });
    const n = String(nombre || "").replace(/'/g, "''");
    const c = String(contenido || "").replace(/'/g, "''");
    let cmd = `Get-ChildItem -Path '${b.replace(/'/g, "''")}' -Recurse -ErrorAction SilentlyContinue`;
    if (n) cmd += ` -Filter '*${n}*'`;
    cmd += " | Select-Object -First 50 FullName, Length, LastWriteTime";
    if (c) {
      cmd = `Get-ChildItem -Path '${b.replace(/'/g, "''")}' -Recurse -File -ErrorAction SilentlyContinue | Select-String -Pattern '${c}' -ErrorAction SilentlyContinue | Select-Object -First 50 Path, LineNumber, Line`;
    }
    cmd += " | ConvertTo-Json";
    exec("powershell -NoProfile -Command \"" + cmd + "\"", { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      try {
        let j = stdout.trim() ? JSON.parse(stdout.trim()) : [];
        if (!Array.isArray(j)) j = [j];
        resolve({ ok: true, resultados: j });
      } catch (e) { resolve({ ok: true, resultados: [], raw: stdout.trim().slice(0, 500) }); }
    });
  });
}

// E: Brillo
function setBrillo(nivel) {
  return new Promise((resolve) => {
    const n = Math.max(0, Math.min(100, parseInt(nivel, 10) || 50));
    const cmd = `$m = Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue; if ($m) { $m.WmiSetBrightness(1, ${n}); Write-Output ok } else { Write-Output nosoporte }`;
    exec("powershell -NoProfile -Command \"" + cmd + "\"", { windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      const out = stdout.trim();
      if (out === "nosoporte") resolve({ ok: false, error: "Este monitor no soporta control de brillo por software." });
      else resolve({ ok: true, hecho: "Brillo al " + n + "%" });
    });
  });
}

// J: Terminal (ejecutar comando)
function ejecutarComando(comando, cwd) {
  return new Promise((resolve) => {
    const workdir = cwd && fs.existsSync(cwd) ? cwd : "C:\\Users\\ANM";
    exec(comando, { cwd: workdir, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || "").slice(0, 8000), stderr: (stderr || "").slice(0, 4000), error: err ? err.message : null, code: err ? err.code : 0 });
    });
  });
}

// I: Notificaciones (cola en memoria)
const NOTIF_QUEUE = [];
function pushNotif(texto) {
  const n = { id: Date.now(), texto: String(texto || ""), ts: new Date().toISOString() };
  NOTIF_QUEUE.push(n);
  if (NOTIF_QUEUE.length > 50) NOTIF_QUEUE.shift();
  return n;
}

// O: Wake-on-LAN
function wakeOnLan(mac) {
  return new Promise((resolve) => {
    const clean = String(mac || "").replace(/[:-]/g, "").trim();
    if (!/^[0-9a-fA-F]{12}$/.test(clean)) return resolve({ ok: false, error: "MAC invalida (12 hex, ej. AA:BB:CC:DD:EE:FF)" });
    const bytes = Buffer.alloc(6, 0xFF);
    const macBuf = Buffer.from(clean, "hex");
    const packet = Buffer.alloc(6 + 16 * 6);
    bytes.copy(packet, 0);
    for (let i = 0; i < 16; i++) macBuf.copy(packet, 6 + i * 6);
    const dgram = require("dgram");
    const sock = dgram.createSocket("udp4");
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch (e) {}
      sock.send(packet, 0, packet.length, 9, "255.255.255.255", (err) => {
        try { sock.close(); } catch (x) {}
        if (err) resolve({ ok: false, error: err.message });
        else resolve({ ok: true, hecho: "Magic packet enviado a " + mac });
      });
    });
  });
}

// P: Backup/sync (copia de carpeta a destino en la PC)
function backupCarpeta(origen, destino) {
  return new Promise((resolve) => {
    const o = resolvePath(origen || "descargas");
    const d = resolvePath(destino || "documentos");
    if (!o || !isAllowed(o) || !d || !isAllowed(d)) return resolve({ ok: false, error: "rutas no permitidas" });
    const cmd = `robocopy "${o}" "${d}" /E /R:2 /W:1 /NFL /NDL /NJH /NJS`;
    exec(cmd, { windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // robocopy retorna 0-7 como exito
      if (err && err.code > 7) return resolve({ ok: false, error: stderr.trim() || err.message });
      resolve({ ok: true, hecho: "Backup completado: " + o + " -> " + d });
    });
  });
}

// Q: Sesiones de OpenCode
function listarSesionesOC() {
  return new Promise((resolve) => {
    exec(`"${OPENCODE_CLI}" session list --format json`, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: err.message, raw: (stderr || "").slice(0, 500) });
      try {
        let j = JSON.parse(stdout.trim());
        resolve({ ok: true, sesiones: j });
      } catch (e) {
        resolve({ ok: true, raw: stdout.trim().slice(0, 2000) });
      }
    });
  });
}

const APPS_PERMITIDAS = {
  chrome: "chrome", edge: "msedge", firefox: "firefox",
  notepad: "notepad", bloc: "notepad", calculadora: "calc", calc: "calc",
  explorador: "explorer", explorer: "explorer", paint: "mspaint",
  cmd: "cmd", powershell: "powershell", terminal: "wt",
};

function abrirApp(nombre) {
  return new Promise((resolve) => {
    const key = String(nombre || "").toLowerCase().trim();
    const app = APPS_PERMITIDAS[key];
    if (!app) return resolve({ ok: false, error: "App no permitida: " + nombre + ". Permitidas: " + Object.keys(APPS_PERMITIDAS).join(", ") });
    exec("start " + app, { windowsHide: true }, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, app: app });
    });
  });
}

const MOTORES = {
  google: (q) => "https://www.google.com/search?q=" + encodeURIComponent(q),
  youtube: (q) => "https://www.youtube.com/results?search_query=" + encodeURIComponent(q),
  bing: (q) => "https://www.bing.com/search?q=" + encodeURIComponent(q),
  duckduckgo: (q) => "https://duckduckgo.com/?q=" + encodeURIComponent(q),
};

function buscarWeb(motor, query) {
  const m = String(motor || "google").toLowerCase();
  const fn = MOTORES[m] || MOTORES.google;
  const url = fn(String(query || ""));
  return abrirUrl(url).then((r) => (r.ok ? { ok: true, url: url, motor: m } : r));
}

function runVolumeScript(args) {
  return new Promise((resolve) => {
    const ps = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", path.join(SCRIPTS, "set_volume.ps1")].concat(args), { windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { try { ps.kill(); } catch (e) {} resolve({ ok: false, error: "timeout" }); }, 15000);
    ps.stdout.on("data", (d) => { stdout += d.toString(); });
    ps.stderr.on("data", (d) => { stderr += d.toString(); });
    ps.on("close", (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      let volumen = null, mute = null;
      const m = out.match(/volumen=(\d+)/);
      if (m) volumen = parseInt(m[1], 10);
      const mm = out.match(/mute=(\w+)/i);
      if (mm) mute = mm[1].toLowerCase() === "true";
      if (code === 0) resolve({ ok: true, volumen: volumen, mute: mute, raw: out });
      else resolve({ ok: false, error: stderr.trim() || out || ("exit " + code) });
    });
    ps.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

function runZipScript(folderPath, zipPath) {
  return new Promise((resolve) => {
    const cmd = `Compress-Archive -Path '${folderPath.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    const ps = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-Command", cmd], { windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => { try { ps.kill(); } catch (e) {} resolve({ ok: false, error: "timeout" }); }, 120000);
    ps.stderr.on("data", (d) => { stderr += d.toString(); });
    ps.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(zipPath)) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || ("exit " + code) });
    });
    ps.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "x-token, content-type",
    });
    res.end();
    return;
  }

  if (pathname === "/health") {
    return sendJson(res, 200, { ok: true, bases: Object.keys(BASES) });
  }

  // Para /subir no consumimos el body aqui (se streamea directo a disco).
  const bodyBuf = (req.method === "POST" && pathname !== "/subir") ? await readBody(req) : Buffer.alloc(0);
  const q = parsed.query || {};
  let params = Object.assign({}, q);
  // intentar parsear body como JSON si aplica
  if (bodyBuf.length && (req.headers["content-type"] || "").includes("application/json")) {
    try { Object.assign(params, JSON.parse(bodyBuf.toString("utf8"))); } catch (e) {}
  }

  if (pathname === "/listar") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const carpeta = params.carpeta || "";
    const resolved = resolvePath(carpeta);
    if (!resolved || !isAllowed(resolved)) return sendJson(res, 403, { ok: false, error: "carpeta no permitida" });
    let stat;
    try { stat = fs.statSync(resolved); } catch (e) { return sendJson(res, 404, { ok: false, error: "no existe" }); }
    if (!stat.isDirectory()) return sendJson(res, 400, { ok: false, error: "no es carpeta" });
    try {
      const items = listarDir(resolved);
      return sendJson(res, 200, { ok: true, ruta: resolved, items });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (pathname === "/archivo") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const ruta = params.ruta || "";
    const resolved = resolvePath(ruta);
    if (!resolved || !isAllowed(resolved)) return sendJson(res, 403, { ok: false, error: "ruta no permitida" });
    let stat;
    try { stat = fs.statSync(resolved); } catch (e) { return sendJson(res, 404, { ok: false, error: "no existe" }); }
    if (!stat.isFile()) return sendJson(res, 400, { ok: false, error: "no es archivo" });

    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    const nombre = path.basename(resolved);
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stat.size,
      "Content-Disposition": 'attachment; filename="' + encodeURIComponent(nombre) + '"',
      "Access-Control-Allow-Origin": "*",
    });
    const stream = fs.createReadStream(resolved);
    stream.on("error", (e) => { console.error("stream error", e); try { res.end(); } catch (x) {} });
    stream.pipe(res);
    console.log("Descarga:", resolved, "(" + stat.size + " bytes)");
    return;
  }

  if (pathname === "/descargar-carpeta") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const carpeta = params.carpeta || params.ruta || "";
    const resolved = resolvePath(carpeta);
    if (!resolved || !isAllowed(resolved)) return sendJson(res, 403, { ok: false, error: "carpeta no permitida" });
    let stat;
    try { stat = fs.statSync(resolved); } catch (e) { return sendJson(res, 404, { ok: false, error: "no existe" }); }
    if (!stat.isDirectory()) return sendJson(res, 400, { ok: false, error: "no es carpeta" });

    const zipName = path.basename(resolved) + ".zip";
    const zipPath = path.join(os.tmpdir(), "nexo_" + Date.now() + "_" + zipName);
    console.log("Zipeando carpeta:", resolved, "->", zipPath);
    const zr = await runZipScript(resolved, zipPath);
    if (!zr.ok) {
      try { fs.unlinkSync(zipPath); } catch (e) {}
      return sendJson(res, 500, { ok: false, error: "No pude zipear: " + zr.error });
    }
    let zstat;
    try { zstat = fs.statSync(zipPath); } catch (e) { return sendJson(res, 500, { ok: false, error: "zip no generado" }); }
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": zstat.size,
      "Content-Disposition": 'attachment; filename="' + encodeURIComponent(zipName) + '"',
      "Access-Control-Allow-Origin": "*",
    });
    const stream = fs.createReadStream(zipPath);
    stream.on("end", () => { try { fs.unlinkSync(zipPath); } catch (e) {} });
    stream.on("error", (e) => { console.error("stream error", e); try { res.end(); } catch (x) {} try { fs.unlinkSync(zipPath); } catch (y) {} });
    stream.pipe(res);
    console.log("Descarga carpeta:", resolved, "(" + zstat.size + " bytes)");
    return;
  }

  if (pathname === "/subir") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const carpeta = params.carpeta || "descargas";
    const rel = params.ruta || params.nombre || ("archivo_" + Date.now());
    const baseResolved = resolvePath(carpeta);
    if (!baseResolved || !isAllowed(baseResolved)) return sendJson(res, 403, { ok: false, error: "carpeta no permitida" });
    // validar que base es carpeta
    let bstat;
    try { bstat = fs.statSync(baseResolved); } catch (e) { return sendJson(res, 404, { ok: false, error: "carpeta base no existe" }); }
    if (!bstat.isDirectory()) return sendJson(res, 400, { ok: false, error: "no es carpeta" });

    // resolver ruta relativa dentro de la base, evitando traversal
    const relNorm = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
    const target = path.resolve(baseResolved, relNorm);
    if (!isAllowed(target)) return sendJson(res, 403, { ok: false, error: "ruta no permitida" });
    // asegurar que sigue dentro de la base
    if (!target.toLowerCase().startsWith(path.resolve(baseResolved).toLowerCase() + path.sep.toLowerCase()) && target.toLowerCase() !== path.resolve(baseResolved).toLowerCase()) {
      return sendJson(res, 403, { ok: false, error: "fuera de la carpeta base" });
    }

    // crear directorios padre
    const parent = path.dirname(target);
    try { fs.mkdirSync(parent, { recursive: true }); } catch (e) { return sendJson(res, 500, { ok: false, error: "no pude crear carpeta: " + e.message }); }

    // stream body to file
    const ws = fs.createWriteStream(target);
    let size = 0;
    req.pipe(ws);
    req.on("data", (c) => { size += c.length; });
    await new Promise((resolve) => {
      ws.on("finish", resolve);
      ws.on("error", (e) => { console.error("write error", e); resolve(); });
      req.on("aborted", () => { try { ws.destroy(); } catch (x) {} resolve(); });
    });
    if (!fs.existsSync(target)) return sendJson(res, 500, { ok: false, error: "fallo al guardar" });
    const finalStat = fs.statSync(target);
    console.log("Subida:", target, "(" + finalStat.size + " bytes)");
    return sendJson(res, 200, { ok: true, ruta: path.relative(baseResolved, target).replace(/\\/g, "/"), guardado_en: target, tamano: finalStat.size });
  }

  if (pathname === "/volumen") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const args = [];
    if (params.nivel !== undefined && params.nivel !== null && params.nivel !== "") {
      args.push("-Nivel", String(params.nivel));
    }
    if (params.mute !== undefined && params.mute !== null && params.mute !== "") {
      args.push("-Mute", String(params.mute).toLowerCase() === "true" ? "$true" : "$false");
    }
    if (params.accion) {
      args.push("-Accion", String(params.accion));
      if (params.veces !== undefined) args.push("-Veces", String(params.veces));
    }
    if (args.length === 0) args.push("-Nivel", "-1");
    const r = await runVolumeScript(args);
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });
    return sendJson(res, 200, { ok: true, volumen: r.volumen, mute: r.mute, raw: r.raw });
  }

  if (pathname === "/abrir-url") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const u = params.url || "";
    const r = await abrirUrl(u);
    return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, url: u, hecho: "Abriendo " + u } : { ok: false, error: r.error });
  }

  if (pathname === "/abrir-app") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const nombre = params.nombre || params.app || "";
    const r = await abrirApp(nombre);
    return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, app: r.app, hecho: "Abriendo " + r.app } : { ok: false, error: r.error });
  }

  if (pathname === "/buscar") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const motor = params.motor || "google";
    const query = params.query || params.q || params.texto || "";
    const r = await buscarWeb(motor, query);
    return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, url: r.url, motor: r.motor, hecho: "Buscando '" + query + "' en " + r.motor } : { ok: false, error: r.error });
  }

  if (pathname === "/info") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const cpus = os.cpus();
    const nets = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] || []) {
        if (n.family === "IPv4" && !n.internal) ips.push({ interfaz: name, ip: n.address });
      }
    }
    // discos via PowerShell
    const diskInfo = await new Promise((resolve) => {
      exec('powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk -Filter \\"DriveType=3\\" | Select-Object DeviceID, @{N=\'SizeGB\';E={[math]::Round($_.Size/1GB,2)}}, @{N=\'FreeGB\';E={[math]::Round($_.FreeSpace/1GB,2)}} | ConvertTo-Json"', { windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          let j = JSON.parse(stdout.trim());
          if (!Array.isArray(j)) j = [j];
          resolve(j.map((d) => ({ unidad: d.DeviceID, total_gb: d.SizeGB, libre_gb: d.FreeGB })));
        } catch (e) { resolve([]); }
      });
    });
    return sendJson(res, 200, {
      ok: true,
      hostname: os.hostname(),
      plataforma: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: { modelo: cpus[0] ? cpus[0].model : "", nucleos: cpus.length, velocidad_mhz: cpus[0] ? cpus[0].speed : 0 },
      ram: { total_mb: Math.round(os.totalmem() / 1024 / 1024), libre_mb: Math.round(os.freemem() / 1024 / 1024), usado_mb: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024) },
      uptime_segundos: Math.round(os.uptime()),
      ips: ips,
      discos: diskInfo,
    });
  }

  if (pathname === "/opencode") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const prompt = params.prompt || params.texto || params.mensaje || "";
    if (!prompt) return sendJson(res, 400, { ok: false, error: "falta prompt" });
    const cwd = params.cwd || params.carpeta || "";
    const model = params.model || params.modelo || "";
    console.log("OpenCode:", prompt.slice(0, 80));
    const r = await runOpenCode(prompt, cwd, model);
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  // A: Portapapeles
  if (pathname === "/portapapeles") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    if (req.method === "POST" || params.texto !== undefined || params.text !== undefined) {
      const texto = (params.texto !== undefined ? params.texto : params.text) || "";
      const r = await clipboardWrite(String(texto));
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    const r = await clipboardRead();
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  // B: Screenshot
  if (pathname === "/screenshot") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const r = await screenshot();
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });
    const stat = fs.statSync(r.path);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": stat.size,
      "Content-Disposition": 'attachment; filename="screenshot.png"',
      "Access-Control-Allow-Origin": "*",
    });
    const stream = fs.createReadStream(r.path);
    stream.on("end", () => { try { fs.unlinkSync(r.path); } catch (e) {} });
    stream.on("error", (e) => { try { res.end(); } catch (x) {} try { fs.unlinkSync(r.path); } catch (y) {} });
    stream.pipe(res);
    console.log("Screenshot:", r.path, "(" + stat.size + " bytes)");
    return;
  }

  // K: Media
  if (pathname === "/media") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const accion = params.accion || params.action || "";
    const r = await mediaKey(accion);
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  // M: TTS en la PC
  if (pathname === "/tts") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const texto = params.texto || params.text || "";
    const r = await ttsPC(texto);
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  // D: Procesos
  if (pathname === "/procesos") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const r = await listarProcesos();
    return sendJson(res, r.ok ? 200 : 500, r);
  }
  if (pathname === "/matar") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const target = params.nombre || params.pid || params.proceso || "";
    const r = await matarProceso(target);
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  // C: Ventanas
  if (pathname === "/ventanas") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const r = await listarVentanas();
    return sendJson(res, r.ok ? 200 : 500, r);
  }
  if (pathname === "/ventana") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const accion = params.accion || params.action || "";
    const titulo = params.titulo || params.title || "";
    const r = await accionVentana(accion, titulo);
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  // F: Busqueda de archivos
  if (pathname === "/buscar-archivos") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const r = await buscarArchivos(params.carpeta || params.base || "descargas", params.nombre || "", params.contenido || "");
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  // E: Brillo
  if (pathname === "/brillo") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const r = await setBrillo(params.nivel);
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  // I: Notificaciones
  if (pathname === "/notificaciones") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    if (req.method === "POST" || params.texto) {
      const n = pushNotif(params.texto || params.text || params.mensaje || "");
      return sendJson(res, 200, { ok: true, notificacion: n });
    }
    return sendJson(res, 200, { ok: true, notificaciones: NOTIF_QUEUE });
  }

  // J: Terminal
  if (pathname === "/terminal") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const comando = params.comando || params.command || params.cmd || "";
    if (!comando) return sendJson(res, 400, { ok: false, error: "falta comando" });
    const r = await ejecutarComando(comando, params.cwd);
    return sendJson(res, 200, r);
  }

  // O: Wake-on-LAN
  if (pathname === "/wol") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const r = await wakeOnLan(params.mac || params.mac_address || "");
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  // P: Backup
  if (pathname === "/backup") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const r = await backupCarpeta(params.origen || params.source, params.destino || params.destination);
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  // Q: Sesiones OpenCode
  if (pathname === "/opencode-sesiones") {
    if (!checkToken(req, q)) return sendJson(res, 401, { ok: false, error: "token invalido" });
    const r = await listarSesionesOC();
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  sendJson(res, 404, { ok: false, error: "endpoint no encontrado" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Puente PC listo en http://0.0.0.0:" + PORT);
  console.log("Bases permitidas:", Object.keys(BASES).join(", "));
  console.log("Token:", TOKEN);
  console.log("Prueba: curl http://127.0.0.1:" + PORT + "/health");
});

server.on("error", (e) => { console.error("Error servidor:", e.message); });