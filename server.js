const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = "lp_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-liveproof-secret";
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || "";
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || "";
const YOOKASSA_RETURN_URL = process.env.YOOKASSA_RETURN_URL || "";

const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "app-db.json");

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

function ensureDb() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    const initial = { users: [], widgets: [], payments: [] };
    fs.writeFileSync(dbPath, JSON.stringify(initial, null, 2), "utf8");
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}

function writeDb(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), "utf8");
}

function genId() {
  return crypto.randomBytes(8).toString("hex");
}

function generateYearlyActiveUntil() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}

function generateMonthlyActiveUntil() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

async function createYooKassaPayment({ amountRub, description, metadata }) {
  if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY || !YOOKASSA_RETURN_URL) {
    throw new Error("YOOKASSA_NOT_CONFIGURED");
  }

  const auth = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64");
  const idempotenceKey =
    typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${genId()}`;
  const { data } = await axios.post(
    "https://api.yookassa.ru/v3/payments",
    {
      amount: {
        value: `${Number(amountRub).toFixed(2)}`,
        currency: "RUB"
      },
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: YOOKASSA_RETURN_URL
      },
      description,
      metadata
    },
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Idempotence-Key": idempotenceKey,
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );
  return data;
}

function signValue(value) {
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
  return `${value}.${signature}`;
}

function verifySignedValue(signed) {
  if (!signed || !signed.includes(".")) return null;
  const lastDot = signed.lastIndexOf(".");
  const value = signed.slice(0, lastDot);
  const signature = signed.slice(lastDot + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? value : null;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const chunks = header.split(";").map((s) => s.trim()).filter(Boolean);
  const out = {};
  for (const chunk of chunks) {
    const idx = chunk.indexOf("=");
    if (idx === -1) continue;
    out[decodeURIComponent(chunk.slice(0, idx))] = decodeURIComponent(chunk.slice(idx + 1));
  }
  return out;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function createSession(userId) {
  const payload = JSON.stringify({ userId, exp: Date.now() + SESSION_TTL_MS });
  return signValue(Buffer.from(payload).toString("base64url"));
}

function readSession(req) {
  const cookies = parseCookies(req);
  const signed = cookies[SESSION_COOKIE];
  const raw = verifySignedValue(signed || "");
  if (!raw) return null;
  try {
    const payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function clearSession(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function setSession(res, userId) {
  const token = createSession(userId);
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax`
  );
}

function authRequired(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  req.session = session;
  return next();
}

app.get("/site", (_req, res) => {
  res.sendFile(path.join(publicDir, "site.html"));
});

app.get("/pricing", (_req, res) => {
  res.sendFile(path.join(publicDir, "pricing.html"));
});

app.get("/requisites", (_req, res) => {
  res.sendFile(path.join(publicDir, "requisites.html"));
});

app.get("/offer", (_req, res) => {
  res.sendFile(path.join(publicDir, "offer.html"));
});

app.get("/privacy", (_req, res) => {
  res.sendFile(path.join(publicDir, "privacy.html"));
});

app.get("/auth", (_req, res) => {
  res.sendFile(path.join(publicDir, "auth.html"));
});

app.get("/cabinet", (_req, res) => {
  res.sendFile(path.join(publicDir, "cabinet.html"));
});

app.post("/api/auth/register", (req, res) => {
  const email = (req.body.email || "").toString().trim().toLowerCase();
  const password = (req.body.password || "").toString();
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: "Введите email и пароль не короче 6 символов" });
  }

  const db = readDb();
  if (db.users.some((u) => u.email === email)) {
    return res.status(409).json({ error: "Пользователь с таким email уже существует" });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const user = {
    id: genId(),
    email,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  writeDb(db);
  setSession(res, user.id);
  return res.json({ ok: true, email: user.email });
});

app.post("/api/auth/login", (req, res) => {
  const email = (req.body.email || "").toString().trim().toLowerCase();
  const password = (req.body.password || "").toString();
  const db = readDb();
  const user = db.users.find((u) => u.email === email);
  if (!user) return res.status(401).json({ error: "Неверный email или пароль" });
  const hash = hashPassword(password, user.salt);
  if (hash !== user.passwordHash) return res.status(401).json({ error: "Неверный email или пароль" });
  setSession(res, user.id);
  return res.json({ ok: true, email: user.email });
});

