/**
 * M2 手绘引擎：风格 = 「绘制原语 + 构图规则 + 种子」。
 *
 * 机制对齐 M0 PoC（design-lab/doodle-poc）与 anidoodle canvas-core：
 *  - 随机只来自 mulberry32(seed)，禁 Math.random/Date，画面是 seed 的纯函数；
 *  - 布局/抖动/颗粒各用独立派生流，调一个参数不牵动全局；
 *  - 手绘感来自几何抖动（jitter/blob），不依赖 ctx.filter；
 *  - 同（内容, 风格, 种子）逐像素一致，换种子（variant）即「换一张构图」。
 *
 * 页面 = <canvas> 插画层（内联脚本同步绘制）+ 纸色文字面板（HTML/CSS）。
 * 文字块类名 sk-* 已加入 renderer.ts 的探针白名单，出图前走同一套版式体检。
 */
import { escapeHtml } from "../core/contentText";
import type { CardPage } from "./templates";

const esc = (value: unknown): string => escapeHtml(value === null || value === undefined ? "" : String(value));

/* ------------------------------------------------------------------ 类型 */

export interface SketchStyleInfo {
  key: string;
  name: string;
  tagline: string;
  desc: string;
  fit: string;
  colors: string[];
  temperature: "neutral" | "bold" | "calm";
  group: string;
  font: string;
  /** 文字面板底色 */
  paper: string;
  /** 正文墨色 */
  ink: string;
  /** 强调色 */
  accent: string;
  /** 面板内浅色（分隔线/编号底） */
  soft: string;
}

/* ------------------------------------------------------------ 首批 5 风格 */

const SANS = '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif';
const KAI = '"Kaiti SC","KaiTi","STKaiti","Microsoft YaHei",serif';
const SONG = '"Songti SC","STSong","SimSun",Georgia,serif';
const EMOJI_FONTS = ',"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji"';

export const SKETCH_STYLES: SketchStyleInfo[] = [
  {
    key: "sk-flat",
    name: "平涂向量",
    tagline: "Flat Vector",
    desc: "几何色块平涂、手绘抖动边缘与细颗粒，干净现代的科技感",
    fit: "产品介绍、功能亮点、科技数码",
    colors: ["#FDF6EC", "#3F6B52", "#F4A83C"],
    temperature: "neutral",
    group: "art",
    font: `${SANS}${EMOJI_FONTS}`,
    paper: "#FDF6EC",
    ink: "#3A3631",
    accent: "#F4A83C",
    soft: "#EAE0CC",
  },
  {
    key: "sk-pencil",
    name: "铅笔淡彩",
    tagline: "Pencil & Wash",
    desc: "铅笔线稿打底、水彩色斑轻晕染，生活感与手账气质",
    fit: "生活方式、日常记录、探店测评",
    colors: ["#FBF7EE", "#4A4A46", "#E9A23B"],
    temperature: "calm",
    group: "art",
    font: `${KAI}${EMOJI_FONTS}`,
    paper: "#FBF7EE",
    ink: "#4A4A46",
    accent: "#E9A23B",
    soft: "#EFE6D2",
  },
  {
    key: "sk-marker",
    name: "马克漫画",
    tagline: "Marker Comic",
    desc: "粗黑描边、网点与速度线，高饱和撞色的漫画海报感",
    fit: "活动宣传、观点输出、醒目提醒",
    colors: ["#FFFFFF", "#17181C", "#FF5D73"],
    temperature: "bold",
    group: "art",
    font: `${SANS}${EMOJI_FONTS}`,
    paper: "#FFFFFF",
    ink: "#17181C",
    accent: "#FF5D73",
    soft: "#FFE07A",
  },
  {
    key: "sk-sumie",
    name: "水墨国风",
    tagline: "Sumi-e Ink",
    desc: "宣纸留白、墨色晕染与一笔竹枝，安静克制的东方气质",
    fit: "文化内容、读书笔记、品牌故事",
    colors: ["#F7F4EC", "#2B2723", "#B03A2E"],
    temperature: "calm",
    group: "art",
    font: `${SONG}${EMOJI_FONTS}`,
    paper: "#F7F4EC",
    ink: "#2B2723",
    accent: "#B03A2E",
    soft: "#E7E1D2",
  },
  {
    key: "sk-cutpaper",
    name: "剪纸节日",
    tagline: "Cut Paper",
    desc: "层叠锯齿色纸、圆窗与灯笼纹样，红金配色的节庆气氛",
    fit: "节日热点、促销活动、喜庆盘点",
    colors: ["#FBF3E4", "#7E1F1A", "#E8B84B"],
    temperature: "bold",
    group: "art",
    font: `${KAI}${EMOJI_FONTS}`,
    paper: "#FBF3E4",
    ink: "#5C1A16",
    accent: "#C8392B",
    soft: "#F0DFC0",
  },
];

