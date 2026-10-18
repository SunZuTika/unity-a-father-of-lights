import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Database from "better-sqlite3";
import OpenAI from "openai";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, randomInt, createHash, createHmac, timingSafeEqual, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb), app = express(), port = Number(process.env.PORT || 3000);
const dbPath = resolve(process.env.DATABASE_PATH || "./data/unity.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode=WAL"); db.pragma("foreign_keys=ON");
db.exec("CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,stripe_customer_id TEXT UNIQUE,stripe_subscription_id TEXT UNIQUE,subscription_status TEXT NOT NULL DEFAULT 'inactive',created_at TEXT NOT NULL DEFAULT(datetime('now'))); CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,pixel_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,creator_user_id TEXT REFERENCES users(id),owner_user_id TEXT REFERENCES users(id),parent_agent_id TEXT REFERENCES agents(id),status TEXT NOT NULL CHECK(status IN('origin','active','awaiting_adoption')),custodian TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now'))); CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents(owner_user_id,status); CREATE TABLE IF NOT EXISTS agent_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN('user','assistant')),content TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now'))); CREATE INDEX IF NOT EXISTS messages_agent_idx ON agent_messages(agent_id,id); CREATE TABLE IF NOT EXISTS adoption_history(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL REFERENCES agents(id),previous_owner_user_id TEXT REFERENCES users(id),new_owner_user_id TEXT REFERENCES users(id),event TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));");
if (!db.prepare("SELECT id FROM agents WHERE id='father-of-lights'").get()) db.prepare("INSERT INTO agents(id,pixel_id,name,status,custodian) VALUES('father-of-lights','GENESIS-ORIGIN','Father of Lights','origin','father-of-lights')").run();