app.post("/api/auth/logout", (_req, res) => {
  clearSession(res);
  return res.json({ ok: true });
});

app.get("/api/me", authRequired, (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.session.userId);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  return res.json({ id: user.id, email: user.email });
});

app.get("/api/my-widgets", authRequired, (req, res) => {
  const db = readDb();
  const widgets = db.widgets.filter((w) => w.userId === req.session.userId);
  return res.json({ widgets });
});

app.post("/api/my-widgets", authRequired, (req, res) => {
  const channel = (req.body.channel || "").toString().trim().replace(/^@/, "");
  if (!channel) return res.status(400).json({ error: "Укажите канал" });
  const db = readDb();
  const widget = {
    id: genId(),
    userId: req.session.userId,
    channel,
    plan: "free",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.widgets.push(widget);
  writeDb(db);
  return res.json({ widget });
});

app.post("/api/my-widgets/:id/checkout", authRequired, async (req, res) => {
  const widgetId = req.params.id;
  const tariff = (req.body.tariff || "monthly").toString().toLowerCase();
  const amounts = {
    monthly: 300,
    yearly: 3000
  };
  const amountRub = amounts[tariff];
  if (!amountRub) return res.status(400).json({ error: "Unknown tariff" });

  const db = readDb();
  const widget = db.widgets.find((w) => w.id === widgetId && w.userId === req.session.userId);
  if (!widget) return res.status(404).json({ error: "Widget not found" });

  const payment = {
    id: genId(),
    widgetId: widget.id,
    userId: req.session.userId,
    tariff,
    amountRub,
    status: "pending",
    provider: "yookassa",
    providerPaymentId: null,
    confirmationUrl: null,
    createdAt: new Date().toISOString()
  };

  try {
    const yooPayment = await createYooKassaPayment({
      amountRub,
      description: `LiveProof ${tariff === "yearly" ? "годовой" : "месячный"} тариф`,
      metadata: {
        paymentId: payment.id,
        widgetId: widget.id,
        userId: req.session.userId,
        tariff
      }
    });

    payment.providerPaymentId = yooPayment.id;
    payment.confirmationUrl = yooPayment.confirmation ? yooPayment.confirmation.confirmation_url : null;
    db.payments.push(payment);
    writeDb(db);

    return res.json({
      ok: true,
      paymentId: payment.id,
      tariff,
      amountRub,
      checkoutUrl: payment.confirmationUrl
    });
  } catch (error) {
    const detail =
      error.message === "YOOKASSA_NOT_CONFIGURED"
        ? "ЮKassa не настроена. Заполните YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY и YOOKASSA_RETURN_URL."
        : "Не удалось создать платеж в ЮKassa";
    return res.status(500).json({ error: detail });
  }
});

app.post("/api/my-widgets/:id/activate-paid", authRequired, (req, res) => {
  const widgetId = req.params.id;
  const tariff = (req.body.tariff || "monthly").toString().toLowerCase();
  if (!["monthly", "yearly"].includes(tariff)) return res.status(400).json({ error: "Unknown tariff" });
  const db = readDb();
  const widget = db.widgets.find((w) => w.id === widgetId && w.userId === req.session.userId);
  if (!widget) return res.status(404).json({ error: "Widget not found" });
  widget.plan = "paid";
  widget.billingCycle = tariff;
  widget.updatedAt = new Date().toISOString();
  writeDb(db);
  return res.json({ ok: true, widget });
});

app.post("/api/payments/webhook", (req, res) => {
  const event = req.body || {};
  if (event.event !== "payment.succeeded" || !event.object || !event.object.id) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const providerPaymentId = event.object.id;
  const db = readDb();
  const payment = db.payments.find((p) => p.providerPaymentId === providerPaymentId);
  if (!payment) return res.status(200).json({ ok: true, ignored: true });
  if (payment.status === "succeeded") return res.status(200).json({ ok: true, alreadyProcessed: true });

  payment.status = "succeeded";
  payment.succeededAt = new Date().toISOString();

  const widget = db.widgets.find((w) => w.id === payment.widgetId);
  if (widget) {
    widget.plan = "paid";
    widget.billingCycle = payment.tariff;
    widget.activeUntil = payment.tariff === "yearly" ? generateYearlyActiveUntil() : generateMonthlyActiveUntil();
    widget.updatedAt = new Date().toISOString();
  }

  writeDb(db);
  return res.status(200).json({ ok: true });
});

app.get("/embed/:widgetId", (req, res) => {
  const widgetId = req.params.widgetId;
  const db = readDb();
  const widget = db.widgets.find((w) => w.id === widgetId);
  if (!widget) return res.status(404).send("Widget not found");
  const siteUrl = "https://liveproof.online";
  const siteName = "LiveProof";
  const src = widget.plan === "paid"
    ? `/?channel=${encodeURIComponent(widget.channel)}&plan=paid`
    : `/?channel=${encodeURIComponent(widget.channel)}&plan=free&siteName=${encodeURIComponent(siteName)}&siteUrl=${encodeURIComponent(siteUrl)}`;
  return res.send(`<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>html,body{margin:0;padding:0;background:transparent;}</style>
  </head>
  <body>
    <iframe src="${src}" width="100%" height="760" style="border:0;display:block" loading="lazy"></iframe>
  </body>
</html>`);
});

function normalizeNumber(value) {
  if (!value) return 0;

  const clean = value
    .toString()
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, "")
    .replace(",", ".")
    .toUpperCase();

  if (!clean) return 0;

  if (clean.endsWith("K")) return Math.round(parseFloat(clean) * 1000);
  if (clean.endsWith("M")) return Math.round(parseFloat(clean) * 1000000);
  if (clean.endsWith("B")) return Math.round(parseFloat(clean) * 1000000000);

  const parsed = parseInt(clean.replace(/[^\d]/g, ""), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseSubscribers(raw) {
  if (!raw) return 0;
  const match = raw.match(/([\d\s.,KMBkmb]+)/);
  if (!match) return 0;
  return normalizeNumber(match[1]);
}

function getNumberTokens(text) {
  if (!text) return [];
  const tokens = text.match(/\d+(?:[.,]\d+)?\s*[KMBkmb]?/g);
  return tokens || [];
}

function sumNumbersFromText(text) {
  return getNumberTokens(text).reduce((sum, token) => sum + normalizeNumber(token), 0);
}

function firstNumberFromText(text) {
  const token = getNumberTokens(text)[0];
  return token ? normalizeNumber(token) : 0;
}

function extractUrlFromStyle(styleValue) {
  if (!styleValue) return null;
  const match = styleValue.match(/url\(["']?(.*?)["']?\)/i);
  return match ? match[1] : null;
}

function getFirstNonEmpty($root, selectors) {
  for (const selector of selectors) {
    const value = $root.find(selector).first().text().trim();
    if (value) return value;
  }
  return "";
}

function parseMedia($post) {
  const photoStyle = $post.find(".tgme_widget_message_photo_wrap").attr("style");
  const videoStyle = $post.find(".tgme_widget_message_video_thumb").attr("style");
  const linkPreviewStyle = $post.find(".link_preview_image").attr("style");

  const photoUrl = extractUrlFromStyle(photoStyle);
  if (photoUrl) {
    return { type: "photo", url: photoUrl };
  }

  const videoPreviewUrl = extractUrlFromStyle(videoStyle);
  if (videoPreviewUrl) {
    return { type: "video", url: videoPreviewUrl };
  }

  const previewUrl = extractUrlFromStyle(linkPreviewStyle);
  if (previewUrl) {
    return { type: "preview", url: previewUrl };
  }

  return null;
}

function extractPostText($, $post) {
  const $text = $post.find(".tgme_widget_message_text").first();
  if (!$text.length) return "";

  let html = $text.html() || "";
  html = html.replace(/<br\s*\/?>/gi, "\n");
  html = html.replace(/<\/(p|div|blockquote|li|h1|h2|h3|h4|h5|h6)>/gi, "$&\n");

  const plain = cheerio.load(`<div>${html}</div>`)("div").text();
  return plain
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractPostHtml($post) {
  const $text = $post.find(".tgme_widget_message_text").first();
  if (!$text.length) return "";

  const allowedTags = new Set([
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "a",
    "code",
    "pre",
    "blockquote",
    "br"
  ]);

  const $fragment = cheerio.load(`<div>${$text.html() || ""}</div>`, null, false);
  $fragment("*").each((_, node) => {
    const tag = (node.tagName || "").toLowerCase();
    if (!tag || tag === "html" || tag === "head" || tag === "body" || tag === "div") return;

    if (!allowedTags.has(tag)) {
      $fragment(node).replaceWith($fragment(node).text());
      return;
    }

    const attrs = node.attribs || {};
    for (const attrName of Object.keys(attrs)) {
      const lower = attrName.toLowerCase();
      if (tag === "a" && lower === "href") continue;
      $fragment(node).removeAttr(attrName);
    }
  });

  return $fragment("div").html().trim();
}

function parsePost($, $post, channel) {
  const href = $post.find(".tgme_widget_message_date").attr("href") || "";
  const idMatch = href.match(/\/(\d+)$/);
  const id = idMatch ? Number(idMatch[1]) : null;

  const text = extractPostText($, $post);
  const textHtml = extractPostHtml($post);

  const date = $post.find("time").attr("datetime") || null;
  const viewsRaw = getFirstNonEmpty($post, [
    ".tgme_widget_message_views",
    ".tgme_widget_message_info_views"
  ]);

  const commentsRaw = getFirstNonEmpty($post, [
    ".tgme_widget_message_replies .tgme_widget_message_meta_count",
    ".tgme_widget_message_replies",
    ".tgme_widget_message_info_replies",
    "[class*='repl']"
  ]);

  let likes = 0;
  $post.find(".tgme_widget_message_reactions .tgme_widget_message_reaction").each((_, el) => {
    const $reaction = $(el);
    const countRaw =
      $reaction.find(".tgme_widget_message_reaction_count").first().text().trim() || $reaction.text().trim();
    likes += normalizeNumber(countRaw);
  });

  if (likes === 0) {
    $post.find(".tgme_widget_message_reaction_count").each((_, el) => {
      likes += normalizeNumber($(el).text().trim());
    });
  }

  if (likes === 0) {
    const reactionsRaw = getFirstNonEmpty($post, [
      ".tgme_widget_message_reactions",
      "[class*='reaction']"
    ]);
    likes = sumNumbersFromText(reactionsRaw);
  }

  const media = parseMedia($post);
  const comments = commentsRaw ? firstNumberFromText(commentsRaw) : 0;

  return {
    id,
    text: text || "Пост без текста",
    textHtml,
    date,
    likes,
    comments,
    views: normalizeNumber(viewsRaw),
    media,
    url: id ? `https://t.me/${channel}/${id}` : href || `https://t.me/${channel}`
  };
}

async function fetchChannelData(channel) {
  const url = `https://t.me/s/${channel}`;
  const { data } = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
    },
    timeout: 10000
  });

  const $ = cheerio.load(data);
  const title = $(".tgme_channel_info_header_title").first().text().trim() || channel;
  const subscribersText = $(".tgme_channel_info_counter").first().text().trim();
  const subscribers = parseSubscribers(subscribersText);

  const posts = [];
  $(".tgme_widget_message_wrap").each((_, el) => {
    const post = parsePost($, $(el), channel);
    if (post.id) posts.push(post);
  });

  posts.sort((a, b) => (b.id || 0) - (a.id || 0));

  return {
    channel,
    title,
    subscribers,
    channelUrl: `https://t.me/${channel}`,
    posts: posts.slice(0, 5)
  };
}

app.get("/api/channel/:channel", async (req, res) => {
  try {
    const channel = req.params.channel.replace("@", "").trim();
    if (!channel) {
      return res.status(400).json({ error: "Channel is required" });
    }

    const result = await fetchChannelData(channel);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      error: "Не удалось получить данные канала",
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Telegram widget server running at http://localhost:${PORT}`);
});