export const DEFAULT_SKETCH_STYLE = "sk-flat";

export function isSketchStyleKey(key: unknown): boolean {
  return SKETCH_STYLES.some((item) => item.key === String(key || "").trim());
}

export function sketchStyleInfo(key: unknown): SketchStyleInfo {
  const found = SKETCH_STYLES.find((item) => item.key === String(key || "").trim());
  return found || SKETCH_STYLES[0];
}

/** 种子派生：同（草稿，变体）稳定；变体 +1 即「换一张构图」。 */
export function sketchSeed(draftId: unknown, variant: unknown = 0): number {
  const id = Math.trunc(Number(draftId) || 1) || 1;
  const ver = Math.max(0, Math.trunc(Number(variant) || 0));
  return (Math.imul(id, 2654435761) + Math.imul(ver + 1, 40503) + 0x9e3779b9) >>> 0;
}

/* --------------------------------------------------------- 内联脚本：原语 */

const COMMON_JS = `
function mulberry32(seed){var a=seed>>>0;return function(){a=(a+0x6D2B79F5)|0;
var t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;
return((t^(t>>>14))>>>0)/4294967296;};}
function lerp(a,b,t){return a+(b-a)*t;}
function jitter(pts,amt,rng){return pts.map(function(p){
return [p[0]+(rng()-0.5)*2*amt,p[1]+(rng()-0.5)*2*amt];});}
function poly(ctx,pts,fill){ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);
for(var i=1;i<pts.length;i++)ctx.lineTo(pts[i][0],pts[i][1]);ctx.closePath();
if(fill){ctx.fillStyle=fill;ctx.fill();}}
function blob(ctx,cx,cy,rx,ry,n,amt,rng,fill){var pts=[];
for(var i=0;i<n;i++){var a=i/n*Math.PI*2;var j=1+(rng()-0.5)*2*amt;
pts.push([cx+Math.cos(a)*rx*j,cy+Math.sin(a)*ry*j]);}poly(ctx,pts,fill);}
function strokePoly(ctx,pts,color,w){ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);
for(var i=1;i<pts.length;i++)ctx.lineTo(pts[i][0],pts[i][1]);
ctx.strokeStyle=color;ctx.lineWidth=w;ctx.lineJoin="round";ctx.lineCap="round";ctx.stroke();}
function grain(ctx,W,H,rng,n,colors){for(var i=0;i<n;i++){
var gx=rng()*W,gy=rng()*H;ctx.fillStyle=colors[Math.floor(rng()*colors.length)];
ctx.fillRect(gx,gy,2.4,2.4);}}
`;

/* --------------------------------------------------- 内联脚本：5 风格绘制 */