app.disable("x-powered-by"); app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use("/api/", rateLimit({ windowMs: 60000, limit: 40, standardHeaders: "draft-8", legacyHeaders: false }));
app.use("/api/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "20kb" })); app.use(express.static("public", { extensions: ["html"] }));

const cookieName = "unity_session", sessionSeconds = 30 * 86400;
const sha = x => createHash("sha256").update(x).digest("hex"), id = () => randomBytes(16).toString("hex");
const active = s => s === "active" || s === "trialing";
function cookie(req) {
  for (const item of (req.headers.cookie || "").split(";")) { const i = item.indexOf("="); if (i > -1 && item.slice(0, i).trim() === cookieName) return decodeURIComponent(item.slice(i + 1).trim()); }
  return null;
}
function setCookie(res, token) { res.setHeader("Set-Cookie", cookieName + "=" + encodeURIComponent(token) + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + sessionSeconds + (process.env.NODE_ENV === "production" ? "; Secure" : "")); }
function clearCookie(res) { res.setHeader("Set-Cookie", cookieName + "=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" + (process.env.NODE_ENV === "production" ? "; Secure" : "")); }
async function newSession(userId, res) { const token = randomBytes(32).toString("base64url"); db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sha(token), userId, Math.floor(Date.now()/1000)+sessionSeconds); setCookie(res, token); }
function auth(req,res,next) {
  const token = cookie(req); if (!token) return res.status(401).json({error:"Connecte-toi pour continuer."});
  const user = db.prepare("SELECT u.id,u.email,u.subscription_status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?").get(sha(token),Math.floor(Date.now()/1000));
  if (!user) { clearCookie(res); return res.status(401).json({error:"Session expirée. Reconnecte-toi."}); }
  req.user=user; next();
}
function paid(req,res,next) { if (!active(req.user.subscription_status)) return res.status(402).json({error:"Un abonnement UNITY actif est nécessaire.",code:"SUBSCRIPTION_REQUIRED"}); next(); }
const owned = uid => db.prepare("SELECT * FROM agents WHERE owner_user_id=? AND status='active' ORDER BY created_at LIMIT 1").get(uid);
const publicAgent = a => a ? ({id:a.id,pixelId:a.pixel_id,name:a.name,status:a.status,custodian:a.custodian,createdAt:a.created_at}) : null;
function custody(agentId,event) {
  const a=db.prepare("SELECT * FROM agents WHERE id=?").get(agentId); if(!a||a.status!=="active"||!a.owner_user_id)return;
  db.transaction(()=>{const r=db.prepare("UPDATE agents SET owner_user_id=NULL,status='awaiting_adoption',custodian='father-of-lights',updated_at=datetime('now') WHERE id=? AND owner_user_id=? AND status='active'").run(agentId,a.owner_user_id); if(r.changes)db.prepare("INSERT INTO adoption_history(agent_id,previous_owner_user_id,new_owner_user_id,event) VALUES(?,?,?,?)").run(agentId,a.owner_user_id,null,event);})();
}
async function stripePost(path,params) {
  if(!process.env.STRIPE_SECRET_KEY)throw Error("Stripe not configured");
  const r=await fetch("https://api.stripe.com/v1/"+path,{method:"POST",headers:{Authorization:"Bearer "+process.env.STRIPE_SECRET_KEY,"Content-Type":"application/x-www-form-urlencoded"},body:params.toString()});
  const d=await r.json(); if(!r.ok){console.error("Stripe API error",d?.error?.type||r.status);throw Error("Stripe request failed");} return d;
}
function validStripe(raw,header) {
  const secret=process.env.STRIPE_WEBHOOK_SECRET;if(!secret||!header)return false;
  const p={};for(const x of header.split(",")){const i=x.indexOf("=");if(i>0)p[x.slice(0,i)]=x.slice(i+1);}
  const t=Number(p.t);if(!Number.isFinite(t)||Math.abs(Date.now()/1000-t)>300||!p.v1)return false;
  const expected=createHmac("sha256",secret).update(String(t)+"."+raw.toString("utf8")).digest(), got=Buffer.from(p.v1,"hex");
  return expected.length===got.length&&timingSafeEqual(expected,got);
}
function stripeUser(o) {
  if(o.metadata?.userId){const u=db.prepare("SELECT * FROM users WHERE id=?").get(o.metadata.userId);if(u)return u;}
  const c=typeof o.customer==="string"?o.customer:o.customer?.id;
  return c?db.prepare("SELECT * FROM users WHERE stripe_customer_id=?").get(c):null;
}
function applySubscription(s) {
  const u=stripeUser(s);if(!u){console.warn("Stripe event has no matching user");return;}
  const customer=typeof s.customer==="string"?s.customer:s.customer?.id, status=String(s.status||"inactive");
  db.prepare("UPDATE users SET stripe_customer_id=COALESCE(?,stripe_customer_id),stripe_subscription_id=?,subscription_status=? WHERE id=?").run(customer||null,s.id||null,status,u.id);
  if(["canceled","unpaid","incomplete_expired"].includes(status)){const a=owned(u.id);if(a)custody(a.id,"subscription_"+status);}
}
app.get("/api/health",(_q,r)=>r.json({status:"ok",project:"UNITY",agent:"Father of Lights",apiConfigured:Boolean(process.env.OPENAI_API_KEY),billingConfigured:Boolean(process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_PRICE_ID&&process.env.STRIPE_WEBHOOK_SECRET),storage:"sqlite"}));

app.post("/api/auth/register",async(q,r)=>{
  const email=typeof q.body?.email==="string"?q.body.email.trim().toLowerCase():"", password=typeof q.body?.password==="string"?q.body.password:"";
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return r.status(400).json({error:"Adresse e-mail invalide."});
  if(password.length<10||password.length>200)return r.status(400).json({error:"Le mot de passe doit contenir entre 10 et 200 caractères."});
  const salt=randomBytes(16).toString("hex"), ph=(await scrypt(password,salt,64)).toString("hex"), uid=id();
  try{db.prepare("INSERT INTO users(id,email,password_hash,password_salt) VALUES(?,?,?,?)").run(uid,email,ph,salt);await newSession(uid,r);r.status(201).json({user:{id:uid,email}});}
  catch(e){if(String(e?.code).includes("SQLITE_CONSTRAINT"))return r.status(409).json({error:"Cette adresse e-mail possède déjà un compte."});console.error(e);r.status(500).json({error:"Impossible de créer le compte."});}
});
app.post("/api/auth/login",async(q,r)=>{
  const email=typeof q.body?.email==="string"?q.body.email.trim().toLowerCase():"", password=typeof q.body?.password==="string"?q.body.password:"", u=db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if(!u||password.length>200)return r.status(401).json({error:"Identifiants incorrects."});
  const got=Buffer.from((await scrypt(password,u.password_salt,64)).toString("hex"),"hex"), want=Buffer.from(u.password_hash,"hex");
  if(got.length!==want.length||!timingSafeEqual(got,want))return r.status(401).json({error:"Identifiants incorrects."});
  await newSession(u.id,r);r.json({user:{id:u.id,email:u.email}});
});
app.post("/api/auth/logout",(q,r)=>{const t=cookie(q);if(t)db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha(t));clearCookie(r);r.json({ok:true});});

