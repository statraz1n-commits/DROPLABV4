'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {SKINS,INDEX,CASES,RARITIES,chooseDrop,getCaseOdds,getCaseStats}=require('./catalog');

// Tiny .env reader; no runtime dependencies. Environment variables take precedence.
const envPath=path.join(__dirname,'.env');
if(fs.existsSync(envPath)){
 for(const line of fs.readFileSync(envPath,'utf8').split(/\r?\n/)){
  const match=line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/);
  if(match && process.env[match[1]]===undefined)process.env[match[1]]=match[2].trim().replace(/^(['"])(.*)\1$/,'$2');
 }
}
const PORT=Number(process.env.PORT)||3000;
const BASE_URL=(process.env.BASE_URL||`http://localhost:${PORT}`).replace(/\/$/,'');
const ORIGIN=new URL(BASE_URL).origin;
const DB_PATH=path.resolve(__dirname,process.env.DB_PATH||'./data/droplab.sqlite');
const SECURE=BASE_URL.startsWith('https://');
const ADMIN_STEAM_IDS=(process.env.ADMIN_STEAM_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
if(SECURE && (!process.env.SESSION_SECRET||process.env.SESSION_SECRET.startsWith('CHANGE_ME'))){console.warn('WARN: Set SESSION_SECRET in production.');}
fs.mkdirSync(path.dirname(DB_PATH),{recursive:true});
const db=new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL;
 PRAGMA busy_timeout=5000;
 PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS users(
 id TEXT PRIMARY KEY,steam_id TEXT UNIQUE,name TEXT NOT NULL,avatar TEXT NOT NULL DEFAULT '',
 role TEXT NOT NULL DEFAULT 'player',balance INTEGER NOT NULL DEFAULT 1500,
 created_at INTEGER NOT NULL,last_bonus INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS inventory(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id),skin_id TEXT NOT NULL,
 skin_name TEXT NOT NULL,skin_image TEXT NOT NULL DEFAULT '',rarity TEXT NOT NULL,price INTEGER NOT NULL,
 wear TEXT NOT NULL,case_id TEXT NOT NULL,created_at INTEGER NOT NULL,sold_at INTEGER);
 CREATE TABLE IF NOT EXISTS openings(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id),
 display_name TEXT NOT NULL,skin_name TEXT NOT NULL,skin_id TEXT NOT NULL,rarity TEXT NOT NULL,case_id TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS balance_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,admin_id TEXT NOT NULL,target_id TEXT NOT NULL,
 amount INTEGER NOT NULL,before_balance INTEGER NOT NULL,after_balance INTEGER NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS openid_nonces(nonce TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS upgrades(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id),
 source_inventory_id INTEGER NOT NULL,source_skin_id TEXT NOT NULL,source_price INTEGER NOT NULL,
 target_skin_id TEXT NOT NULL,target_price INTEGER NOT NULL,chance REAL NOT NULL,success INTEGER NOT NULL,
 awarded_inventory_id INTEGER,created_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS upgrades_user_idx ON upgrades(user_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS inventory_owner_idx ON inventory(user_id,sold_at,created_at DESC);
 CREATE INDEX IF NOT EXISTS opening_recent_idx ON openings(created_at DESC);
 CREATE INDEX IF NOT EXISTS sessions_exp_idx ON sessions(expires_at);`);
// Automatic, non-destructive migration for existing deployed SQLite databases.
if(!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='favorite_case')){
 db.exec("ALTER TABLE users ADD COLUMN favorite_case TEXT NOT NULL DEFAULT ''");
}
// V3: add coins and free virtual top-up without removing existing accounts.
const userColumns=db.prepare('PRAGMA table_info(users)').all().map(r=>r.name);
if(!userColumns.includes('coins'))db.exec('ALTER TABLE users ADD COLUMN coins INTEGER NOT NULL DEFAULT 0');
if(!userColumns.includes('last_refill'))db.exec('ALTER TABLE users ADD COLUMN last_refill INTEGER NOT NULL DEFAULT 0');
if(!userColumns.includes('coins_earned'))db.exec('ALTER TABLE users ADD COLUMN coins_earned INTEGER NOT NULL DEFAULT 0');
const coinCols=db.prepare('PRAGMA table_info(openings)').all().map(r=>r.name);
if(!coinCols.includes('amount'))db.exec('ALTER TABLE openings ADD COLUMN amount INTEGER NOT NULL DEFAULT 0');
if(!db.prepare('PRAGMA table_info(balance_logs)').all().some(r=>r.name==='currency'))db.exec("ALTER TABLE balance_logs ADD COLUMN currency TEXT NOT NULL DEFAULT 'CR'");
// Older database rows remain valid; new attempts support up to six source skins.
db.exec(`CREATE TABLE IF NOT EXISTS upgrade_sources(upgrade_id INTEGER NOT NULL,inventory_id INTEGER NOT NULL,skin_id TEXT NOT NULL,price INTEGER NOT NULL,PRIMARY KEY(upgrade_id,inventory_id));
CREATE TABLE IF NOT EXISTS virtual_refills(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,amount INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS contracts(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id),source_ids TEXT NOT NULL,source_count INTEGER NOT NULL,source_value INTEGER NOT NULL,skin_id TEXT NOT NULL,prize_value INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS contracts_owner_idx ON contracts(user_id,created_at DESC);`);
const now=()=>Date.now();
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
const cookieNames=(req)=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=')).filter(x=>x.length===2));
const hash=s=>process.env.SESSION_SECRET?crypto.createHmac('sha256',process.env.SESSION_SECRET).update(s).digest('hex'):crypto.createHash('sha256').update(s).digest('hex');
const secret=()=>crypto.randomBytes(32).toString('hex');
const safeStr=(v,max=50)=>String(v||'').replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,max);
const wrap=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
const fromDb=r=>r?{id:r.id,steamId:r.steam_id||null,name:r.name,avatar:r.avatar,role:r.role,balance:r.balance,createdAt:r.created_at,lastBonus:r.last_bonus,favoriteCase:r.favorite_case||'',coins:r.coins||0,coinsEarned:r.coins_earned||0,lastRefill:r.last_refill||0}:null;
function sessionFor(req){
 const token=cookieNames(req).dl_session;
 if(!token||!/^[0-9a-f]{64}$/.test(token))return null;
 const row=db.prepare(`SELECT s.csrf,s.expires_at,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hash(token));
 if(!row||row.expires_at<now())return null;
 return {csrf:row.csrf,user:fromDb(row)};
}
function newSession(res,userId){
 const token=secret(),csrf=secret(),expire=now()+1000*60*60*24*30;
 db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES (?,?,?,?)').run(hash(token),userId,csrf,expire);
 res.setHeader('Set-Cookie',`dl_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${SECURE?'; Secure':''}`);
 return csrf;
}
function logout(req,res){const token=cookieNames(req).dl_session;if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));res.setHeader('Set-Cookie',`dl_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${SECURE?'; Secure':''}`);}
function authed(req,res){const s=sessionFor(req);if(!s){json(res,401,{error:'Войдите в аккаунт, чтобы продолжить'});return null;}return s;}
function checkMutation(req,res,s){
 if(req.headers['x-csrf-token']!==s.csrf){json(res,403,{error:'Сессия устарела. Перезагрузите страницу.'});return false;}
 return true;
}
async function body(req){
 let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>40000)throw Object.assign(new Error('Слишком большой запрос'),{status:413});}
 if(!raw)return {};
 try{return JSON.parse(raw);}catch{throw Object.assign(new Error('Неверный JSON'),{status:400});}
}
const limits=new Map();
function rate(req,key,limit=30,period=60000){
 const forwarded=process.env.RENDER?String(req.headers['x-forwarded-for']||'').split(',')[0].trim():'';
 const ip=(forwarded||req.socket.remoteAddress||'unknown').slice(0,60);
 const k=ip+':'+key;const current=limits.get(k)||{n:0,until:now()+period};
 if(now()>current.until){current.n=0;current.until=now()+period;}
 current.n++;limits.set(k,current);
 return current.n<=limit;
}
const userInfo=id=>fromDb(db.prepare('SELECT * FROM users WHERE id=?').get(id));
const getProfile=id=>{
 const inventory=db.prepare('SELECT * FROM inventory WHERE user_id=? AND sold_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1000').all(id);
 const opens=db.prepare("SELECT COUNT(*) AS n FROM openings WHERE user_id=? AND case_id NOT IN ('upgrader','contract')").get(id).n;
 const total=db.prepare('SELECT COALESCE(SUM(price),0) n FROM inventory WHERE user_id=? AND sold_at IS NULL').get(id).n;
 const allDrops=db.prepare('SELECT COUNT(*) n,COALESCE(SUM(price),0) value FROM inventory WHERE user_id=?').get(id);
 const sold=db.prepare('SELECT COUNT(*) n FROM inventory WHERE user_id=? AND sold_at IS NOT NULL').get(id).n;
 const upgrades=db.prepare('SELECT COUNT(*) n,COALESCE(SUM(success),0) wins FROM upgrades WHERE user_id=?').get(id);
 const contracts=db.prepare('SELECT COUNT(*) n FROM contracts WHERE user_id=?').get(id).n;
 const topCases=db.prepare("SELECT case_id,COUNT(*) n FROM openings WHERE user_id=? AND case_id NOT IN ('upgrader','contract') GROUP BY case_id ORDER BY n DESC,case_id LIMIT 5").all(id);
 const best=db.prepare("SELECT skin_id,skin_name,rarity,price,case_id FROM inventory WHERE user_id=? ORDER BY price DESC LIMIT 1").get(id);
 const u=db.prepare('SELECT coins,coins_earned FROM users WHERE id=?').get(id);
 return {inventory:inventory.map(x=>({id:x.id,skinId:x.skin_id,skinName:x.skin_name,image:INDEX[x.skin_id]?.image||x.skin_image,rarity:x.rarity,price:x.price,wear:x.wear,caseId:x.case_id,createdAt:x.created_at})),stats:{openings:opens,inventoryValue:total,items:inventory.length,upgrades:upgrades.n,upgradeWins:upgrades.wins,contracts,topCases,bestDrop:best||null,totalWon:allDrops.value,totalItems:allDrops.n,sold,coins:u.coins,coinsEarned:u.coins_earned,favoriteCase:topCases[0]?.case_id||'',favoriteOpens:topCases[0]?.n||0}};
};
const publicCases=()=>CASES.map(({drops,...c})=>({...c,coverImage:c.image,dropCount:drops.length,...getCaseStats({...c,drops})}));
const catalogInfo=()=>({cases:publicCases(),skins:SKINS,rarities:RARITIES});
function postLogin(res,user){newSession(res,user.id);json(res,200,{ok:true,user:userInfo(user.id)});}
function assertSameOrigin(req,res){
 const origin=req.headers.origin;
 if(origin&&origin!==ORIGIN){json(res,403,{error:'Недопустимый источник запроса'});return false;}
 return true;
}

