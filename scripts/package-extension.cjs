"use strict";

// Dependency-free, reproducible ZIP for direct unpacked installation.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const root = path.resolve(__dirname, "..");
const extension = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error("Manifest/package version mismatch");

const files = new Map();
function collect(dir, relative = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) throw new Error("Refusing symlink: " + entry.name);
    const name = relative + entry.name;
    if (entry.isDirectory()) collect(path.join(dir, entry.name), name + "/");
    else if (entry.isFile()) files.set(name, fs.readFileSync(path.join(dir, entry.name)));
  }
}
collect(extension);
for (const name of ["README.md", "PRIVACY.md", "LICENSE"]) files.set(name, fs.readFileSync(path.join(root, name)));
files.set("安装说明.txt", Buffer.from(`Fab 免费素材助手 v${manifest.version} · 作者：菊山\r\n\r\n1. 将 ZIP 完整解压到单独文件夹，不要直接加载 ZIP。\r\n2. 打开 edge://extensions 或 chrome://extensions。\r\n3. 开启开发人员模式，点击“加载解压缩的扩展”。\r\n4. 选择直接包含 manifest.json 的文件夹。本安装包不用进入 extension 子目录。\r\n5. 登录 Fab 并刷新网页，顶部会出现可展开的助手胶囊。\r\n\r\n出现“清单文件丢失或不可读取”时：打开所选文件夹，确认 manifest.json 就在当前层。\r\n不要单独移动 manifest.json，其他脚本和页面也需要保留。\r\n如果下载的是 Code → Download ZIP 源码包，应选择源码里的 extension 文件夹。\r\n\r\n完整使用说明见 README.md，隐私说明见 PRIVACY.md。\r\n保留安装目录，移动或删除后浏览器可能无法加载。\r\n升级时先暂停任务并导出结果，覆盖原安装目录后重新加载扩展、刷新 Fab。\r\n本扩展不会在安装或升级时自动开始领取。\r\n`, "utf8"));
const required = [manifest.action?.default_popup, manifest.background?.service_worker,
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap(script => [...(script.js || []), ...(script.css || [])])].filter(Boolean);
for (const name of required) if (!files.has(name)) throw new Error("Missing manifest asset: " + name);

const table = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = (value >>> 8) ^ table[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
const locals = [], central = [];
let offset = 0;
for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b, "en"))) {
  const filename = Buffer.from(name, "utf8"), compressed = zlib.deflateRawSync(content, { level: 9 });
  const crc = crc32(content), header = Buffer.alloc(30), record = Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); // 1980-01-01, stable timestamp
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(content.length, 22); header.writeUInt16LE(filename.length, 26);
  record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
  record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14);
  record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20);
  record.writeUInt32LE(content.length, 24); record.writeUInt16LE(filename.length, 28);
  record.writeUInt32LE(offset, 42);
  locals.push(header, filename, compressed); central.push(record, filename);
  offset += header.length + filename.length + compressed.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...locals, directory, end]);
const name = `fab-library-helper-v${manifest.version}.zip`, output = path.join(root, "downloads");
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, name), archive);
const hash = crypto.createHash("sha256").update(archive).digest("hex");
fs.writeFileSync(path.join(output, name + ".sha256"), `${hash}  ${name}\n`);
console.log(`Packaged ${name}: ${files.size} files, ${archive.length} bytes, SHA256 ${hash}`);