const SKETCH_DRAW: Record<string, string> = {
  /* 平涂向量：太阳/云/三层山/树/小屋/飞鸟 + 颗粒（M0 PoC 配方） */
  "sk-flat": `
function draw(ctx,W,H,seed,P,wide){
  var rngL=mulberry32(seed),rngJ=mulberry32((seed*31+7)>>>0),rngG=mulberry32((seed*7919+13)>>>0);
  var AW=P.aw||W, AH=P.artH||H;
  ctx.fillStyle=P.paper;ctx.fillRect(0,0,W,H);
  var sx=lerp(AW*0.55,AW*0.80,rngL()), sy=lerp(AH*0.12,AH*0.20,rngL()), sr=lerp(70,110,rngL());
  blob(ctx,sx,sy,sr*1.35,sr*1.35,22,0.05,rngJ,"rgba(244,168,60,0.25)");
  blob(ctx,sx,sy,sr,sr,26,0.03,rngJ,"#F4A83C");
  var clouds=2+Math.floor(rngL()*2);
  for(var c=0;c<clouds;c++){
    var cx=lerp(AW*0.10,AW*0.85,rngL()), cy=lerp(AH*0.08,AH*0.24,rngL()), s=lerp(0.7,1.1,rngL());
    var parts=[[-70,8,46],[0,-14,62],[72,6,44],[10,22,52]];
    for(var k=0;k<parts.length;k++){var p=parts[k];
      blob(ctx,cx+p[0]*s,cy+p[1]*s,p[2]*s,p[2]*0.72*s,14,0.06,rngJ,"#FFFFFF");}
  }
  poly(ctx,jitter([[0,AH*0.52],[AW*0.22,AH*0.42],[AW*0.45,AH*0.50],[AW*0.68,AH*0.40],[AW*0.88,AH*0.48],[AW,AH*0.45],[AW,H],[0,H]],16,rngJ),"#D8E3DA");
  poly(ctx,jitter([[0,AH*0.66],[AW*0.18,AH*0.56],[AW*0.42,AH*0.64],[AW*0.66,AH*0.53],[AW*0.85,AH*0.62],[AW,AH*0.58],[AW,H],[0,H]],18,rngJ),"#A9C3AD");
  poly(ctx,jitter([[0,AH*0.84],[AW*0.25,AH*0.78],[AW*0.55,AH*0.86],[AW*0.80,AH*0.79],[AW,AH*0.83],[AW,H],[0,H]],14,rngJ),"#7FA98B");
  var trees=3+Math.floor(rngL()*3);
  for(var i=0;i<trees;i++){
    var tx=lerp(AW*0.08,AW*0.92,rngL()), ty=lerp(AH*0.74,AH*0.86,rngL()), s=lerp(0.7,1.2,rngL());
    poly(ctx,jitter([[tx,ty-140*s],[tx+58*s,ty-36*s],[tx-58*s,ty-36*s]],7,rngJ),"#3F6B52");
    poly(ctx,jitter([[tx,ty-100*s],[tx+76*s,ty+8*s],[tx-76*s,ty+8*s]],7,rngJ),"#4C7A5F");
    ctx.fillStyle="#8A5A3B";ctx.fillRect(tx-8*s,ty+6*s,16*s,42*s);
  }
  var hx=lerp(AW*0.30,AW*0.62,rngL()), hy=AH*0.84, hw=lerp(150,210,rngL());
  poly(ctx,jitter([[hx,hy],[hx+hw,hy],[hx+hw,hy-hw*0.52],[hx,hy-hw*0.52]],6,rngJ),"#F7EFE2");
  poly(ctx,jitter([[hx-24,hy-hw*0.52],[hx+hw+24,hy-hw*0.52],[hx+hw/2,hy-hw*0.95]],7,rngJ),"#C96F4A");
  ctx.fillStyle="#8A5A3B";ctx.fillRect(hx+hw*0.38,hy-hw*0.30,hw*0.24,hw*0.30);
  var birds=2+Math.floor(rngL()*3);
  ctx.strokeStyle="#3A3631";ctx.lineWidth=5;ctx.lineCap="round";
  for(var b=0;b<birds;b++){
    var bx=lerp(AW*0.12,AW*0.85,rngL()), by=lerp(AH*0.14,AH*0.32,rngL()), bs=lerp(14,26,rngL());
    ctx.beginPath();
    ctx.arc(bx-bs,by,bs,Math.PI*1.15,Math.PI*1.85);
    ctx.arc(bx+bs,by,bs,Math.PI*1.15,Math.PI*1.85);
    ctx.stroke();
  }
  grain(ctx,W,H,rngG,900,["rgba(58,54,49,0.05)","rgba(255,255,255,0.06)"]);
}`,
  /* 铅笔淡彩：水彩色斑 + 铅笔线稿 + 排线 */
  "sk-pencil": `
function draw(ctx,W,H,seed,P,wide){
  var rngL=mulberry32(seed),rngJ=mulberry32((seed*31+7)>>>0),rngW=mulberry32((seed*7919+13)>>>0);
  var AW=P.aw||W, AH=P.artH||H;
  ctx.fillStyle=P.paper;ctx.fillRect(0,0,W,H);
  var washes=4+Math.floor(rngL()*3);
  var washCols=["rgba(233,162,59,0.13)","rgba(127,168,201,0.12)","rgba(192,112,95,0.10)","rgba(143,198,180,0.11)"];
  for(var i=0;i<washes;i++){
    var wx=lerp(0,AW,rngL()), wy=lerp(0,AH*0.9,rngL()), wr=lerp(120,260,rngL());
    var col=washCols[Math.floor(rngL()*washCols.length)];
    blob(ctx,wx,wy,wr,wr*lerp(0.6,1,rngL()),18,0.22,rngJ,col);
    blob(ctx,wx,wy,wr*0.7,wr*0.5,14,0.25,rngJ,col);
  }
  var ink="rgba(74,74,70,0.85)";
  var horizon=AH*0.66;
  strokePoly(ctx,jitter([[0,horizon],[AW*0.3,horizon-24],[AW*0.6,horizon+16],[AW,horizon-10]],6,rngJ),ink,3);
  strokePoly(ctx,jitter([[AW*0.05,AH*0.5],[AW*0.3,AH*0.40],[AW*0.55,AH*0.48],[AW*0.8,AH*0.42],[AW,AH*0.5]],10,rngJ),"rgba(74,74,70,0.45)",2.4);
  var hx=lerp(AW*0.16,AW*0.5,rngL()), hy=horizon+8, hw=lerp(170,230,rngL());
  var house=[[hx,hy],[hx+hw,hy],[hx+hw,hy-hw*0.55],[hx,hy-hw*0.55]];
  strokePoly(ctx,jitter(house,4,rngJ),ink,3.2);
  strokePoly(ctx,jitter(house,4,rngJ),"rgba(74,74,70,0.35)",2.2);
  strokePoly(ctx,jitter([[hx-20,hy-hw*0.55],[hx+hw/2,hy-hw*0.95],[hx+hw+20,hy-hw*0.55]],5,rngJ),ink,3.2);
  strokePoly(ctx,jitter([[hx+hw*0.36,hy],[hx+hw*0.36,hy-hw*0.26],[hx+hw*0.60,hy-hw*0.26],[hx+hw*0.60,hy]],3,rngJ),"rgba(74,74,70,0.7)",2.4);
  var trees=2+Math.floor(rngL()*2);
  for(var t=0;t<trees;t++){
    var tx=lerp(AW*0.62,AW*0.92,rngL()), ty=lerp(horizon+14,horizon+46,rngL()), s=lerp(0.85,1.25,rngL());
    strokePoly(ctx,jitter([[tx,ty],[tx+6*s,ty-110*s]],4,rngJ),ink,3.4);
    strokePoly(ctx,jitter([[tx+10*s,ty],[tx+2*s,ty-108*s]],4,rngJ),"rgba(74,74,70,0.5)",2.2);
    var crown=[];
    for(var a=0;a<8;a++){var ang=a/8*Math.PI*2;
      crown.push([tx+4*s+Math.cos(ang)*lerp(52,74,rngJ())*s,ty-118*s+Math.sin(ang)*lerp(34,52,rngJ())*s]);}
    strokePoly(ctx,crown,ink,3);
  }
  var hatchX=lerp(AW*0.1,AW*0.3,rngL());
  for(var h2=0;h2<12;h2++){
    var hx2=hatchX+h2*13, hy2=horizon+26+h2*4;
    strokePoly(ctx,[[hx2,hy2],[hx2+34,hy2+22]],"rgba(74,74,70,0.35)",2);
  }
  var birds=2+Math.floor(rngL()*2);
  for(var b=0;b<birds;b++){
    var bx=lerp(AW*0.15,AW*0.8,rngL()), by=lerp(AH*0.16,AH*0.30,rngL()), bs=lerp(13,22,rngL());
    ctx.strokeStyle=ink;ctx.lineWidth=2.6;ctx.lineCap="round";
    ctx.beginPath();ctx.arc(bx-bs,by,bs,Math.PI*1.15,Math.PI*1.85);
    ctx.arc(bx+bs,by,bs,Math.PI*1.15,Math.PI*1.85);ctx.stroke();
  }
  grain(ctx,W,H,rngW,500,["rgba(74,74,70,0.05)","rgba(233,162,59,0.05)"]);
}`,
  /* 马克漫画：网点 + 爆炸星 + 粗描边云与贴纸 + 速度线 */
  "sk-marker": `
function draw(ctx,W,H,seed,P,wide){
  var rngL=mulberry32(seed),rngJ=mulberry32((seed*31+7)>>>0),rngD=mulberry32((seed*7919+13)>>>0);
  var AW=P.aw||W, AH=P.artH||H;
  ctx.fillStyle="#FFFFFF";ctx.fillRect(0,0,W,H);
  var dotX0=AW*0.55, dotY0=0;
  ctx.fillStyle="rgba(255,93,115,0.30)";
  for(var gy=0;gy<AH*0.5;gy+=16){for(var gx=dotX0;gx<AW;gx+=16){
    var dx=gx+(rngD()-0.5)*3, dy=gy+(rngD()-0.5)*3;
    ctx.beginPath();ctx.arc(dx,dy,2.6,0,Math.PI*2);ctx.fill();}}
  ctx.strokeStyle="#17181C";ctx.lineWidth=12;ctx.lineJoin="round";
  var sx=lerp(AW*0.2,AW*0.6,rngL()), sy=lerp(AH*0.22,AH*0.4,rngL()), sr=lerp(120,170,rngL());
  var star=[];
  for(var a=0;a<24;a++){var ang=a/24*Math.PI*2-Math.PI/2;
    var rr=(a%2===0?sr:sr*0.45)*(1+(rngJ()-0.5)*0.12);
    star.push([sx+Math.cos(ang)*rr,sy+Math.sin(ang)*rr]);}
  poly(ctx,star,"#FFD447");poly(ctx,star,"");ctx.strokeStyle="#17181C";ctx.lineWidth=10;ctx.stroke();
  ctx.beginPath();ctx.arc(sx,sy,sr*0.42,0,Math.PI*2);ctx.fillStyle="#FFFFFF";ctx.fill();ctx.stroke();
  var clouds=2+Math.floor(rngL()*2);
  for(var c=0;c<clouds;c++){
    var cx=lerp(AW*0.1,AW*0.85,rngL()), cy=lerp(AH*0.10,AH*0.26,rngL()), s=lerp(0.7,1.05,rngL());
    var pts=[];for(var i=0;i<14;i++){var ang=i/14*Math.PI*2;
      pts.push([cx+Math.cos(ang)*95*s*(1+(rngJ()-0.5)*0.16),cy+Math.sin(ang)*52*s*(1+(rngJ()-0.5)*0.16)]);}
    poly(ctx,pts,"#FFFFFF");ctx.strokeStyle="#17181C";ctx.lineWidth=9;ctx.stroke();
  }
  var groups=2+Math.floor(rngL()*2);
  ctx.lineWidth=7;ctx.lineCap="round";
  for(var g2=0;g2<groups;g2++){
    var gx2=lerp(AW*0.05,AW*0.7,rngL()), gy2=lerp(AH*0.5,AH*0.85,rngL());
    for(var l=0;l<4;l++){ctx.beginPath();ctx.moveTo(gx2,gy2+l*16);
      ctx.lineTo(gx2+lerp(90,170,rngJ()),gy2+l*16);ctx.stroke();}
  }
  var stickers=3+Math.floor(rngL()*3);
  var cols=["#FF5D73","#4E9AF1","#8FC6B4","#FFD447"];
  for(var st=0;st<stickers;st++){
    var px=lerp(AW*0.08,AW*0.9,rngL()), py=lerp(AH*0.55,AH*0.92,rngL()), ps=lerp(22,48,rngL());
    var col=cols[Math.floor(rngL()*cols.length)];
    ctx.fillStyle=col;ctx.strokeStyle="#17181C";ctx.lineWidth=8;
    var kind=Math.floor(rngL()*3);
    if(kind===0){ctx.beginPath();ctx.arc(px,py,ps,0,Math.PI*2);ctx.fill();ctx.stroke();}
    else if(kind===1){poly(ctx,jitter([[px,py-ps],[px+ps,py+ps],[px-ps,py+ps]],3,rngJ),col);
      ctx.strokeStyle="#17181C";ctx.lineWidth=8;ctx.stroke();}
    else{ctx.beginPath();ctx.ellipse(px,py,ps*1.2,ps*0.8,rngJ(),0,Math.PI*2);ctx.fill();ctx.stroke();}
  }
  var baseY=AH*0.96;
  strokePoly(ctx,jitter([[0,baseY],[AW*0.25,baseY-14],[AW*0.55,baseY+10],[AW,baseY-8]],6,rngJ),"#17181C",10);
  grain(ctx,W,H,rngD,240,["rgba(23,24,28,0.05)"]);
}`,
  /* 水墨国风：宣纸 + 墨色晕染远山 + 一笔竹 + 飞白 + 印章 */
  "sk-sumie": `
function draw(ctx,W,H,seed,P,wide){
  var rngL=mulberry32(seed),rngJ=mulberry32((seed*31+7)>>>0),rngG=mulberry32((seed*7919+13)>>>0);
  var AW=P.aw||W, AH=P.artH||H;
  ctx.fillStyle="#F7F4EC";ctx.fillRect(0,0,W,H);
  var layers=[[AH*0.30,0.05,1.0],[AH*0.40,0.08,0.8],[AH*0.52,0.12,0.62]];
  for(var l=0;l<layers.length;l++){
    var ly=AH*layers[l][0]*(layers[l][2]);
    blob(ctx,AW*0.42,ly,AW*0.55,AH*0.10*(1+l*0.35),26,0.10,rngJ,"rgba(43,39,35,"+layers[l][1]+")");
    blob(ctx,AW*0.75,ly+AH*0.05,AW*0.4,AH*0.07*(1+l*0.3),22,0.12,rngJ,"rgba(43,39,35,"+layers[l][1]*0.8+")");
  }
  var peakX=lerp(AW*0.25,AW*0.5,rngL());
  poly(ctx,jitter([[peakX-AW*0.30,AH*0.66],[peakX,AH*0.30],[peakX+AW*0.30,AH*0.66]],10,rngJ),"rgba(43,39,35,0.16)");
  strokePoly(ctx,jitter([[peakX-AW*0.30,AH*0.66],[peakX,AH*0.30],[peakX+AW*0.30,AH*0.66]],10,rngJ),"rgba(43,39,35,0.35)",3);
  var bx=AW*0.84, bend=lerp(0.02,0.06,rngL());
  ctx.strokeStyle="rgba(43,39,35,0.8)";
  var segs=4+Math.floor(rngL()*2);
  for(var s=0;s<segs;s++){
    var y0=AH*0.14+s*(AH*0.62/segs), y1=AH*0.14+(s+1)*(AH*0.62/segs);
    var x0=bx+Math.sin(s*bend*10)*10, x1=bx+Math.sin((s+1)*bend*10)*16;
    ctx.lineWidth=lerp(9,5,s/segs);ctx.lineCap="round";
    ctx.beginPath();ctx.moveTo(x0,y0);ctx.quadraticCurveTo((x0+x1)/2+6,(y0+y1)/2,x1,y1);ctx.stroke();
    ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x0-7,y0);ctx.lineTo(x0+7,y0);ctx.stroke();
  }
  var leaves=5+Math.floor(rngL()*4);
  for(var lf=0;lf<leaves;lf++){
    var lx=bx-lerp(10,60,rngJ()), ly2=lerp(AH*0.20,AH*0.62,rngJ());
    var ang=lerp(-2.4,-0.7,rngJ()), len=lerp(52,92,rngJ());
    ctx.save();ctx.translate(lx,ly2);ctx.rotate(ang);
    ctx.fillStyle="rgba(43,39,35,"+lerp(0.55,0.85,rngJ()).toFixed(2)+")";
    ctx.beginPath();ctx.ellipse(len/2,0,len/2,7,0,0,Math.PI*2);ctx.fill();ctx.restore();
  }
  for(var f=0;f<3;f++){
    strokePoly(ctx,[[AW*lerp(0.05,0.2,rngJ()),AH*lerp(0.75,0.9,rngJ())],
      [AW*lerp(0.3,0.5,rngJ()),AH*lerp(0.78,0.94,rngJ())]],"rgba(43,39,35,0.13)",2);
  }
  ctx.fillStyle="#B03A2E";
  var sealS=54, sealX=AW-sealS-28, sealY=28;
  ctx.beginPath();
  if(ctx.roundRect){ctx.roundRect(sealX,sealY,sealS,sealS,8);}else{ctx.rect(sealX,sealY,sealS,sealS);}
  ctx.fill();
  ctx.strokeStyle="#F7F4EC";ctx.lineWidth=4;
  ctx.strokeRect(sealX+12,sealY+12,sealS-24,sealS-24);
  grain(ctx,W,H,rngG,420,["rgba(43,39,35,0.045)"]);
}`,
  /* 剪纸节日：圆月 + 层叠锯齿山 + 灯笼 + 旗串 + 金点 */
  "sk-cutpaper": `
function draw(ctx,W,H,seed,P,wide){
  var rngL=mulberry32(seed),rngJ=mulberry32((seed*31+7)>>>0),rngG=mulberry32((seed*7919+13)>>>0);
  var AW=P.aw||W, AH=P.artH||H;
  ctx.fillStyle="#FBF3E4";ctx.fillRect(0,0,W,H);
  var mx=lerp(AW*0.3,AW*0.55,rngL()), my=AH*0.24, mr=lerp(95,135,rngL());
  ctx.beginPath();ctx.arc(mx,my,mr,0,Math.PI*2);ctx.fillStyle="#E8B84B";ctx.fill();
  ctx.strokeStyle="rgba(200,57,43,0.55)";ctx.lineWidth=6;
  for(var r2=1;r2<=3;r2++){ctx.beginPath();
    ctx.arc(mx,my,mr-r2*16,Math.PI*0.15*r2,Math.PI*(1.7+0.05*r2));ctx.stroke();}
  var bands=[["#E4C46A",0.52],["#D98E32",0.62],["#C8392B",0.72],["#A92C22",0.82],["#7E1F1A",0.92]];
  for(var b=0;b<bands.length;b++){
    var baseY=AH*bands[b][1], col=bands[b][0], pts=[[0,baseY]];
    var n=4+Math.floor(rngL()*3);
    for(var z=0;z<n;z++){
      var zx=(z+0.5)/n*AW;
      pts.push([zx,baseY-lerp(30,80,rngJ())]);
      pts.push([(z+1)/n*AW,baseY]);
    }
    pts.push([AW,H],[0,H]);
    poly(ctx,pts,col);
  }
  var flagY=AH*0.12;
  strokePoly(ctx,[[AW*0.03,flagY],[AW*0.97,flagY-10]],"rgba(200,57,43,0.65)",4);
  var flags=5+Math.floor(rngL()*4);
  for(var f=0;f<flags;f++){
    var fx=lerp(AW*0.06,AW*0.94,rngL());
    var drop=12+Math.sin(f)*8;
    poly(ctx,[[fx-16,flagY+drop],[fx+16,flagY+drop],[fx,flagY+drop+44]],f%2?"#C8392B":"#E8B84B");
  }
  var lanterns=2;
  for(var lt=0;lt<lanterns;lt++){
    var lxx=lerp(AW*0.12,AW*0.85,rngL()), lyy=lerp(AH*0.30,AH*0.44,rngL()), ls=lerp(0.8,1.1,rngL());
    strokePoly(ctx,[[lxx,lyy-58*ls],[lxx,lyy-30*ls]],"#7E1F1A",4);
    ctx.fillStyle="#C8392B";
    ctx.beginPath();ctx.ellipse(lxx,lyy,52*ls,42*ls,0,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle="#E8B84B";ctx.lineWidth=5;
    ctx.beginPath();ctx.ellipse(lxx,lyy,52*ls,42*ls,0,0,Math.PI*2);ctx.stroke();
    ctx.beginPath();ctx.moveTo(lxx-20*ls,lyy-40*ls);ctx.lineTo(lxx+20*ls,lyy-40*ls);ctx.stroke();
    ctx.beginPath();ctx.moveTo(lxx-20*ls,lyy+40*ls);ctx.lineTo(lxx+20*ls,lyy+40*ls);ctx.stroke();
    strokePoly(ctx,[[lxx,lyy+42*ls],[lxx,lyy+42*ls+30*ls]],"#E8B84B",4);
  }
  for(var g=0;g<26;g++){
    var px2=rngG()*AW, py2=rngG()*AH*0.9;
    ctx.fillStyle=rngG()>0.5?"rgba(232,184,75,0.8)":"rgba(200,57,43,0.55)";
    ctx.beginPath();ctx.arc(px2,py2,lerp(3,7,rngG()),0,Math.PI*2);ctx.fill();
  }
}`,
};