// Fetch image URLs only; the catalog and opening logic work if GitHub/CDN is unavailable.
const cacheFile=path.join(path.dirname(DB_PATH),'catalog-image-cache.json');
function applyCache(data){
 if(!data||typeof data!=='object')return;
 for(const s of SKINS)if(typeof data.skins?.[s.id]==='string'&&data.skins[s.id].startsWith('https://'))s.image=data.skins[s.id];
 for(const c of CASES)if(typeof data.cases?.[c.id]==='string'&&data.cases[c.id].startsWith('https://'))c.image=data.cases[c.id];
}
try{if(fs.existsSync(cacheFile))applyCache(JSON.parse(fs.readFileSync(cacheFile,'utf8')));}catch(e){console.warn('Catalog cache:',e.message);}
const normalize=n=>String(n||'').toLowerCase().replace(/^[★*]\s*/,'').replace(/['’]/g,"'").replace(/\s+/g,' ').trim();
async function refreshImages(){
 try{
  const base='https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en';
  const r=await fetch(base+'/skins.json',{signal:AbortSignal.timeout(25000)});
  if(!r.ok)throw new Error('HTTP '+r.status);
  const rows=await r.json();const byName=new Map();
  for(const s of rows)if(s.name&&s.image)byName.set(normalize(s.name),s.image);
  let count=0;
  for(const s of SKINS){
   const direct=byName.get(normalize(s.name));
   if(direct){s.image=direct;count++;}
  }
  try{
   const cr=await fetch(base+'/crates.json',{signal:AbortSignal.timeout(22000)});
   if(cr.ok){const crates=await cr.json();for(const c of CASES)if(c.coverKey){const found=crates.find(x=>x.name===c.coverKey);if(found?.image)c.image=found.image;}}
  }catch(e){console.warn('Crate art:',e.message);}
  fs.writeFileSync(cacheFile,JSON.stringify({skins:Object.fromEntries(SKINS.map(s=>[s.id,s.image])),cases:Object.fromEntries(CASES.map(c=>[c.id,c.image]))}));
  console.log(`CS2 images loaded: ${count}/${SKINS.length}`);
 }catch(e){console.warn('CS2 image service unavailable; using visual placeholders:',e.message);}
}
refreshImages();

async function steamAuth(req,res,url){
 const callback=`${BASE_URL}/auth/steam/callback`;
 if(url.pathname==='/auth/steam'){
  const p=new URLSearchParams({
   'openid.ns':'http://specs.openid.net/auth/2.0',
   'openid.mode':'checkid_setup',
   'openid.return_to':callback,
   'openid.realm':`${ORIGIN}/`,
   'openid.identity':'http://specs.openid.net/auth/2.0/identifier_select',
   'openid.claimed_id':'http://specs.openid.net/auth/2.0/identifier_select'
  });
  res.writeHead(302,{Location:'https://steamcommunity.com/openid/login?'+p});return res.end();
 }
 const p=Object.fromEntries(url.searchParams.entries());
 const claimed=p['openid.claimed_id']||'';
 const identity=p['openid.identity']||'';
 const match=claimed.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
 const ret=p['openid.return_to'];
 const endpoint=p['openid.op_endpoint'];
 if(p['openid.mode']!=='id_res'||!match||identity!==claimed||ret!==callback||
  !['https://steamcommunity.com/openid/login','https://steamcommunity.com/openid/login/'].includes(endpoint)||
  !p['openid.sig']||!p['openid.signed']||!p['openid.response_nonce']){
  res.writeHead(302,{Location:'/?auth=invalid'});return res.end();
 }
 try{
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(p))if(key.startsWith('openid.'))params.append(key,value);
  params.set('openid.mode','check_authentication');
  const result=await fetch('https://steamcommunity.com/openid/login',{method:'POST',body:params,headers:{'Content-Type':'application/x-www-form-urlencoded'},signal:AbortSignal.timeout(12000)});
  const check=await result.text();
  if(!result.ok||!/(^|\n)is_valid:true(\n|$)/.test(check))throw new Error('OpenID not verified');
  const nonce=p['openid.response_nonce'];
  try{db.prepare('INSERT INTO openid_nonces(nonce,created_at) VALUES (?,?)').run(nonce,now());}
  catch{throw new Error('Replayed Steam response');}
  const steamId=match[1];let name='Steam #'+steamId.slice(-6),avatar='';
  if(process.env.STEAM_WEB_API_KEY){
   try{const u=`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(process.env.STEAM_WEB_API_KEY)}&steamids=${steamId}`;
    const r=await fetch(u,{signal:AbortSignal.timeout(4500)});const profile=(await r.json()).response?.players?.[0];
    if(profile){name=safeStr(profile.personaname,40)||name;avatar=profile.avatarfull||'';}}
   catch(e){console.warn('Steam profile unavailable',e.message);}
  }
  const id='steam:'+steamId;
  const role=ADMIN_STEAM_IDS.includes(steamId)?'admin':'player';
  db.prepare(`INSERT INTO users(id,steam_id,name,avatar,role,balance,created_at) VALUES(?,?,?,?,?,1500,?)
   ON CONFLICT(id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,role=excluded.role`).run(id,steamId,name,avatar,role,now());
  newSession(res,id);res.writeHead(302,{Location:'/'});res.end();
 }catch(e){console.error('Steam auth failed:',e.message);res.writeHead(302,{Location:'/?auth=failed'});res.end();}
}

async function api(req,res,url){
 const pathname=url.pathname,method=req.method;
 if(method==='GET'&&pathname==='/api/bootstrap'){
  const s=sessionFor(req);
  const recent=db.prepare('SELECT display_name,skin_id,skin_name,rarity,case_id,created_at FROM openings ORDER BY id DESC LIMIT 35').all().map(x=>({...x,image:INDEX[x.skin_id]?.image||''}));
  return json(res,200,{...catalogInfo(),user:s?.user||null,csrf:s?.csrf||null,recent,totals:{opens:db.prepare("SELECT COUNT(*) n FROM openings WHERE case_id NOT IN ('upgrader','contract')").get().n,players:db.prepare('SELECT COUNT(*) n FROM users').get().n}});
 }
 if(method==='GET'&&pathname==='/api/profile'){
  const s=authed(req,res);if(!s)return;
  return json(res,200,{user:s.user,...getProfile(s.user.id)});
 }
 if(method==='GET'&&pathname.startsWith('/api/cases/')){
  const c=CASES.find(x=>x.id===pathname.split('/')[3]);if(!c)return json(res,404,{error:'Кейс не найден'});
  return json(res,200,{...publicCases().find(x=>x.id===c.id),items:getCaseOdds(c)});
 }
 if(method==='GET'&&pathname==='/api/feed'){
  const recent=db.prepare('SELECT display_name,skin_id,skin_name,rarity,case_id,created_at FROM openings ORDER BY id DESC LIMIT 40').all().map(x=>({...x,image:INDEX[x.skin_id]?.image||''}));
  return json(res,200,{recent});
 }
 if(method==='GET'&&pathname==='/api/leaderboard'){
  const rows=db.prepare('SELECT id,name,avatar,balance FROM users WHERE role!=\'admin\' ORDER BY balance DESC LIMIT 10').all();
  return json(res,200,{players:rows.map(x=>({id:x.id,name:x.name,avatar:x.avatar,balance:x.balance}))});
 }
 if(method==='POST'&&pathname==='/api/auth/guest'){
  if(!rate(req,'guest',12,3600000))return json(res,429,{error:'Слишком много попыток. Попробуйте позже.'});
  const id='guest:'+crypto.randomUUID(),name='Игрок '+crypto.randomInt(1000,9999);
  db.prepare('INSERT INTO users(id,name,balance,created_at) VALUES(?,?,1500,?)').run(id,name,now());
  return postLogin(res,{id});
 }
 if(method==='POST'&&pathname==='/api/auth/admin'){
  if(!rate(req,'admin',6,900000))return json(res,429,{error:'Лимит попыток входа. Попробуйте позже.'});
  const {username,password}=await body(req);
  const adminName=process.env.ADMIN_USERNAME||'xtc',adminPass=process.env.ADMIN_PASSWORD;
  if(!adminName||!adminPass||['CHOOSE_YOUR_OWN_STRONG_PASSWORD','SET_YOUR_PASSWORD_IN_RENDER_ENV'].includes(adminPass))return json(res,403,{error:'Вход администратора не настроен. Задайте ADMIN_USERNAME и ADMIN_PASSWORD на сервере.'});
  const a=Buffer.from(hash(String(password||'')),'hex'),b=Buffer.from(hash(adminPass),'hex');
  if(username!==adminName||!crypto.timingSafeEqual(a,b))return json(res,401,{error:'Неверный логин или пароль'});
  const id='admin:local';
  db.prepare(`INSERT INTO users(id,name,role,balance,created_at) VALUES(?,?,'admin',999999,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role='admin'`).run(id,'Администратор',now());
  return postLogin(res,{id});
 }
 const s=authed(req,res);if(!s)return;
 if(method==='POST'&&!checkMutation(req,res,s))return;
 if(method==='POST'&&pathname==='/api/auth/logout'){logout(req,res);return json(res,200,{ok:true});}
 if(method==='POST'&&pathname==='/api/cases/open'){
  if(!rate(req,'open',100,60000))return json(res,429,{error:'Слишком много открытий за минуту'});
  const payload=await body(req),c=CASES.find(x=>x.id===payload.caseId);
  if(!c)return json(res,404,{error:'Кейс не найден'});
  const count=payload.count==='max'?null:Number(payload.count??1);
  if(count!==null&&(!Number.isSafeInteger(count)||count<1||count>9))return json(res,400,{error:'От 1 до 9 кейсов за раз'});
  const result=wrap(()=>{
   const u=db.prepare('SELECT balance,coins,name FROM users WHERE id=?').get(s.user.id);
   const currency=c.currency==='COIN'?'coins':'balance';
   const afford=Math.floor(u[currency]/c.price);
   const quantity=count===null?Math.min(9,afford):count;
   if(quantity<1||quantity>9||u[currency]<quantity*c.price)throw Object.assign(new Error('Недостаточно '+(currency==='coins'?'монет':'CR')+' для открытия'),{status:400});
   const earned=c.currency==='COIN'?0:Math.max(1,Math.floor(c.price/40))*quantity;
   if(currency==='coins')db.prepare('UPDATE users SET coins=coins-? WHERE id=?').run(quantity*c.price,s.user.id);
   else db.prepare('UPDATE users SET balance=balance-?,coins=coins+?,coins_earned=coins_earned+? WHERE id=?').run(quantity*c.price,earned,earned,s.user.id);
   const ts=now(),items=[];
   const inventoryInsert=db.prepare('INSERT INTO inventory(user_id,skin_id,skin_name,skin_image,rarity,price,wear,case_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
   const openingInsert=db.prepare('INSERT INTO openings(user_id,display_name,skin_id,skin_name,rarity,case_id,created_at,amount) VALUES (?,?,?,?,?,?,?,?)');
   for(let i=0;i<quantity;i++){
    const d=chooseDrop(c),wear=['Прямо с завода','Немного поношенное','После полевых испытаний','Поношенное','Закалённое в боях'][crypto.randomInt(5)];
    const ins=inventoryInsert.run(s.user.id,d.id,d.name,d.image,d.rarity,d.price,wear,c.id,ts+i);
    openingInsert.run(s.user.id,u.name,d.id,d.name,d.rarity,c.id,ts+i,d.price);
    items.push({...d,wear,inventoryId:Number(ins.lastInsertRowid)});
   }
   const latest=db.prepare('SELECT balance,coins,coins_earned FROM users WHERE id=?').get(s.user.id);
   return {items,item:items[0],count:quantity,spent:quantity*c.price,coinsEarned:earned,...latest,currency:c.currency||'CR'};
  });
  // The animation's predetermined visual landing position is not a second random draw.
  const hitIndex=27;
  const reels=result.items.map(item=>{const line=Array.from({length:36},()=>chooseDrop(c).id);line[hitIndex]=item.id;return line;});
  return json(res,200,{...result,reel:reels[0],reels,hitIndex});
 }
 if(method==='POST'&&pathname==='/api/profile/favorite'){
  const p=await body(req),favorite=String(p.caseId||'');
  if(favorite&&!CASES.some(c=>c.id===favorite))return json(res,400,{error:'Кейс не найден'});
  db.prepare('UPDATE users SET favorite_case=? WHERE id=?').run(favorite,s.user.id);
  return json(res,200,{ok:true,favoriteCase:favorite});
 }
 if(method==='POST'&&pathname==='/api/upgrade/attempt'){
  if(!rate(req,'upgrade',35,60000))return json(res,429,{error:'Слишком много попыток апгрейда'});
  const p=await body(req),ids=p.inventoryIds??[p.inventoryId],targetId=String(p.targetSkinId||''),credit=Number(p.addBalance||0);
  if(!Array.isArray(ids)||ids.length<1||ids.length>6||ids.some(id=>!Number.isSafeInteger(Number(id))||Number(id)<1)||new Set(ids.map(Number)).size!==ids.length||!INDEX[targetId]||!Number.isSafeInteger(credit)||credit<0||credit>1000000)
    return json(res,400,{error:'Выбери от 1 до 6 предметов, цель и допустимый баланс'});
  const result=wrap(()=>{
   const selected=ids.map(id=>db.prepare('SELECT * FROM inventory WHERE id=? AND user_id=? AND sold_at IS NULL').get(Number(id),s.user.id));
   if(selected.some(x=>!x))throw Object.assign(new Error('Один из исходных предметов уже использован'),{status:404});
   const target=INDEX[targetId],sourceSum=selected.reduce((sum,x)=>sum+x.price,0),value=sourceSum+credit;
   const balance=db.prepare('SELECT balance,coins FROM users WHERE id=?').get(s.user.id);
   if(credit>balance.balance)throw Object.assign(new Error('Недостаточно CR для добавления к апгрейду'),{status:400});
   if(target.price<=value)throw Object.assign(new Error('Цель должна стоить больше суммы предметов и CR'),{status:400});
   const chance=Math.max(.001,Math.min(75,Math.round(value/target.price*85*1000)/1000));
   const success=crypto.randomInt(10000000)<Math.round(chance*100000);
   const ts=now();
   for(const id of ids)db.prepare('UPDATE inventory SET sold_at=? WHERE id=? AND user_id=? AND sold_at IS NULL').run(ts,Number(id),s.user.id);
   db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(credit,s.user.id);
   let prize=null,awardedId=null,earned=0;
   if(success){
    const wear=['Прямо с завода','Немного поношенное','После полевых испытаний','Поношенное','Закалённое в боях'][crypto.randomInt(5)];
    const ins=db.prepare('INSERT INTO inventory(user_id,skin_id,skin_name,skin_image,rarity,price,wear,case_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(s.user.id,target.id,target.name,target.image,target.rarity,target.price,wear,'upgrader',ts);
    awardedId=Number(ins.lastInsertRowid);prize={...target,wear,inventoryId:awardedId};
    const name=db.prepare('SELECT name FROM users WHERE id=?').get(s.user.id).name;
    db.prepare('INSERT INTO openings(user_id,display_name,skin_id,skin_name,rarity,case_id,created_at,amount) VALUES (?,?,?,?,?,?,?,?)').run(s.user.id,name,target.id,target.name,target.rarity,'upgrader',ts,target.price);
    earned=Math.max(3,Math.floor(value/40));
    db.prepare('UPDATE users SET coins=coins+?,coins_earned=coins_earned+? WHERE id=?').run(earned,earned,s.user.id);
   }
   const ins=db.prepare('INSERT INTO upgrades(user_id,source_inventory_id,source_skin_id,source_price,target_skin_id,target_price,chance,success,awarded_inventory_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(s.user.id,Number(ids[0]),selected[0].skin_id,value,target.id,target.price,chance,success?1:0,awardedId,ts);
   const upgradeId=Number(ins.lastInsertRowid);
   for(const src of selected)db.prepare('INSERT INTO upgrade_sources(upgrade_id,inventory_id,skin_id,price) VALUES(?,?,?,?)').run(upgradeId,src.id,src.skin_id,src.price);
   const balances=db.prepare('SELECT balance,coins,coins_earned FROM users WHERE id=?').get(s.user.id);
   return {success,chance,item:prize,source:{id:selected[0].skin_id,name:selected.length===1?selected[0].skin_name:`${selected.length} предметов`,price:value},target,upgradeId,coinsEarned:earned,...balances};
  });
  return json(res,200,result);
 }
 if(method==='POST'&&pathname==='/api/contracts/create'){
  if(!rate(req,'contract',30,60000))return json(res,429,{error:'Слишком много контрактов за минуту'});
  const p=await body(req),ids=p.inventoryIds;
  if(!Array.isArray(ids)||ids.length<3||ids.length>10||ids.some(x=>!Number.isSafeInteger(x)||x<=0)||new Set(ids).size!==ids.length)
   return json(res,400,{error:'Для контракта выбери от 3 до 10 разных предметов'});
  const result=wrap(()=>{
   const selected=ids.map(id=>db.prepare('SELECT * FROM inventory WHERE id=? AND user_id=? AND sold_at IS NULL').get(id,s.user.id));
   if(selected.some(x=>!x))throw Object.assign(new Error('Один из предметов уже использован или не принадлежит тебе'),{status:404});
   const sourceValue=selected.reduce((sum,x)=>sum+x.price,0);
   if(sourceValue>20000)throw Object.assign(new Error('Максимальная стоимость контракта — 20 000 CR'),{status:400});
   const wins=SKINS.filter(x=>x.price>=Math.ceil(sourceValue*1.02)&&x.price<=Math.ceil(sourceValue*1.6));
   const losses=SKINS.filter(x=>x.price>=Math.ceil(sourceValue*.45)&&x.price<=Math.floor(sourceValue*.98));
   const profitable=crypto.randomInt(10000)<2000;
   let available=profitable&&wins.length?wins:losses.length?losses:wins;
   if(!available.length)available=SKINS.filter(x=>x.price>=Math.ceil(sourceValue*.45)).sort((a,b)=>Math.abs(a.price-sourceValue*.8)-Math.abs(b.price-sourceValue*.8)).slice(0,7);
   if(!available.length)throw Object.assign(new Error('Для этой суммы нет подходящего предмета'),{status:400});
   // A seeded selection happens only on the server, independently of the animation.
   const prize=available[crypto.randomInt(available.length)];
   const ts=now();
   for(const id of ids)db.prepare('UPDATE inventory SET sold_at=? WHERE id=? AND user_id=? AND sold_at IS NULL').run(ts,id,s.user.id);
   const wear=['Прямо с завода','Немного поношенное','После полевых испытаний','Поношенное','Закалённое в боях'][crypto.randomInt(5)];
   const inserted=db.prepare('INSERT INTO inventory(user_id,skin_id,skin_name,skin_image,rarity,price,wear,case_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(s.user.id,prize.id,prize.name,prize.image,prize.rarity,prize.price,wear,'contract',ts);
   db.prepare('INSERT INTO contracts(user_id,source_ids,source_count,source_value,skin_id,prize_value,created_at) VALUES(?,?,?,?,?,?,?)').run(s.user.id,JSON.stringify(ids),ids.length,sourceValue,prize.id,prize.price,ts);
   const name=db.prepare('SELECT name FROM users WHERE id=?').get(s.user.id).name;
   db.prepare('INSERT INTO openings(user_id,display_name,skin_id,skin_name,rarity,case_id,created_at,amount) VALUES(?,?,?,?,?,?,?,?)').run(s.user.id,name,prize.id,prize.name,prize.rarity,'contract',ts,prize.price);
   return {ok:true,sourceCount:ids.length,sourceValue,item:{...prize,inventoryId:Number(inserted.lastInsertRowid),wear},contractChance:20};
  });return json(res,200,result);
 }
 if(method==='POST'&&pathname==='/api/wallet/refill'){
  if(!rate(req,'refill',8,60000))return json(res,429,{error:'Слишком много запросов'});
  const result=wrap(()=>{
   const u=db.prepare('SELECT balance,last_refill FROM users WHERE id=?').get(s.user.id);
   if(now()-u.last_refill<12*60*60*1000)throw Object.assign(new Error('Пополнение доступно раз в 12 часов'),{status:400});
   if(u.balance>1500)throw Object.assign(new Error('Бесплатный запас CR доступен при балансе до 1 500'),{status:400});
   const amount=1000,ts=now();
   db.prepare('UPDATE users SET balance=balance+?,last_refill=? WHERE id=?').run(amount,ts,s.user.id);
   db.prepare('INSERT INTO virtual_refills(user_id,amount,created_at) VALUES (?,?,?)').run(s.user.id,amount,ts);
   return {balance:u.balance+amount,lastRefill:ts,amount,nextAt:ts+12*60*60*1000};
  });return json(res,200,result);
 }
 if(method==='POST'&&pathname==='/api/bonus/claim'){
  const result=wrap(()=>{
   const u=db.prepare('SELECT balance,last_bonus FROM users WHERE id=?').get(s.user.id);
   const delay=24*60*60*1000;
   if(now()-u.last_bonus<delay)throw Object.assign(new Error('Бонус будет доступен позже'),{status:400});
   db.prepare('UPDATE users SET balance=balance+200,last_bonus=? WHERE id=?').run(now(),s.user.id);
   return {balance:u.balance+200,nextAt:now()+delay};
  });return json(res,200,result);
 }
 if(method==='POST'&&/^\/api\/inventory\/\d+\/sell$/.test(pathname)){
  const itemId=Number(pathname.split('/')[3]);
  const result=wrap(()=>{
   const item=db.prepare('SELECT * FROM inventory WHERE id=? AND user_id=? AND sold_at IS NULL').get(itemId,s.user.id);
   if(!item)throw Object.assign(new Error('Предмет не найден или уже продан'),{status:404});
   db.prepare('UPDATE inventory SET sold_at=? WHERE id=?').run(now(),itemId);
   db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(item.price,s.user.id);
   return {earned:item.price,balance:db.prepare('SELECT balance FROM users WHERE id=?').get(s.user.id).balance};
  });return json(res,200,result);
 }
 if(method==='POST'&&pathname==='/api/inventory/sell-all'){
  const result=wrap(()=>{
   const sum=db.prepare('SELECT COALESCE(SUM(price),0) n,COUNT(*) count FROM inventory WHERE user_id=? AND sold_at IS NULL').get(s.user.id);
   db.prepare('UPDATE inventory SET sold_at=? WHERE user_id=? AND sold_at IS NULL').run(now(),s.user.id);
   db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(sum.n,s.user.id);
   return {earned:sum.n,count:sum.count,balance:db.prepare('SELECT balance FROM users WHERE id=?').get(s.user.id).balance};
  });return json(res,200,result);
 }
 if(pathname.startsWith('/api/admin/')){
  if(s.user.role!=='admin')return json(res,403,{error:'Только для администратора'});
  if(method==='GET'&&pathname==='/api/admin/users'){
   const q=safeStr(url.searchParams.get('q')||'',60);
   const users=db.prepare('SELECT id,steam_id,name,role,balance,coins,created_at FROM users WHERE name LIKE ? OR id LIKE ? OR steam_id LIKE ? ORDER BY created_at DESC LIMIT 80').all(...Array(3).fill('%'+q+'%'));
   return json(res,200,{users:users.map(x=>({id:x.id,steamId:x.steam_id,name:x.name,role:x.role,balance:x.balance,coins:x.coins,createdAt:x.created_at}))});
  }
  if(method==='GET'&&pathname==='/api/admin/logs'){
   return json(res,200,{logs:db.prepare('SELECT * FROM balance_logs ORDER BY id DESC LIMIT 40').all()});
  }
  if(method==='POST'&&pathname==='/api/admin/balance'){
   const p=await body(req),target=String(p.userId||''),amount=Number(p.amount),mode=p.mode,currency=p.currency==='COIN'?'coins':'balance';
   if(!['add','set'].includes(mode)||!Number.isSafeInteger(amount)||Math.abs(amount)>1000000||
     (mode==='set'&&amount<0))return json(res,400,{error:'Проверьте сумму и режим начисления'});
   const result=wrap(()=>{
    const user=db.prepare('SELECT id,balance,coins FROM users WHERE id=?').get(target);
    if(!user)throw Object.assign(new Error('Игрок не найден'),{status:404});
    const before=user[currency],after=mode==='set'?amount:before+amount;
    if(after<0||after>100000000)throw Object.assign(new Error('Баланс должен быть от 0 до 100 млн.'),{status:400});
    db.prepare(`UPDATE users SET ${currency}=? WHERE id=?`).run(after,target);
    db.prepare('INSERT INTO balance_logs(admin_id,target_id,amount,before_balance,after_balance,created_at,currency) VALUES (?,?,?,?,?,?,?)').run(s.user.id,target,after-before,before,after,now(),currency==='coins'?'COIN':'CR');
    return {balance:after,userId:target,currency:currency==='coins'?'COIN':'CR'};
   });return json(res,200,result);
  }
 }
 return json(res,404,{error:'Маршрут не найден'});
}
const staticRoot=path.join(__dirname,'public');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webp':'image/webp'};
function sendStatic(req,res,url){
 let filename;
 try{filename=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);}catch{return json(res,400,{error:'Неверный путь'});}
 const target=path.resolve(staticRoot,'.'+filename);
 if(!target.startsWith(staticRoot+path.sep))return json(res,403,{error:'Недопустимый путь'});
 fs.stat(target,(err,stat)=>{
  if(err||!stat.isFile())return json(res,404,{error:'Страница не найдена'});
  res.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream','Cache-Control':'public, max-age=180'});
  fs.createReadStream(target).pipe(res);
 });
}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
 res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://steamcommunity.com");
 let url;try{url=new URL(req.url,BASE_URL);}catch{return json(res,400,{error:'Неверный URL'});}
 if(req.method==='OPTIONS'){res.writeHead(405);return res.end();}
 if(!['GET','POST'].includes(req.method))return json(res,405,{error:'Метод не поддерживается'});
 if(req.method==='POST'&&!assertSameOrigin(req,res))return;
 try{
  if(url.pathname==='/auth/steam'||url.pathname==='/auth/steam/callback'){
   if(req.method!=='GET')return json(res,405,{error:'Метод не поддерживается'});
   return await steamAuth(req,res,url);
  }
  if(url.pathname.startsWith('/api/'))return await api(req,res,url);
  if(req.method==='GET')return sendStatic(req,res,url);
  return json(res,405,{error:'Метод не поддерживается'});
 }catch(e){console.error('Request error:',e);return json(res,e.status||500,{error:e.status?e.message:'Ошибка сервера. Попробуйте снова.'});}
});
server.listen(PORT,'0.0.0.0',()=>{console.log(`DROPLAB running at ${BASE_URL} | DB ${DB_PATH}`);});
setInterval(()=>{
 const cutoff=now()-1000*60*60*24*7;
 db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now());
 db.prepare('DELETE FROM openid_nonces WHERE created_at<?').run(cutoff);
 for(const [k,v] of limits)if(v.until<now())limits.delete(k);
},60000).unref();
