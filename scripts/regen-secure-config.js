const crypto = require('crypto');
const fs = require('fs');

const SECRETS = {
  SUPABASE_URL: "https://acwlagoieszpydklikqw.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjd2xhZ29pZXN6cHlka2xpa3F3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1ODc5MDYsImV4cCI6MjA5MzE2MzkwNn0.I50smOD2_phj8PSSg4A0KzepYliWQinGXVmZpop9ljI"
};

// Passphrase assembled from segments (mirrored in secure-config.js as XOR'd chunks)
const SEG = ["FTk_","v1#","9aC2","@Ldn","X7q!","Bz3$","uW0%","Pe8&"];
const passphrase = SEG.join("|") + ":FamilyTool/2024";
const key = crypto.createHash("sha256").update(passphrase, "utf8").digest();

const iv = crypto.randomBytes(16);
const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
const plaintext = Buffer.from(JSON.stringify(SECRETS), "utf8");
const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const mac = crypto.createHmac("sha256", key).update(Buffer.concat([iv, ct])).digest();

const blob = {
  v: 1,
  alg: "AES-256-CBC+HMAC-SHA256",
  kdf: "SHA-256(passphrase)",
  iv: iv.toString("base64"),
  ct: ct.toString("base64"),
  mac: mac.toString("base64")
};
const b64 = Buffer.from(JSON.stringify(blob)).toString("base64");
fs.writeFileSync("../config.secure", b64 + "\n");
fs.writeFileSync("./.blob.b64.tmp", b64);
console.log("OK", b64.length, "chars");

// verify
const blob2 = JSON.parse(Buffer.from(b64,"base64").toString());
const iv2 = Buffer.from(blob2.iv,"base64"), ct2 = Buffer.from(blob2.ct,"base64");
const mac2 = crypto.createHmac("sha256", key).update(Buffer.concat([iv2,ct2])).digest();
if(!crypto.timingSafeEqual(mac2, Buffer.from(blob2.mac,"base64"))) throw new Error("MAC fail");
const d = crypto.createDecipheriv("aes-256-cbc", key, iv2);
console.log("Decrypt OK:", Buffer.concat([d.update(ct2),d.final()]).toString("utf8").slice(0,60));

// Also produce XOR'd passphrase segments so the JS loader can rebuild it
// without ever storing it as plain text constants.
function toXor(seg){
  // pad seg into base64 using random pad of same length
  const padLen = seg.length;
  const pad = crypto.randomBytes(padLen);
  const xored = Buffer.alloc(padLen);
  for(let i=0;i<padLen;i++) xored[i] = seg.charCodeAt(i) ^ pad[i];
  return { b64: xored.toString("base64"), padHex: Array.from(pad).map(b=>"\\x"+b.toString(16).padStart(2,"0")).join("") };
}
const segOut = SEG.map(toXor);
fs.writeFileSync("./.segs.tmp.json", JSON.stringify(segOut, null, 2));
console.log(segOut);