/* ------------------------------------------------------------------ CSS */

function fitTitle(text: string, base: number, width = 880, maxLines = 3): number {
  const units = Math.max(1, Array.from(text).length);
  for (const factor of [1, 0.92, 0.85, 0.78, 0.72, 0.66, 0.6]) {
    const size = Math.round(base * factor);
    if (size < 34) break;
    const perLine = Math.max(1, width / size);
    if (units / perLine <= maxLines - 0.2) return size;
  }
  return 34;
}

function sketchCss(style: SketchStyleInfo, width: number, height: number, wide: boolean): string {
  return `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;background:${style.paper}}
body{-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.page{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:${style.paper};
font-family:${style.font}}
.page canvas{position:absolute;left:0;top:0;z-index:1}
.sk-panel{position:absolute;z-index:2;border-radius:26px;background:${style.paper};
box-shadow:0 18px 50px rgba(20,16,10,.12);padding:48px 54px;display:flex;flex-direction:column}
${wide ? ".sk-panel{left:44%;right:56px;top:64px;bottom:64px}" : ".sk-panel{left:84px;right:84px;bottom:80px}"}
.sk-kicker{font-size:24px;letter-spacing:.26em;color:${style.accent};font-weight:700}
.sk-rule{height:3px;background:${style.ink};opacity:.14;margin:18px 0 26px}
.sk-title{font-size:96px;line-height:1.24;font-weight:800;color:${style.ink};letter-spacing:.01em}
.sk-sub{margin-top:26px;font-size:36px;line-height:1.6;color:${style.ink};opacity:.74}
.sk-sec{font-size:48px;font-weight:800;color:${style.ink};line-height:1.3}
.sk-sec small{display:block;margin-top:8px;font-size:24px;letter-spacing:.2em;color:${style.accent};font-weight:700}
.sk-items{flex:1;display:flex;flex-direction:column;justify-content:space-evenly;margin-top:8px}
.sk-item{display:flex;gap:22px;align-items:flex-start;font-size:34px;line-height:1.5;font-weight:600;color:${style.ink}}
.sk-item p{flex:1}
.sk-no{flex:none;min-width:62px;height:62px;border-radius:16px;background:${style.accent};color:#fff;
display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:800}
.sk-big{font-size:72px;line-height:1.4;font-weight:800;color:${style.ink}}
.sk-note{margin-top:26px;font-size:34px;line-height:1.6;color:${style.ink};opacity:.74}
.sk-tags{display:flex;gap:16px;flex-wrap:wrap;margin-top:30px}
.sk-tag{border:2px solid ${style.accent};color:${style.accent};border-radius:999px;
padding:10px 26px;font-size:26px;font-weight:700}
.sk-foot{margin-top:auto;padding-top:26px;display:flex;justify-content:space-between;
font-size:24px;letter-spacing:.14em;color:${style.ink};opacity:.55}
`;
}

