const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static("public"));

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
    posts: posts.slice(0, 4)
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
