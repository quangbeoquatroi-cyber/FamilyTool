const fs = require('fs');
const aesjs = fs.readFileSync('./vendor/aes-js.min.js','utf8').split('\n').filter(l=>!l.startsWith('//')).join('\n');
const sha256 = fs.readFileSync('./vendor/sha256.min.js','utf8').split('\n').filter(l=>!l.startsWith('//')).join('\n');
const blob = fs.readFileSync('./.blob.b64.tmp','utf8').trim();

const loader = `/*!
 * secure-config.js — FamilyTool Secure Configuration Loader
 * ---------------------------------------------------------
 * Loads AES-256-CBC + HMAC-SHA256 encrypted secrets from an inline blob
 * (mirror of /config.secure). Decryption is fully synchronous so any code
 * that follows this script tag can use \`window.SecureConfig\` immediately
 * without changing its control flow.
 *
 * Passphrase is reassembled at runtime from XOR'd segments scattered through
 * this file — it is never stored as a single plain-text constant. Note that
 * client-side secrets can never be cryptographically protected from a
 * determined attacker; this is defense-in-depth obfuscation on top of the
 * existing Supabase Row-Level-Security model.
 *
 * To rotate secrets, regenerate both /config.secure AND the BLOB_B64
 * embedded below using scripts/regen-secure-config.js.
 *
 * Bundled libraries:
 *   - aes-js  (MIT) https://github.com/ricmoo/aes-js
 *   - js-sha256 (MIT) https://github.com/emn178/js-sha256
 */
(function(){
// (No 'use strict' on the outer wrapper: bundled libs rely on \`this\` at call site.)
${sha256}
${aesjs}
var sha256=(typeof globalThis!=='undefined'?globalThis:window).sha256;
var aesjs=(typeof globalThis!=='undefined'?globalThis:window).aesjs;
try{var __g=(typeof globalThis!=='undefined'?globalThis:window);delete __g.sha256;delete __g.sha224;delete __g.aesjs;}catch(e){}
;(function(root){if(!sha256||!aesjs)throw new Error('SecureConfig: bundled crypto libs missing');
  function _x(b64, pad){var s=atob(b64),o='';for(var i=0;i<s.length;i++)o+=String.fromCharCode(s.charCodeAt(i)^pad[i%pad.length]);return o;}
  var P=[
    _x('N4mzOw==',[0x71,0xdd,0xd8,0x64]),
    _x('a+I0',    [0x1d,0xd3,0x17]),
    _x('pR2xwQ==',[0x9c,0x7c,0xf2,0xf3]),
    _x('P6HrtA==',[0x7f,0xed,0x8f,0xda]),
    _x('O1/AsA==',[0x63,0x68,0xb1,0x91]),
    _x('uwsNhw==',[0xf9,0x71,0x3e,0xa3]),
    _x('7i/PkQ==',[0x9b,0x78,0xff,0xb4]),
    _x('3LbM+Q==',[0x8c,0xd3,0xf4,0xdf])
  ];
  var pw=P.join('|')+':FamilyTool/2024';
  var key=sha256.array(pw);
  var BLOB_B64='${blob}';
  function b64ToBytes(s){var b=atob(s),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}
  var blob=JSON.parse(atob(BLOB_B64));
  var iv=b64ToBytes(blob.iv),ct=b64ToBytes(blob.ct),mac=b64ToBytes(blob.mac);
  var macIn=new Uint8Array(iv.length+ct.length);macIn.set(iv,0);macIn.set(ct,iv.length);
  var macCalc=sha256.hmac.array(key,macIn);
  var diff=mac.length^macCalc.length;
  for(var i=0;i<mac.length;i++) diff|=mac[i]^macCalc[i];
  if(diff!==0) throw new Error('SecureConfig: integrity check failed');
  var aesCbc=new aesjs.ModeOfOperation.cbc(new Uint8Array(key),iv);
  var pt=aesjs.padding.pkcs7.strip(aesCbc.decrypt(ct));
  var json=aesjs.utils.utf8.fromBytes(pt);
  var cfg=JSON.parse(json);
  Object.freeze(cfg);
  Object.defineProperty(root,'SecureConfig',{value:cfg,writable:false,configurable:false,enumerable:false});
  // Wipe intermediates from local scope (best-effort)
  pw=null;key=null;json=null;pt=null;
})(typeof window!=='undefined'?window:globalThis);
})();
`;
fs.mkdirSync('../assets', {recursive:true});
fs.writeFileSync('../assets/secure-config.js', loader);
console.log('Loader size:', loader.length, 'bytes');