/* --------------------------------------------------------------- 页面组装 */

function sketchPanelBody(page: CardPage, style: SketchStyleInfo, seed: number): string {
  const kicker = `<div class="sk-kicker">ECHOQ · ${esc(style.tagline.toUpperCase())}</div><div class="sk-rule"></div>`;
  const foot = `<div class="sk-foot"><span>${esc(style.tagline)} / 手绘插画</span><span>构图 #${seed % 100000}</span></div>`;
  if (page.kind === "cover") {
    const size = fitTitle(page.title, 96);
    return `${kicker}<h1 class="sk-title" style="font-size:${size}px">${esc(page.title)}</h1>` +
      `<div class="sk-sub">${esc(page.subtitle)}</div>${foot}`;
  }
  if (page.kind === "ending") {
    const size = fitTitle(page.subtitle, 68);
    const tags = page.tags
      .slice(0, 3)
      .map((tag) => `<span class="sk-tag">#${esc(tag)}</span>`)
      .join("");
    return `${kicker}<div class="sk-big" style="font-size:${size}px">${esc(page.subtitle)}</div>` +
      `<div class="sk-note">${esc(page.title)}</div><div class="sk-tags">${tags}</div>${foot}`;
  }
  const heading = `${page.sectionIcon} ${page.section}`.trim() || "重点";
  const items = page.items
    .map((item, offset) => {
      const text = item.icon ? `${item.icon} ${item.text}` : item.text;
      return `<div class="sk-item"><b class="sk-no">${String(offset + 1).padStart(2, "0")}</b><p>${esc(text)}</p></div>`;
    })
    .join("");
  return `${kicker}<div class="sk-sec">${esc(heading)}<small>SECTION ${String(Math.max(1, page.index - 1)).padStart(2, "0")}</small></div>` +
    `<div class="sk-items">${items}</div>${foot}`;
}