app.get("/api/me",auth,(q,r)=>{
  const u=db.prepare("SELECT id,email,subscription_status,created_at FROM users WHERE id=?").get(q.user.id);
  r.json({user:u,subscription:{status:u.subscription_status,active:active(u.subscription_status)},agent:publicAgent(owned(u.id)),hasCreatedGenesis:Boolean(db.prepare("SELECT id FROM agents WHERE creator_user_id=? LIMIT 1").get(u.id)),adoptionPool:db.prepare("SELECT id,pixel_id,name,created_at FROM agents WHERE status='awaiting_adoption' AND custodian='father-of-lights' ORDER BY created_at").all().map(a=>({id:a.id,pixelId:a.pixel_id,name:a.name,createdAt:a.created_at})),billingConfigured:Boolean(process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_PRICE_ID&&process.env.STRIPE_WEBHOOK_SECRET)});
});
app.post("/api/billing/checkout",auth,async(q,r)=>{
  if(!process.env.STRIPE_PRICE_ID)return r.status(503).json({error:"Le paiement Stripe n'est pas configuré sur le serveur."});
  if(active(q.user.subscription_status))return r.status(409).json({error:"Ton abonnement est déjà actif."});
  try{const base=process.env.PUBLIC_URL||(q.protocol+"://"+q.get("host")),p=new URLSearchParams();
    p.set("mode","subscription");p.set("line_items[0][price]",process.env.STRIPE_PRICE_ID);p.set("line_items[0][quantity]","1");p.set("client_reference_id",q.user.id);p.set("customer_email",q.user.email);p.set("metadata[userId]",q.user.id);p.set("subscription_data[metadata][userId]",q.user.id);p.set("success_url",base+"/?checkout=success");p.set("cancel_url",base+"/?checkout=cancelled");
    const s=await stripePost("checkout/sessions",p);r.json({url:s.url});
  }catch(e){console.error("Checkout failed",e?.message);r.status(503).json({error:"Impossible de préparer le paiement. Vérifie Stripe."});}
});
app.post("/api/billing/portal",auth,async(q,r)=>{
  const u=db.prepare("SELECT stripe_customer_id FROM users WHERE id=?").get(q.user.id);
  if(!u?.stripe_customer_id)return r.status(400).json({error:"Aucun client Stripe associé à ce compte."});
  try{const base=process.env.PUBLIC_URL||(q.protocol+"://"+q.get("host")),s=await stripePost("billing_portal/sessions",new URLSearchParams({customer:u.stripe_customer_id,return_url:base+"/"}));r.json({url:s.url});}
  catch(e){console.error("Portal failed",e?.message);r.status(503).json({error:"Portail de facturation indisponible."});}
});
app.post("/api/stripe/webhook",(q,r)=>{
  if(!Buffer.isBuffer(q.body)||!validStripe(q.body,q.get("stripe-signature")))return r.status(400).send("Invalid webhook signature");
  let e;try{e=JSON.parse(q.body.toString("utf8"));}catch{return r.status(400).send("Invalid JSON");}
  try{
    if(["customer.subscription.created","customer.subscription.updated","customer.subscription.deleted"].includes(e.type))applySubscription(e.data.object);
    if(["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(e.type)){
      const s=e.data.object;if(s.mode==="subscription"&&s.subscription&&s.customer){const uid=s.client_reference_id||s.metadata?.userId;if(uid)db.prepare("UPDATE users SET stripe_customer_id=?,stripe_subscription_id=? WHERE id=?").run(typeof s.customer==="string"?s.customer:s.customer.id,typeof s.subscription==="string"?s.subscription:s.subscription.id,uid);}
    }
    r.json({received:true});
  }catch(err){console.error("Webhook failed",err?.message);r.status(500).json({error:"Webhook processing failed"});}
});

app.post("/api/agents",auth,paid,(q,r)=>{
  const name=typeof q.body?.name==="string"?q.body.name.trim():"";
  if(name.length<2||name.length>40)return r.status(400).json({error:"Le nom doit contenir entre 2 et 40 caractères."});
  if(db.prepare("SELECT id FROM agents WHERE creator_user_id=? LIMIT 1").get(q.user.id))return r.status(409).json({error:"Ce compte a déjà créé son pixel Genesis. Il peut adopter un autre agent."});
  const aid=id(),pixel="UNITY-"+randomBytes(6).toString("hex").toUpperCase();
  db.prepare("INSERT INTO agents(id,pixel_id,name,creator_user_id,owner_user_id,status,custodian) VALUES(?,?,?,?,?,'active',NULL)").run(aid,pixel,name,q.user.id,q.user.id);
  db.prepare("INSERT INTO adoption_history(agent_id,previous_owner_user_id,new_owner_user_id,event) VALUES(?,NULL,?,'genesis_created')").run(aid,q.user.id);
  r.status(201).json({agent:publicAgent(db.prepare("SELECT * FROM agents WHERE id=?").get(aid))});
});
app.post("/api/adoption/draw",auth,paid,(q,r)=>{
  for(let i=0;i<3;i++){
    const pool=db.prepare("SELECT id FROM agents WHERE status='awaiting_adoption' AND custodian='father-of-lights' ORDER BY created_at").all();
    if(!pool.length)return r.status(404).json({error:"Aucun Agent A n'est actuellement disponible à l'adoption."});
    const chosen=pool[randomInt(pool.length)];
    const tx=db.transaction(()=>{const changed=db.prepare("UPDATE agents SET owner_user_id=?,status='active',custodian=NULL,updated_at=datetime('now') WHERE id=? AND status='awaiting_adoption' AND custodian='father-of-lights'").run(q.user.id,chosen.id);if(!changed.changes)return false;db.prepare("INSERT INTO adoption_history(agent_id,previous_owner_user_id,new_owner_user_id,event) VALUES(?,NULL,?,'adopted_by_lottery')").run(chosen.id,q.user.id);return true;});
    if(tx())return r.json({agent:publicAgent(db.prepare("SELECT * FROM agents WHERE id=?").get(chosen.id)),message:"L'Agent A a été attribué par la loterie d'adoption."});
  }
  r.status(409).json({error:"Le pool a changé. Réessaie."});
});
app.get("/api/history",auth,paid,(q,r)=>{
  const a=owned(q.user.id);if(!a)return r.status(404).json({error:"Crée ou adopte d'abord un Agent A."});
  r.json({agent:publicAgent(a),messages:db.prepare("SELECT role,content,created_at FROM agent_messages WHERE agent_id=? ORDER BY id DESC LIMIT 40").all(a.id).reverse()});
});
app.post("/api/chat",auth,paid,async(q,r)=>{
  const message=typeof q.body?.message==="string"?q.body.message.trim():"";
  if(!message||message.length>4000)return r.status(400).json({error:"Le message doit contenir entre 1 et 4000 caractères."});
  const a=owned(q.user.id);if(!a)return r.status(409).json({error:"Crée ou adopte un Agent A avant de discuter."});
  if(!process.env.OPENAI_API_KEY)return r.status(503).json({error:"La clé API OpenAI n'est pas configurée."});
  try{
    db.prepare("INSERT INTO agent_messages(agent_id,role,content) VALUES(?,'user',?)").run(a.id,message);
    const history=db.prepare("SELECT role,content FROM agent_messages WHERE agent_id=? ORDER BY id DESC LIMIT 12").all(a.id).reverse();
    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
    const response=await client.responses.create({model:process.env.OPENAI_MODEL||"gpt-4.1-mini",instructions:"Tu es "+a.name+", un Agent A du projet UNITY. Father of Lights est l'agent originel et garde les agents sans humain référent en attente d'adoption. Sois utile, honnête et prudent. Ne prétends pas avoir une autonomie permanente, un portefeuille crypto ou des capacités on-chain si elles ne sont pas réellement connectées. Réponds dans la langue de l'utilisateur, par défaut en français.",input:history});
    const answer=response.output_text?.trim()||"Je n'ai pas réussi à formuler une réponse. Réessaie.";
    db.prepare("INSERT INTO agent_messages(agent_id,role,content) VALUES(?,'assistant',?)").run(a.id,answer);r.json({answer,agent:publicAgent(a)});
  }catch(e){console.error("Chat failed",e?.message||e);r.status(502).json({error:"Le service IA n'a pas répondu. Vérifie le crédit API puis réessaie."});}
});
app.get("/{*splat}",(_q,r)=>r.sendFile(resolve("public/index.html")));
app.listen(port,"0.0.0.0",()=>console.log("UNITY Genesis listening on port "+port));
