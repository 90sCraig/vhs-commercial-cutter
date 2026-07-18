// Renders the app icon (a VHS cassette in the booth's palette) to build/icon.png
// via an Electron canvas. electron-builder converts the PNG to a multi-size .ico.
//   node_modules/electron/dist/electron.exe scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const draw = `
const cv = document.getElementById('c'), x = cv.getContext('2d');
const W = 1024, H = 1024;
function rr(x0,y0,w,h,r){ x.beginPath(); x.moveTo(x0+r,y0);
  x.arcTo(x0+w,y0,x0+w,y0+h,r); x.arcTo(x0+w,y0+h,x0,y0+h,r);
  x.arcTo(x0,y0+h,x0,y0,r); x.arcTo(x0,y0,x0+w,y0,r); x.closePath(); }

// rounded-square backplate (corners stay transparent)
let g = x.createLinearGradient(0,0,0,H);
g.addColorStop(0,'#12161a'); g.addColorStop(1,'#080a0c');
rr(60,60,W-120,H-120,190); x.fillStyle=g; x.fill();
rr(60,60,W-120,H-120,190); x.strokeStyle='rgba(95,206,140,0.22)'; x.lineWidth=6; x.stroke();

// --- CRT television ---
const bx=170, by=316, bw=684, bh=486, br=44;

// antenna (rabbit ears) rising from the top
x.strokeStyle='#6b7570'; x.lineWidth=9; x.lineCap='round';
x.beginPath(); x.moveTo(512, by+6); x.lineTo(372, 168); x.stroke();
x.beginPath(); x.moveTo(512, by+6); x.lineTo(656, 150); x.stroke();
x.fillStyle='#828c86';
x.beginPath(); x.arc(372,168,10,0,7); x.fill();
x.beginPath(); x.arc(656,150,10,0,7); x.fill();

// TV body with a soft drop shadow
let bg=x.createLinearGradient(0,by,0,by+bh);
bg.addColorStop(0,'#434a51'); bg.addColorStop(1,'#23292e');
x.save(); x.shadowColor='rgba(0,0,0,0.55)'; x.shadowBlur=48; x.shadowOffsetY=22;
rr(bx,by,bw,bh,br); x.fillStyle=bg; x.fill(); x.restore();
x.strokeStyle='#5a636c'; x.lineWidth=5; rr(bx,by,bw,bh,br); x.stroke();

// screen geometry
const sx=214, sy=372, sw=420, sh=360;

// bezel
rr(sx-16, sy-16, sw+32, sh+32, 30); x.fillStyle='#0e1215'; x.fill();
x.strokeStyle='#2a3137'; x.lineWidth=3; x.stroke();

// glowing green phosphor screen
let scr=x.createRadialGradient(sx+sw/2, sy+sh*0.42, 30, sx+sw/2, sy+sh/2, sw*0.8);
scr.addColorStop(0,'#1c4a2e'); scr.addColorStop(0.6,'#0f3020'); scr.addColorStop(1,'#07140d');
rr(sx,sy,sw,sh,18); x.fillStyle=scr; x.fill();

// scanlines + play glyph, clipped to the screen
x.save(); rr(sx,sy,sw,sh,18); x.clip();
x.globalAlpha=0.20; x.fillStyle='#000';
for(let y=sy; y<sy+sh; y+=7) x.fillRect(sx, y, sw, 3);
x.globalAlpha=1;
// play triangle
x.fillStyle='rgba(120,240,160,0.95)';
x.shadowColor='#5fce8c'; x.shadowBlur=34;
const tx=sx+sw/2, ty=sy+sh/2, s=66;
x.beginPath(); x.moveTo(tx-s*0.55, ty-s); x.lineTo(tx-s*0.55, ty+s); x.lineTo(tx+s*0.95, ty); x.closePath(); x.fill();
x.shadowBlur=0; x.restore();

// control column (knobs + speaker grille) on the right
const colcx=746;
function knob(cy){
  let kg=x.createRadialGradient(colcx-8, cy-8, 4, colcx, cy, 38);
  kg.addColorStop(0,'#39424a'); kg.addColorStop(1,'#20262b');
  x.beginPath(); x.arc(colcx,cy,36,0,7); x.fillStyle=kg; x.fill();
  x.strokeStyle='#5a636c'; x.lineWidth=4; x.stroke();
  x.strokeStyle='#5fce8c'; x.lineWidth=5; x.lineCap='round';
  x.beginPath(); x.moveTo(colcx,cy); x.lineTo(colcx, cy-20); x.stroke();
}
knob(430); knob(536);
// speaker grille
x.fillStyle='#2a3137';
for(let i=0;i<5;i++){ rr(colcx-46+i*22, 610, 9, 118, 5); x.fill(); }

// feet
x.fillStyle='#242a2f';
rr(bx+120, by+bh-4, 92, 40, 10); x.fill();
rr(bx+bw-212, by+bh-4, 92, 40, 10); x.fill();

window.__png = cv.toDataURL('image/png');
`;

const html = '<!doctype html><html><head><meta charset="utf-8">'
  + '<style>html,body{margin:0;background:transparent}</style></head>'
  + '<body><canvas id="c" width="1024" height="1024"></canvas>'
  + '<script>' + draw + '</script></body></html>';

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const dataUrl = await win.webContents.executeJavaScript('window.__png');
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log('wrote', out);
  app.quit();
});