/**
 * 手绘单页 HTML。canvas 插画层 + 纸色文字面板；种子决定构图。
 * width>height 视为公众号宽幅封面（插画居左、面板居右）。
 */
export function renderSketchDocument(
  page: CardPage,
  styleKey: string,
  seed: number,
  width: number,
  height: number
): string {
  const style = sketchStyleInfo(styleKey);
  const wide = width > height;
  const panelTop = page.kind === "cover" ? 780 : page.kind === "ending" ? 760 : 560;
  const artH = wide ? height : panelTop + 60;
  const drawJs = SKETCH_DRAW[style.key] || SKETCH_DRAW[DEFAULT_SKETCH_STYLE];
  const payload = {
    paper: style.paper,
    ink: style.ink,
    accent: style.accent,
    aw: wide ? Math.round(width * 0.44) : width,
    artH,
  };
  const panelStyle = wide ? "" : ` style="top:${panelTop}px"`;
  const script = `
(function(){
  var cv=document.getElementById("sk-cv");
  if(!cv)return;
  var ctx=cv.getContext("2d");
  ${COMMON_JS}
  ${drawJs}
  var P=${JSON.stringify(payload)};
  try{draw(ctx,cv.width,cv.height,${seed >>> 0},P,${wide ? "true" : "false"});}catch(e){}
})();`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${esc(page.title)} · ${esc(style.key)}</title>
<style>${sketchCss(style, width, height, wide)}</style></head>
<body><main class="page sk ${style.key}">
<canvas id="sk-cv" width="${width}" height="${height}"></canvas>
<div class="sk-panel"${panelStyle}>${sketchPanelBody(page, style, seed)}</div>
<script>${script}</script>
</main></body></html>`;
}
